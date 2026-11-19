package main

// gomuxai — the agent orchestrator's tree, served to the display.
//
// gomuxai (the `agent` CLI) runs AI coding agents in g3d-termd terminals (namespace `agents`
// by default) and records them in per-binary stores. Its `agent export --json --follow --all`
// is the supported way to watch that: a snapshot line, then one JSON line per change
// (spawned / changed / removed agents, whole-store and whole-host replacements), each
// carrying the whole agent. It reads every store it can find (the binary's own, and
// each live agent-* session's spawning binary's), runs no backend CLI, and logs one
// command-history row per run however long it follows.
//
// The watcher keeps ONE such follower running (restarting it, with a fresh snapshot,
// if it exits), folds its lines into the tree, and pushes `gomux/changed` (the whole
// snapshot — a few KB) to the display whenever the tree it serves moves. Agents are
// keyed host+store+name; the served tree has one node per (host, name) (within a host, a
// live agent beats a departed namesake, then the newest run).
//
// Following the bus (`serve --gomuxai-hosts`, export's --hosts) adds other hosts' agents:
// no store, transcript or screen here, and only what that host could say (an `attached`
// it left out stays out: unknown, not false). The snapshot's `host` names this machine;
// screens (gomux.attach) and reach are this machine's agents only.
//
// RPCs (fs.go dispatch):
//   gomux/list  {}  → snapshot
// An agent's events come from agentEvents/* (agentevents.go), never from here.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// gomuxRestartDelay is how long the watcher waits before restarting an export that
// exited (or before retrying when there's no `agent` yet). A var so tests can shorten it.
var gomuxRestartDelay = 5 * time.Second

// gomuxAgent is one node of the served tree — the display's shape (camelCase), mapped
// from export's agent object. Status fields are gomuxai's REPORTED state (the last hook
// report), not its resolved status: export runs no backend CLI.
type gomuxAgent struct {
	Name      string `json:"name"`
	Host      string `json:"host,omitempty"`
	Parent    string `json:"parent"`              // spawner's name; "" = a person
	Backend   string `json:"backend"`             // claude | agy | aider | custom
	Session   string `json:"session"`             // termd terminal id (agent-<name>)
	Namespace string `json:"namespace,omitempty"` // termd namespace (default "agents" on this host)
	DataDir   string `json:"dataDir"`             // the .gomuxai store that records it
	Cwd       string `json:"cwd,omitempty"`       // spawn cwd
	CreatedAt string `json:"createdAt"`           // RFC3339, UTC
	EndedAt   string `json:"endedAt,omitempty"`   // departed agents: when it was cleaned up
	Run       int64  `json:"run,omitempty"`       // spawn id within its store (two runs of one name)
	Live      bool   `json:"live"`                // not cleaned up
	Attached  *bool  `json:"attached,omitempty"`  // its termd terminal exists right now; absent = its host couldn't say
	Status    string `json:"status,omitempty"`    // idle|processing|waiting|error|ended|unknown (agent statuses)
	EndReason string `json:"endReason,omitempty"` // with ended: quit|gone|replaced|finished|parent|closed
	Event     string `json:"event,omitempty"`     // last hook event (PostToolUse, Stop, …)
	Detail    string `json:"detail,omitempty"`    // e.g. "Bash: rg foo"
	Tool      string `json:"tool,omitempty"`      // tool in flight
	ToolInput string `json:"toolInput,omitempty"` // a pending permission prompt's full call
	StatusAt  string `json:"statusAt,omitempty"`  // when the status was reported
	SessionID string `json:"sessionId,omitempty"`
	// Transcript is the harness's own record of the run (newest known path).
	Transcript      string `json:"transcript,omitempty"`
	Harness         string `json:"harness,omitempty"` // which dialect reads Transcript: claude | agy
	TranscriptSize  int64  `json:"transcriptSize,omitempty"`
	TranscriptMtime int64  `json:"transcriptMtime,omitempty"` // UnixMilli
}

type gomuxSnapshot struct {
	Gen    uint64       `json:"gen"`
	Host   string       `json:"host,omitempty"` // this machine's name on the bus (export's)
	Dirs   []string     `json:"dirs"`
	Agents []gomuxAgent `json:"agents"`
}

