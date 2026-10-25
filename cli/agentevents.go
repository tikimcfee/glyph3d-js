package main

// Agent sessions and their events, moved as lines and never read here.
//
// gomuxai (the `agent` CLI) is the one reader of agent transcripts (its docs/EVENTS.md).
// The relay runs it and moves what it prints:
//   - `agent sessions --json`, re-run every --sessions-interval while a display is
//     connected: agentSessions/list answers with the last run, agentSessions/changed
//     pushes a run whose shown fields differ (sessionShape — not size/mtime/status_at).
//   - `agent transcript <path> --follow [--from <at>]`, one per (transcript, from), shared
//     by every display subscription that asked for it and killed when the last one goes
//     (unfollow, or the display disconnecting), at most --max-followers at once. Its
//     stdout lines are pushed as agentEvents/lines batches, its exit as agentEvents/ended,
//     its stderr to the relay log as [agent-transcript] lines.
//   - `agent transcript <path> [--from <at>] --until <byte>`, one-shot: agentEvents/read.
// Follow and read name the transcript the same way (resolveSession, over the latest
// session list), and hand `agent` its path. For a tail window the relay finds line STARTS
// in the transcript (finding a newline is not parsing); it reads nothing else of it.
//
// RPCs (fs.go dispatch):
//   agentSessions/list   {}                                → {gen, sessions}
//   agentEvents/follow   {session, from?}                  → {ok}
//   agentEvents/unfollow {session}                         → {ok}
//   agentEvents/read     {session, from?, until?, tail?}   → {lines, size}
// Pushes:
//   agentSessions/changed {gen, sessions}   (control plane, like gomux/changed)
//   agentEvents/lines     {session, lines}  (the events plane, below)
//   agentEvents/ended     {session, code, error?}
//
// A subscription is (display, session name): a display holds at most one follower per
// name, and following a name again from another byte swaps its follower. Lines ride their
// own lossless display plane (Relay.pushAgentEvent: control traffic drains first; a push
// waits for room). A display that leaves a push waiting past agentEventsStall is not
// keeping up: its subscription is dropped with agentEvents/ended (code -1) instead of
// buffering. An ended waits for the plane as long as the display stays connected, so it
// always arrives, after the lines queued before it. A follower holds one batch and a few
// lines in memory; between pushes the agent's own pipe backpressures it.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Tuning (vars so tests can shorten them).
var (
	agentEventsBatchWait  = 50 * time.Millisecond // a line waits at most this long for a push
	agentEventsBatchBytes = 256 * 1024            // a push carries at most this much (one longer line goes alone)
	agentEventsStall      = 10 * time.Second      // a push waiting longer than this drops the subscription
	maxAgentReadBytes     = int64(64 << 20)       // agentEvents/read's output cap
)

// Errors a push reports.
var (
	errDisplayGone    = errMsg("display gone")
	errDisplayStalled = errMsg("display not keeping up")
)

// agentEventsPush delivers one lines/ended push to a display, waiting at most `wait` for
// room (0 = as long as the display stays): errDisplayGone if that display has left,
// errDisplayStalled if the wait ran out.
type agentEventsPush func(display uint64, method string, params any, wait time.Duration) error

// AgentEvents runs gomuxai's session list and transcript followers for the displays.
type AgentEvents struct {
	bin          string        // the `agent` binary ("" = look it up on PATH)
	interval     time.Duration // the session list's poll period
	maxFollowers int

	push    agentEventsPush
	notify  func(method string, params any) // agentSessions/changed
	logLine func(session, line string)      // a follower's stderr

	mu        sync.Mutex
	displays  map[uint64]bool
	followers map[followKey]*follower
	subs      map[subKey]*follower
	pollStop  context.CancelFunc

	sessMu  sync.Mutex // one `agent sessions` run at a time; guards the fields below
	polled  bool
	sessRaw []byte       // the latest output
	refs    []sessionRef // what resolveSession reads of it, in list order
	shape   string       // the shown fields of the last list pushed (sessionShape)
	gen     uint64       // bumps with each push
	pollErr string
}

type followKey struct {
	path string // the resolved transcript
	from int64  // -1 = from the start
}

type subKey struct {
	display uint64
	session string
}

