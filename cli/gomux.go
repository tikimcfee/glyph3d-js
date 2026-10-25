package main

// gomuxai — the agent orchestrator's tree, served to the display.
//
// gomuxai (the `agent` CLI) runs AI coding agents in their own tmux sessions and
// records them in per-binary stores. Its `agent export --json --follow --all` is the
// supported way to watch that: a snapshot line, then one JSON line per change
// (spawned / changed / removed agents, whole-store and whole-host replacements), each
// carrying the whole agent. It reads every store it can find (the binary's own, and
// each live agent-* session's spawning binary's), runs no backend CLI, and logs one
// command-history row per run however long it follows.
//
// The watcher keeps ONE such follower running (restarting it, with a fresh snapshot,
// if it exits), folds its lines into the tree, and pushes `gomux/changed` (the whole
// snapshot — a few KB) to the display whenever the tree it serves moves. Agents are
// keyed host+store+name; the served tree has one node per name (a live agent beats a
// departed namesake, then the newest run).
//
// RPCs (fs.go dispatch):
//   gomux/list  {}                                  → snapshot
//   gomux/read  {name, tailBytes?|fromOffset?, maxBytes?, binary?}
//               → the agent's transcript window, agentSessions/read's shape.
//               Only a path the tree names for that agent is served, and only
//               under the harness homes (~/.claude/projects,
//               ~/.gemini/antigravity-cli/brain).

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
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
	Session   string `json:"session"`             // tmux session (agent-<name>)
	DataDir   string `json:"dataDir"`             // the .gomuxai store that records it
	Cwd       string `json:"cwd,omitempty"`       // spawn cwd
	CreatedAt string `json:"createdAt"`           // RFC3339, UTC
	EndedAt   string `json:"endedAt,omitempty"`   // departed agents: when it was cleaned up
	Run       int64  `json:"run,omitempty"`       // spawn id within its store (two runs of one name)
	Live      bool   `json:"live"`                // not cleaned up
	Attached  bool   `json:"attached"`            // its tmux session exists right now
	Status    string `json:"status,omitempty"`    // idle|processing|waiting|error|exited|unknown
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
	Store           string `json:"store"`
	Cwd             string `json:"cwd"`
	CreatedAt       string `json:"created_at"`
	EndedAt         string `json:"ended_at"`
	Live            bool   `json:"live"`
	Attached        bool   `json:"attached"`
	Status          string `json:"status"`
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
	snap    gomuxSnapshot
	notify  func(method string, params any)
	reach   func(dir string) // widens the file handler's reach to an agent's cwd
	reached map[string]bool
	stores0 []string // operator-supplied stores (--gomuxai), passed as --store
	tmuxBin string   // "" = no tmux: screens can't be drawn
	agent   string   // the `agent` binary export runs from ("" = look it up on PATH)
	home    string
	// paneSizes: each screened agent's pane size as last seen or set (watchPaneSizes)
	paneSizes map[string][2]int
}

// NewGomuxWatcher builds a watcher whose export also reads `dirs` (each a .gomuxai dir,
// the dir holding one, or an agent binary — export's --store). No I/O until Start.
func NewGomuxWatcher(dirs []string) *GomuxWatcher {
	home, _ := os.UserHomeDir()
	tmuxBin, _ := exec.LookPath("tmux")
	return &GomuxWatcher{
		agents:  map[string]exportAgent{},
		reached: map[string]bool{},
		stores0: dirs,
		tmuxBin: tmuxBin,
		home:    home,
	}
}

// SetReachHook wires the file handler's reach: each agent's spawn cwd is handed
// over once, so its book's file snapshots can load.
func (w *GomuxWatcher) SetReachHook(fn func(dir string)) { w.reach = fn }

// SetNotifyHook wires the display push channel (gomux/changed).
func (w *GomuxWatcher) SetNotifyHook(fn func(method string, params any)) { w.notify = fn }

