package main

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gomuxFixtureStore builds a .gomuxai dir with gomuxai's schema (as of the
// spawned_by column) and returns its path. rows are executed as-is.
func gomuxFixtureStore(t *testing.T, withSpawnedBy bool, rows ...string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".gomuxai")
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "gomuxai.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	agents := `CREATE TABLE agents (name TEXT PRIMARY KEY, session_name TEXT NOT NULL, backend TEXT NOT NULL,
		task_file TEXT, log_file TEXT, created_at TEXT NOT NULL`
	if withSpawnedBy {
		agents += `, spawned_by TEXT`
	}
	stmts := append([]string{agents + `)`,
		`CREATE TABLE state (agent_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
			updated_at TEXT NOT NULL, PRIMARY KEY (agent_name, key))`,
		`CREATE TABLE command_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL, parent TEXT NOT NULL,
			cwd TEXT NOT NULL, args TEXT NOT NULL, exit_code INTEGER NOT NULL, error TEXT NOT NULL, build TEXT NOT NULL)`,
	}, rows...)
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	return dir
}

func spawnRow(at, caller, cwd, argv string, exit int) string {
	return `INSERT INTO command_log (started_at,duration_ms,host,agent,parent,cwd,args,exit_code,error,build) VALUES ('` +
		at + `',1,'h','` + caller + `','','` + cwd + `','` + argv + `',` + map[bool]string{true: "0", false: "1"}[exit == 0] + `,'','b')`
}

// newGomuxTestWatcher: no tmux (sessions never attached), home pinned so the
// transcript allow-list is the test's.
func newGomuxTestWatcher(t *testing.T, home string, dirs ...string) *GomuxWatcher {
	t.Helper()
	w := NewGomuxWatcher(dirs)
	w.tmuxBin = ""
	w.agentBin = ""
	w.home = home
	return w
}

func gomuxByName(s gomuxSnapshot) map[string]gomuxAgent {
	m := map[string]gomuxAgent{}
	for _, a := range s.Agents {
		m[a.Name] = a
	}
	return m
}

