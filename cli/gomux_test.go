package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newGomuxTestWatcher(t *testing.T) *GomuxWatcher {
	t.Helper()
	return NewGomuxWatcher(nil, "")
}

func gomuxByName(s gomuxSnapshot) map[string]gomuxAgent {
	m := map[string]gomuxAgent{}
	for _, a := range s.Agents {
		m[a.Name] = a
	}
	return m
}

func mustApply(t *testing.T, w *GomuxWatcher, line string) {
	t.Helper()
	if err := w.applyLine([]byte(line)); err != nil {
		t.Fatalf("apply %s: %v", line, err)
	}
}

// exportFixture: two claude transcripts for export lines to name.
func exportFixture(t *testing.T) (coordT, childT string) {
	t.Helper()
	proj := filepath.Join(t.TempDir(), ".claude", "projects", "-p")
	os.MkdirAll(proj, 0o755)
	coordT = filepath.Join(proj, "c.jsonl")
	childT = filepath.Join(proj, "t1.jsonl")
	os.WriteFile(coordT, []byte("{}\n"), 0o644)
	os.WriteFile(childT, []byte("{}\n"), 0o644)
	return
}

func agentJSON(fields map[string]any) string {
	b, _ := json.Marshal(fields)
	return string(b)
}

func TestGomuxExport_SnapshotEventsAndStores(t *testing.T) {
	coordT, childT := exportFixture(t)
	w := newGomuxTestWatcher(t)
	var pushes []gomuxSnapshot
	w.SetNotifyHook(func(method string, params any) {
		if method == "gomux/changed" {
			pushes = append(pushes, params.(gomuxSnapshot))
		}
	})
	reached := map[string]int{}
	w.SetReachHook(func(dir string) { reached[dir]++ })

	coord := agentJSON(map[string]any{"name": "coord", "host": "h", "kind": "tmux", "run": 3, "backend": "claude",
		"session": "agent-coord", "store": "/s/a", "cwd": "/w/coord", "created_at": "2026-10-25T01:28:43Z",
		"live": true, "attached": true, "status": "processing", "detail": "Bash: rg foo", "tool": "Bash",
		"status_at": "2026-10-25T01:30:00.25Z", "session_id": "sid", "transcript": coordT, "dialect": "claude",
		"transcript_size": 3, "transcript_mtime": "2026-10-25T01:30:00.5Z"})
	old := agentJSON(map[string]any{"name": "old", "host": "h", "kind": "tmux", "run": 1, "backend": "agy",
		"session": "agent-old", "store": "/s/a", "cwd": "/w/old", "created_at": "2026-10-24T23:00:00Z",
		"ended_at": "2026-10-24T23:30:00Z", "live": false, "transcript": "/etc/passwd", "dialect": "agy"})
	mustApply(t, w, `{"type":"snapshot","host":"h","stores":[{"dir":"/s/a","this":true}],"agents":[`+coord+`,`+old+`]}`)

	s := w.Snapshot()
	got := gomuxByName(s)
	c := got["coord"]
	if !c.Live || !c.hasSession() || c.Status != "processing" || c.Detail != "Bash: rg foo" || c.Harness != "claude" ||
		c.DataDir != "/s/a" || c.Cwd != "/w/coord" || c.TranscriptSize != 3 || c.Run != 3 ||
		c.TranscriptMtime != time.Date(2026, 10, 25, 1, 30, 0, 5e8, time.UTC).UnixMilli() {
		t.Errorf("coord = %+v", c)
	}
	if o := got["old"]; o.Live || o.Status != "ended" || o.EndReason != "closed" || o.Harness != "agy" || o.Transcript != "/etc/passwd" || o.EndedAt == "" {
		t.Errorf("old = %+v (departed: ended (closed); export's transcript passes through)", o)
	}
	if s.Agents[0].Name != "old" || len(pushes) != 1 || len(s.Dirs) != 1 {
		t.Errorf("order/pushes/dirs: %v %d %v", s.Agents, len(pushes), s.Dirs)
	}
	if reached["/w/coord"] != 1 || reached["/w/old"] != 1 {
		t.Errorf("each cwd handed to reach once: %v", reached)
	}

	// a spawn in a store found mid-follow, then a status change, then a quiet repeat
	child := agentJSON(map[string]any{"name": "coord-t1", "host": "h", "kind": "tmux", "run": 1, "parent": "coord",
		"backend": "claude", "session": "agent-coord-t1", "store": "/s/b", "cwd": "/w/coord",
		"created_at": "2026-10-25T01:41:31Z", "live": true, "attached": true, "status": "idle",
		"transcript": childT, "dialect": "claude"})
	mustApply(t, w, `{"type":"store","store":{"dir":"/s/b","cursor":0,"events":false},"agents":[`+child+`]}`)
	k := gomuxByName(w.Snapshot())["coord-t1"]
	if k.Parent != "coord" || k.DataDir != "/s/b" || k.Transcript != childT {
		t.Errorf("coord-t1 = %+v", k)
	}
	if !strings.Contains(strings.Join(w.Snapshot().Dirs, ","), "/s/b") {
		t.Errorf("a store line adds its store: %v", w.Snapshot().Dirs)
	}
	waiting := strings.Replace(child, `"status":"idle"`, `"status":"waiting","tool_input":"{\"command\":\"ls\"}"`, 1)
	mustApply(t, w, `{"type":"changed","id":4,"store":"/s/b","at":"x","reason":"status","agent":`+waiting+`}`)
	if k := gomuxByName(w.Snapshot())["coord-t1"]; k.Status != "waiting" || k.ToolInput == "" {
		t.Errorf("changed: %+v", k)
	}
	n := len(pushes)
	mustApply(t, w, `{"type":"changed","store":"/s/b","at":"x","reason":"transcript","agent":`+waiting+`}`)
	if len(pushes) != n {
		t.Errorf("an unchanged agent pushes nothing (pushes %d → %d)", n, len(pushes))
	}

	// cleanup keeps the agent (with --all), now departed
	gone := strings.Replace(strings.Replace(waiting, `"live":true`, `"live":false,"ended_at":"2026-10-25T02:00:00Z"`, 1),
		`"attached":true`, `"attached":false`, 1)
	if !strings.Contains(gone, `"live":false`) || !strings.Contains(gone, `"attached":false`) {
		t.Fatal("fixture: live/attached not found to flip")
	}
	mustApply(t, w, `{"type":"removed","id":9,"store":"/s/b","at":"x","agent":`+gone+`}`)
	if k := gomuxByName(w.Snapshot())["coord-t1"]; k.Live || k.Status != "waiting" {
		t.Errorf("removed: %+v (keeps its last report, live=false)", k)
	}

	// a replacement store line drops the store's agents not listed again
	mustApply(t, w, `{"type":"store","store":{"dir":"/s/b"},"agents":[]}`)
	if _, ok := gomuxByName(w.Snapshot())["coord-t1"]; ok {
		t.Errorf("store line replaces that store's agents")
	}

	// unknown types fail loud
	if err := w.applyLine([]byte(`{"type":"mystery"}`)); err == nil {
		t.Errorf("an unknown line type must error")
	}
}