// Start keeps one export follower running until ctx ends, and watches screened agents'
// pane sizes.
func (w *GomuxWatcher) Start(ctx context.Context) {
	if w.tmuxBin != "" {
		go w.watchPaneSizes(ctx)
	}
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

// follow runs one `agent export --json --follow --all` and folds its lines in until it
// exits. A restart begins with a fresh snapshot, which replaces the whole tree.
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
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return errMsg("start " + bin + " export: " + err.Error())
	}
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

// publish rebuilds the served tree (one node per name) and pushes it when it moved.
func (w *GomuxWatcher) publish() {
	w.mu.Lock()
	byName := map[string]exportAgent{}
	for _, a := range w.agents {
		if a.Store == "" {
			continue // another host's agent: no store, transcript, or screen to serve
		}
		if prev, ok := byName[a.Name]; ok && !exportPrefer(a, prev) {
			continue
		}
		byName[a.Name] = a
	}
	dirs := append([]string{}, w.stores...)
	w.mu.Unlock()

	agents := make([]gomuxAgent, 0, len(byName))
	for _, a := range byName {
		agents = append(agents, w.toNode(a))
	}
	sort.Slice(agents, func(i, j int) bool {
		ti, tj := parseTime(agents[i].CreatedAt), parseTime(agents[j].CreatedAt)
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return agents[i].Name < agents[j].Name
	})
	sort.Strings(dirs)

	if w.reach != nil {
		for _, a := range agents {
			if a.Cwd != "" && !w.reached[a.Cwd] {
				w.reached[a.Cwd] = true
				w.reach(a.Cwd)
			}
		}
	}

	w.mu.Lock()
	changed := !reflect.DeepEqual(agents, w.snap.Agents) || !reflect.DeepEqual(dirs, w.snap.Dirs)
	if changed {
		w.snap = gomuxSnapshot{Gen: w.snap.Gen + 1, Dirs: dirs, Agents: agents}
	}
	snap := w.snap
	w.mu.Unlock()
	if changed && w.notify != nil {
		w.notify("gomux/changed", snap)
	}
}

// exportPrefer: should a replace b for the same name? A live agent beats a departed
// namesake, then the newer run.
func exportPrefer(a, b exportAgent) bool {
	if a.Live != b.Live {
		return a.Live
	}
	return parseTime(a.CreatedAt).After(parseTime(b.CreatedAt))
}

// toNode maps export's agent to the display's node, dropping a transcript outside the
// harness homes (it would never be served).
func (w *GomuxWatcher) toNode(a exportAgent) gomuxAgent {
	n := gomuxAgent{
		Name: a.Name, Host: a.Host, Parent: a.Parent, Backend: a.Backend, Session: a.Session,
		DataDir: a.Store, Cwd: a.Cwd, CreatedAt: a.CreatedAt, EndedAt: a.EndedAt, Run: a.Run,
		Live: a.Live, Attached: a.Attached, Status: a.Status, Event: a.Event, Detail: a.Detail,
		Tool: a.Tool, ToolInput: a.ToolInput, StatusAt: a.StatusAt, SessionID: a.SessionID,
		Transcript: a.Transcript, Harness: a.Dialect, TranscriptSize: a.TranscriptSize,
	}
	if !a.Live && n.Status == "" {
		n.Status = "exited"
	}
	if t := parseTime(a.TranscriptMtime); !t.IsZero() {
		n.TranscriptMtime = t.UnixMilli()
	}
	if n.Transcript != "" && !w.transcriptAllowed(n.Transcript) {
		log.Printf("[gomux] %s: transcript outside the harness homes, not served: %s", a.Name, n.Transcript)
		n.Transcript = ""
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

// tmux runs a read-only query against the DEFAULT tmux server (gomuxai's) — the
// screens' pane size. TMUX is unset so a relay started inside another server asks the
// default one.
func (w *GomuxWatcher) tmux(args ...string) (string, error) {
	if w.tmuxBin == "" {
		return "", errMsg("tmux not on PATH")
	}
	cmd := exec.Command(w.tmuxBin, args...)
	env := os.Environ()
	out := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "TMUX=") {
			out = append(out, kv)
		}
	}
	cmd.Env = out
	b, err := cmd.Output()
	return string(b), err
}

