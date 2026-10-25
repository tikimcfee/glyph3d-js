package main

import (
	"bytes"
	"context"
	"encoding/json"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeAgent is an `agent` script: `sessions --json` prints $D/sessions.json (or fails
// while $D/sessions.fail exists); `transcript` without --follow prints its args as one
// JSON line; `transcript <path> --follow` behaves by the path's base name <s>:
//
//	dies   prints a line, says why on stderr, exits 4
//	burst  prints 2000 numbered lines, then idles
//	long   prints a short line, a 10 KB line, a short line, then idles
//	other  writes its pid to $D/<s>.pid and streams $D/<s>.out (tail -f) forever
//
// Every run appends "<args>" to $D/calls.
const fakeAgentScript = `#!/bin/sh
D="$(dirname "$0")"
echo "$*" >> "$D/calls"
cmd=$1; shift
case "$cmd" in
sessions)
  [ -f "$D/sessions.fail" ] && { echo "sessions broke" >&2; exit 2; }
  cat "$D/sessions.json"; exit 0 ;;
transcript)
  t=$1; s=$(basename "$t" .jsonl); shift
  follow=0
  for a in "$@"; do [ "$a" = --follow ] && follow=1; done
  if [ $follow = 0 ]; then printf '{"args":"%s"}\n' "$t $*"; exit 0; fi
  echo $$ > "$D/$s.pid"
  case "$s" in
  dies) echo '{"l":1}'; echo "transcript replaced" >&2; exit 4 ;;
  burst)
    i=0
    while [ $i -lt 2000 ]; do printf '{"i":%d,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n' $i; i=$((i+1)); done
    exec sleep 600 ;;
  long)
    echo '{"a":1}'
    printf '{"big":"%s"}\n' "$(head -c 10240 /dev/zero | tr '\0' 'y')"
    echo '{"b":2}'
    exec sleep 600 ;;
  *) touch "$D/$s.out"; exec tail -n +1 -f "$D/$s.out" ;;
  esac ;;
esac
exit 3
`

type pushRec struct {
	wait    time.Duration
	display uint64
	method  string
	session string
	lines   []string
	code    int
	err     string
}

// pushSink records pushes; stall makes every lines push report errDisplayStalled.
type pushSink struct {
	mu    sync.Mutex
	recs  []pushRec
	stall bool
}

func (s *pushSink) push(display uint64, method string, params any, wait time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := pushRec{display: display, method: method, wait: wait}
	switch p := params.(type) {
	case agentEventsLines:
		r.session, r.lines = p.Session, append([]string{}, p.Lines...)
		if s.stall {
			return errDisplayStalled
		}
	case agentEventsEnded:
		r.session, r.code, r.err = p.Session, p.Code, p.Error
	}
	s.recs = append(s.recs, r)
	return nil
}

func (s *pushSink) snapshot() []pushRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]pushRec{}, s.recs...)
}

// lines is every line pushed to a display for a session, in push order.
func (s *pushSink) lines(display uint64, session string) []string {
	var out []string
	for _, r := range s.snapshot() {
		if r.display == display && r.session == session && r.method == "agentEvents/lines" {
			out = append(out, r.lines...)
		}
	}
	return out
}

func (s *pushSink) ended(session string) []pushRec {
	var out []pushRec
	for _, r := range s.snapshot() {
		if r.session == session && r.method == "agentEvents/ended" {
			out = append(out, r)
		}
	}
	return out
}

type agentFixture struct {
	dir  string
	a    *AgentEvents
	sink *pushSink
	mu   sync.Mutex
	logs []string
}

func newAgentFixture(t *testing.T) *agentFixture {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent"), []byte(fakeAgentScript), 0o755); err != nil {
		t.Fatal(err)
	}
	f := &agentFixture{dir: dir, sink: &pushSink{}}
	var listed []map[string]any // the sessions the follow tests name, at $D/<s>.jsonl
	for _, s := range []string{"s", "a", "b", "c", "burst", "long", "dies"} {
		listed = append(listed, map[string]any{"session_id": s, "path": filepath.Join(dir, s+".jsonl")})
	}
	f.setSessions(t, listed...)
	f.a = NewAgentEvents(time.Hour, 64)
	f.a.bin = filepath.Join(dir, "agent")
	f.a.push = f.sink.push
	f.a.logLine = func(session, line string) {
		f.mu.Lock()
		f.logs = append(f.logs, session+": "+line)
		f.mu.Unlock()
	}
	t.Cleanup(func() {
		f.a.mu.Lock()
		for _, fl := range f.a.followers {
			f.a.stopLocked(fl)
		}
		if f.a.pollStop != nil {
			f.a.pollStop()
		}
		f.a.mu.Unlock()
	})
	return f
}