// follower is one running `agent transcript --follow`.
type follower struct {
	key    followKey
	cmd    *exec.Cmd
	cancel context.CancelFunc
	out    *os.File        // our end of its stdout
	subs   map[subKey]bool // subscriptions holding it (AgentEvents.mu)
	done   bool            // stopped by the relay or exited: no more pushes but ended (AgentEvents.mu)
}

type agentSessionsList struct {
	Gen      uint64          `json:"gen"`
	Sessions json.RawMessage `json:"sessions"` // `agent sessions --json`'s array, as printed
}

type agentEventsLines struct {
	Session string   `json:"session"`
	Lines   []string `json:"lines"`
}

type agentEventsEnded struct {
	Session string `json:"session"`
	Code    int    `json:"code"`
	Error   string `json:"error,omitempty"`
}

// NewAgentEvents builds the subsystem; nothing runs until a display connects.
func NewAgentEvents(interval time.Duration, maxFollowers int) *AgentEvents {
	return &AgentEvents{
		interval:     interval,
		maxFollowers: maxFollowers,
		displays:     map[uint64]bool{},
		followers:    map[followKey]*follower{},
		subs:         map[subKey]*follower{},
		logLine:      func(session, line string) { log.Printf("[agent-transcript] %s: %s", session, line) },
	}
}

func (a *AgentEvents) binary() (string, error) {
	if a.bin != "" {
		return a.bin, nil
	}
	bin, err := exec.LookPath("agent")
	if err != nil {
		return "", errMsg("no gomuxai `agent` on PATH")
	}
	return bin, nil
}

// ---- displays ----

// DisplayConnected registers a display (the relay's id for it) and starts the session
// poll if it is the first.
func (a *AgentEvents) DisplayConnected(display uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.displays[display] = true
	if a.pollStop == nil {
		ctx, cancel := context.WithCancel(context.Background())
		a.pollStop = cancel
		go a.poll(ctx)
	}
}

// DisplayGone drops a display's subscriptions (a follower left with none stops) and
// stops the session poll when no display remains.
func (a *AgentEvents) DisplayGone(display uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.displays, display)
	for sk, f := range a.subs {
		if sk.display == display {
			a.dropSubLocked(sk, f)
		}
	}
	if len(a.displays) == 0 && a.pollStop != nil {
		a.pollStop()
		a.pollStop = nil
	}
}

// ---- following ----

// Follow subscribes a display to a session's events from a byte (-1 = the start). The
// session resolves through resolveSession first (an unknown or ambiguous one is an
// error, not a follower that dies). Idempotent; a follow from another byte, or of a name
// that now resolves to another transcript, replaces the display's follower for it.
func (a *AgentEvents) Follow(ctx context.Context, display uint64, session string, from int64) error {
	path, err := a.resolveSession(ctx, session)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.displays[display] {
		return errDisplayGone
	}
	sk, key := subKey{display, session}, followKey{path, from}
	if f := a.subs[sk]; f != nil {
		if f.key == key && !f.done {
			return nil
		}
		a.dropSubLocked(sk, f)
	}
	f := a.followers[key]
	if f == nil {
		if len(a.followers) >= a.maxFollowers {
			log.Printf("[agent-transcript] follower cap (%d) reached: not following %s", a.maxFollowers, session)
			return fmt.Errorf("follower cap reached: %d transcripts followed (--max-followers); not following %s", a.maxFollowers, session)
		}
		if f, err = a.startLocked(key); err != nil {
			return err
		}
	}
	f.subs[sk] = true
	a.subs[sk] = f
	return nil
}

// Unfollow drops a display's subscription to a session (none held is fine).
func (a *AgentEvents) Unfollow(display uint64, session string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	sk := subKey{display, session}
	if f := a.subs[sk]; f != nil {
		a.dropSubLocked(sk, f)
	}
}

func (a *AgentEvents) dropSubLocked(sk subKey, f *follower) {
	if a.subs[sk] == f {
		delete(a.subs, sk)
	}
	delete(f.subs, sk)
	if len(f.subs) == 0 {
		a.stopLocked(f)
	}
}

// stopLocked kills a follower nobody holds. It sends no ended: its subscribers left.
func (a *AgentEvents) stopLocked(f *follower) {
	if f.done {
		return
	}
	f.done = true
	if a.followers[f.key] == f {
		delete(a.followers, f.key)
	}
	f.cancel()
	f.out.Close() // the stream also ends on its own once its reader is gone
}