// exportAgent is export's agent object (snake_case, gomuxai's convention).
type exportAgent struct {
	Name            string `json:"name"`
	Host            string `json:"host"`
	Kind            string `json:"kind"`
	Run             int64  `json:"run"`
	Parent          string `json:"parent"`
	Backend         string `json:"backend"`
	Session         string `json:"session"`
	Namespace       string `json:"namespace,omitempty"`
	Store           string `json:"store"`
	Cwd             string `json:"cwd"`
	CreatedAt       string `json:"created_at"`
	EndedAt         string `json:"ended_at"`
	Live            bool   `json:"live"`
	Attached        *bool  `json:"attached,omitempty"` // nil: a far host couldn't say
	Status          string `json:"status"`
	EndReason       string `json:"end_reason"`
	Event           string `json:"event"`
	Detail          string `json:"detail"`
	Tool            string `json:"tool"`
	ToolInput       string `json:"tool_input"`
	StatusAt        string `json:"status_at"`
	SessionID       string `json:"session_id"`
	Transcript      string `json:"transcript"`
	Dialect         string `json:"dialect"`
	TranscriptSize  int64  `json:"transcript_size"`
	TranscriptMtime string `json:"transcript_mtime"`
}

type exportStore struct {
	Dir string `json:"dir"`
}

type exportHost struct {
	Host string `json:"host"`
}

// exportLine is any line export --follow prints; Type says which fields are set.
type exportLine struct {
	Type   string        `json:"type"` // snapshot | spawned | changed | removed | store | host | unrecorded
	Host   any           `json:"host"` // snapshot: this host's name; host line: an exportHost
	Stores []exportStore `json:"stores"`
	Store  any           `json:"store"` // event lines: the store dir; store line: an exportStore
	Agents []exportAgent `json:"agents"`
	Agent  *exportAgent  `json:"agent"`
}

// GomuxWatcher follows `agent export` and serves the tree.
type GomuxWatcher struct {
	mu      sync.Mutex
	agents  map[string]exportAgent // by host|store|name
	stores  []string
	host    string // this machine's name on the bus (export's snapshot line)
	snap    gomuxSnapshot
	notify  func(method string, params any)
	reach   func(dir string) // widens the file handler's reach to an agent's cwd
	reached map[string]bool
	stores0 []string // operator-supplied stores (--gomuxai), passed as --store
	hosts   string   // other hosts to follow over the bus (--gomuxai-hosts: all | h1,h2), passed as --hosts; "" = this one only
	agent   string   // the `agent` binary export runs from ("" = look it up on PATH)
}

// NewGomuxWatcher builds a watcher whose export also reads `dirs` (each a .gomuxai dir,
// the dir holding one, or an agent binary — export's --store) and lists `hosts`' agents
// over the bus ("all", or host,host — export's --hosts; "" for none). No I/O until Start.
func NewGomuxWatcher(dirs []string, hosts string) *GomuxWatcher {
	return &GomuxWatcher{
		agents:  map[string]exportAgent{},
		reached: map[string]bool{},
		stores0: dirs,
		hosts:   hosts,
	}
}

// SetReachHook wires the file handler's reach: each agent's spawn cwd is handed
// over once, so its book's file snapshots can load.
func (w *GomuxWatcher) SetReachHook(fn func(dir string)) { w.reach = fn }

// SetNotifyHook wires the display push channel (gomux/changed).
func (w *GomuxWatcher) SetNotifyHook(fn func(method string, params any)) { w.notify = fn }

// Start keeps one export follower running until ctx ends.
func (w *GomuxWatcher) Start(ctx context.Context) {
	go func() {
		for ctx.Err() == nil {
			if err := w.follow(ctx); err != nil && ctx.Err() == nil {
				log.Printf("[gomux] %v — retrying in %s", err, gomuxRestartDelay)
			}
			select {
			case <-ctx.Done():
			case <-time.After(gomuxRestartDelay):
			}
		}
	}()
}