func TestGomuxExport_LiveBeatsDepartedNamesake(t *testing.T) {
	w := newGomuxTestWatcher(t)
	mustApply(t, w, `{"type":"snapshot","stores":[{"dir":"/a"},{"dir":"/b"}],"agents":[`+
		`{"name":"x","store":"/a","created_at":"2026-10-25T03:00:00Z","live":false},`+
		`{"name":"x","store":"/b","created_at":"2026-10-25T01:00:00Z","live":true,"status":"idle"}]}`)
	if x := gomuxByName(w.Snapshot())["x"]; !x.Live || x.DataDir != "/b" {
		t.Errorf("live namesake should win: %+v", x)
	}
}

// A claude agent's session id: export's when it reports one, else the transcript's name
// (Claude names it by the session); never guessed for another harness.
func TestGomuxExport_SessionIDFromTranscript(t *testing.T) {
	coordT, childT := exportFixture(t)
	w := newGomuxTestWatcher(t)
	mustApply(t, w, `{"type":"snapshot","stores":[{"dir":"/s"}],"agents":[`+
		agentJSON(map[string]any{"name": "said", "store": "/s", "live": true, "session_id": "sid", "transcript": coordT, "dialect": "claude"})+`,`+
		agentJSON(map[string]any{"name": "named", "store": "/s", "live": true, "transcript": childT, "dialect": "claude"})+`,`+
		agentJSON(map[string]any{"name": "outside", "store": "/s", "live": true, "transcript": "/etc/x.jsonl", "dialect": "claude"})+`,`+
		agentJSON(map[string]any{"name": "gem", "store": "/s", "live": true, "transcript": childT, "dialect": "agy"})+`]}`)
	got := gomuxByName(w.Snapshot())
	for name, want := range map[string]string{"said": "sid", "named": "t1", "outside": "x", "gem": ""} {
		if got[name].SessionID != want {
			t.Errorf("%s: sessionId %q, want %q", name, got[name].SessionID, want)
		}
	}
}