func (f *agentFixture) appendLines(t *testing.T, session string, lines ...string) {
	t.Helper()
	fh, err := os.OpenFile(filepath.Join(f.dir, session+".out"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	for _, l := range lines {
		fh.WriteString(l + "\n")
	}
}

// followCalls counts `transcript <session> --follow` runs.
func (f *agentFixture) followCalls(session string) int {
	b, _ := os.ReadFile(filepath.Join(f.dir, "calls"))
	n := 0
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "transcript "+filepath.Join(f.dir, session+".jsonl")+" ") && strings.Contains(l, "--follow") {
			n++
		}
	}
	return n
}

// pidOf waits for a follower's pid file.
func (f *agentFixture) pidOf(t *testing.T, session string) int {
	t.Helper()
	var pid int
	waitFor(t, "pid of "+session, func() bool {
		b, err := os.ReadFile(filepath.Join(f.dir, session+".pid"))
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil
	})
	return pid
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (f *agentFixture) followerCount() int {
	f.a.mu.Lock()
	defer f.a.mu.Unlock()
	return len(f.a.followers)
}

func TestAgentEvents_FollowIsSharedAndRefcounted(t *testing.T) {
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	f.a.DisplayConnected(2)
	for _, d := range []uint64{1, 2, 1} {
		if err := f.a.Follow(bg, d, "s", -1); err != nil {
			t.Fatalf("follow from display %d: %v", d, err)
		}
	}
	pid := f.pidOf(t, "s")
	if n := f.followerCount(); n != 1 {
		t.Fatalf("two displays (one asking twice) share one follower; have %d", n)
	}
	f.appendLines(t, "s", `{"n":1}`, `{"n":2}`)
	waitFor(t, "both displays get the lines", func() bool {
		return len(f.sink.lines(1, "s")) == 2 && len(f.sink.lines(2, "s")) == 2
	})

	f.a.Unfollow(1, "s")
	if !alive(pid) {
		t.Fatal("the follower stops only when its last subscriber goes")
	}
	f.appendLines(t, "s", `{"n":3}`)
	waitFor(t, "display 2 alone gets the next line", func() bool { return len(f.sink.lines(2, "s")) == 3 })
	time.Sleep(3 * agentEventsBatchWait)
	if got := f.sink.lines(1, "s"); len(got) != 2 {
		t.Errorf("an unfollowed display gets nothing more: %v", got)
	}

	f.a.Unfollow(2, "s")
	waitFor(t, "the follower killed", func() bool { return !alive(pid) })
	if n := f.followerCount(); n != 0 {
		t.Errorf("no followers left, have %d", n)
	}
	time.Sleep(3 * agentEventsBatchWait)
	if e := f.sink.ended("s"); len(e) != 0 {
		t.Errorf("an unfollowed stream sends no ended: %+v", e)
	}
	if n := f.followCalls("s"); n != 1 {
		t.Errorf("one `agent transcript --follow` ran, saw %d", n)
	}
	f.a.Unfollow(2, "s") // nothing held: fine
}

func TestAgentEvents_DisplayGoneDropsItsSubscriptions(t *testing.T) {
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	f.a.DisplayConnected(2)
	f.a.Follow(bg, 1, "a", -1)
	f.a.Follow(bg, 1, "b", -1)
	f.a.Follow(bg, 2, "b", -1)
	pa, pb := f.pidOf(t, "a"), f.pidOf(t, "b")
	f.a.DisplayGone(1)
	waitFor(t, "a's follower killed", func() bool { return !alive(pa) })
	if !alive(pb) {
		t.Fatal("b is still held by display 2")
	}
	f.a.DisplayGone(2)
	waitFor(t, "b's follower killed", func() bool { return !alive(pb) })
	if err := f.a.Follow(bg, 1, "a", -1); err == nil {
		t.Error("a follow from a display that left must fail")
	}
}

func TestAgentEvents_FollowFromAnotherByteSwaps(t *testing.T) {
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	f.a.Follow(bg, 1, "s", -1)
	first := f.pidOf(t, "s")
	os.Remove(filepath.Join(f.dir, "s.pid"))
	if err := f.a.Follow(bg, 1, "s", 120); err != nil {
		t.Fatal(err)
	}
	second := f.pidOf(t, "s")
	waitFor(t, "the old follower killed", func() bool { return !alive(first) })
	if !alive(second) || f.followerCount() != 1 {
		t.Fatalf("one follower, from 120: alive=%v count=%d", alive(second), f.followerCount())
	}
	b, _ := os.ReadFile(filepath.Join(f.dir, "calls"))
	if !strings.Contains(string(b), "transcript "+filepath.Join(f.dir, "s.jsonl")+" --follow -q --from 120") {
		t.Errorf("the follower resumes --from 120:\n%s", b)
	}
}

func TestAgentEvents_BatchesInOrderAndNeverSplitsALine(t *testing.T) {
	saved := agentEventsBatchBytes
	agentEventsBatchBytes = 4096
	defer func() { agentEventsBatchBytes = saved }()
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	f.a.Follow(bg, 1, "burst", -1)
	waitFor(t, "2000 lines", func() bool { return len(f.sink.lines(1, "burst")) >= 2000 })
	got := f.sink.lines(1, "burst")
	if len(got) != 2000 {
		t.Fatalf("got %d lines, want 2000", len(got))
	}
	for i, l := range got {
		var v struct{ I int }
		if err := json.Unmarshal([]byte(l), &v); err != nil || v.I != i {
			t.Fatalf("line %d = %q (whole JSON, in order)", i, l)
		}
	}
	pushes := 0
	for _, r := range f.sink.snapshot() {
		if r.method != "agentEvents/lines" {
			continue
		}
		pushes++
		size := 0
		for _, l := range r.lines {
			size += len(l)
		}
		if size > 4096 {
			t.Errorf("a push of %d bytes over the 4096 cap (%d lines)", size, len(r.lines))
		}
	}
	if pushes < 2000*60/4096 {
		t.Errorf("only %d pushes for ~120 KB at 4 KB a push", pushes)
	}

	// a line longer than the cap goes alone, whole, between its neighbours
	f.a.Follow(bg, 1, "long", -1)
	waitFor(t, "the long line's batch", func() bool { return len(f.sink.lines(1, "long")) == 3 })
	var batches [][]string
	for _, r := range f.sink.snapshot() {
		if r.method == "agentEvents/lines" && r.session == "long" {
			batches = append(batches, r.lines)
		}
	}
	all := f.sink.lines(1, "long")
	if all[0] != `{"a":1}` || len(all[1]) != 10240+10 || all[2] != `{"b":2}` {
		t.Errorf("long: %q… (%d bytes) …", all[0], len(all[1]))
	}
	for _, b := range batches {
		for _, l := range b {
			if len(l) > 4096 && len(b) != 1 {
				t.Errorf("the 10 KB line shared a push: %d lines", len(b))
			}
		}
	}
}

func TestAgentEvents_FollowerCap(t *testing.T) {
	f := newAgentFixture(t)
	f.a.maxFollowers = 2
	f.a.DisplayConnected(1)
	f.a.DisplayConnected(2)
	if err := f.a.Follow(bg, 1, "a", -1); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Follow(bg, 1, "b", -1); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Follow(bg, 2, "a", -1); err != nil {
		t.Errorf("sharing a follower isn't a new one: %v", err)
	}
	err := f.a.Follow(bg, 1, "c", -1)
	if err == nil || !strings.Contains(err.Error(), "cap") || !strings.Contains(err.Error(), "c") {
		t.Fatalf("a third follower must fail loud, got %v", err)
	}
	f.a.Unfollow(1, "b")
	if err := f.a.Follow(bg, 1, "c", -1); err != nil {
		t.Errorf("room again after an unfollow: %v", err)
	}
}

func TestAgentEvents_EndedWhenTheFollowerExits(t *testing.T) {
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	f.a.Follow(bg, 1, "dies", -1)
	waitFor(t, "ended", func() bool { return len(f.sink.ended("dies")) == 1 })
	recs := f.sink.snapshot()
	if recs[0].method != "agentEvents/lines" || recs[0].lines[0] != `{"l":1}` {
		t.Errorf("its lines come first: %+v", recs)
	}
	e := f.sink.ended("dies")[0]
	if e.code != 4 || e.err != "transcript replaced" || e.display != 1 {
		t.Errorf("ended = %+v (exit code + stderr)", e)
	}
	f.mu.Lock()
	logged := strings.Join(f.logs, "\n")
	f.mu.Unlock()
	if !strings.Contains(logged, "dies.jsonl: transcript replaced") {
		t.Errorf("stderr goes to the relay log: %q", logged)
	}
	if f.followerCount() != 0 {
		t.Error("an exited follower is gone")
	}
	os.Remove(filepath.Join(f.dir, "dies.pid"))
	if err := f.a.Follow(bg, 1, "dies", -1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a re-follow runs a new process", func() bool { return f.followCalls("dies") == 2 })
}

func TestAgentEvents_StalledDisplayIsDroppedNotBuffered(t *testing.T) {
	f := newAgentFixture(t)
	f.sink.stall = true
	f.a.DisplayConnected(1)
	f.a.Follow(bg, 1, "s", -1)
	pid := f.pidOf(t, "s")
	f.appendLines(t, "s", `{"n":1}`)
	waitFor(t, "ended for the stalled display", func() bool { return len(f.sink.ended("s")) == 1 })
	if e := f.sink.ended("s")[0]; e.code != -1 || !strings.Contains(e.err, "not keeping up") {
		t.Errorf("ended = %+v", e)
	}
	waitFor(t, "the follower killed", func() bool { return !alive(pid) })
	f.a.mu.Lock()
	subs := len(f.a.subs)
	f.a.mu.Unlock()
	if subs != 0 || f.followerCount() != 0 {
		t.Errorf("subscription and follower dropped: subs=%d followers=%d", subs, f.followerCount())
	}
}

// ---- tail ----

// bruteTailFrom is tailFrom's rule written plainly over the whole byte slice.
func bruteTailFrom(b []byte, n int64) int64 {
	size := int64(len(b))
	if n >= size {
		return -1
	}
	var starts []int64 // starts of COMPLETE lines
	s := int64(0)
	for i, c := range b {
		if c == '\n' {
			starts = append(starts, s)
			s = int64(i) + 1
		}
	}
	if len(starts) == 0 {
		return -1
	}
	w := starts[len(starts)-1]
	for _, st := range starts {
		if st >= size-n {
			w = st
			break
		}
	}
	if w == 0 {
		return -1
	}
	for i, st := range starts {
		if st == w {
			return starts[i-1]
		}
	}
	panic("unreachable")
}

func TestTailFrom_LineStartMath(t *testing.T) {
	body := []byte("aaaa\nbbbb\ncccc\n") // lines at 0, 5, 10; size 15
	for _, c := range []struct {
		n, want int64
		why     string
	}{
		{5, 5, "the window is \"cccc\" (starts at 10); --from the line before it"},
		{6, 5, "size-n = 9 is the newline: the first line start at/after it is 10"},
		{7, 5, "8 is mid-line: the window starts at the next line, 10"},
		{11, 0, "size-n = 4: window from 5, --from the line at 0"},
		{14, 0, "size-n = 1: window from 5"},
		{15, -1, "the whole file is the window"},
		{99, -1, "a file smaller than n reads from 0"},
		{1, 5, "no line starts in the last byte: the last complete line, 10"},
	} {
		got, err := tailFrom(bytes.NewReader(body), int64(len(body)), c.n)
		if err != nil || got != c.want {
			t.Errorf("tail %d: got %d (%v), want %d — %s", c.n, got, err, c.want, c.why)
		}
	}
	// a line being written (no newline yet) never starts the window
	part := []byte("aaaa\nbbbb\ncc")
	if got, _ := tailFrom(bytes.NewReader(part), 12, 1); got != 0 {
		t.Errorf("partial last line: got %d, want 0 (the window is bbbb at 5)", got)
	}
	if got, _ := tailFrom(bytes.NewReader([]byte("no newline yet")), 14, 3); got != -1 {
		t.Errorf("no complete line: got %d, want -1", got)
	}
	if _, err := tailFrom(bytes.NewReader(body), 15, 0); err == nil {
		t.Error("tail 0 must fail")
	}

	// against the plain rule, over files that cross the scan chunk
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 300; trial++ {
		var b bytes.Buffer
		for b.Len() < rng.Intn(3*newlineScanChunk) {
			b.WriteString(strings.Repeat("x", rng.Intn(newlineScanChunk/2)+0))
			b.WriteByte('\n')
		}
		if rng.Intn(3) == 0 {
			b.WriteString("partial")
		}
		data := b.Bytes()
		if len(data) == 0 {
			continue
		}
		n := rng.Int63n(int64(len(data))+10) + 1
		got, err := tailFrom(bytes.NewReader(data), int64(len(data)), n)
		if want := bruteTailFrom(data, n); err != nil || got != want {
			t.Fatalf("trial %d (size %d, n %d): got %d (%v), want %d", trial, len(data), n, got, err, want)
		}
	}
}

// ---- reads ----

func (f *agentFixture) setSessions(t *testing.T, sessions ...map[string]any) {
	t.Helper()
	b, _ := json.Marshal(sessions)
	if err := os.WriteFile(filepath.Join(f.dir, "sessions.json"), append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAgentEvents_ReadWindows(t *testing.T) {
	f := newAgentFixture(t)
	tp := filepath.Join(f.dir, "s1.jsonl")
	os.WriteFile(tp, []byte("aaaa\nbbbb\ncccc\n"), 0o644)
	f.setSessions(t, map[string]any{"session_id": "s1", "path": tp}, map[string]any{"session_id": "pending", "path": ""})
	ctx := context.Background()
	read := func(p agentEventsReadParams) (agentEventsReadResult, string, error) {
		r, err := f.a.Read(ctx, p)
		if err != nil {
			return r, "", err
		}
		var v struct{ Args string }
		if len(r.Lines) == 1 {
			json.Unmarshal([]byte(r.Lines[0]), &v)
		}
		return r, v.Args, nil
	}
	i64 := func(v int64) *int64 { return &v }

	r, args, err := read(agentEventsReadParams{Session: "s1", Tail: i64(5)})
	if err != nil || r.Size != 15 || args != tp+" --until 15 -q --from 5" {
		t.Errorf("tail 5: %+v %q %v", r, args, err)
	}
	if _, args, _ = read(agentEventsReadParams{Session: "s1", Tail: i64(50)}); args != tp+" --until 15 -q" {
		t.Errorf("a tail past the size reads from the start: %q", args)
	}
	if _, args, _ = read(agentEventsReadParams{Session: tp, From: i64(5), Until: i64(10)}); args != tp+" --until 10 -q --from 5" {
		t.Errorf("from/until by path: %q", args)
	}
	if _, args, _ = read(agentEventsReadParams{Session: "s1", Until: i64(999)}); args != tp+" --until 15 -q" {
		t.Errorf("until past the size clamps to it: %q", args)
	}
	if _, _, err = read(agentEventsReadParams{Session: "nobody"}); err == nil || !strings.Contains(err.Error(), "nobody") {
		t.Errorf("an unlisted session fails loud: %v", err)
	}
	if _, _, err = read(agentEventsReadParams{Session: "pending"}); err == nil || !strings.Contains(err.Error(), "no transcript") {
		t.Errorf("a session with no transcript fails loud: %v", err)
	}

	// a session that appears after the last list is found by asking again
	tp2 := filepath.Join(f.dir, "s2.jsonl")
	os.WriteFile(tp2, []byte("x\n"), 0o644)
	f.setSessions(t, map[string]any{"session_id": "s1", "path": tp}, map[string]any{"session_id": "s2", "path": tp2})
	if r, _, err := read(agentEventsReadParams{Session: "s2"}); err != nil || r.Size != 2 {
		t.Errorf("new session: %+v %v", r, err)
	}

	// the output cap fails loud instead of answering a huge window
	saved := maxAgentReadBytes
	maxAgentReadBytes = 8
	defer func() { maxAgentReadBytes = saved }()
	if _, _, err := read(agentEventsReadParams{Session: "s1"}); err == nil || !strings.Contains(err.Error(), "narrow") {
		t.Errorf("over the cap: %v", err)
	}
}

func TestAgentEvents_ReadHandlerValidates(t *testing.T) {
	h, _, _ := newTestHandler(t)
	h.agents = newAgentFixture(t).a
	for _, c := range []struct{ params, want string }{
		{`{"session":"s","tail":10,"from":5}`, "tail and from"},
		{`{"session":"s","tail":0}`, "positive"},
		{`{"session":"s","from":-1}`, "≥ 0"},
		{`{"tail":10}`, "invalid params"},
	} {
		write, c2 := captureRPC(t)
		h.handleAgentEventsRead(write, json.RawMessage("1"), json.RawMessage(c.params))
		if c2.Error == nil || !strings.Contains(c2.Error.Message, c.want) {
			t.Errorf("%s: want an error naming %q, got %+v", c.params, c.want, c2)
		}
	}
	h.agents = nil
	write, c := captureRPC(t)
	h.handleAgentEventsFollow(write, json.RawMessage("1"), json.RawMessage(`{"session":"s"}`), 1)
	if c.Error == nil || !strings.Contains(c.Error.Message, "--no-gomuxai") {
		t.Errorf("with gomuxai off the RPCs say so: %+v", c)
	}
}

// ---- the session list ----

func TestAgentEvents_SessionsPollPushesOnlyChanges(t *testing.T) {
	f := newAgentFixture(t)
	f.a.interval = 30 * time.Millisecond
	var mu sync.Mutex
	var pushes []agentSessionsList
	f.a.notify = func(method string, params any) {
		if method == "agentSessions/changed" {
			mu.Lock()
			pushes = append(pushes, params.(agentSessionsList))
			mu.Unlock()
		}
	}
	got := func() []agentSessionsList {
		mu.Lock()
		defer mu.Unlock()
		return append([]agentSessionsList{}, pushes...)
	}
	sessionCalls := func() int {
		b, _ := os.ReadFile(filepath.Join(f.dir, "calls"))
		return strings.Count(string(b), "sessions --json")
	}
	f.setSessions(t, map[string]any{"session_id": "a", "path": "/p/a", "size": 1})

	f.a.DisplayConnected(1)
	waitFor(t, "the first list pushed", func() bool { return len(got()) == 1 })
	waitFor(t, "a few polls", func() bool { return sessionCalls() >= 4 })
	if p := got(); len(p) != 1 || p[0].Gen != 1 || !strings.Contains(string(p[0].Sessions), `"a"`) {
		t.Fatalf("an unchanged list pushes nothing more: %+v", p)
	}
	l, err := f.a.List(context.Background())
	if err != nil || l.Gen != 1 {
		t.Errorf("list = %+v %v", l, err)
	}

	settle := func(what string) {
		n0 := sessionCalls()
		waitFor(t, what, func() bool { return sessionCalls() >= n0+3 })
	}
	// size, mtime and status_at alone ride along: no push, but list() has them
	f.setSessions(t, map[string]any{"session_id": "a", "path": "/p/a", "size": 2, "mtime": "later", "status_at": "later"})
	settle("polls of the grown session")
	if p := got(); len(p) != 1 {
		t.Fatalf("size/mtime/status_at alone pushed: %d pushes", len(p))
	}
	if l, _ := f.a.List(context.Background()); l.Gen != 1 || !strings.Contains(string(l.Sessions), `"size":2`) {
		t.Errorf("list() carries the newest sizes under the last gen: gen %d %s", l.Gen, l.Sessions)
	}
	// a session appearing pushes; the list reordering alone doesn't; it leaving pushes
	b := map[string]any{"session_id": "b", "path": "/p/b"}
	a2 := map[string]any{"session_id": "a", "path": "/p/a", "size": 2, "mtime": "later", "status_at": "later"}
	f.setSessions(t, b, a2)
	waitFor(t, "b's arrival pushed", func() bool { return len(got()) == 2 })
	f.setSessions(t, a2, b)
	settle("polls of the reordered list")
	f.setSessions(t, a2)
	waitFor(t, "b's leaving pushed", func() bool { return len(got()) == 3 })
	settle("quiet polls")
	if p := got(); len(p) != 3 || p[2].Gen != 3 {
		t.Fatalf("arrive + leave push once each, a reorder never: %d pushes", len(p))
	}
	// a field a display shows does push
	f.setSessions(t, map[string]any{"session_id": "a", "path": "/p/a", "size": 2, "status": "processing"})
	waitFor(t, "the status change pushed", func() bool { return len(got()) == 4 })
	if p := got()[3]; p.Gen != 4 || !strings.Contains(string(p.Sessions), `"processing"`) {
		t.Errorf("changed push = %s (gen %d)", p.Sessions, p.Gen)
	}

	// a failing run keeps the last list and doesn't push
	os.WriteFile(filepath.Join(f.dir, "sessions.fail"), nil, 0o644)
	n := sessionCalls()
	waitFor(t, "failing polls", func() bool { return sessionCalls() >= n+2 })
	if len(got()) != 4 {
		t.Errorf("a failed run pushes nothing")
	}
	if l, _ := f.a.List(context.Background()); l.Gen != 4 {
		t.Errorf("the last good list stands: gen %d", l.Gen)
	}
	os.Remove(filepath.Join(f.dir, "sessions.fail"))

	// no display, no polling
	f.a.DisplayGone(1)
	time.Sleep(50 * time.Millisecond)
	n = sessionCalls()
	time.Sleep(5 * f.a.interval)
	if m := sessionCalls(); m != n {
		t.Errorf("polling stops with the last display: %d → %d runs", n, m)
	}
}

func TestAgentEvents_ListRunsOnceWhenNoneRanYet(t *testing.T) {
	f := newAgentFixture(t)
	f.setSessions(t, map[string]any{"session_id": "z", "path": "/p/z"})
	l, err := f.a.List(context.Background())
	if err != nil || l.Gen != 1 || !strings.Contains(string(l.Sessions), `"z"`) {
		t.Fatalf("list = %s %v", l.Sessions, err)
	}
	g := newAgentFixture(t)
	os.WriteFile(filepath.Join(g.dir, "sessions.fail"), nil, 0o644)
	if _, err := g.a.List(context.Background()); err == nil || !strings.Contains(err.Error(), "sessions broke") {
		t.Errorf("a failing first run fails loud with its stderr: %v", err)
	}
}

// Sanity: the fixture's script really is what the tests think.
func TestAgentEvents_FakeAgentRuns(t *testing.T) {
	f := newAgentFixture(t)
	out, err := exec.Command(f.a.bin, "transcript", "x", "--until", "3").Output()
	if err != nil || strings.TrimSpace(string(out)) != `{"args":"x --until 3"}` {
		t.Fatalf("fake agent: %q %v", out, err)
	}
}

// Through a real relay: the display's follow pushes lines on its socket, and closing
// that socket kills the follower.
func TestAgentEvents_RelayWiringAndDisconnect(t *testing.T) {
	f := newAgentFixture(t)
	r, dial := newTestRelay(t)
	h, _, _ := newTestHandler(t)
	h.agents = f.a
	r.fs = h
	r.wireFS(h)

	d := dial(t)
	d.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	readJSON(t, d) // ack
	d.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":7,"method":"agentEvents/follow","params":{"session":"s"}}`))
	f.appendLines(t, "s", `{"n":1}`)
	var sawOK, sawLines bool
	deadline := time.Now().Add(3 * time.Second)
	for !(sawOK && sawLines) && time.Now().Before(deadline) {
		m := readJSON(t, d)
		if res, _ := m["result"].(map[string]any); m["id"] == float64(7) && res["ok"] == true {
			sawOK = true
		}
		if m["method"] == "agentEvents/lines" {
			p := m["params"].(map[string]any)
			if p["session"] == "s" && p["lines"].([]any)[0] == `{"n":1}` {
				sawLines = true
			}
		}
	}
	if !sawOK || !sawLines {
		t.Fatalf("follow ok=%v lines=%v", sawOK, sawLines)
	}
	pid := f.pidOf(t, "s")
	d.Close()
	waitFor(t, "the follower killed on disconnect", func() bool { return !alive(pid) })
}

var bg = context.Background()

// ---- one resolver for follow and read ----

func TestAgentEvents_ResolveSession(t *testing.T) {
	f := newAgentFixture(t)
	wgOld := map[string]any{"name": "lead", "store": "/s"}
	f.setSessions(t,
		map[string]any{"session_id": "agent-sub1", "path": "/t/sub1.jsonl", "workgroup": wgOld, "parent_session": map[string]any{"session_id": "c0ffee-new"}},
		map[string]any{"session_id": "c0ffee-new", "path": "/t/new.jsonl", "workgroup": wgOld},
		map[string]any{"session_id": "c0ffee-old", "path": "/t/old.jsonl", "workgroup": wgOld},
		map[string]any{"session_id": "deadbeef-1", "path": "/t/dead.jsonl"},
		map[string]any{"session_id": "pending", "path": ""},
	)
	for _, c := range []struct{ in, want string }{
		{"deadbeef-1", "/t/dead.jsonl"},  // exact id
		{"/t/old.jsonl", "/t/old.jsonl"}, // exact path
		{"lead", "/t/new.jsonl"},         // workgroup name: its newest non-subagent session
		{"dead", "/t/dead.jsonl"},        // a unique id prefix
		{"agent-s", "/t/sub1.jsonl"},
	} {
		if got, err := f.a.resolveSession(bg, c.in); err != nil || got != c.want {
			t.Errorf("resolve %q = %q (%v), want %q", c.in, got, err, c.want)
		}
	}
	for _, c := range []struct{ in, want string }{
		{"c0ffee", "ambiguous"},
		{"nobody", "no agent session"},
		{"pending", "no transcript yet"},
		{"/t/elsewhere.jsonl", "no agent session"},
	} {
		if _, err := f.a.resolveSession(bg, c.in); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("resolve %q: want an error naming %q, got %v", c.in, c.want, err)
		}
	}
	// a miss asks again once (a session newer than the last list); an ambiguous name doesn't
	calls := func() int {
		b, _ := os.ReadFile(filepath.Join(f.dir, "calls"))
		return strings.Count(string(b), "sessions --json")
	}
	n := calls()
	f.a.resolveSession(bg, "c0ffee")
	if calls() != n {
		t.Errorf("an ambiguous name re-polled")
	}
	f.setSessions(t, map[string]any{"session_id": "fresh", "path": "/t/fresh.jsonl"})
	if got, err := f.a.resolveSession(bg, "fresh"); err != nil || got != "/t/fresh.jsonl" || calls() != n+1 {
		t.Errorf("a new session: %q %v after %d polls", got, err, calls()-n)
	}
}

// follow resolves first: an unknown name is an RPC error and starts nothing; the follower
// runs on the resolved path, shared across the names that resolve to it, each display
// subscription hearing its own name back.
func TestAgentEvents_FollowResolves(t *testing.T) {
	f := newAgentFixture(t)
	f.setSessions(t, map[string]any{"session_id": "s", "path": filepath.Join(f.dir, "s.jsonl"), "workgroup": map[string]any{"name": "lead"}})
	f.a.DisplayConnected(1)
	if err := f.a.Follow(bg, 1, "nobody", -1); err == nil || !strings.Contains(err.Error(), "nobody") {
		t.Fatalf("an unknown session must fail the follow: %v", err)
	}
	if f.followerCount() != 0 {
		t.Fatal("an unknown session started a follower")
	}
	f.a.Follow(bg, 1, "lead", -1)
	f.a.Follow(bg, 1, "s", -1)
	f.pidOf(t, "s")
	if n := f.followerCount(); n != 1 {
		t.Fatalf("two names for one transcript share a follower: %d", n)
	}
	f.appendLines(t, "s", `{"n":1}`)
	waitFor(t, "lines under both names", func() bool { return len(f.sink.lines(1, "lead")) == 1 && len(f.sink.lines(1, "s")) == 1 })
	f.a.Unfollow(1, "lead")
	if f.followerCount() != 1 {
		t.Error("the other name still holds it")
	}
}

func TestAgentEvents_ReadTailBeforeUntil(t *testing.T) {
	f := newAgentFixture(t)
	tp := filepath.Join(f.dir, "w.jsonl")
	os.WriteFile(tp, []byte("aaaa\nbbbb\ncccc\ndddd\neeee\n"), 0o644) // lines at 0 5 10 15 20; size 25
	f.setSessions(t, map[string]any{"session_id": "w", "path": tp})
	i64 := func(v int64) *int64 { return &v }
	r, err := f.a.Read(bg, agentEventsReadParams{Session: "w", Until: i64(15), Tail: i64(5)})
	var v struct{ Args string }
	if err == nil && len(r.Lines) == 1 {
		json.Unmarshal([]byte(r.Lines[0]), &v)
	}
	// the last ~5 bytes before 15: the window is "cccc" (10), --from the line before (5)
	if err != nil || v.Args != tp+" --until 15 -q --from 5" || r.Size != 25 {
		t.Errorf("tail before until: %q %v (size %d)", v.Args, err, r.Size)
	}
	r, _ = f.a.Read(bg, agentEventsReadParams{Session: "w", Until: i64(15), Tail: i64(40)})
	json.Unmarshal([]byte(r.Lines[0]), &v)
	if v.Args != tp+" --until 15 -q" {
		t.Errorf("a tail past until reads from the start: %q", v.Args)
	}
	h, _, _ := newTestHandler(t)
	h.agents = f.a
	write, c := captureRPC(t)
	h.handleAgentEventsRead(write, json.RawMessage("1"), json.RawMessage(`{"session":"w","until":15,"tail":5}`))
	if c.Error != nil {
		t.Errorf("tail with until is allowed: %s", c.Error.Message)
	}
}

// An ended never gives up on a connected display: it waits for the events plane with no
// deadline (behind the lines queued before it), for a stall and for an exit alike.
func TestAgentEvents_EndedWaitsForTheDisplay(t *testing.T) {
	f := newAgentFixture(t)
	f.sink.stall = true
	f.a.DisplayConnected(1)
	f.a.Follow(bg, 1, "s", -1)
	f.pidOf(t, "s")
	f.appendLines(t, "s", `{"n":1}`)
	waitFor(t, "the stall's ended", func() bool { return len(f.sink.ended("s")) == 1 })
	if e := f.sink.ended("s")[0]; e.wait != 0 {
		t.Errorf("a stall's ended waited at most %s; it must wait as long as the display stays", e.wait)
	}
	f.sink.mu.Lock()
	f.sink.stall = false
	f.sink.mu.Unlock()
	f.a.Follow(bg, 1, "dies", -1)
	waitFor(t, "the exit's ended", func() bool { return len(f.sink.ended("dies")) == 1 })
	if e := f.sink.ended("dies")[0]; e.wait != 0 {
		t.Errorf("an exit's ended waited at most %s", e.wait)
	}
}
