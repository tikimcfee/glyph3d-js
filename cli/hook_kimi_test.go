package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// hookTestServer stands up a relay-end websocket: answers the hookConnect handshake
// ("ping" → ack+pong), echoes "ok" to every command, and queues each command frame
// (never the ping) on the returned channel.
func hookTestServer(t *testing.T) (*websocket.Conn, <-chan string) {
	t.Helper()
	up := websocket.Upgrader{}
	msgs := make(chan string, 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			_, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			if string(m) == "ping" {
				c.WriteMessage(websocket.TextMessage, []byte("OK: connected as ctrl-1"))
				c.WriteMessage(websocket.TextMessage, []byte("pong"))
				continue
			}
			msgs <- string(m)
			c.WriteMessage(websocket.TextMessage, []byte("ok"))
		}
	}))
	t.Cleanup(srv.Close)
	conn, err := hookConnect("ws" + strings.TrimPrefix(srv.URL, "http"))
	if err != nil {
		t.Fatalf("hookConnect: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, msgs
}

// drainMsgs collects whatever arrives within wait (a hook writes synchronously, so
// anything not here by then isn't coming).
func drainMsgs(msgs <-chan string, wait time.Duration) []string {
	var out []string
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case m := <-msgs:
			out = append(out, m)
		case <-timer.C:
			return out
		}
	}
}

// decodeCall unwraps the `call <base64(argvJSON)>` framing sendTool/sendMessage/
// sendAgentMeta/sendKimiWire share.
func decodeCall(t *testing.T, msg string) []string {
	t.Helper()
	if !strings.HasPrefix(msg, "call ") {
		t.Fatalf("not a call frame: %q", msg)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(msg, "call "))
	if err != nil {
		t.Fatalf("call b64: %v", err)
	}
	var argv []string
	if err := json.Unmarshal(raw, &argv); err != nil {
		t.Fatalf("call argv: %v", err)
	}
	return argv
}

func TestKimiAgentIdForSession(t *testing.T) {
	// LOCKSTEP with sessionAdapter.js kimiAgentIdForSession — cases mirror
	// tools/kimiSessionAdapter.test.mjs.
	cases := map[string]string{
		"session_474cf46e-c317-40eb-ae0e-e02cd9aaa074": "474cf46e",
		"474cf46e-c317": "474cf46e",
		"session_":      "kimi",
		"":              "kimi",
		"session_a-b-c": "abc",
	}
	for in, want := range cases {
		if got := kimiAgentIdForSession(in); got != want {
			t.Errorf("kimiAgentIdForSession(%q): got %q, want %q", in, got, want)
		}
	}
}

// writeKimiIndex lays down a session_index.jsonl with the given entries.
func writeKimiIndex(t *testing.T, entries ...map[string]string) string {
	t.Helper()
	var data []byte
	for _, e := range entries {
		line, _ := json.Marshal(e)
		data = append(data, line...)
		data = append(data, '\n')
	}
	data = append(data, []byte("not json at all\n")...) // malformed lines drop
	indexPath := filepath.Join(t.TempDir(), "session_index.jsonl")
	if err := os.WriteFile(indexPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return indexPath
}

func TestKimiWirePathForSession(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "wd_x", "session_abc")
	indexPath := writeKimiIndex(t,
		map[string]string{"sessionId": "session_other", "sessionDir": filepath.Join(home, "other"), "workDir": "/x"},
		map[string]string{"sessionId": "session_abc", "sessionDir": dir, "workDir": "/proj"},
	)

	wire, err := kimiWirePathForSession(indexPath, "session_abc")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if want := filepath.Join(dir, "agents", "main", "wire.jsonl"); wire != want {
		t.Errorf("wire: got %q, want %q", wire, want)
	}

	if _, err := kimiWirePathForSession(indexPath, "session_nope"); err == nil {
		t.Error("unknown session id must error")
	}
	if _, err := kimiWirePathForSession(filepath.Join(t.TempDir(), "absent.jsonl"), "session_abc"); err == nil {
		t.Error("absent index must error")
	}
}

func TestKimiWirePathForSession_Containment(t *testing.T) {
	// A sessionDir whose final component cleans away ("rel/.." → ".") would resolve
	// the wire OUTSIDE the session dir — reject rather than read it.
	indexPath := writeKimiIndex(t,
		map[string]string{"sessionId": "session_evil", "sessionDir": "rel/..", "workDir": "/proj"},
	)
	if _, err := kimiWirePathForSession(indexPath, "session_evil"); err == nil {
		t.Error("wire path escaping the session dir must error")
	}
}

