package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// agyFixture is a temp Antigravity CLI home (h.agyHome): brain dirs with
// transcripts, a history.jsonl, subagent descriptors and annotation titles.
type agyFixture struct {
	t    *testing.T
	home string
}

func newAgyFixture(t *testing.T, h *FSHandler) *agyFixture {
	t.Helper()
	f := &agyFixture{t: t, home: t.TempDir()}
	h.agyHome = f.home
	return f
}

func (f *agyFixture) transcript(id, body string, mtime time.Time) {
	f.t.Helper()
	p := agyTranscriptPath(f.home, id)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		f.t.Fatal(err)
	}
}

func (f *agyFixture) file(rel, body string) {
	f.t.Helper()
	p := filepath.Join(f.home, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func historyLine(t *testing.T, fields map[string]string) string {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

// A conversation is attributed to the root by history.jsonl (typed prompts) or
// by a parent's subagent descriptor (workspaceUris); other workspaces, history
// lines without a conversationId, and brain dirs without a transcript stay out.
func TestAgentSessionsList_AgyAttribution(t *testing.T) {
	h, _ := newSessionsHandler(t)
	h.kimiIndex = ""
	f := newAgyFixture(t, h)
	older := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	newer := time.Now().Add(-1 * time.Hour).Truncate(time.Second)

	f.transcript("aaaa-main", "{}\n", older)    // typed in the root
	f.transcript("bbbb-sub", "{}\n", newer)     // subagent working in the root
	f.transcript("cccc-other", "{}\n", newer)   // typed in another workspace
	f.transcript("dddd-unnamed", "{}\n", newer) // its only history line has no conversationId
	// eeee-empty: attributed, but its brain dir has no transcript.
	f.file(filepath.Join("brain", "eeee-empty", "scratch", ".keep"), "")

	f.file("history.jsonl",
		historyLine(t, map[string]string{"display": "first", "workspace": h.root})+ // no id: unattributable
			historyLine(t, map[string]string{"display": "go", "workspace": h.root + "/", "conversationId": "aaaa-main"})+
			historyLine(t, map[string]string{"display": "x", "workspace": "/some/other/root", "conversationId": "cccc-other"})+
			historyLine(t, map[string]string{"display": "y", "workspace": h.root, "conversationId": "eeee-empty"})+
			"{torn line\n")
	sub, _ := json.Marshal(map[string]any{
		"conversationId":     "bbbb-sub",
		"subagentDescriptor": map[string]string{"typeName": "self", "role": "Renderer Expert"},
		"workspaceUris":      []string{"file://" + filepath.ToSlash(h.root)},
	})
	f.file(filepath.Join("brain", "aaaa-main", ".system_generated", "subagents", "bbbb-sub.json"), string(sub))
	f.file(filepath.Join("annotations", "aaaa-main.pbtxt"), `title:"Port the \"renderer\""`)

	r := listSessions(t, h)
	var got []string
	for _, s := range r.Sessions {
		if s.Harness != "agy" {
			t.Errorf("unexpected harness %q for %s", s.Harness, s.ID)
		}
		got = append(got, s.ID)
	}
	if len(got) != 2 || got[0] != "bbbb-sub" || got[1] != "aaaa-main" {
		t.Fatalf("agy list: got %v, want [bbbb-sub aaaa-main] (newest first)", got)
	}

	// Read: cwd is the root, title from the annotation (escapes decoded) or the
	// subagent's role.
	rm, c := readSession(t, h, `{"id":"aaaa-main","harness":"agy"}`)
	if rm == nil {
		t.Fatalf("read aaaa-main: %+v", c.Error)
	}
	if rm.Cwd != h.root || rm.Title != `Port the "renderer"` || rm.Content != "{}\n" {
		t.Errorf("read aaaa-main: got cwd=%q title=%q content=%q", rm.Cwd, rm.Title, rm.Content)
	}
	rs, c := readSession(t, h, `{"id":"bbbb-sub","harness":"agy"}`)
	if rs == nil {
		t.Fatalf("read bbbb-sub: %+v", c.Error)
	}
	if rs.Title != "Renderer Expert" {
		t.Errorf("subagent title: got %q, want the role", rs.Title)
	}

	// Another workspace's conversation doesn't resolve here, nor under claude.
	if r, c := readSession(t, h, `{"id":"cccc-other","harness":"agy"}`); r != nil || c.Error.Code != errFileNotFound {
		t.Errorf("other-workspace id: want not-found, got %+v / %+v", r, c.Error)
	}
	if r, _ := readSession(t, h, `{"id":"aaaa-main"}`); r != nil {
		t.Errorf("agy id must not resolve under the default (claude) harness: %+v", r)
	}
}

func TestAgentSessionsRead_AgyTailAndBinaryTitle(t *testing.T) {
	h, _ := newSessionsHandler(t)
	f := newAgyFixture(t, h)
	f.transcript("aaaa-main", "aaaa\nbbbb\ncccc\n", time.Now())
	f.file("history.jsonl", historyLine(t, map[string]string{"workspace": h.root, "conversationId": "aaaa-main"}))
	f.file(filepath.Join("annotations", "aaaa-main.pbtxt"), `title:"T"`)

	r, c := readSession(t, h, `{"id":"aaaa-main","harness":"agy","tailBytes":8}`)
	if r == nil {
		t.Fatalf("tail read: %+v", c.Error)
	}
	if r.Content != "cccc\n" || !r.Truncated {
		t.Errorf("agy tail: got content=%q truncated=%v", r.Content, r.Truncated)
	}

	writeBin, bc := captureBin(t)
	h.handleAgentSessionsRead(func([]byte) { t.Error("binary-opted read wrote a text frame") },
		writeBin, json.RawMessage("3"), json.RawMessage(`{"id":"aaaa-main","harness":"agy","binary":true}`))
	if bc.hdr["title"] != "T" || bc.hdr["cwd"] != h.root {
		t.Errorf("binary hdr: got %v", bc.hdr)
	}
}

func TestAgentSessionsList_AgyAbsentHome(t *testing.T) {
	h, _ := newSessionsHandler(t)
	h.kimiIndex = ""
	h.agyHome = filepath.Join(t.TempDir(), "no-such-agy")
	if r := listSessions(t, h); len(r.Sessions) != 0 {
		t.Errorf("absent agy home: got %+v", r.Sessions)
	}
	h.agyHome = ""
	if r, c := readSession(t, h, `{"id":"aaaa","harness":"agy"}`); r != nil || c.Error.Code != errFileNotFound {
		t.Errorf("no agy home: want not-found, got %+v / %+v", r, c.Error)
	}
}

func TestFileURIPath(t *testing.T) {
	for in, want := range map[string]string{
		"file:///home/u/proj":   filepath.Clean(filepath.FromSlash("/home/u/proj")),
		"file:///home/u/proj/":  filepath.Clean(filepath.FromSlash("/home/u/proj")),
		"file:///C:/Users/proj": filepath.Clean(filepath.FromSlash("C:/Users/proj")),
		"https://x/y":           "",
		"not a uri %%":          "",
	} {
		if got := fileURIPath(in); got != want {
			t.Errorf("fileURIPath(%q) = %q, want %q", in, got, want)
		}
	}
}
