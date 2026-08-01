package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// rpcCapture decodes the single JSON-RPC frame a handler writes, exposing
// whichever side (result or error) it carried.
type rpcCapture struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// captureRPC returns a writeFn that decodes the handler's response into the
// returned capture. Handlers invoked directly (not via Handle's goroutine)
// write synchronously, so the capture is filled when the handler returns.
func captureRPC(t *testing.T) (writeFn, *rpcCapture) {
	t.Helper()
	c := &rpcCapture{}
	return func(data []byte) {
		if err := json.Unmarshal(data, c); err != nil {
			t.Fatalf("bad rpc frame: %v", err)
		}
	}, c
}

// newSessionsHandler roots a handler at a temp project and points its
// sessionsDir at a controlled temp transcript dir.
func newSessionsHandler(t *testing.T) (*FSHandler, string) {
	t.Helper()
	h, _, _ := newTestHandler(t)
	dir := t.TempDir()
	h.sessionsDir = dir
	return h, dir
}

func writeSession(t *testing.T, dir, name, body string, mtime time.Time) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(full, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func listSessions(t *testing.T, h *FSHandler) agentSessionsListResult {
	t.Helper()
	write, c := captureRPC(t)
	h.handleAgentSessionsList(write, json.RawMessage("1"), json.RawMessage("{}"))
	if c.Error != nil {
		t.Fatalf("list error: %d %s", c.Error.Code, c.Error.Message)
	}
	var r agentSessionsListResult
	if err := json.Unmarshal(c.Result, &r); err != nil {
		t.Fatalf("decode list result: %v", err)
	}
	return r
}

func readSession(t *testing.T, h *FSHandler, params string) (*agentSessionsReadResult, *rpcCapture) {
	t.Helper()
	write, c := captureRPC(t)
	h.handleAgentSessionsRead(write, json.RawMessage("1"), json.RawMessage(params))
	if c.Error != nil {
		return nil, c
	}
	var r agentSessionsReadResult
	if err := json.Unmarshal(c.Result, &r); err != nil {
		t.Fatalf("decode read result: %v", err)
	}
	return &r, c
}

func TestEncodeClaudeProjectDir(t *testing.T) {
	// Pairs verified against real ~/.claude/projects entries: every character
	// outside [A-Za-z0-9] becomes '-' (slashes, underscores, dots alike).
	cases := map[string]string{
		"/home/ivan/dev/glyph3d-js":       "-home-ivan-dev-glyph3d-js",
		"/home/ivan/dev/media_gen":        "-home-ivan-dev-media-gen",
		"/home/ivan/dev/_public/graphify": "-home-ivan-dev--public-graphify",
		"/a/b.c":                          "-a-b-c",
	}
	for in, want := range cases {
		if got := encodeClaudeProjectDir(in); got != want {
			t.Errorf("encode(%q): got %q, want %q", in, got, want)
		}
	}
}

func TestAgentSessionsList_AbsentDir(t *testing.T) {
	h, _ := newSessionsHandler(t)
	h.sessionsDir = filepath.Join(t.TempDir(), "does-not-exist")

	r := listSessions(t, h)
	if len(r.Sessions) != 0 {
		t.Errorf("absent dir: got %d sessions, want 0", len(r.Sessions))
	}
	if r.Dir == "" {
		t.Error("absent dir: Dir should still report the derived path")
	}
}

func TestAgentSessionsList_NewestFirstJSONLOnly(t *testing.T) {
	h, dir := newSessionsHandler(t)
	older := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	newer := time.Now().Add(-1 * time.Hour).Truncate(time.Second)
	writeSession(t, dir, "aaaa-1111.jsonl", "{}\n", older)
	writeSession(t, dir, "bbbb-2222.jsonl", "{}\n{}\n", newer)
	writeSession(t, dir, "notes.txt", "not a transcript", newer)
	writeSession(t, dir, "weird name.jsonl", "{}\n", newer) // outside the id alphabet
	if err := os.Mkdir(filepath.Join(dir, "cccc-3333"), 0o755); err != nil {
		t.Fatal(err) // Claude Code keeps sibling per-session dirs; they must not list
	}

	r := listSessions(t, h)
	if len(r.Sessions) != 2 {
		t.Fatalf("got %d sessions, want 2: %+v", len(r.Sessions), r.Sessions)
	}
	if r.Sessions[0].ID != "bbbb-2222" || r.Sessions[1].ID != "aaaa-1111" {
		t.Errorf("order: got [%s %s], want [bbbb-2222 aaaa-1111]", r.Sessions[0].ID, r.Sessions[1].ID)
	}
	if r.Sessions[0].Mtime != newer.UnixMilli() {
		t.Errorf("mtime: got %d, want %d", r.Sessions[0].Mtime, newer.UnixMilli())
	}
	if r.Sessions[1].Size != 3 {
		t.Errorf("size: got %d, want 3", r.Sessions[1].Size)
	}
}

func TestAgentSessionsRead_Full(t *testing.T) {
	h, dir := newSessionsHandler(t)
	body := "{\"a\":1}\n{\"b\":2}\n"
	mt := time.Now().Add(-time.Hour).Truncate(time.Second)
	writeSession(t, dir, "abc-123.jsonl", body, mt)

	r, c := readSession(t, h, `{"id":"abc-123"}`)
	if r == nil {
		t.Fatalf("read error: %+v", c.Error)
	}
	if r.Content != body {
		t.Errorf("content: got %q, want %q", r.Content, body)
	}
	if r.Truncated {
		t.Error("full read must not report truncated")
	}
	if r.Size != int64(len(body)) || r.Mtime != mt.UnixMilli() {
		t.Errorf("stat: got size=%d mtime=%d, want size=%d mtime=%d", r.Size, r.Mtime, len(body), mt.UnixMilli())
	}
}

func TestAgentSessionsRead_TailAlignsToLine(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "aaaa\nbbbb\ncccc\n", time.Now())

	// tailBytes=8 lands mid-"bbbb" — content must start at the next line.
	r, c := readSession(t, h, `{"id":"abc-123","tailBytes":8}`)
	if r == nil {
		t.Fatalf("read error: %+v", c.Error)
	}
	if r.Content != "cccc\n" {
		t.Errorf("tail content: got %q, want %q", r.Content, "cccc\n")
	}
	if !r.Truncated {
		t.Error("tail read must report truncated")
	}
	if r.Size != 15 {
		t.Errorf("size must describe the whole file: got %d, want 15", r.Size)
	}
}