func TestTailWireLines_FirstSightReplays(t *testing.T) {
	dir := t.TempDir()
	wire := filepath.Join(dir, "wire.jsonl")
	cursor := filepath.Join(dir, "c.cursor")
	if err := os.WriteFile(wire, []byte("l1\nl2\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var sent []string
	send := func(line []byte) { sent = append(sent, string(line)) }

	// First sight REPLAYS from offset 0 (the kimi tail is the only ingress — the
	// payload carries no events), landing the cursor at EOF.
	tailWireLines(cursor, wire, send)
	if len(sent) != 2 || sent[0] != "l1" || sent[1] != "l2" {
		t.Fatalf("first sight replay: got %v, want [l1 l2]", sent)
	}
	cur, err := os.ReadFile(cursor)
	if err != nil || strings.TrimSpace(string(cur)) != "6" {
		t.Fatalf("cursor after first sight: %q err=%v, want 6", cur, err)
	}

	// New complete lines forward; a torn tail waits for its newline.
	appendWire := func(s string) {
		f, _ := os.OpenFile(wire, os.O_APPEND|os.O_WRONLY, 0o600)
		defer f.Close()
		f.WriteString(s)
	}
	appendWire("l3\n")
	tailWireLines(cursor, wire, send)
	if len(sent) != 3 || sent[2] != "l3" {
		t.Fatalf("second flush: got %v, want [l1 l2 l3]", sent)
	}
	appendWire("part")
	tailWireLines(cursor, wire, send)
	if len(sent) != 3 {
		t.Fatalf("torn line must not forward: got %v", sent)
	}
	appendWire("-done\n")
	tailWireLines(cursor, wire, send)
	if len(sent) != 4 || sent[3] != "part-done" {
		t.Fatalf("completed line: got %v, want [l1 l2 l3 part-done]", sent)
	}
}

func TestForwardConversation_MetaOncePerSession(t *testing.T) {
	conn, msgs := hookTestServer(t)
	t.Setenv("TMPDIR", t.TempDir())
	transcript := filepath.Join(t.TempDir(), "sess.jsonl")
	head := `{"type":"user","slug":"my-session","cwd":"/proj","gitBranch":"main","message":{"role":"user","content":"hi"}}` + "\n" +
		`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hello"}]}}` + "\n" +
		`{"type":"ai-title","aiTitle":"Doing things","sessionId":"abcd1234-5678"}` + "\n"
	if err := os.WriteFile(transcript, []byte(head), 0o600); err != nil {
		t.Fatal(err)
	}
	event := &HookEvent{SessionID: "abcd1234-5678", TranscriptPath: transcript}

	// FIRST SIGHT: exactly one command — agent.meta — and no conversation dump.
	forwardConversation(conn, event)
	got := drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("first sight: got %d commands %v, want 1 (agent.meta)", len(got), got)
	}
	argv := decodeCall(t, got[0])
	if len(argv) != 3 || argv[0] != "agent.meta" || argv[1] != "abcd1234" {
		t.Fatalf("agent.meta argv: %v", argv)
	}
	var meta map[string]string
	if err := json.Unmarshal([]byte(argv[2]), &meta); err != nil {
		t.Fatalf("meta json: %v", err)
	}
	want := map[string]string{
		"harness": "claude", "slug": "my-session", "title": "Doing things",
		"model": "claude-opus-4-8", "cwd": "/proj", "gitBranch": "main",
	}
	for k, v := range want {
		if meta[k] != v {
			t.Errorf("meta[%s]: got %q, want %q (full: %v)", k, meta[k], v, meta)
		}
	}

	// SECOND poke: the appended line forwards as agent.message; meta does NOT repeat.
	f, _ := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"more"}]}}` + "\n")
	f.Close()
	forwardConversation(conn, event)
	got = drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("second poke: got %d commands %v, want 1 (agent.message)", len(got), got)
	}
	argv = decodeCall(t, got[0])
	if len(argv) != 5 || argv[0] != "agent.message" || argv[1] != "abcd1234" || argv[3] != "text" || argv[4] != "more" {
		t.Fatalf("agent.message argv: %v", argv)
	}
}

func TestForwardKimiWire_ShipsRawLinesThenStop(t *testing.T) {
	conn, msgs := hookTestServer(t)
	t.Setenv("TMPDIR", t.TempDir())
	home := t.TempDir()
	sid := "session_474cf46e-c317-40eb-ae0e-e02cd9aaa074"
	dir := filepath.Join(home, "sessions", "wd_x", sid)
	wire := kimiWirePath(dir)
	if err := os.MkdirAll(filepath.Dir(wire), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wire, []byte("{\"type\":\"metadata\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	indexPath := writeKimiIndex(t, map[string]string{"sessionId": sid, "sessionDir": dir, "workDir": "/proj"})
	saved := kimiIndexPath
	kimiIndexPath = func() string { return indexPath }
	defer func() { kimiIndexPath = saved }()

	event := &HookEvent{SessionID: sid, EventName: "PostToolUse", CWD: "/proj"}

	// First sight REPLAYS the existing wire line raw, base64'd, under the mirrored lane id.
	forwardKimiWire(conn, event)
	got := drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("first sight: got %d commands %v, want 1 (replay)", len(got), got)
	}
	argv := decodeCall(t, got[0])
	if len(argv) != 3 || argv[0] != "agent.kimi-wire" || argv[1] != "474cf46e" {
		t.Fatalf("first-sight agent.kimi-wire argv: %v", argv)
	}
	if raw, _ := base64.StdEncoding.DecodeString(argv[2]); string(raw) != `{"type":"metadata"}` {
		t.Fatalf("first-sight payload: %q", raw)
	}

	// A new wire line ships raw, base64'd, under the mirrored lane id.
	f, _ := os.OpenFile(wire, os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString("{\"type\":\"tool.call\",\"n\":1}\n")
	f.Close()
	forwardKimiWire(conn, event)
	got = drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("post tool: got %d commands %v, want 1", len(got), got)
	}
	argv = decodeCall(t, got[0])
	if len(argv) != 3 || argv[0] != "agent.kimi-wire" || argv[1] != "474cf46e" {
		t.Fatalf("agent.kimi-wire argv: %v", argv)
	}
	raw, err := base64.StdEncoding.DecodeString(argv[2])
	if err != nil || string(raw) != "{\"type\":\"tool.call\",\"n\":1}" {
		t.Fatalf("wire payload: %q err=%v", raw, err)
	}

	// Stop: final flush (nothing new here) + plain-text agent.stop on the same lane.
	handleKimiStop(conn, event)
	got = drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 || got[0] != "agent.stop 474cf46e" {
		t.Fatalf("stop: got %v, want [agent.stop 474cf46e]", got)
	}
}