func TestGomuxSnapshot_TreeAcrossStores(t *testing.T) {
	home := t.TempDir()
	proj := filepath.Join(home, ".claude", "projects", "-p")
	os.MkdirAll(proj, 0o755)
	coordT := filepath.Join(proj, "c.jsonl")
	os.WriteFile(coordT, []byte("{}\n{}\n"), 0o644)
	childT := filepath.Join(proj, "t1.jsonl")
	os.WriteFile(childT, []byte("{}\n"), 0o644)

	// Store A: a live coord (local-offset created_at) with reported state, and a
	// departed helper spawned by a person.
	a := gomuxFixtureStore(t, true,
		`INSERT INTO agents VALUES ('coord','agent-coord','claude','','','2026-10-24T20:28:43-05:00','')`,
		`INSERT INTO state VALUES ('coord','_status','processing','2026-10-24T20:57:33.68-05:00')`,
		`INSERT INTO state VALUES ('coord','_detail','Bash: rg foo','2026-10-24T20:57:33.68-05:00')`,
		`INSERT INTO state VALUES ('coord','_tool','Bash','2026-10-24T20:57:33.68-05:00')`,
		`INSERT INTO state VALUES ('coord','_transcript','`+coordT+`','2026-10-24T20:57:33.68-05:00')`,
		`INSERT INTO state VALUES ('coord','note','user keys are not reserved','2026-10-24T20:57:33.68-05:00')`,
		spawnRow("2026-10-25T01:28:43.772Z", "", "/w/coord", `["spawn","coord","--backend","claude"]`, 0),
		spawnRow("2026-10-24T23:00:00.000Z", "", "/w/old", `["spawn","old","--backend=agy"]`, 0),
		spawnRow("2026-10-24T23:00:01.000Z", "", "/w/x", `["spawn","failed"]`, 1),
	)
	// Store B (a dev build coord ran): its helper, recorded only here.
	b := gomuxFixtureStore(t, true,
		spawnRow("2026-10-25T01:41:31.002Z", "coord", "/w/coord", `["spawn","coord-t1","--backend","claude"]`, 0),
	)
	os.WriteFile(filepath.Join(b, "logs", "coord-t1.transcripts"),
		[]byte("claude\t/elsewhere/first.jsonl\nclaude\t"+childT+"\n"), 0o644)

	w := newGomuxTestWatcher(t, home, a, b)
	reached := map[string]int{}
	w.SetReachHook(func(dir string) { reached[dir]++ })
	w.discover()
	w.refresh()
	w.refresh()
	if reached["/w/coord"] != 1 || reached["/w/old"] != 1 || len(reached) != 2 {
		t.Errorf("each agent's cwd is handed to reach once: %v", reached)
	}
	s := w.Snapshot()
	got := gomuxByName(s)

	if len(s.Dirs) != 2 || len(s.Agents) != 3 {
		t.Fatalf("dirs=%v agents=%v", s.Dirs, s.Agents)
	}
	c := got["coord"]
	if !c.Live || c.Status != "processing" || c.Tool != "Bash" || c.Detail != "Bash: rg foo" ||
		c.Cwd != "/w/coord" || c.Harness != "claude" || c.TranscriptSize != 6 {
		t.Errorf("coord = %+v", c)
	}
	if c.CreatedAt != "2026-10-25T01:28:43.000Z" {
		t.Errorf("created_at not normalized to UTC: %s", c.CreatedAt)
	}
	if o := got["old"]; o.Live || o.Status != "exited" || o.Backend != "agy" || o.Harness != "agy" || o.Transcript != "" {
		t.Errorf("old = %+v", o)
	}
	if _, ok := got["failed"]; ok {
		t.Errorf("a failed spawn must not list")
	}
	k := got["coord-t1"]
	if k.Parent != "coord" || k.Transcript != childT || k.TranscriptSize != 3 || k.DataDir != b {
		t.Errorf("coord-t1 = %+v", k)
	}
	// Ordered by creation: old, coord, coord-t1.
	if s.Agents[0].Name != "old" || s.Agents[2].Name != "coord-t1" {
		t.Errorf("order = %v", s.Agents)
	}

	// A quiet tick changes nothing (gen holds); a transcript append does.
	gen := s.Gen
	w.refresh()
	if w.Snapshot().Gen != gen {
		t.Errorf("quiet refresh moved gen")
	}
	f, _ := os.OpenFile(childT, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("{}\n")
	f.Close()
	w.refresh()
	if s2 := w.Snapshot(); s2.Gen != gen+1 || gomuxByName(s2)["coord-t1"].TranscriptSize != 6 {
		t.Errorf("append not seen: gen %d→%d %+v", gen, s2.Gen, gomuxByName(s2)["coord-t1"])
	}
}

func TestGomuxSnapshot_PreSpawnedByStoreAndOutsideTranscript(t *testing.T) {
	home := t.TempDir()
	d := gomuxFixtureStore(t, false,
		`INSERT INTO agents VALUES ('a','agent-a','claude','','','2026-10-24T20:00:00Z')`,
		`INSERT INTO state VALUES ('a','_transcript','/etc/passwd','2026-10-24T20:00:00Z')`,
	)
	w := newGomuxTestWatcher(t, home, d)
	w.discover()
	w.refresh()
	a := gomuxByName(w.Snapshot())["a"]
	if !a.Live || a.Parent != "" || a.Transcript != "" {
		t.Errorf("a = %+v (an outside transcript must not be served)", a)
	}
}

func TestGomuxRead_ServesOnlyTheNamedTranscript(t *testing.T) {
	home := t.TempDir()
	proj := filepath.Join(home, ".claude", "projects", "-p")
	os.MkdirAll(proj, 0o755)
	tp := filepath.Join(proj, "s.jsonl")
	os.WriteFile(tp, []byte("{\"a\":1}\n{\"b\":2}\n"), 0o644)
	d := gomuxFixtureStore(t, true,
		`INSERT INTO agents VALUES ('a','agent-a','claude','','','2026-10-24T20:00:00Z','')`,
		`INSERT INTO state VALUES ('a','_transcript','`+tp+`','2026-10-24T20:00:00Z')`,
	)
	h, _, _ := newTestHandler(t)
	h.gomux = newGomuxTestWatcher(t, home, d)
	h.gomux.discover()
	h.gomux.refresh()

	write, c := captureRPC(t)
	h.handleGomuxRead(write, func([]byte) {}, json.RawMessage("1"), json.RawMessage(`{"name":"a","tailBytes":9}`))
	if c.Error != nil {
		t.Fatalf("read: %s", c.Error.Message)
	}
	var r agentSessionsReadResult
	json.Unmarshal(c.Result, &r)
	if r.ID != "a" || r.Content != "{\"b\":2}\n" || !r.Truncated || r.Offset != 8 {
		t.Errorf("window = %+v", r)
	}

	write, c = captureRPC(t)
	h.handleGomuxRead(write, func([]byte) {}, json.RawMessage("2"), json.RawMessage(`{"name":"nobody"}`))
	if c.Error == nil || !strings.Contains(c.Error.Message, "nobody") {
		t.Errorf("unknown agent should fail loud, got %+v", c)
	}

	write, c = captureRPC(t)
	h.handleGomuxList(write, json.RawMessage("3"), json.RawMessage(`{}`))
	var s gomuxSnapshot
	json.Unmarshal(c.Result, &s)
	if len(s.Agents) != 1 || s.Agents[0].Name != "a" {
		t.Errorf("list = %+v", s)
	}
}