// follow runs one `agent export --json --follow --all [--hosts …]` and folds its lines in
// until it exits. A restart begins with a fresh snapshot, which replaces the whole tree.
func (w *GomuxWatcher) follow(ctx context.Context) error {
	bin := w.agent
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("agent"); err != nil {
			return errMsg("no gomuxai `agent` on PATH")
		}
	}
	args := []string{"export", "--json", "--follow", "--all", "-q"}
	for _, d := range w.stores0 {
		args = append(args, "--store", d)
	}
	if w.hosts != "" {
		args = append(args, "--hosts", w.hosts)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := startChild(cmd); err != nil {
		return errMsg("start " + bin + " export: " + err.Error())
	}
	defer childExited(cmd)
	log.Printf("[gomux] following %s %s", bin, strings.Join(args, " "))
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for sc.Scan() {
		if err := w.applyLine(sc.Bytes()); err != nil {
			log.Printf("[gomux] export line: %v", err)
		}
	}
	err = cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	msg := strings.TrimSpace(stderr.String())
	if err != nil {
		return errMsg(bin + " export exited: " + err.Error() + orEmpty(" — "+msg, msg != ""))
	}
	return errMsg(bin + " export ended" + orEmpty(" — "+msg, msg != ""))
}

// applyLine folds one export line into the tree and pushes the tree if it moved.
func (w *GomuxWatcher) applyLine(raw []byte) error {
	var l exportLine
	if err := json.Unmarshal(raw, &l); err != nil {
		return err
	}
	w.mu.Lock()
	switch l.Type {
	case "snapshot":
		w.agents = map[string]exportAgent{}
		w.host, _ = l.Host.(string)
		w.stores = w.stores[:0]
		for _, s := range l.Stores {
			w.stores = append(w.stores, s.Dir)
		}
		for _, a := range l.Agents {
			w.agents[exportKey(a)] = a
		}
	case "spawned", "changed", "removed":
		if l.Agent != nil {
			w.agents[exportKey(*l.Agent)] = *l.Agent
		}
	case "store":
		var st exportStore
		if b, err := json.Marshal(l.Store); err == nil {
			json.Unmarshal(b, &st)
		}
		for k, a := range w.agents {
			if a.Store == st.Dir {
				delete(w.agents, k)
			}
		}
		for _, a := range l.Agents {
			w.agents[exportKey(a)] = a
		}
		if st.Dir != "" && !containsString(w.stores, st.Dir) {
			w.stores = append(w.stores, st.Dir)
		}
	case "host":
		var h exportHost
		if b, err := json.Marshal(l.Host); err == nil {
			json.Unmarshal(b, &h)
		}
		for k, a := range w.agents {
			if a.Host == h.Host && a.Store == "" {
				delete(w.agents, k)
			}
		}
		for _, a := range l.Agents {
			w.agents[exportKey(a)] = a
		}
	case "unrecorded":
		// agent-* sessions no store records — nothing to draw
	default:
		w.mu.Unlock()
		return errMsg("unknown line type " + strconv.Quote(l.Type))
	}
	w.mu.Unlock()
	w.publish()
	return nil
}

func exportKey(a exportAgent) string { return a.Host + "|" + a.Store + "|" + a.Name }

// publish rebuilds the served tree (one node per (host, name)) and pushes it when it moved.
func (w *GomuxWatcher) publish() {
	w.mu.Lock()
	byHostName := map[string]exportAgent{}
	for _, a := range w.agents {
		k := a.Host + "|" + a.Name
		if prev, ok := byHostName[k]; ok && !exportPrefer(a, prev) {
			continue
		}
		byHostName[k] = a
	}
	dirs := append([]string{}, w.stores...)
	host := w.host
	w.mu.Unlock()

	agents := make([]gomuxAgent, 0, len(byHostName))
	for _, a := range byHostName {
		agents = append(agents, w.toNode(a, host))
	}
	sort.Slice(agents, func(i, j int) bool {
		ti, tj := parseTime(agents[i].CreatedAt), parseTime(agents[j].CreatedAt)
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		if agents[i].Name != agents[j].Name {
			return agents[i].Name < agents[j].Name
		}
		return agents[i].Host < agents[j].Host
	})
	sort.Strings(dirs)

	if w.reach != nil {
		for _, a := range agents {
			// another host's cwd names a path THERE: never widen this machine's reach by it
			if a.Host == host && a.Cwd != "" && !w.reached[a.Cwd] {
				w.reached[a.Cwd] = true
				w.reach(a.Cwd)
			}
		}
	}

	w.mu.Lock()
	changed := host != w.snap.Host || !reflect.DeepEqual(agents, w.snap.Agents) || !reflect.DeepEqual(dirs, w.snap.Dirs)
	if changed {
		w.snap = gomuxSnapshot{Gen: w.snap.Gen + 1, Host: host, Dirs: dirs, Agents: agents}
	}
	snap := w.snap
	w.mu.Unlock()
	if changed && w.notify != nil {
		w.notify("gomux/changed", snap)
	}
}