// transcriptAllowed: only the harness homes are served, symlinks resolved.
func (w *GomuxWatcher) transcriptAllowed(p string) bool {
	if w.home == "" || !filepath.IsAbs(p) {
		return false
	}
	rp := evalSymlinksOrSelf(filepath.Clean(p))
	for _, root := range []string{
		filepath.Join(w.home, ".claude", "projects"),
		filepath.Join(w.home, ".gemini", "antigravity-cli", "brain"),
	} {
		if isUnder(rp, evalSymlinksOrSelf(root)) {
			return true
		}
	}
	return false
}

// agentByName returns the served node for a name.
func (w *GomuxWatcher) agentByName(name string) (gomuxAgent, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, a := range w.snap.Agents {
		if a.Name == name {
			return a, true
		}
	}
	return gomuxAgent{}, false
}

// notePaneSize records an agent pane's size as seen (so a size we set isn't echoed back).
func (w *GomuxWatcher) notePaneSize(name string, cols, rows int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.paneSizes == nil {
		w.paneSizes = map[string][2]int{}
	}
	w.paneSizes[name] = [2]int{cols, rows}
}

// watchPaneSizes reads each SCREENED agent's pane size every 2s and pushes
// `gomux/paneSize` when it moved — a screen follows its agent's pane wherever the size
// was changed. Only agents with a screen session on our socket are asked.
func (w *GomuxWatcher) watchPaneSizes(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, a := range w.Snapshot().Agents {
			if !a.Attached {
				continue
			}
			if exec.Command("tmux", "-L", tmuxSocket, "has-session", "-t", "glyph-"+sanitizeSession(gomuxTerminalID(a.Name))).Run() != nil {
				continue
			}
			out, err := w.tmux("display-message", "-p", "-t", a.Session, "#{pane_width} #{pane_height}")
			if err != nil {
				continue
			}
			f := strings.Fields(strings.TrimSpace(out))
			if len(f) != 2 {
				continue
			}
			c, e1 := strconv.Atoi(f[0])
			r, e2 := strconv.Atoi(f[1])
			if e1 != nil || e2 != nil {
				continue
			}
			w.mu.Lock()
			prev, seen := w.paneSizes[a.Name]
			w.mu.Unlock()
			if seen && prev == [2]int{c, r} {
				continue
			}
			w.notePaneSize(a.Name, c, r)
			if seen && w.notify != nil {
				w.notify("gomux/paneSize", map[string]any{"name": a.Name, "id": gomuxTerminalID(a.Name), "cols": c, "rows": r})
			}
		}
	}
}

// Snapshot returns the current tree.
func (w *GomuxWatcher) Snapshot() gomuxSnapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.snap
}

// transcriptOf resolves an agent name to its served transcript path.
func (w *GomuxWatcher) transcriptOf(name string) (gomuxAgent, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, a := range w.snap.Agents {
		if a.Name == name {
			return a, a.Transcript != ""
		}
	}
	return gomuxAgent{}, false
}

// ---- RPC handlers ----

func (h *FSHandler) handleGomuxList(write writeFn, id json.RawMessage, _ json.RawMessage) {
	if h.gomux == nil {
		h.sendRPCError(write, id, -32000, "gomuxai watcher not running", nil)
		return
	}
	h.sendRPCResult(write, id, h.gomux.Snapshot())
}

type gomuxReadParams struct {
	Name string `json:"name"`
	transcriptWindow
}