func (a *AgentEvents) startLocked(key followKey) (*follower, error) {
	bin, err := a.binary()
	if err != nil {
		return nil, err
	}
	args := []string{"transcript", key.path, "--follow", "-q"}
	if key.from >= 0 {
		args = append(args, "--from", strconv.FormatInt(key.from, 10))
	}
	// Our own pipes, not exec's: Wait then never cuts off a stdout we are still reading.
	outR, outW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout, cmd.Stderr = outW, errW
	err = startChild(cmd)
	outW.Close()
	errW.Close()
	if err != nil {
		cancel()
		outR.Close()
		errR.Close()
		return nil, errMsg("start " + bin + " transcript: " + err.Error())
	}
	f := &follower{key: key, cmd: cmd, cancel: cancel, out: outR, subs: map[subKey]bool{}}
	a.followers[key] = f
	log.Printf("[agent-transcript] following %s%s (pid %d)", key.path,
		orEmpty(" from "+strconv.FormatInt(key.from, 10), key.from >= 0), cmd.Process.Pid)
	go a.run(f, errR)
	return f, nil
}

// run moves one follower's output until it exits, then reports the exit.
func (a *AgentEvents) run(f *follower, stderr *os.File) {
	var errTail strings.Builder // the last stderr lines, for ended's error
	errDone := make(chan struct{})
	go func() {
		defer close(errDone)
		defer stderr.Close()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 4096), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			a.logLine(f.key.path, line)
			if errTail.Len() > 2048 {
				errTail.Reset()
			}
			if errTail.Len() > 0 {
				errTail.WriteByte('\n')
			}
			errTail.WriteString(line)
		}
	}()

	lines := make(chan []byte, 16)
	go func() {
		defer close(lines)
		br := bufio.NewReaderSize(f.out, 64*1024)
		for {
			b, err := br.ReadBytes('\n')
			if err != nil {
				if len(b) > 0 && !errors.Is(err, os.ErrClosed) {
					log.Printf("[agent-transcript] %s: dropped an unterminated last line (%d bytes)", f.key.path, len(b))
				}
				return
			}
			if b = bytes.TrimRight(b, "\r\n"); len(b) > 0 {
				lines <- b
			}
		}
	}()
	a.batch(f, lines)
	f.out.Close()
	<-errDone
	err := f.cmd.Wait()
	childExited(f.cmd)
	f.cancel()

	a.mu.Lock()
	stopped := f.done
	f.done = true
	if a.followers[f.key] == f {
		delete(a.followers, f.key)
	}
	to := sortedSubs(f.subs)
	for _, sk := range to {
		if a.subs[sk] == f {
			delete(a.subs, sk)
		}
	}
	f.subs = map[subKey]bool{}
	a.mu.Unlock()
	if stopped {
		log.Printf("[agent-transcript] stopped %s", f.key.path)
		return
	}
	code, msg := 0, ""
	if err != nil {
		code = -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		msg = err.Error()
	}
	if tail := strings.TrimSpace(errTail.String()); tail != "" {
		msg = tail
	}
	log.Printf("[agent-transcript] %s ended (code %d)%s", f.key.path, code, orEmpty(": "+msg, msg != ""))
	for _, sk := range to {
		a.sendEnded(sk, code, msg)
	}
}

// sendEnded tells a display its subscription is over. It waits for the events plane as
// long as the display stays connected — behind the lines already queued, so it arrives
// after them — because a display must always learn it lost a subscription.
func (a *AgentEvents) sendEnded(sk subKey, code int, msg string) {
	err := a.push(sk.display, "agentEvents/ended", agentEventsEnded{Session: sk.session, Code: code, Error: msg}, 0)
	if err != nil && err != errDisplayGone {
		log.Printf("[agent-transcript] %s: ended not delivered: %v", sk.session, err)
	}
}

func sortedSubs(m map[subKey]bool) []subKey {
	out := make([]subKey, 0, len(m))
	for sk := range m {
		out = append(out, sk)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].display != out[j].display {
			return out[i].display < out[j].display
		}
		return out[i].session < out[j].session
	})
	return out
}