// The follower runs a real process: a fake `agent` printing a snapshot and a change.
func TestGomuxExport_FollowsAProcess(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "agent")
	body := "#!/bin/sh\n" +
		"[ \"$1\" = export ] || exit 3\n" +
		`echo '{"type":"snapshot","stores":[{"dir":"/a"}],"agents":[{"name":"p","store":"/a","live":true,"status":"idle"}]}'` + "\n" +
		`echo '{"type":"changed","store":"/a","reason":"status","agent":{"name":"p","store":"/a","live":true,"status":"processing"}}'` + "\n" +
		"sleep 30\n"
	os.WriteFile(script, []byte(body), 0o755)
	w := newGomuxTestWatcher(t)
	w.agent = script
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.Start(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p := gomuxByName(w.Snapshot())["p"]; p.Status == "processing" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("the follower never applied the change: %+v", w.Snapshot())
}

func TestGomuxList_ServesTheTree(t *testing.T) {
	h, _, _ := newTestHandler(t)
	h.gomux = newGomuxTestWatcher(t)
	mustApply(t, h.gomux, `{"type":"snapshot","stores":[{"dir":"/a"}],"agents":[{"name":"a","store":"/a","live":true}]}`)
	write, c := captureRPC(t)
	h.handleGomuxList(write, json.RawMessage("1"), json.RawMessage(`{}`))
	var s gomuxSnapshot
	json.Unmarshal(c.Result, &s)
	if len(s.Agents) != 1 || s.Agents[0].Name != "a" {
		t.Errorf("list = %+v", s)
	}
}

// Following the bus: another host's agents are served beside this one's, one node per
// (host, name) — a namesake on each host is two agents — and an `attached` the far host
// left out stays out (unknown, not false). Screens and reach stay this machine's.
func TestGomuxExport_OtherHostsBesideThisOne(t *testing.T) {
	w := newGomuxTestWatcher(t)
	reached := map[string]int{}
	w.SetReachHook(func(dir string) { reached[dir]++ })
	mustApply(t, w, `{"type":"snapshot","host":"workstation","stores":[{"dir":"/s"}],"agents":[`+
		`{"name":"helper","host":"workstation","store":"/s","cwd":"/w/here","session":"agent-helper","live":true,"attached":true,"status":"idle","created_at":"2026-11-15T01:00:00Z"}]}`)
	mustApply(t, w, `{"type":"host","host":{"host":"laptop","agents":2},"agents":[`+
		`{"name":"helper","host":"laptop","cwd":"/w/there","session":"agent-helper","live":true,"status":"processing","created_at":"2026-11-15T02:00:00Z"},`+
		`{"name":"gone","host":"laptop","live":true,"attached":false,"status":"idle","created_at":"2026-11-15T03:00:00Z"}]}`)

	s := w.Snapshot()
	if s.Host != "workstation" {
		t.Errorf("the snapshot names this machine: %q", s.Host)
	}
	by := map[string]gomuxAgent{}
	for _, a := range s.Agents {
		by[a.Name+"@"+a.Host] = a
	}
	here, there, gone := by["helper@workstation"], by["helper@laptop"], by["gone@laptop"]
	if len(s.Agents) != 3 || here.DataDir != "/s" || !here.hasSession() || there.Status != "processing" || there.DataDir != "" {
		t.Fatalf("both helpers served, each its own host's: %+v", s.Agents)
	}
	if there.Attached != nil || there.hasSession() {
		t.Errorf("an attached the far host left out is unknown, not false: %v", there.Attached)
	}
	if gone.Attached == nil || *gone.Attached {
		t.Errorf("a stated attached:false stays false: %v", gone.Attached)
	}
	b, _ := json.Marshal(there)
	if strings.Contains(string(b), `"attached"`) {
		t.Errorf("the node leaves an unknown attached out: %s", b)
	}
	if b, _ := json.Marshal(gone); !strings.Contains(string(b), `"attached":false`) {
		t.Errorf("the node says a stated false: %s", b)
	}
	if reached["/w/here"] != 1 || reached["/w/there"] != 0 {
		t.Errorf("only this machine's cwds widen reach: %v", reached)
	}
	if a, ok := w.localAgent("helper"); !ok || a.Host != "workstation" {
		t.Errorf("a screen's agent is this machine's, never a far namesake: %+v", a)
	}
	if _, ok := w.localAgent("gone"); ok {
		t.Errorf("a far agent has no screen here")
	}

	// a host line replaces that host's agents, leaving this one's
	mustApply(t, w, `{"type":"host","host":{"host":"laptop","agents":0},"agents":[]}`)
	if s := w.Snapshot(); len(s.Agents) != 1 || s.Agents[0].Host != "workstation" {
		t.Errorf("host line replaces only that host's agents: %+v", s.Agents)
	}
}