// exportPrefer: should a replace b for the same host and name? A live agent beats a departed
// namesake, then the newer run.
func exportPrefer(a, b exportAgent) bool {
	if a.Live != b.Live {
		return a.Live
	}
	return parseTime(a.CreatedAt).After(parseTime(b.CreatedAt))
}

// toNode maps export's agent to the display's node.
func (w *GomuxWatcher) toNode(a exportAgent, host string) gomuxAgent {
	ns := a.Namespace
	if ns == "" && (a.Host == "" || (host != "" && a.Host == host)) {
		ns = "agents"
	}
	n := gomuxAgent{
		Name: a.Name, Host: a.Host, Parent: a.Parent, Backend: a.Backend, Session: a.Session,
		Namespace: ns,
		DataDir:   a.Store, Cwd: a.Cwd, CreatedAt: a.CreatedAt, EndedAt: a.EndedAt, Run: a.Run,
		Live: a.Live, Attached: a.Attached, Status: a.Status, EndReason: a.EndReason, Event: a.Event, Detail: a.Detail,
		Tool: a.Tool, ToolInput: a.ToolInput, StatusAt: a.StatusAt, SessionID: a.SessionID,
		Transcript: a.Transcript, Harness: a.Dialect, TranscriptSize: a.TranscriptSize,
	}
	if !a.Live && n.Status == "" {
		// gomuxai's export says ended (closed) for a departed agent; one from a store
		// that predates it says nothing.
		n.Status, n.EndReason = "ended", "closed"
	}
	if t := parseTime(a.TranscriptMtime); !t.IsZero() {
		n.TranscriptMtime = t.UnixMilli()
	}
	// Claude names a transcript by its session id (<projects>/<cwd-slug>/<uuid>.jsonl);
	// export's session_id stays empty until gomuxai's hooks report one. The display
	// joins an agent to its `agent sessions` entry (and its agentEvents follow) by it.
	if n.SessionID == "" && n.Harness == "claude" && n.Transcript != "" {
		n.SessionID = strings.TrimSuffix(filepath.Base(n.Transcript), ".jsonl")
	}
	return n
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func orEmpty(s string, keep bool) string {
	if keep {
		return s
	}
	return ""
}

type errMsg string

func (e errMsg) Error() string { return string(e) }

// limitedWriter keeps the first n bytes written (an exited export's stderr, for the log).
type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

// localAgent returns the served node for an agent on THIS machine — the only ones a screen
// can attach to directly over this machine's termd socket — never a far namesake.
func (w *GomuxWatcher) localAgent(name string) (gomuxAgent, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, a := range w.snap.Agents {
		if a.Name == name && a.Host == w.snap.Host {
			return a, true
		}
	}
	return gomuxAgent{}, false
}

// hasSession: the agent's host said its termd terminal exists. Unknown (nil) is not a session
// to act on.
func (a gomuxAgent) hasSession() bool { return a.Attached != nil && *a.Attached }

// Snapshot returns the current tree.
func (w *GomuxWatcher) Snapshot() gomuxSnapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.snap
}

// ---- RPC handlers ----

func (h *FSHandler) handleGomuxList(write writeFn, id json.RawMessage, _ json.RawMessage) {
	if h.gomux == nil {
		h.sendRPCError(write, id, -32000, "gomuxai watcher not running", nil)
		return
	}
	h.sendRPCResult(write, id, h.gomux.Snapshot())
}

// ---- the agent's live screen ----

// gomuxTerminalID is the terminal an agent's screen shows in: `gx-<name>` (a termd id: at most
// 64 bytes of [A-Za-z0-9._-]), so it never collides with a spawned term-N.
func gomuxTerminalID(name string) string { return "gx-" + terminalIDPart(name, 61) }

