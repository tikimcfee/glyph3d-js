package main

// gomuxai — the agent orchestrator's tree, served to the display.
//
// gomuxai (the `agent` CLI) runs AI coding agents in their own tmux sessions and
// records them in a per-binary SQLite store: `.gomuxai/gomuxai.db` next to the
// symlink-resolved `agent` executable. Every copy of the binary keeps its own
// store, and an agent that spawns helpers with a different copy (a dev build in a
// worktree) records them in THAT copy's store — so one tree spans several data
// dirs. All agents share one tmux server (the default socket), session
// `agent-<name>`.
//
// This file READS that state and never writes it: every DB opens `mode=ro`, no
// `agent` subcommand runs (each one logs a command_log row, and status probes
// can spawn backend CLIs). Discovery:
//   - the `agent` on PATH (symlinks resolved) → its .gomuxai dir, plus any
//     operator-supplied dirs;
//   - every live `agent-*` tmux session → `show-environment PATH`'s first
//     entry is the dir of the binary that spawned it (gomuxai prepends it) →
//     that dir's .gomuxai. This finds the worktree builds' stores too, which
//     is how a cross-store parent link (coord in one store, coord-t1 in
//     another) stitches into one tree.
//
// The snapshot is the tree: live agents (the `agents` table + the reserved
// `_status`/`_tool`/`_transcript`/… keys in `state`), plus DEPARTED agents —
// cleanup deletes the row, but the store keeps each spawn in command_log
// (`args[0]=="spawn"`, the caller's AGENT_NAME as `agent`) and each transcript
// path in logs/<name>.transcripts, so a finished agent's run stays readable.
//
// Change detection is a 1s poll: PRAGMA data_version per store (bumps on any
// other connection's commit), the live tmux session set, and each transcript's
// size. A changed snapshot pushes `gomux/changed` (the whole snapshot — it's a
// few KB) to the display. gomuxai's own push channel is its NATS bus, which
// needs keys and a running daemon, and misses stores without a bus; polling a
// pragma is cheaper than either.
//
// RPCs (fs.go dispatch):
//   gomux/list  {}                                  → snapshot
//   gomux/read  {name, tailBytes?|fromOffset?, maxBytes?, binary?}
//               → the agent's transcript window, agentSessions/read's shape.
//               Only a path the snapshot names for that agent is served, and
//               only under the harness homes (~/.claude/projects,
//               ~/.gemini/antigravity-cli/brain).

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

// gomuxPollInterval is the change-detection tick. A var so tests can shorten it.
var gomuxPollInterval = time.Second

// gomuxRediscoverEvery re-runs data-dir discovery every N ticks (new worktree
// builds appear as their first agent spawns).
const gomuxRediscoverEvery = 10