// batch pushes lines in order, at most agentEventsBatchWait after the first of a batch
// arrives and at most agentEventsBatchBytes at a time (a longer line goes alone, whole),
// until the stream closes.
func (a *AgentEvents) batch(f *follower, lines <-chan []byte) {
	var batch []string
	size := 0
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	flush := func() {
		if len(batch) > 0 {
			a.deliver(f, batch)
		}
		batch, size = nil, 0
	}
	for {
		select {
		case b, ok := <-lines:
			if !ok {
				timer.Stop()
				flush()
				return
			}
			if len(batch) > 0 && size+len(b) > agentEventsBatchBytes {
				flush()
			}
			if len(batch) == 0 {
				timer.Reset(agentEventsBatchWait)
			}
			batch = append(batch, string(b))
			size += len(b)
			if size >= agentEventsBatchBytes {
				flush()
			}
		case <-timer.C:
			flush()
		}
	}
}

// deliver pushes one batch to every subscription holding the follower, each under the
// session name it followed by. A display that stalls loses its subscription.
func (a *AgentEvents) deliver(f *follower, batch []string) {
	a.mu.Lock()
	if f.done {
		a.mu.Unlock()
		return
	}
	to := sortedSubs(f.subs)
	a.mu.Unlock()
	for _, sk := range to {
		msg := agentEventsLines{Session: sk.session, Lines: batch}
		if err := a.push(sk.display, "agentEvents/lines", msg, agentEventsStall); err == errDisplayStalled {
			a.stalled(f, sk)
		}
	}
}

// stalled drops a subscription whose display left a push waiting agentEventsStall, and
// tells it so (sendEnded: queued behind its lines, however long the plane takes).
func (a *AgentEvents) stalled(f *follower, sk subKey) {
	a.mu.Lock()
	held := f.subs[sk]
	if held {
		a.dropSubLocked(sk, f)
	}
	a.mu.Unlock()
	if !held {
		return
	}
	msg := fmt.Sprintf("display not keeping up: a push waited %s; follow again from the last at", agentEventsStall)
	log.Printf("[agent-transcript] %s: %s (display %d unsubscribed)", sk.session, msg, sk.display)
	go a.sendEnded(sk, -1, msg)
}

// ---- the session list ----

