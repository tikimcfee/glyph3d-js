package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// newTestHandler roots a handler at a temp project dir, with one extra reach
// dir, and returns (handler, projectRoot, reachRoot). Both dirs are real so
// symlink resolution lines up with resolvePath's symlink-resolved candidates.
func newTestHandler(t *testing.T) (*FSHandler, string, string) {
	t.Helper()
	root := t.TempDir()
	reach := t.TempDir()
	// EvalSymlinks the expected roots so comparisons survive /tmp→/private/tmp
	// style indirection on macOS.
	rootResolved, _ := filepath.EvalSymlinks(root)
	reachResolved, _ := filepath.EvalSymlinks(reach)
	h, err := NewFSHandler(root, []string{reach})
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	return h, rootResolved, reachResolved
}

func writeFile(t *testing.T, dir, rel, body string) string {
	t.Helper()
	full := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

func TestResolvePath_ProjectFile(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "src/index.js", "x")

	got, err := h.resolvePath("file:///src/index.js")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if want := filepath.Join(root, "src/index.js"); got != want {
		t.Errorf("project file: got %q, want %q", got, want)
	}
}

func TestResolvePath_ReachAbsolute(t *testing.T) {
	h, _, reach := newTestHandler(t)
	abs := writeFile(t, reach, "agent-scratch.txt", "hello")

	// The agent wrote to <reach>/agent-scratch.txt; addressing its absolute
	// path must resolve there, not under the project root.
	got, err := h.resolvePath("file://" + abs)
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if got != abs {
		t.Errorf("reach file: got %q, want %q", got, abs)
	}
}

func TestResolvePath_ProjectWinsOverReach(t *testing.T) {
	// A project that has its OWN dir colliding with a reach path keeps
	// addressing its own files (existing project file takes precedence).
	root := t.TempDir()
	reach := t.TempDir()
	rootResolved, _ := filepath.EvalSymlinks(root)
	h, err := NewFSHandler(root, []string{reach})
	if err != nil {
		t.Fatal(err)
	}
	// Build a path that exists under BOTH root and reach. Use the reach dir's
	// basename joined under root as the addressed path so candidate 1 fires.
	writeFile(t, root, "shared/note.md", "in-project")
	got, err := h.resolvePath("file:///shared/note.md")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if want := filepath.Join(rootResolved, "shared/note.md"); got != want {
		t.Errorf("precedence: got %q, want %q", got, want)
	}
}

func TestResolvePath_NewFileDefaultsInProject(t *testing.T) {
	h, root, _ := newTestHandler(t)
	// A not-yet-created path that isn't under any reach root must default to the
	// project root so a write creates it in-project (backward compatible).
	got, err := h.resolvePath("file:///notes/new.md")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if want := filepath.Join(root, "notes/new.md"); got != want {
		t.Errorf("new in-project file: got %q, want %q", got, want)
	}
}

func TestResolvePath_NewFileInReach(t *testing.T) {
	h, _, reach := newTestHandler(t)
	// A not-yet-created absolute path UNDER a reach root resolves there, so a
	// write can land in /tmp.
	target := filepath.Join(reach, "fresh.txt")
	got, err := h.resolvePath("file://" + target)
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if got != target {
		t.Errorf("new reach file: got %q, want %q", got, target)
	}
}

func TestResolvePath_RejectsTraversal(t *testing.T) {
	h, _, _ := newTestHandler(t)
	if _, err := h.resolvePath("file:///../../etc/passwd"); err == nil {
		t.Error("expected traversal rejection")
	}
}

func TestResolvePath_UnreachableAbsoluteRemapsInProject(t *testing.T) {
	h, root, _ := newTestHandler(t)
	// An absolute path to a real file outside every allowed root (e.g.
	// /etc/passwd) must NOT leak that file. Because the file:/// form is
	// ambiguous, it falls back to the project-relative interpretation —
	// <root>/etc/passwd — which doesn't exist, so the read 404s. The key
	// assertion: the resolved path is in-project, never the real /etc/passwd.
	got, err := h.resolvePath("file:///etc/passwd")
	if err != nil {
		t.Fatalf("resolvePath: %v", err)
	}
	if got == "/etc/passwd" {
		t.Fatal("leaked the real /etc/passwd")
	}
	if want := filepath.Join(root, "etc/passwd"); got != want {
		t.Errorf("unreachable absolute: got %q, want in-project %q", got, want)
	}
}

// TestHandleReadFile_TmpEndToEnd is the motivating case: an agent drops a file
// in the system temp dir; the relay, rooted at an unrelated project, pulls it
// up and returns its content over fs/readFile — no --reach needed.
func TestHandleReadFile_TmpEndToEnd(t *testing.T) {
	root := t.TempDir() // the "project" — unrelated to the scratch file
	h, err := NewFSHandler(root, nil)
	if err != nil {
		t.Fatal(err)
	}

	f, err := os.CreateTemp("", "glyph3d-agent-scratch-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	const body = "// written by an agent, rendered from /tmp\n"
	if _, err := f.WriteString(body); err != nil {
		t.Fatal(err)
	}
	f.Close()

	var captured []byte
	h.handleReadFile(func(data []byte) { captured = data }, json.RawMessage(`1`),
		mustJSON(t, readFileParams{URI: "file://" + f.Name()}))

	var resp struct {
		Result *fileContent           `json:"result"`
		Error  map[string]interface{} `json:"error"`
	}
	if err := json.Unmarshal(captured, &resp); err != nil {
		t.Fatalf("unmarshal response: %v (raw: %s)", err, captured)
	}
	if resp.Error != nil {
		t.Fatalf("readFile errored: %v", resp.Error)
	}
	if resp.Result == nil || resp.Result.Content != body {
		t.Fatalf("content mismatch: got %+v, want %q", resp.Result, body)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestResolvePath_TempDirReachableByDefault(t *testing.T) {
	// Even with no --reach, the system temp dir is reachable (the motivating
	// case: agents writing scratch to /tmp).
	root := t.TempDir()
	h, err := NewFSHandler(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.CreateTemp("", "glyph3d-reach-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.Close()
	abs, _ := filepath.EvalSymlinks(f.Name())

	got, err := h.resolvePath("file://" + f.Name())
	if err != nil {
		t.Fatalf("temp dir should be reachable: %v", err)
	}
	if got != abs {
		t.Errorf("temp file: got %q, want %q", got, abs)
	}
}