// gomuxAgent is one node of the tree. Status fields are gomuxai's REPORTED
// state (hook-written), not its native-resolved status — the store is what we
// can read without running the CLI.
type gomuxAgent struct {
	Name      string `json:"name"`
	Parent    string `json:"parent"`              // spawner's name; "" = a person
	Backend   string `json:"backend"`             // claude | agy | aider | custom
	Session   string `json:"session"`             // tmux session (agent-<name>)
	DataDir   string `json:"dataDir"`             // the .gomuxai dir that records it
	Cwd       string `json:"cwd,omitempty"`       // spawn cwd (command_log), when known
	CreatedAt string `json:"createdAt"`           // RFC3339, UTC
	Live      bool   `json:"live"`                // a row in agents (not cleaned up)
	Attached  bool   `json:"attached"`            // its tmux session exists right now
	Status    string `json:"status,omitempty"`    // idle|processing|waiting|error|exited|unknown
	Event     string `json:"event,omitempty"`     // last hook event (PostToolUse, Stop, …)
	Detail    string `json:"detail,omitempty"`    // e.g. "Bash: rg foo"
	Tool      string `json:"tool,omitempty"`      // tool in flight
	ToolInput string `json:"toolInput,omitempty"` // a pending permission prompt's full call
	StatusAt  string `json:"statusAt,omitempty"`  // when _status was written
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

type gomuxStore struct {
	dir     string
	db      *sql.DB
	version int64
	// hasSpawnedBy: stores created before the column (and never reopened by a
	// newer binary) lack it.
	hasSpawnedBy bool
	// cached is the last read, valid while data_version holds — a quiet store
	// costs one pragma per tick.
	cached []gomuxAgent
}

// GomuxWatcher owns discovery, the read-only store handles, and the snapshot.
type GomuxWatcher struct {
	mu       sync.Mutex
	stores   map[string]*gomuxStore // by data dir
	explicit []string               // operator-supplied data dirs (always watched)
	sessEnv  map[string]string      // tmux session → discovered data dir ("" = none)
	snap     gomuxSnapshot
	notify   func(method string, params any)
	tmuxBin  string // "" = no tmux: nothing is attached, no session discovery
	agentBin string // the `agent` on PATH ("" = none): its store is always watched
	home     string
}

// NewGomuxWatcher builds a watcher over the discoverable stores plus `dirs`
// (each a .gomuxai dir, or a dir/binary next to one). It does no I/O until Start.
func NewGomuxWatcher(dirs []string) *GomuxWatcher {
	home, _ := os.UserHomeDir()
	tmuxBin, _ := exec.LookPath("tmux")
	agentBin, _ := exec.LookPath("agent")
	w := &GomuxWatcher{
		stores:   map[string]*gomuxStore{},
		sessEnv:  map[string]string{},
		tmuxBin:  tmuxBin,
		agentBin: agentBin,
		home:     home,
	}
	for _, d := range dirs {
		if dd := gomuxDataDirFor(d); dd != "" {
			w.explicit = append(w.explicit, dd)
		} else {
			log.Printf("[gomux] --gomuxai %s: no .gomuxai/gomuxai.db there — ignored", d)
		}
	}
	return w
}

// SetNotifyHook wires the display push channel (gomux/changed).
func (w *GomuxWatcher) SetNotifyHook(fn func(method string, params any)) { w.notify = fn }

// gomuxDataDirFor maps a .gomuxai dir, the dir holding one, or an `agent`
// binary to its data dir — "" when no store is there.
func gomuxDataDirFor(p string) string {
	if p == "" {
		return ""
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	cands := []string{p, filepath.Join(p, ".gomuxai")}
	if info, err := os.Stat(p); err == nil && !info.IsDir() {
		cands = []string{filepath.Join(filepath.Dir(p), ".gomuxai")}
	}
	for _, c := range cands {
		if info, err := os.Stat(filepath.Join(c, "gomuxai.db")); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

// Start runs the poll loop until ctx ends.
func (w *GomuxWatcher) Start(ctx context.Context) {
	go func() {
		tick := 0
		// Twice: the second discovery follows the first snapshot's spawn cwds.
		w.discover()
		w.refresh()
		w.discover()
		w.refresh()
		t := time.NewTicker(gomuxPollInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				w.close()
				return
			case <-t.C:
				tick++
				if tick%gomuxRediscoverEvery == 0 {
					w.discover()
				}
				w.refresh()
			}
		}
	}()
}

func (w *GomuxWatcher) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, s := range w.stores {
		s.db.Close()
	}
	w.stores = map[string]*gomuxStore{}
}

// tmux runs a read-only query against the DEFAULT tmux server (gomuxai's). TMUX
// is unset so a relay started inside some other tmux server still asks the
// default one.
func (w *GomuxWatcher) tmux(args ...string) (string, error) {
	if w.tmuxBin == "" {
		return "", fmt.Errorf("tmux not on PATH")
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

// liveSessions lists the default server's `agent-*` sessions. No server (no
// tmux running) is an empty set, not an error.
func (w *GomuxWatcher) liveSessions() map[string]bool {
	set := map[string]bool{}
	out, err := w.tmux("list-sessions", "-F", "#{session_name}")
	if err != nil {
		return set
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "agent-") {
			set[line] = true
		}
	}
	return set
}

// discover opens any store not yet open: the PATH binary's, the explicit ones,
// and each live agent session's spawning binary's.
func (w *GomuxWatcher) discover() {
	dirs := append([]string{}, w.explicit...)
	if dd := gomuxDataDirFor(w.agentBin); dd != "" {
		dirs = append(dirs, dd)
	}
	// A dev build's store sits in its repo's bin/ (gomuxai's `make build`), and
	// the agents that ran it were spawned from that repo — so each known
	// agent's spawn cwd names a candidate. This keeps a departed team's store
	// (no live session left to point at it) in the tree.
	w.mu.Lock()
	for _, a := range w.snap.Agents {
		if a.Cwd != "" {
			if dd := gomuxDataDirFor(filepath.Join(a.Cwd, "bin")); dd != "" {
				dirs = append(dirs, dd)
			}
		}
	}
	w.mu.Unlock()
	for sess := range w.liveSessions() {
		w.mu.Lock()
		dd, seen := w.sessEnv[sess]
		w.mu.Unlock()
		if !seen {
			out, err := w.tmux("show-environment", "-t", sess, "PATH")
			if err == nil {
				// "PATH=/first/dir:/…" — gomuxai prepends its binary's dir.
				v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "PATH="))
				first, _, _ := strings.Cut(v, string(os.PathListSeparator))
				dd = gomuxDataDirFor(first)
			}
			w.mu.Lock()
			w.sessEnv[sess] = dd
			w.mu.Unlock()
		}
		if dd != "" {
			dirs = append(dirs, dd)
		}
	}
	for _, dd := range dirs {
		w.mu.Lock()
		_, open := w.stores[dd]
		w.mu.Unlock()
		if open {
			continue
		}
		s, err := openGomuxStore(dd)
		if err != nil {
			log.Printf("[gomux] open %s: %v", dd, err)
			continue
		}
		w.mu.Lock()
		w.stores[dd] = s
		w.mu.Unlock()
		log.Printf("[gomux] watching %s", dd)
	}
}

// openGomuxStore opens a store read-only. Not `immutable`: the DB is WAL-mode
// and live, and data_version must see other connections' commits. One
// connection, so data_version compares against a stable handle.
func openGomuxStore(dir string) (*gomuxStore, error) {
	dsn := "file:" + (&url.URL{Path: filepath.Join(dir, "gomuxai.db")}).EscapedPath() + "?mode=ro&_pragma=busy_timeout(2000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name = 'spawned_by'`).Scan(&n); err != nil {
		db.Close()
		return nil, err
	}
	return &gomuxStore{dir: dir, db: db, version: -1, hasSpawnedBy: n > 0}, nil
}