func (a *AgentEvents) poll(ctx context.Context) {
	t := time.NewTicker(a.interval)
	defer t.Stop()
	for {
		a.refreshSessions(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// refreshSessions runs `agent sessions --json` once and keeps its output; a list whose
// shape changed takes the next gen and is pushed.
func (a *AgentEvents) refreshSessions(ctx context.Context) error {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	raw, err := a.runSessions(ctx)
	if err == nil {
		err = a.applySessionsLocked(raw)
	}
	if err != nil {
		if ctx.Err() == nil && err.Error() != a.pollErr {
			log.Printf("[agent-sessions] %v", err)
		}
		a.pollErr = err.Error()
		return err
	}
	a.pollErr = ""
	return nil
}

func (a *AgentEvents) runSessions(ctx context.Context) ([]byte, error) {
	bin, err := a.binary()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "sessions", "--json", "-q")
	var stdout bytes.Buffer
	var stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	err = startChild(cmd)
	if err == nil {
		err = cmd.Wait()
		childExited(cmd)
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		return nil, errMsg(bin + " sessions --json: " + err.Error() + orEmpty(" — "+msg, msg != ""))
	}
	return bytes.TrimSpace(stdout.Bytes()), nil
}

// sessionShape is what a display shows of a session: a list whose shapes are unchanged
// (only size, mtime, status_at or order moved) isn't pushed; those ride the next push
// and agentSessions/list.
type sessionShape struct {
	ID            string          `json:"session_id"`
	Path          string          `json:"path"`
	Harness       string          `json:"harness"`
	Cwd           string          `json:"cwd"`
	Project       string          `json:"project"`
	Title         string          `json:"title"`
	AgentName     string          `json:"agent_name"`
	Status        string          `json:"status"`
	Workgroup     json.RawMessage `json:"workgroup"`
	ParentSession json.RawMessage `json:"parent_session"`
	ContinuedIn   string          `json:"continued_in"`
}

func (a *AgentEvents) applySessionsLocked(raw []byte) error {
	if a.polled && bytes.Equal(raw, a.sessRaw) {
		return nil
	}
	var ss []sessionShape
	if err := json.Unmarshal(raw, &ss); err != nil {
		return errMsg("agent sessions --json: not a JSON array of sessions: " + err.Error())
	}
	refs := make([]sessionRef, len(ss))
	keys := make([]string, len(ss))
	for i, s := range ss {
		var wg struct {
			Name string `json:"name"`
		}
		json.Unmarshal(s.Workgroup, &wg)
		refs[i] = sessionRef{id: s.ID, path: s.Path, workgroup: wg.Name, sub: isJSONSet(s.ParentSession)}
		k, _ := json.Marshal(s)
		keys[i] = string(k)
	}
	sort.Strings(keys)
	shape := strings.Join(keys, "\n")
	first := !a.polled
	a.polled, a.sessRaw, a.refs = true, raw, refs
	if !first && shape == a.shape {
		return nil
	}
	a.shape = shape
	a.gen++
	debugf("[agent-sessions] changed: gen %d, %d sessions, %d bytes pushed", a.gen, len(ss), len(raw))
	if a.notify != nil {
		a.notify("agentSessions/changed", agentSessionsList{Gen: a.gen, Sessions: raw})
	}
	return nil
}

func isJSONSet(r json.RawMessage) bool {
	s := strings.TrimSpace(string(r))
	return s != "" && s != "null"
}

// List answers with the latest list (running `agent sessions` first if none ran yet),
// under the gen of the last shape pushed.
func (a *AgentEvents) List(ctx context.Context) (agentSessionsList, error) {
	a.sessMu.Lock()
	polled := a.polled
	a.sessMu.Unlock()
	if !polled {
		if err := a.refreshSessions(ctx); err != nil {
			return agentSessionsList{}, err
		}
	}
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	return agentSessionsList{Gen: a.gen, Sessions: a.sessRaw}, nil
}

// sessionRef is what resolveSession reads of a listed session.
type sessionRef struct {
	id, path, workgroup string
	sub                 bool // a subagent's session (parent_session set)
}

// errSessionMiss: no listed session answers to the name (asking again may help;
// an ambiguous name is a different error, which asking again won't fix).
type errSessionMiss string

func (e errSessionMiss) Error() string { return string(e) }

// resolveSession is the ONE way follow and read name a transcript, over the latest
// `agent sessions` list: an exact session_id, an exact path, a workgroup agent's name
// (its newest session that isn't a subagent's — the list is newest first), or the
// start of exactly one session_id. A miss asks `agent sessions` again once. An unknown
// or ambiguous name, or a session with no transcript yet, is an error.
func (a *AgentEvents) resolveSession(ctx context.Context, session string) (string, error) {
	if session == "" {
		return "", errMsg("session required")
	}
	a.sessMu.Lock()
	polled := a.polled
	a.sessMu.Unlock()
	if !polled {
		if err := a.refreshSessions(ctx); err != nil {
			return "", err
		}
	}
	ref, err := a.lookupSession(session)
	if _, miss := err.(errSessionMiss); miss {
		if rerr := a.refreshSessions(ctx); rerr != nil {
			return "", rerr
		}
		ref, err = a.lookupSession(session)
	}
	if err != nil {
		return "", err
	}
	if ref.path == "" {
		return "", errMsg("agent session " + strconv.Quote(session) + " (" + ref.id + ") has no transcript yet")
	}
	return ref.path, nil
}

func (a *AgentEvents) lookupSession(s string) (sessionRef, error) {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	for _, r := range a.refs {
		if r.id == s {
			return r, nil
		}
	}
	for _, r := range a.refs {
		if r.path != "" && r.path == s {
			return r, nil
		}
	}
	for _, r := range a.refs {
		if r.workgroup == s && !r.sub {
			return r, nil
		}
	}
	var hits []sessionRef
	for _, r := range a.refs {
		if strings.HasPrefix(r.id, s) {
			hits = append(hits, r)
		}
	}
	switch len(hits) {
	case 1:
		return hits[0], nil
	case 0:
		return sessionRef{}, errSessionMiss("no agent session " + strconv.Quote(s) +
			": agent sessions lists none by that session_id, path, workgroup name or id prefix")
	}
	ids := make([]string, 0, 3)
	for _, h := range hits[:min(3, len(hits))] {
		ids = append(ids, h.id)
	}
	return sessionRef{}, fmt.Errorf("agent session %q is ambiguous: %d session ids start with it (%s…)", s, len(hits), strings.Join(ids, ", "))
}

// ---- reading ----

type agentEventsReadParams struct {
	Session string `json:"session"`
	From    *int64 `json:"from"`
	Until   *int64 `json:"until"`
	Tail    *int64 `json:"tail"`
}

type agentEventsReadResult struct {
	Lines []string `json:"lines"`
	Size  int64    `json:"size"`
}

// Read runs one bounded `agent transcript --until` over a session's transcript
// (resolveSession). The window ends at the size it saw, or `until` if lower; `tail: N`
// starts it at the first line start at or after end-N (see tailFrom) — with `until`, the
// last ~N bytes before it.
func (a *AgentEvents) Read(ctx context.Context, p agentEventsReadParams) (agentEventsReadResult, error) {
	path, err := a.resolveSession(ctx, p.Session)
	if err != nil {
		return agentEventsReadResult{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return agentEventsReadResult{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return agentEventsReadResult{}, err
	}
	size := info.Size()
	from, until := int64(-1), size
	if p.From != nil {
		from = *p.From
	}
	if p.Until != nil && *p.Until < until {
		until = *p.Until
	}
	if p.Tail != nil {
		if from, err = tailFrom(file, until, *p.Tail); err != nil {
			return agentEventsReadResult{}, err
		}
	}
	bin, err := a.binary()
	if err != nil {
		return agentEventsReadResult{}, err
	}
	args := []string{"transcript", path, "--until", strconv.FormatInt(until, 10), "-q"}
	if from >= 0 {
		args = append(args, "--from", strconv.FormatInt(from, 10))
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return agentEventsReadResult{}, err
	}
	if err := startChild(cmd); err != nil {
		return agentEventsReadResult{}, errMsg("start " + bin + " transcript: " + err.Error())
	}
	res := agentEventsReadResult{Lines: []string{}, Size: size}
	var total int64
	br := bufio.NewReaderSize(out, 64*1024)
	var readErr error
	for {
		b, err := br.ReadBytes('\n')
		if b = bytes.TrimRight(b, "\r\n"); len(b) > 0 {
			if total += int64(len(b)); total > maxAgentReadBytes {
				readErr = fmt.Errorf("window over %d bytes of events; narrow it with until or tail", maxAgentReadBytes)
				cancel()
				break
			}
			res.Lines = append(res.Lines, string(b))
		}
		if err != nil {
			break
		}
	}
	io.Copy(io.Discard, out)
	werr := cmd.Wait()
	childExited(cmd)
	if readErr != nil {
		return agentEventsReadResult{}, readErr
	}
	if werr != nil {
		msg := strings.TrimSpace(stderr.String())
		return agentEventsReadResult{}, errMsg(bin + " " + strings.Join(args, " ") + ": " + orEmpty(msg, msg != "") + orEmpty(werr.Error(), msg == ""))
	}
	return res, nil
}

// tailFrom answers "the last ~n bytes" of a transcript's first `size` bytes (its size, or
// a read's until) as the --from to pass: the window starts at the first line start at or after size-n that begins a
// complete line (or, when none does, at the last complete line), and since --from
// resumes AFTER the line starting at its offset, the answer is the start of the line
// before the window. -1 = read from the start (the window starts at byte 0, or the file
// is no bigger than n).
func tailFrom(r io.ReaderAt, size, n int64) (int64, error) {
	if n <= 0 {
		return 0, errMsg("tail must be a positive byte count")
	}
	if n >= size {
		return -1, nil
	}
	last, err := lastNewlineBefore(r, size)
	if err != nil || last < 0 {
		return -1, err // no complete line at all
	}
	end := last + 1 // complete lines end here
	target := size - n
	w := int64(-1)
	if target < end {
		nl, err := firstNewlineFrom(r, target-1, end)
		if err != nil {
			return 0, err
		}
		if nl >= 0 && nl+1 < end {
			w = nl + 1
		}
	}
	if w < 0 { // no complete line starts in the window: the last complete line
		prev, err := lastNewlineBefore(r, last)
		if err != nil {
			return 0, err
		}
		w = prev + 1
	}
	if w == 0 {
		return -1, nil
	}
	prev, err := lastNewlineBefore(r, w-1)
	if err != nil {
		return 0, err
	}
	return prev + 1, nil
}

const newlineScanChunk = 64 * 1024

// lastNewlineBefore is the offset of the last '\n' before p, or -1.
func lastNewlineBefore(r io.ReaderAt, p int64) (int64, error) {
	buf := make([]byte, newlineScanChunk)
	for hi := p; hi > 0; {
		lo := max(0, hi-newlineScanChunk)
		b := buf[:hi-lo]
		if _, err := r.ReadAt(b, lo); err != nil && err != io.EOF {
			return 0, err
		}
		if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
			return lo + int64(i), nil
		}
		hi = lo
	}
	return -1, nil
}

// firstNewlineFrom is the offset of the first '\n' in [p, end), or -1.
func firstNewlineFrom(r io.ReaderAt, p, end int64) (int64, error) {
	buf := make([]byte, newlineScanChunk)
	for lo := max(p, 0); lo < end; lo += newlineScanChunk {
		b := buf[:min(end-lo, newlineScanChunk)]
		if _, err := r.ReadAt(b, lo); err != nil && err != io.EOF {
			return 0, err
		}
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			return lo + int64(i), nil
		}
	}
	return -1, nil
}

// ---- RPC handlers ----

func (h *FSHandler) agentEventsOff(write writeFn, id json.RawMessage) bool {
	if h.agents == nil {
		h.sendRPCError(write, id, -32000, "gomuxai disabled (--no-gomuxai): no agent sessions or events", nil)
		return true
	}
	return false
}

func (h *FSHandler) handleAgentSessionsList(write writeFn, id json.RawMessage, _ json.RawMessage) {
	if h.agentEventsOff(write, id) {
		return
	}
	s, err := h.agents.List(context.Background())
	if err != nil {
		h.sendRPCError(write, id, -32000, err.Error(), nil)
		return
	}
	h.sendRPCResult(write, id, s)
}

type agentEventsFollowParams struct {
	Session string `json:"session"`
	From    *int64 `json:"from"`
}

func (h *FSHandler) handleAgentEventsFollow(write writeFn, id json.RawMessage, raw json.RawMessage, display uint64) {
	if h.agentEventsOff(write, id) {
		return
	}
	var p agentEventsFollowParams
	if err := json.Unmarshal(raw, &p); err != nil || p.Session == "" {
		h.sendRPCError(write, id, -32602, "invalid params: want {session, from?}", nil)
		return
	}
	from := int64(-1)
	if p.From != nil {
		if *p.From < 0 {
			h.sendRPCError(write, id, -32602, "from must be a byte offset ≥ 0 (omit it to follow from the start)", nil)
			return
		}
		from = *p.From
	}
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	if err := h.agents.Follow(ctx, display, p.Session, from); err != nil {
		h.sendRPCError(write, id, -32000, err.Error(), map[string]string{"session": p.Session})
		return
	}
	h.sendRPCResult(write, id, map[string]bool{"ok": true})
}

func (h *FSHandler) handleAgentEventsUnfollow(write writeFn, id json.RawMessage, raw json.RawMessage, display uint64) {
	if h.agentEventsOff(write, id) {
		return
	}
	var p struct {
		Session string `json:"session"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.Session == "" {
		h.sendRPCError(write, id, -32602, "invalid params: want {session}", nil)
		return
	}
	h.agents.Unfollow(display, p.Session)
	h.sendRPCResult(write, id, map[string]bool{"ok": true})
}

func (h *FSHandler) handleAgentEventsRead(write writeFn, id json.RawMessage, raw json.RawMessage) {
	if h.agentEventsOff(write, id) {
		return
	}
	var p agentEventsReadParams
	if err := json.Unmarshal(raw, &p); err != nil || p.Session == "" {
		h.sendRPCError(write, id, -32602, "invalid params: want {session, from?, until?, tail?}", nil)
		return
	}
	switch {
	case p.Tail != nil && p.From != nil:
		h.sendRPCError(write, id, -32602, "tail and from both given: a tail picks its own from (tail with until reads the last bytes before until)", nil)
		return
	case p.Tail != nil && *p.Tail <= 0:
		h.sendRPCError(write, id, -32602, "tail must be a positive byte count", nil)
		return
	case p.From != nil && *p.From < 0, p.Until != nil && *p.Until < 0:
		h.sendRPCError(write, id, -32602, "from and until are byte offsets ≥ 0 (omit them for the start / the end)", nil)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	res, err := h.agents.Read(ctx, p)
	if err != nil {
		h.sendRPCError(write, id, -32000, err.Error(), map[string]string{"session": p.Session})
		return
	}
	h.sendRPCResult(write, id, res)
}