func TestAgentSessionsRead_TailWholeFileNotTruncated(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "aaaa\nbbbb\n", time.Now())

	// A tail request covering the whole file is just a full read.
	r, c := readSession(t, h, `{"id":"abc-123","tailBytes":9999}`)
	if r == nil {
		t.Fatalf("read error: %+v", c.Error)
	}
	if r.Content != "aaaa\nbbbb\n" || r.Truncated {
		t.Errorf("whole-file tail: got content=%q truncated=%v", r.Content, r.Truncated)
	}
}

func TestAgentSessionsRead_TailNoNewlineIsEmpty(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "aaaa\nbbbb", time.Now())

	// The 3-byte window is the torn end of one line — nothing whole to return.
	r, c := readSession(t, h, `{"id":"abc-123","tailBytes":3}`)
	if r == nil {
		t.Fatalf("read error: %+v", c.Error)
	}
	if r.Content != "" || !r.Truncated {
		t.Errorf("torn-line tail: got content=%q truncated=%v, want empty+truncated", r.Content, r.Truncated)
	}
}

func TestAgentSessionsRead_CapBoundsFullRead(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "aaaa\nbbbb\ncccc\n", time.Now())

	saved := maxSessionReadSize
	maxSessionReadSize = 10
	defer func() { maxSessionReadSize = saved }()

	r, c := readSession(t, h, `{"id":"abc-123"}`)
	if r == nil {
		t.Fatalf("read error: %+v", c.Error)
	}
	if r.Content != "cccc\n" || !r.Truncated {
		t.Errorf("capped read: got content=%q truncated=%v, want %q+truncated", r.Content, r.Truncated, "cccc\n")
	}
}

func TestAgentSessionsRead_RejectsBadIDs(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "{}\n", time.Now())

	for _, id := range []string{"../abc-123", "a/b", "abc.123", "", "a b"} {
		params, _ := json.Marshal(map[string]string{"id": id})
		r, c := readSession(t, h, string(params))
		if r != nil {
			t.Errorf("id %q: expected rejection, got content %q", id, r.Content)
			continue
		}
		if c.Error.Code != -32602 {
			t.Errorf("id %q: got code %d, want -32602", id, c.Error.Code)
		}
	}
}

func TestAgentSessionsRead_NotFound(t *testing.T) {
	h, _ := newSessionsHandler(t)

	r, c := readSession(t, h, `{"id":"no-such-session"}`)
	if r != nil {
		t.Fatalf("expected not-found, got %+v", r)
	}
	if c.Error.Code != errFileNotFound {
		t.Errorf("got code %d, want %d", c.Error.Code, errFileNotFound)
	}
}

func TestAgentSessionsRead_NegativeTailRejected(t *testing.T) {
	h, dir := newSessionsHandler(t)
	writeSession(t, dir, "abc-123.jsonl", "{}\n", time.Now())

	r, c := readSession(t, h, `{"id":"abc-123","tailBytes":-1}`)
	if r != nil {
		t.Fatalf("expected rejection, got %+v", r)
	}
	if c.Error.Code != -32602 {
		t.Errorf("got code %d, want -32602", c.Error.Code)
	}
}
