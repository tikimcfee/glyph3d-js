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

// newGomuxTestWatcher: home pinned so the transcript allow-list is the test's.
func newGomuxTestWatcher(t *testing.T, home string) *GomuxWatcher {
	t.Helper()
	w := NewGomuxWatcher(nil)
	w.tmuxBin = ""
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

func mustApply(t *testing.T, w *GomuxWatcher, line string) {
	t.Helper()
	if err := w.applyLine([]byte(line)); err != nil {
		t.Fatalf("apply %s: %v", line, err)
	}
}

// exportFixture: a home with two claude transcripts, and export lines over two stores.
func exportFixture(t *testing.T) (home, coordT, childT string) {
	t.Helper()
	home = t.TempDir()
	proj := filepath.Join(home, ".claude", "projects", "-p")
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
	home, coordT, childT := exportFixture(t)
	w := newGomuxTestWatcher(t, home)
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
	if !c.Live || !c.Attached || c.Status != "processing" || c.Detail != "Bash: rg foo" || c.Harness != "claude" ||
		c.DataDir != "/s/a" || c.Cwd != "/w/coord" || c.TranscriptSize != 3 || c.Run != 3 ||
		c.TranscriptMtime != time.Date(2026, 10, 25, 1, 30, 0, 5e8, time.UTC).UnixMilli() {
		t.Errorf("coord = %+v", c)
	}
	if o := got["old"]; o.Live || o.Status != "exited" || o.Harness != "agy" || o.Transcript != "" || o.EndedAt == "" {
		t.Errorf("old = %+v (departed: exited; a transcript outside the harness homes isn't served)", o)
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

	// another host's agents (no store) aren't served; unknown types fail loud
	mustApply(t, w, `{"type":"host","host":{"host":"mac","agents":1},"agents":[{"name":"far","host":"mac","live":true,"status":"idle"}]}`)
	if _, ok := gomuxByName(w.Snapshot())["far"]; ok {
		t.Errorf("another host's agent has no transcript or screen to serve")
	}
	if err := w.applyLine([]byte(`{"type":"mystery"}`)); err == nil {
		t.Errorf("an unknown line type must error")
	}
}

func TestGomuxExport_LiveBeatsDepartedNamesake(t *testing.T) {
	w := newGomuxTestWatcher(t, t.TempDir())
	mustApply(t, w, `{"type":"snapshot","stores":[{"dir":"/a"},{"dir":"/b"}],"agents":[`+
		`{"name":"x","store":"/a","created_at":"2026-10-25T03:00:00Z","live":false},`+
		`{"name":"x","store":"/b","created_at":"2026-10-25T01:00:00Z","live":true,"status":"idle"}]}`)
	if x := gomuxByName(w.Snapshot())["x"]; !x.Live || x.DataDir != "/b" {
		t.Errorf("live namesake should win: %+v", x)
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
	w := newGomuxTestWatcher(t, t.TempDir())
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

func TestGomuxRead_ServesOnlyTheNamedTranscript(t *testing.T) {
	home := t.TempDir()
	proj := filepath.Join(home, ".claude", "projects", "-p")
	os.MkdirAll(proj, 0o755)
	tp := filepath.Join(proj, "s.jsonl")
	os.WriteFile(tp, []byte("{\"a\":1}\n{\"b\":2}\n"), 0o644)
	h, _, _ := newTestHandler(t)
	h.gomux = newGomuxTestWatcher(t, home)
	mustApply(t, h.gomux, `{"type":"snapshot","stores":[{"dir":"/a"}],"agents":[{"name":"a","store":"/a","live":true,"transcript":`+
		string(mustJSON(t, tp))+`,"dialect":"claude"}]}`)

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
