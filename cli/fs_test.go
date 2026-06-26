package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
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

// callWriteFile invokes handleWriteFile and decodes the JSON-RPC envelope into
// either a result (success) or an error object (rpcErr is nil on success). The
// error map's "code" is a float64 (JSON number) — compare via int(...).
func callWriteFile(t *testing.T, h *FSHandler, p writeFileParams) (*writeFileResult, map[string]any) {
	t.Helper()
	var captured []byte
	h.handleWriteFile(func(data []byte) { captured = data }, json.RawMessage(`1`), mustJSON(t, p))
	var resp struct {
		Result *writeFileResult `json:"result"`
		Error  map[string]any   `json:"error"`
	}
	if err := json.Unmarshal(captured, &resp); err != nil {
		t.Fatalf("unmarshal write response: %v (raw: %s)", err, captured)
	}
	return resp.Result, resp.Error
}

func errCode(t *testing.T, rpcErr map[string]any) int {
	t.Helper()
	code, ok := rpcErr["code"].(float64)
	if !ok {
		t.Fatalf("error has no numeric code: %v", rpcErr)
	}
	return int(code)
}

// TestHandleWriteFile_NewFile is the happy path: a fresh file is created with
// the right bytes, and renameio leaves no temp turds behind.
func TestHandleWriteFile_NewFile(t *testing.T) {
	h, root, _ := newTestHandler(t)
	const body = "hello, disk\n"

	res, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///newfile.txt", Content: body})
	if rpcErr != nil {
		t.Fatalf("write errored: %v", rpcErr)
	}
	if res == nil || int(res.BytesWritten) != len(body) {
		t.Fatalf("bytesWritten: got %+v, want %d", res, len(body))
	}
	got, err := os.ReadFile(filepath.Join(root, "newfile.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Errorf("content: got %q, want %q", got, body)
	}
	// The atomic-replace temp must be cleaned up — only the target remains.
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.Name() != "newfile.txt" {
			t.Errorf("leftover file in root after write: %q", e.Name())
		}
	}
}

// TestHandleWriteFile_PreservesMode proves the renameio replace keeps the
// existing file's mode — the exec bit on a script, and the tight 0600 on a
// secrets file — rather than flattening everything to 0644.
func TestHandleWriteFile_PreservesMode(t *testing.T) {
	h, root, _ := newTestHandler(t)
	cases := []struct {
		name string
		mode os.FileMode
	}{
		{"deploy.sh", 0o755},   // exec bit must survive a save
		{"secrets.env", 0o600}, // a secret must NOT be widened to world-readable
	}
	for _, c := range cases {
		target := filepath.Join(root, c.name)
		if err := os.WriteFile(target, []byte("old\n"), c.mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(target, c.mode); err != nil { // defeat umask
			t.Fatal(err)
		}
		_, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///" + c.name, Content: "new\n"})
		if rpcErr != nil {
			t.Fatalf("%s: write errored: %v", c.name, rpcErr)
		}
		info, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != c.mode {
			t.Errorf("%s: mode not preserved: got %o, want %o", c.name, got, c.mode)
		}
	}
}

// TestHandleWriteFile_StaleWrite is the lost-update barrier: a write whose
// baseMtime no longer matches the file on disk is refused, and the on-disk
// content is left exactly as the external writer left it.
func TestHandleWriteFile_StaleWrite(t *testing.T) {
	h, root, _ := newTestHandler(t)
	target := filepath.Join(root, "notes.md")
	if err := os.WriteFile(target, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(target)
	base := info.ModTime().UnixMilli()

	// Correct base → the write goes through.
	res, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///notes.md", Content: "v2\n", BaseMtime: base})
	if rpcErr != nil {
		t.Fatalf("write with correct base errored: %v", rpcErr)
	}
	if res == nil || res.BytesWritten != 3 {
		t.Fatalf("unexpected result: %+v", res)
	}

	// Something else changes the file underneath us (forced to a distinct mtime).
	if err := os.WriteFile(target, []byte("external\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Unix(0, base*1e6).Add(5 * time.Second)
	if err := os.Chtimes(target, future, future); err != nil {
		t.Fatal(err)
	}

	// A write still carrying the OLD base must be refused.
	_, rpcErr = callWriteFile(t, h, writeFileParams{URI: "file:///notes.md", Content: "v3\n", BaseMtime: base})
	if rpcErr == nil {
		t.Fatal("expected stale-write rejection")
	}
	if code := errCode(t, rpcErr); code != errStaleWrite {
		t.Errorf("wrong error code: got %d, want %d (errStaleWrite)", code, errStaleWrite)
	}
	if got, _ := os.ReadFile(target); string(got) != "external\n" {
		t.Errorf("stale write clobbered the file: got %q, want %q", got, "external\n")
	}
}

// TestHandleWriteFile_TruncationBarrier is the empty-overwrite guard: empty
// content over a non-empty file is refused unless allowEmpty is set; an empty
// brand-new file is always fine.
func TestHandleWriteFile_TruncationBarrier(t *testing.T) {
	h, root, _ := newTestHandler(t)
	target := filepath.Join(root, "data.json")
	if err := os.WriteFile(target, []byte("{\"a\":1}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Empty over non-empty → refused, file untouched.
	_, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///data.json", Content: ""})
	if rpcErr == nil {
		t.Fatal("expected truncation rejection")
	}
	if code := errCode(t, rpcErr); code != errWouldTruncate {
		t.Errorf("wrong code: got %d, want %d (errWouldTruncate)", code, errWouldTruncate)
	}
	if got, _ := os.ReadFile(target); string(got) != "{\"a\":1}\n" {
		t.Errorf("file truncated despite barrier: got %q", got)
	}

	// allowEmpty → the deliberate clear is permitted.
	res, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///data.json", Content: "", AllowEmpty: true})
	if rpcErr != nil {
		t.Fatalf("allowEmpty write errored: %v", rpcErr)
	}
	if res == nil || res.BytesWritten != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if got, _ := os.ReadFile(target); len(got) != 0 {
		t.Errorf("allowEmpty did not clear the file: got %q", got)
	}

	// Empty content to a brand-new path is always fine (no truncation to guard).
	if _, rpcErr := callWriteFile(t, h, writeFileParams{URI: "file:///fresh-empty.txt", Content: ""}); rpcErr != nil {
		t.Fatalf("empty new file errored: %v", rpcErr)
	}
	if _, err := os.Stat(filepath.Join(root, "fresh-empty.txt")); err != nil {
		t.Errorf("empty new file not created: %v", err)
	}
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