func (h *FSHandler) handleGomuxRead(write writeFn, writeBin writeBinFn, id json.RawMessage, raw json.RawMessage) {
	if h.gomux == nil {
		h.sendRPCError(write, id, -32000, "gomuxai watcher not running", nil)
		return
	}
	var p gomuxReadParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	a, ok := h.gomux.transcriptOf(p.Name)
	if !ok {
		h.sendRPCError(write, id, errFileNotFound, "no transcript for gomuxai agent: "+p.Name, map[string]string{"name": p.Name})
		return
	}
	h.serveTranscriptWindow(write, writeBin, id, p.Name, a.Transcript, a.Cwd, "", p.transcriptWindow)
}

// ---- the agent's live screen ----

// gomuxScreenScript draws an agent's screen with no tmux client on gomuxai's server:
// $1 = tmux binary, $2 = the agent's session, $3 = its pipe-pane log. Input is ignored
// (echo off; tail reads no stdin). Each captured row lands at its own position (so the
// snapshot can't scroll), the cursor goes where the pane's is, then the log streams on.
const gomuxScreenScript = `stty -echo -icanon 2>/dev/null
printf '\033[2J\033[H'
env -u TMUX "$1" capture-pane -e -p -t "$2" | awk '{ printf "\033[%d;1H%s", NR, $0 }'
pos=$(env -u TMUX "$1" display-message -p -t "$2" '#{cursor_y} #{cursor_x}')
set -- "$@" $pos
printf '\033[%d;%dH' $(( $4 + 1 )) $(( $5 + 1 ))
exec tail -c 0 -F "$3"
`

// gomuxTerminalID is the terminal an agent's screen shows in: `gx-<name>`, so its
// glyphd-side session is `glyph-gx-<name>` and never collides with a spawned term-N.
func gomuxTerminalID(name string) string { return "gx-" + sanitizeSession(name) }

// attachGomuxAgent forks a terminal adapter that shows the agent's screen WITHOUT a tmux
// client on gomuxai's server. Any client there — even a read-only one — becomes tmux's
// "most recently active client", the default target of every CLI command, and a
// read-only one makes gomuxai's own send-keys fail host-wide. So the screen is built
// from what gomuxai already records: a capture-pane snapshot (each row positioned, then
// the cursor), followed by `tail -F` of the pane's pipe-pane log (logs/<name>.log, the
// raw byte stream the agent's terminal emits). The adapter's session lives on our socket
// as always; its shell ignores input (echo off, tail reads no stdin), so keys typed at it
// go nowhere, and nothing here can resize or touch the agent's window. The terminal
// opens at the agent pane's own size. Killing it kills only our session.
func (r *Relay) attachGomuxAgent(send func(any), name string) {
	reply := func(err string) { send(map[string]any{"event": "gomux.attaching", "name": name, "error": err}) }
	if r.fs == nil || r.fs.gomux == nil {
		reply("gomuxai watcher not running")
		return
	}
	var agent *gomuxAgent
	for _, a := range r.fs.gomux.Snapshot().Agents {
		if a.Name == name {
			a := a
			agent = &a
			break
		}
	}
	if agent == nil {
		reply("no gomuxai agent named " + name)
		return
	}
	if !agent.Attached {
		reply("agent " + name + " has no tmux session (" + agent.Session + ")")
		return
	}
	logPath := filepath.Join(agent.DataDir, "logs", name+".log")
	if info, err := os.Stat(logPath); err != nil || info.IsDir() {
		reply("no pane log for " + name + " at " + logPath + " (gomuxai pipes each agent's pane there)")
		return
	}
	cols, rows := 80, 24
	if out, err := r.fs.gomux.tmux("display-message", "-p", "-t", agent.Session, "#{pane_width} #{pane_height}"); err == nil {
		if f := strings.Fields(strings.TrimSpace(out)); len(f) == 2 {
			if c, e := strconv.Atoi(f[0]); e == nil && c > 0 {
				cols = c
			}
			if rr, e := strconv.Atoi(f[1]); e == nil && rr > 0 {
				rows = rr
			}
		}
	}
	exePath, err := os.Executable()
	if err != nil {
		reply("cannot locate glyph3d-cli binary: " + err.Error())
		return
	}
	id := gomuxTerminalID(name)
	// ONE adapter per screen. A display reload asks for every screen again before the
	// adapters it already has re-adopt their terminals; a second adapter would attach a
	// second client to the same session, and with window-size latest the two clients'
	// sizes fight (the screen ping-pongs). If the session has a client, its adapter is
	// alive and will re-create the terminal itself — answer with its id. A request
	// already in flight (no client yet) is answered the same way.
	if r.gomuxScreenLive(id) {
		send(map[string]any{"event": "gomux.attaching", "name": name, "id": id, "existing": true})
		return
	}
	args := []string{"attach", id, "--port", strconv.Itoa(r.port), "--tmux-socket", tmuxSocket,
		"--cols", strconv.Itoa(cols), "--rows", strconv.Itoa(rows),
		"--", "sh", "-c", gomuxScreenScript, "gomux-screen", r.fs.gomux.tmuxBin, agent.Session, logPath}
	cmd := exec.Command(exePath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		reply("spawn failed: " + err.Error())
		return
	}
	pid := cmd.Process.Pid
	log.Printf("[gomux] %s: screen as terminal '%s' (pid %d, %dx%d, from its pane log)", name, id, pid, cols, rows)
	send(map[string]any{"event": "gomux.attaching", "name": name, "id": id, "cols": cols, "rows": rows})
	go func() {
		err := cmd.Wait()
		log.Printf("[gomux] %s: screen adapter '%s' (pid %d) exited: %v", name, id, pid, err)
	}()
}