// attachGomuxAgent forks a `glyph3d-cli attach` adapter that subscribes directly to the agent's
// native termd terminal (`--termd-ns <ns> --termd-id <agent.Session> --no-create --detach-on-kill
// --flow lossy`) under display id `gx-<name>`. Because it subscribes as `role: "own"` with lossy
// flow control, both Wall and IDE screens get native resize, scrollback, keys, and paste without
// PTY-in-PTY nesting, stalling the agent's output, or killing the agent when the viewer closes.
func (r *Relay) attachGomuxAgent(send func(any), name string) {
	reply := func(err string) { send(map[string]any{"event": "gomux.attaching", "name": name, "error": err}) }
	if r.fs == nil || r.fs.gomux == nil {
		reply("gomuxai watcher not running")
		return
	}
	agent, ok := r.fs.gomux.localAgent(name)
	if !ok {
		reply("no gomuxai agent named " + name + " on this machine")
		return
	}
	if !agent.hasSession() || agent.Session == "" {
		reply("agent " + name + " has no termd session (" + agent.Session + ")")
		return
	}
	ns := agent.Namespace
	if ns == "" {
		ns = "agents"
	}
	if !validTerminalID(ns) {
		reply(fmt.Sprintf("invalid termd namespace %q", ns))
		return
	}
	if !validTerminalID(agent.Session) {
		reply(fmt.Sprintf("invalid termd session id %q", agent.Session))
		return
	}
	id := gomuxTerminalID(name)
	terms, err := termdList(ns)
	if err != nil {
		r.clearGomuxForked(id)
		log.Printf("[gomux] %s: %v", name, err)
		reply(err.Error())
		return
	}
	var term *termdTerminal
	for i := range terms {
		if terms[i].ID == agent.Session {
			term = &terms[i]
			break
		}
	}
	if term == nil {
		r.clearGomuxForked(id)
		reply(fmt.Sprintf("no terminal %q in termd namespace %q", agent.Session, ns))
		return
	}
	cols, rows := term.Cols, term.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	// ONE adapter per screen on this relay. A display reload asks for every screen again before
	// existing adapters re-adopt their grids; a second adapter would fight the first over size
	// ownership. If this relay already has a running adapter (or one being forked right now),
	// answer with its id and current size so the existing adapter re-creates the grid itself.
	if r.gomuxScreenLive(id) {
		send(map[string]any{"event": "gomux.attaching", "name": name, "id": id, "cols": cols, "rows": rows, "existing": true})
		return
	}
	spec := adapterSpec{
		id:           id,
		termdNS:      ns,
		termdID:      agent.Session,
		noCreate:     true,
		detachOnKill: true,
		flow:         "lossy",
	}
	pid, err := r.startAdapterSpec(spec, cols, rows)
	r.clearGomuxForked(id) // r.adapters[id] now tracks the live child (or start failed)
	if err != nil {
		reply("spawn failed: " + err.Error())
		return
	}
	log.Printf("[gomux] %s: screen as terminal '%s' → %s/%s (pid %d, %dx%d)", name, id, ns, agent.Session, pid, cols, rows)
	send(map[string]any{"event": "gomux.attaching", "name": name, "id": id, "cols": cols, "rows": rows})
}

// gomuxScreenLive reports whether this relay already has a running (or in-flight) adapter for id,
// and otherwise claims the fork slot for the caller about to spawn one.
func (r *Relay) gomuxScreenLive(id string) bool {
	r.gxMu.Lock()
	defer r.gxMu.Unlock()
	r.readoptMu.Lock()
	live := r.adapters[id] > 0
	r.readoptMu.Unlock()
	if live {
		return true
	}
	if r.gxForked == nil {
		r.gxForked = map[string]time.Time{}
	}
	if t, ok := r.gxForked[id]; ok && time.Since(t) < 15*time.Second {
		return true
	}
	r.gxForked[id] = time.Now()
	return false
}

func (r *Relay) clearGomuxForked(id string) {
	r.gxMu.Lock()
	delete(r.gxForked, id)
	r.gxMu.Unlock()
}