// refresh rebuilds the snapshot and pushes it when anything differs.
func (w *GomuxWatcher) refresh() {
	w.mu.Lock()
	stores := make([]*gomuxStore, 0, len(w.stores))
	for _, s := range w.stores {
		stores = append(stores, s)
	}
	w.mu.Unlock()
	sort.Slice(stores, func(i, j int) bool { return stores[i].dir < stores[j].dir })

	live := w.liveSessions()
	byName := map[string]gomuxAgent{}
	dirs := make([]string, 0, len(stores))
	for _, s := range stores {
		dirs = append(dirs, s.dir)
		agents, err := w.readStore(s)
		if err != nil {
			log.Printf("[gomux] read %s: %v", s.dir, err)
			continue
		}
		for _, a := range agents {
			// A name can appear in several stores (a departed agent in one, its
			// reborn namesake in another): the live row wins, then the newest.
			if prev, ok := byName[a.Name]; ok && !gomuxPrefer(a, prev) {
				continue
			}
			byName[a.Name] = a
		}
	}
	agents := make([]gomuxAgent, 0, len(byName))
	for _, a := range byName {
		a.Attached = live[a.Session]
		if a.Transcript != "" {
			if info, err := os.Stat(a.Transcript); err == nil {
				a.TranscriptSize = info.Size()
				a.TranscriptMtime = info.ModTime().UnixMilli()
			}
		}
		agents = append(agents, a)
	}
	sort.Slice(agents, func(i, j int) bool {
		if agents[i].CreatedAt != agents[j].CreatedAt {
			return agents[i].CreatedAt < agents[j].CreatedAt
		}
		return agents[i].Name < agents[j].Name
	})

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

// gomuxPrefer: should a replace b for the same name?
func gomuxPrefer(a, b gomuxAgent) bool {
	if a.Live != b.Live {
		return a.Live
	}
	return a.CreatedAt > b.CreatedAt
}

// readStore reads one store's agents (cached while the store is quiet) — live rows with their reserved state
// keys, then departed ones rebuilt from command_log spawns + transcript logs.
func (w *GomuxWatcher) readStore(s *gomuxStore) ([]gomuxAgent, error) {
	// data_version moves when ANY other connection commits (every `agent`
	// command logs a row, so it's noisy — but a quiet store is skipped). The
	// departed agents' transcripts can still move without a commit only if the
	// log file is appended without a state write, which gomuxai never does.
	var v int64
	if err := s.db.QueryRow(`PRAGMA data_version`).Scan(&v); err != nil {
		return nil, err
	}
	if v == s.version && s.cached != nil {
		return s.cached, nil
	}
	agents, err := w.readStoreRows(s)
	if err != nil {
		return nil, err
	}
	s.version, s.cached = v, agents
	return agents, nil
}

// readStoreRows does readStore's actual reads.
func (w *GomuxWatcher) readStoreRows(s *gomuxStore) ([]gomuxAgent, error) {

	q := `SELECT name, session_name, backend, created_at, ` +
		map[bool]string{true: `COALESCE(spawned_by, '')`, false: `''`}[s.hasSpawnedBy] + ` FROM agents`
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	byName := map[string]*gomuxAgent{}
	var order []string
	for rows.Next() {
		a := &gomuxAgent{DataDir: s.dir, Live: true}
		if err := rows.Scan(&a.Name, &a.Session, &a.Backend, &a.CreatedAt, &a.Parent); err != nil {
			rows.Close()
			return nil, err
		}
		a.CreatedAt = gomuxUTC(a.CreatedAt)
		byName[a.Name] = a
		order = append(order, a.Name)
	}
	rows.Close()

	st, err := s.db.Query(`SELECT agent_name, key, value, updated_at FROM state WHERE key IN
		('_status','_event','_detail','_tool','_tool_input','_session_id','_transcript')`)
	if err != nil {
		return nil, err
	}
	for st.Next() {
		var name, key, value, at string
		if err := st.Scan(&name, &key, &value, &at); err != nil {
			st.Close()
			return nil, err
		}
		a := byName[name]
		if a == nil {
			continue
		}
		switch key {
		case "_status":
			a.Status, a.StatusAt = value, gomuxUTC(at)
		case "_event":
			a.Event = value
		case "_detail":
			a.Detail = value
		case "_tool":
			a.Tool = value
		case "_tool_input":
			a.ToolInput = value
		case "_session_id":
			a.SessionID = value
		case "_transcript":
			a.Transcript = value
		}
	}
	st.Close()

	// Spawns: the newest per name gives cwd for live agents and the whole
	// record for departed ones. The caller's AGENT_NAME is the parent.
	sp, err := s.db.Query(`SELECT started_at, agent, cwd, args FROM command_log
		WHERE args LIKE '["spawn",%' AND exit_code = 0 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for sp.Next() {
		var at, parent, cwd, args string
		if err := sp.Scan(&at, &parent, &cwd, &args); err != nil {
			sp.Close()
			return nil, err
		}
		at = gomuxUTC(at)
		name, backend := gomuxSpawnArgs(args)
		if name == "" {
			continue
		}
		if a := byName[name]; a != nil {
			if a.Live && a.Cwd == "" {
				a.Cwd = cwd
			}
			if !a.Live {
				a.Parent, a.Cwd, a.CreatedAt, a.Backend = parent, cwd, at, backend
			}
			continue
		}
		a := &gomuxAgent{Name: name, Parent: parent, Backend: backend, Session: "agent-" + name,
			DataDir: s.dir, Cwd: cwd, CreatedAt: at, Status: "exited"}
		byName[name] = a
		order = append(order, name)
	}
	sp.Close()

	out := make([]gomuxAgent, 0, len(order))
	for _, name := range order {
		a := byName[name]
		if a.Transcript == "" {
			a.Transcript, a.Harness = gomuxLastTranscript(filepath.Join(s.dir, "logs", name+".transcripts"))
		}
		if a.Harness == "" {
			a.Harness = gomuxHarnessOf(a.Backend, a.Transcript)
		}
		if a.Transcript != "" && !w.transcriptAllowed(a.Transcript) {
			log.Printf("[gomux] %s: transcript outside the harness homes, not served: %s", name, a.Transcript)
			a.Transcript = ""
		}
		out = append(out, *a)
	}
	return out, nil
}

// gomuxUTC normalizes a store timestamp to UTC RFC3339 (millisecond
// precision) — agents rows carry a local offset, command_log rows UTC, and the
// tree sorts by the string.
func gomuxUTC(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return s
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// gomuxSpawnArgs pulls the name and --backend out of a logged spawn's argv.
func gomuxSpawnArgs(raw string) (name, backend string) {
	var argv []string
	if json.Unmarshal([]byte(raw), &argv) != nil || len(argv) < 2 || argv[0] != "spawn" {
		return "", ""
	}
	backend = "claude"
	for i := 2; i < len(argv); i++ {
		switch {
		case argv[i] == "--backend" && i+1 < len(argv):
			backend = argv[i+1]
			i++
		case strings.HasPrefix(argv[i], "--backend="):
			backend = strings.TrimPrefix(argv[i], "--backend=")
		}
	}
	return argv[1], backend
}

// gomuxLastTranscript reads logs/<name>.transcripts (`<backend>\t<path>` per
// line, appended as the session moves) and returns the newest path.
func gomuxLastTranscript(path string) (string, string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	var tp, harness string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		b, p, ok := strings.Cut(sc.Text(), "\t")
		if ok && p != "" {
			harness, tp = b, p
		}
	}
	return tp, harness
}

// gomuxHarnessOf names the dialect a transcript is written in.
func gomuxHarnessOf(backend, transcript string) string {
	switch {
	case backend == "claude" || strings.Contains(transcript, "/.claude/projects/"):
		return "claude"
	case backend == "agy" || strings.Contains(transcript, "/antigravity-cli/brain/"):
		return "agy"
	}
	return ""
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
	h.serveTranscriptWindow(write, writeBin, id, p.Name, a.Transcript, a.Cwd, p.transcriptWindow)
}
