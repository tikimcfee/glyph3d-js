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

// ---- Browse primitives: fs/readDir, fs/addRoot, fs/roots ----

// callRPC invokes one handler func and decodes the JSON-RPC envelope into the
// given result type. rpcErr is nil on success.
func callRPC[T any](t *testing.T, handle func(writeFn, json.RawMessage, json.RawMessage), params any) (*T, map[string]any) {
	t.Helper()
	var captured []byte
	handle(func(data []byte) { captured = data }, json.RawMessage(`1`), mustJSON(t, params))
	var resp struct {
		Result *T             `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.Unmarshal(captured, &resp); err != nil {
		t.Fatalf("unmarshal response: %v (raw: %s)", err, captured)
	}
	return resp.Result, resp.Error
}

func TestHandleReadDir_Unfiltered(t *testing.T) {
	h, root, _ := newTestHandler(t)
	// A dotfile, a binary, a real file, a subdir, and a dangling symlink: the
	// browse listing shows ALL of them — selection needs truth, the text
	// whitelist only applies to tree walks.
	writeFile(t, root, ".env", "SECRET=1")
	writeFile(t, root, "blob.bin", "\x00\x01\x02")
	writeFile(t, root, "main.go", "package main")
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "gone"), filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}

	res, rpcErr := callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file://" + root})
	if rpcErr != nil {
		t.Fatalf("readDir errored: %v", rpcErr)
	}
	if res.Truncated {
		t.Error("unexpected truncation")
	}
	types := map[string]string{}
	sizes := map[string]int64{}
	for _, e := range res.Entries {
		types[e.Name] = e.Type
		sizes[e.Name] = e.Size
	}
	want := map[string]string{
		".env": "file", "blob.bin": "file", "main.go": "file",
		"sub": "directory", "dangling": "symlink",
	}
	for name, wantType := range want {
		if types[name] != wantType {
			t.Errorf("%s: got type %q, want %q (entries: %v)", name, types[name], wantType, types)
		}
	}
	if sizes["main.go"] != int64(len("package main")) {
		t.Errorf("main.go size: got %d", sizes["main.go"])
	}
}

func TestHandleReadDir_Errors(t *testing.T) {
	h, root, _ := newTestHandler(t)
	file := writeFile(t, root, "afile.txt", "x")

	// Missing directory → file-not-found.
	_, rpcErr := callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file:///nope/nothing-here"})
	if rpcErr == nil || errCode(t, rpcErr) != errFileNotFound {
		t.Errorf("missing dir: got %v, want code %d", rpcErr, errFileNotFound)
	}

	// A file is not a directory.
	_, rpcErr = callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file://" + file})
	if rpcErr == nil || errCode(t, rpcErr) != errIsDirectory {
		t.Errorf("file as dir: got %v, want code %d", rpcErr, errIsDirectory)
	}

	// Relative URIs are refused outright — browsing is literal-absolute only.
	_, rpcErr = callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "relative/path"})
	if rpcErr == nil || errCode(t, rpcErr) != -32602 {
		t.Errorf("relative uri: got %v, want -32602", rpcErr)
	}

	// Traversal is rejected as a string rule, same as resolvePath.
	_, rpcErr = callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file:///tmp/../etc"})
	if rpcErr == nil || errCode(t, rpcErr) != -32602 {
		t.Errorf("traversal: got %v, want -32602", rpcErr)
	}
}

func TestHandleReadDir_PermissionDenied(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root; permission bits don't bite")
	}
	h, root, _ := newTestHandler(t)
	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })

	_, rpcErr := callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file://" + locked})
	if rpcErr == nil || errCode(t, rpcErr) != errPermissionDenied {
		t.Errorf("locked dir: got %v, want code %d", rpcErr, errPermissionDenied)
	}
}

func TestHandleReadDir_Truncation(t *testing.T) {
	h, root, _ := newTestHandler(t)
	old := maxReadDirEntries
	maxReadDirEntries = 3
	t.Cleanup(func() { maxReadDirEntries = old })
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		writeFile(t, root, n+".txt", n)
	}

	res, rpcErr := callRPC[readDirResult](t, h.handleReadDir, readDirParams{URI: "file://" + root})
	if rpcErr != nil {
		t.Fatalf("readDir errored: %v", rpcErr)
	}
	if !res.Truncated {
		t.Error("expected truncated=true past the cap")
	}
	if len(res.Entries) != 3 {
		t.Errorf("entries: got %d, want 3", len(res.Entries))
	}
}

// outsideDir creates a directory that is genuinely OUTSIDE every default
// reach root. t.TempDir() won't do here — it lives under /tmp, which is a
// default reach seed, so addRoot against it is a no-op and assertions pass
// vacuously. The package cwd (cli/ during go test) is not under /tmp.
func outsideDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp(".", "g3d-outside-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	abs, err := filepath.Abs(d)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func TestHandleAddRoot_MakesResolvable(t *testing.T) {
	h, _, _ := newTestHandler(t)
	target := outsideDir(t)
	inner := writeFile(t, target, "lib/util.js", "export {}")

	// Before addRoot the absolute path is unreachable: resolvePath remaps it
	// in-project and the file doesn't exist there.
	if got, err := h.resolvePath("file://" + inner); err == nil {
		if resolved, statErr := os.Stat(got); statErr == nil && !resolved.IsDir() {
			t.Fatalf("file should NOT resolve before addRoot (got %q)", got)
		}
	}

	res, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + target})
	if rpcErr != nil {
		t.Fatalf("addRoot errored: %v", rpcErr)
	}
	if !res.Added {
		t.Fatal("outside dir should genuinely add (added=true)")
	}
	resolved, _ := filepath.EvalSymlinks(target)
	if res.Root != filepath.ToSlash(resolved) {
		t.Errorf("root: got %q, want %q", res.Root, resolved)
	}

	// The point of it all: a file under the added root now resolves.
	got, err := h.resolvePath("file://" + inner)
	if err != nil {
		t.Fatalf("file under added root should resolve: %v", err)
	}
	innerResolved, _ := filepath.EvalSymlinks(inner)
	if got != innerResolved {
		t.Errorf("resolve: got %q, want %q", got, innerResolved)
	}
}

func TestHandleAddRoot_DedupeAndNested(t *testing.T) {
	h, root, reach := newTestHandler(t)

	// Under the project root → no-op success.
	sub := filepath.Join(root, "src")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	res, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + sub})
	if rpcErr != nil {
		t.Fatalf("addRoot under project root errored: %v", rpcErr)
	}
	if res.Added {
		t.Error("dir under project root should be a no-op (added=false)")
	}

	// Under an existing reach root → no-op success.
	reachSub := filepath.Join(reach, "nested")
	if err := os.Mkdir(reachSub, 0o755); err != nil {
		t.Fatal(err)
	}
	res, rpcErr = callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + reachSub})
	if rpcErr != nil {
		t.Fatalf("addRoot under reach root errored: %v", rpcErr)
	}
	if res.Added {
		t.Error("dir under existing reach root should be a no-op")
	}

	// Exact duplicate → first add wins, second is a no-op.
	outside := outsideDir(t)
	first, _ := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + outside})
	second, _ := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + outside})
	if first == nil || second == nil {
		t.Fatal("addRoot returned no result")
	}
	if !first.Added {
		t.Error("first addRoot of an outside dir should add")
	}
	if second.Added {
		t.Error("duplicate addRoot should be a no-op")
	}
}

func TestHandleAddRoot_Errors(t *testing.T) {
	h, root, _ := newTestHandler(t)

	// Missing directory.
	_, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file:///no/such/dir/anywhere"})
	if rpcErr == nil || errCode(t, rpcErr) != errFileNotFound {
		t.Errorf("missing: got %v, want code %d", rpcErr, errFileNotFound)
	}

	// A file, not a directory.
	file := writeFile(t, root, "f.txt", "x")
	_, rpcErr = callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + file})
	if rpcErr == nil || errCode(t, rpcErr) != errIsDirectory {
		t.Errorf("file: got %v, want code %d", rpcErr, errIsDirectory)
	}

	// Relative path refused.
	_, rpcErr = callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "some/relative/dir"})
	if rpcErr == nil || errCode(t, rpcErr) != -32602 {
		t.Errorf("relative: got %v, want -32602", rpcErr)
	}
}

func TestHandleAddRoot_SymlinkStoresTarget(t *testing.T) {
	h, _, _ := newTestHandler(t)
	realDir := filepath.Join(outsideDir(t), "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(outsideDir(t), "link")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}

	res, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + link})
	if rpcErr != nil {
		t.Fatalf("addRoot via symlink errored: %v", rpcErr)
	}
	realResolved, _ := filepath.EvalSymlinks(realDir)
	if res.Root != filepath.ToSlash(realResolved) {
		t.Errorf("symlinked root: got %q, want target %q", res.Root, realResolved)
	}
}

func TestHandleRoots_Shape(t *testing.T) {
	h, root, reach := newTestHandler(t)

	res, rpcErr := callRPC[rootsResult](t, h.handleRoots, struct{}{})
	if rpcErr != nil {
		t.Fatalf("roots errored: %v", rpcErr)
	}
	if res.Root != filepath.ToSlash(root) {
		t.Errorf("root: got %q, want %q", res.Root, root)
	}
	foundReach := false
	for _, r := range res.ExtraRoots {
		if r == filepath.ToSlash(reach) {
			foundReach = true
		}
	}
	if !foundReach {
		t.Errorf("extraRoots missing the --reach seed %q: %v", reach, res.ExtraRoots)
	}
	if res.Home == "" {
		t.Error("home should be populated")
	}
	if res.Sep != string(filepath.Separator) {
		t.Errorf("sep: got %q", res.Sep)
	}

	// And it reflects a runtime addRoot.
	added := outsideDir(t)
	if _, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + added}); rpcErr != nil {
		t.Fatalf("addRoot errored: %v", rpcErr)
	}
	res, _ = callRPC[rootsResult](t, h.handleRoots, struct{}{})
	addedResolved, _ := filepath.EvalSymlinks(added)
	found := false
	for _, r := range res.ExtraRoots {
		if r == filepath.ToSlash(addedResolved) {
			found = true
		}
	}
	if !found {
		t.Errorf("extraRoots should reflect runtime addRoot: %v", res.ExtraRoots)
	}
}

// TestAddRootConcurrency exercises addRoot against concurrent resolvePath and
// Roots readers — run with -race, this is the lock's reason to exist.
func TestAddRootConcurrency(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "src/a.js", "x")

	dirs := make([]string, 8)
	for i := range dirs {
		d := filepath.Join(outsideDir(t), "sub")
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		dirs[i] = d
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			if _, err := h.resolvePath("file:///src/a.js"); err != nil {
				t.Errorf("resolvePath under concurrency: %v", err)
				return
			}
			h.Roots()
		}
	}()
	for _, d := range dirs {
		d := d
		go func() { h.addRoot(d) }()
	}
	<-done
}

// ---- listTree: uri-directed walk + truncation surfacing ----

func TestHandleListTree_RootCompat(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "src/a.js", "x")
	writeFile(t, root, "README.md", "x")
	writeFile(t, root, "blob.bin", "x") // whitelist keeps this out

	res, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file:///"})
	if rpcErr != nil {
		t.Fatalf("listTree errored: %v", rpcErr)
	}
	if res.Truncated {
		t.Error("unexpected truncation")
	}
	got := map[string]string{}
	for _, e := range res.Entries {
		got[e.Path] = e.Type
	}
	if got["src"] != "directory" || got["src/a.js"] != "file" || got["README.md"] != "file" {
		t.Errorf("root walk entries wrong: %v", got)
	}
	if _, ok := got["blob.bin"]; ok {
		t.Error("whitelist should exclude blob.bin")
	}
}

func TestHandleListTree_SubdirRelativeEntries(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "src/deep/a.js", "x")
	writeFile(t, root, "other/b.js", "x")

	res, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file:///src"})
	if rpcErr != nil {
		t.Fatalf("listTree errored: %v", rpcErr)
	}
	got := map[string]bool{}
	for _, e := range res.Entries {
		got[e.Path] = true
	}
	// Entries are relative to the WALKED dir, and the sibling dir is absent.
	if !got["deep"] || !got["deep/a.js"] {
		t.Errorf("subdir walk should be relative to src: %v", got)
	}
	if got["src/deep/a.js"] || got["other/b.js"] || got["b.js"] {
		t.Errorf("subdir walk leaked outside src: %v", got)
	}
}

func TestHandleListTree_AddedRootWalkable(t *testing.T) {
	h, _, _ := newTestHandler(t)
	outside := outsideDir(t)
	writeFile(t, outside, "pkg/c.go", "package c")

	// Before addRoot: unreachable absolute → remaps in-project → not found.
	_, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file://" + outside})
	if rpcErr == nil {
		t.Fatal("outside dir should not walk before addRoot")
	}

	if _, rpcErr := callRPC[addRootResult](t, h.handleAddRoot, addRootParams{URI: "file://" + outside}); rpcErr != nil {
		t.Fatalf("addRoot errored: %v", rpcErr)
	}
	res, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file://" + outside})
	if rpcErr != nil {
		t.Fatalf("listTree after addRoot errored: %v", rpcErr)
	}
	got := map[string]bool{}
	for _, e := range res.Entries {
		got[e.Path] = true
	}
	if !got["pkg"] || !got["pkg/c.go"] {
		t.Errorf("added-root walk entries wrong: %v", got)
	}
}

func TestHandleListTree_Truncated(t *testing.T) {
	h, root, _ := newTestHandler(t)
	old := maxTreeEntries
	maxTreeEntries = 3
	t.Cleanup(func() { maxTreeEntries = old })
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		writeFile(t, root, n+".md", n)
	}

	res, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file:///"})
	if rpcErr != nil {
		t.Fatalf("listTree errored: %v", rpcErr)
	}
	if !res.Truncated {
		t.Error("expected truncated=true past the cap")
	}
	if len(res.Entries) != 3 {
		t.Errorf("entries: got %d, want 3", len(res.Entries))
	}
}

func TestHandleListTree_SkipDirsStillApply(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "node_modules/dep/index.js", "x")
	writeFile(t, root, "src/a.js", "x")

	res, rpcErr := callRPC[listTreeResult](t, h.handleListTree, listTreeParams{URI: "file:///"})
	if rpcErr != nil {
		t.Fatalf("listTree errored: %v", rpcErr)
	}
	for _, e := range res.Entries {
		if e.Path == "node_modules" || e.Path == "node_modules/dep/index.js" {
			t.Errorf("skipDirs leaked: %v", e.Path)
		}
	}
}

func TestStripLeadingDriveSlash(t *testing.T) {
	cases := map[string]string{
		"/C:/dev/x":  "C:/dev/x",
		"/z:/x":      "z:/x",
		"/tmp/x":     "/tmp/x", // not a drive form
		"/1:/x":      "/1:/x",  // digit is not a drive letter
		"C:/already": "C:/already",
		"":           "",
	}
	for in, want := range cases {
		if got := stripLeadingDriveSlash(in); got != want {
			t.Errorf("stripLeadingDriveSlash(%q): got %q, want %q", in, got, want)
		}
	}
}

func TestUriToPath(t *testing.T) {
	// OS-independent cases (absolute POSIX paths are absolute everywhere we
	// run tests; the drive-letter branch is unit-tested above).
	got, err := uriToPath("file:///tmp/somewhere")
	if err != nil || got != filepath.FromSlash("/tmp/somewhere") {
		t.Errorf("plain: got %q, %v", got, err)
	}
	if _, err := uriToPath("file:///a/../b"); err == nil {
		t.Error("traversal should be rejected")
	}
	if _, err := uriToPath("not/absolute"); err == nil {
		t.Error("relative should be rejected")
	}
	// Bare paths (no file:// scheme) are accepted — the CLI hands those over.
	got, err = uriToPath("/var/log")
	if err != nil || got != filepath.FromSlash("/var/log") {
		t.Errorf("bare: got %q, %v", got, err)
	}
}