// --gomuxai-hosts rides to export as --hosts; without it export lists this machine only.
func TestGomuxExport_HostsFlagReachesExport(t *testing.T) {
	dir := t.TempDir()
	argsOut := filepath.Join(dir, "args")
	script := filepath.Join(dir, "agent")
	os.WriteFile(script, []byte("#!/bin/sh\necho \"$@\" > '"+argsOut+"'\n"+
		`echo '{"type":"snapshot","host":"workstation","stores":[],"agents":[]}'`+"\nsleep 30\n"), 0o755)
	for hosts, want := range map[string]string{"all": "export --json --follow --all -q --hosts all", "": "export --json --follow --all -q"} {
		w := NewGomuxWatcher(nil, hosts)
		w.agent = script
		os.Remove(argsOut)
		ctx, cancel := context.WithCancel(context.Background())
		w.Start(ctx)
		deadline := time.Now().Add(5 * time.Second)
		for w.Snapshot().Host == "" && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
		got, _ := os.ReadFile(argsOut)
		if strings.TrimSpace(string(got)) != want {
			t.Errorf("hosts %q: export ran with %q, want %q", hosts, strings.TrimSpace(string(got)), want)
		}
	}
}

func TestGomuxExport_NamespaceDefaultsToAgentsOnThisHostOnly(t *testing.T) {
	w := newGomuxTestWatcher(t)
	mustApply(t, w, `{"type":"snapshot","host":"workstation","stores":[{"dir":"/s"}],"agents":[`+
		`{"name":"def","host":"workstation","store":"/s","session":"agent-def","live":true,"attached":true,"status":"idle","created_at":"2026-11-15T01:00:00Z"},`+
		`{"name":"custom","host":"workstation","store":"/s","session":"agent-custom","namespace":"agents-ci","live":true,"attached":true,"status":"idle","created_at":"2026-11-15T01:01:00Z"}]}`)
	mustApply(t, w, `{"type":"host","host":{"host":"remote","agents":1},"agents":[`+
		`{"name":"far","host":"remote","session":"agent-far","live":true,"status":"idle","created_at":"2026-11-15T01:02:00Z"}]}`)

	by := gomuxByName(w.Snapshot())
	if by["def"].Namespace != "agents" {
		t.Errorf("local default Namespace = %q, want \"agents\"", by["def"].Namespace)
	}
	if by["custom"].Namespace != "agents-ci" {
		t.Errorf("local explicit Namespace = %q, want \"agents-ci\"", by["custom"].Namespace)
	}
	if by["far"].Namespace != "" {
		t.Errorf("remote omitted Namespace = %q, want empty", by["far"].Namespace)
	}
}

func TestGomuxResizeCommandRemoved(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := newRelayTestServer(t, r)
	ws := dialTestController(t, srv, r.Token())
	if err := ws.WriteMessage(1, []byte(`{"relay":"gomux.resize","name":"w","cols":100,"rows":30}`)); err != nil {
		t.Fatal(err)
	}
	_, resp, err := ws.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(resp), "unknown relay command: gomux.resize") {
		t.Fatalf("gomux.resize reply = %s, want unknown relay command", resp)
	}
}