// resizeGomuxAgent resizes an agent's own tmux window (its pane) — a screen's resize
// writing back, so the agent's CLI reflows to the size you're viewing it at. It's a
// server command (resize-window), no client: nothing attaches to the agent's session.
// The window's size goes manual, which is what a pane with no clients wants anyway.
func (r *Relay) resizeGomuxAgent(send func(any), name string, cols, rows int) {
	reply := func(err string) {
		send(map[string]any{"event": "gomux.resized", "name": name, "cols": cols, "rows": rows, "error": err})
	}
	if r.fs == nil || r.fs.gomux == nil {
		reply("gomuxai watcher not running")
		return
	}
	if cols < 2 || rows < 2 || cols > 1000 || rows > 1000 {
		reply(fmt.Sprintf("size %dx%d out of range", cols, rows))
		return
	}
	a, ok := r.fs.gomux.agentByName(name)
	if !ok || !a.Attached {
		reply("agent " + name + " has no tmux session")
		return
	}
	if _, err := r.fs.gomux.tmux("resize-window", "-t", a.Session, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows)); err != nil {
		reply("resize-window: " + err.Error())
		return
	}
	r.fs.gomux.notePaneSize(name, cols, rows)
	reply("")
}

// gomuxScreenLive reports whether a screen's adapter exists — its session (on our socket)
// has a client, or one was forked moments ago and hasn't attached yet — and otherwise
// claims the slot for the caller about to fork one.
func (r *Relay) gomuxScreenLive(id string) bool {
	session := "glyph-" + sanitizeSession(id)
	if out, err := exec.Command("tmux", "-L", tmuxSocket, "list-clients", "-t", session, "-F", "#{client_name}").Output(); err == nil && strings.TrimSpace(string(out)) != "" {
		return true
	}
	r.gxMu.Lock()
	defer r.gxMu.Unlock()
	if r.gxForked == nil {
		r.gxForked = map[string]time.Time{}
	}
	if t, ok := r.gxForked[id]; ok && time.Since(t) < 15*time.Second {
		return true
	}
	r.gxForked[id] = time.Now()
	return false
}
