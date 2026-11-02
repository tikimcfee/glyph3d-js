package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type watchSink struct {
	mu      sync.Mutex
	batches [][]string
	ch      chan []string
}

func newWatchSink() *watchSink {
	return &watchSink{
		ch: make(chan []string, 32),
	}
}

func (s *watchSink) hook(method string, params any) {
	if method != "fs/changed" {
		return
	}
	b, err := json.Marshal(params)
	if err != nil {
		return
	}
	var p fsChangedParams
	if err := json.Unmarshal(b, &p); err != nil {
		return
	}
	s.mu.Lock()
	s.batches = append(s.batches, p.Paths)
	s.mu.Unlock()
	s.ch <- p.Paths
}

func (s *watchSink) waitBatch(t *testing.T, timeout time.Duration) []string {
	t.Helper()
	select {
	case paths := <-s.ch:
		return paths
	case <-time.After(timeout):
		t.Fatalf("timed out after %s waiting for fs/changed batch", timeout)
		return nil
	}
}

func (s *watchSink) assertQuiet(t *testing.T, wait time.Duration) {
	t.Helper()
	select {
	case paths := <-s.ch:
		t.Fatalf("unexpected fs/changed push during quiet check: %v", paths)
	case <-time.After(wait):
	}
}

func callWatch(t *testing.T, h *FSHandler, display uint64, paths []string) (*watchResult, map[string]any) {
	t.Helper()
	var captured []byte
	h.handleWatch(func(data []byte) { captured = data }, json.RawMessage(`1`), mustJSON(t, watchParams{Paths: paths}), display)
	var resp struct {
		Result *watchResult   `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.Unmarshal(captured, &resp); err != nil {
		t.Fatalf("unmarshal watch response: %v (raw: %s)", err, captured)
	}
	return resp.Result, resp.Error
}

func callUnwatch(t *testing.T, h *FSHandler, display uint64, p unwatchParams) (*watchResult, map[string]any) {
	t.Helper()
	var captured []byte
	h.handleUnwatch(func(data []byte) { captured = data }, json.RawMessage(`1`), mustJSON(t, p), display)
	var resp struct {
		Result *watchResult   `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.Unmarshal(captured, &resp); err != nil {
		t.Fatalf("unmarshal unwatch response: %v (raw: %s)", err, captured)
	}
	return resp.Result, resp.Error
}

func withShortWatchDebounce(t *testing.T, d time.Duration) {
	t.Helper()
	prev := watchDebounce
	watchDebounce = d
	t.Cleanup(func() { watchDebounce = prev })
}

// TestFSWatch_RefcountedDirsAndTenThousandSubdirs gates the non-recursive,
// refcounted parent-directory watcher:
//   - A root with 10,000 subdirectories (plus an added reach root) adds 0 watches
//     until a file in it is subscribed (teeth: a recursive walk adds >= 10,000
//     watches on construction/addRoot and fails both WatchList()==0 and --watch-max).
//   - Subscribing 3 files in 2 directories adds exactly 2 watches in WatchList().
//   - Unsubscribing decrements refcounts and removes each watch when its last
//     subscribed file is unwatched.
func TestFSWatch_RefcountedDirsAndTenThousandSubdirs(t *testing.T) {
	root := t.TempDir()
	rootResolved, _ := filepath.EvalSymlinks(root)

	const numSubdirs = 10000
	for i := 0; i < numSubdirs; i++ {
		sub := filepath.Join(rootResolved, fmt.Sprintf("sub-%04d", i))
		if err := os.Mkdir(sub, 0o755); err != nil {
			t.Fatalf("mkdir %d: %v", i, err)
		}
	}

	h, err := NewFSHandler(rootResolved, nil)
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	h.extraRoots = nil
	t.Cleanup(h.Close)

	// Tooth: constructing a handler over 10,000 subdirectories must register 0 watches.
	if got := h.watcher.WatchList(); len(got) != 0 {
		t.Fatalf("initial WatchList on 10,000-subdir root: got %d watches, want 0", len(got))
	}

	// Tooth: addRoot of an outside directory with subdirectories must also add 0 watches.
	extra := outsideDir(t)
	extraResolved, _ := filepath.EvalSymlinks(extra)
	if err := os.MkdirAll(filepath.Join(extraResolved, "nested/child"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !h.addRoot(extraResolved) {
		t.Fatalf("expected addRoot(%s) to add new root", extraResolved)
	}
	if got := h.watcher.WatchList(); len(got) != 0 {
		t.Fatalf("WatchList after addRoot: got %d watches (%v), want 0", len(got), got)
	}

	// Subscribe 3 files across 2 directories -> exactly 2 watches in WatchList().
	writeFile(t, rootResolved, "sub-0001/a.js", "a\n")
	writeFile(t, rootResolved, "sub-0001/b.js", "b\n")
	writeFile(t, rootResolved, "sub-0002/c.js", "c\n")

	if _, rpcErr := callWatch(t, h, 1, []string{
		"sub-0001/a.js",
		"sub-0001/b.js",
		"sub-0002/c.js",
	}); rpcErr != nil {
		t.Fatalf("fs/watch 3 files in 2 dirs: %v", rpcErr)
	}

	dir1 := filepath.Join(rootResolved, "sub-0001")
	dir2 := filepath.Join(rootResolved, "sub-0002")
	if got, want := h.watcher.WatchList(), []string{dir1, dir2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("WatchList after 3 files in 2 dirs: got %v (len=%d), want %v (len=2)", got, len(got), want)
	}

	// Unwatching 1 of the 2 files in sub-0001 keeps sub-0001 watched (refcount 2 -> 1).
	if _, rpcErr := callUnwatch(t, h, 1, unwatchParams{Paths: []string{"sub-0001/a.js"}}); rpcErr != nil {
		t.Fatalf("fs/unwatch a.js: %v", rpcErr)
	}
	if got, want := h.watcher.WatchList(), []string{dir1, dir2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("WatchList after unwatching 1 of 2 in dir1: got %v, want %v", got, want)
	}

	// Unwatching the 2nd file in sub-0001 drops refcount to 0 and removes dir1's watch.
	if _, rpcErr := callUnwatch(t, h, 1, unwatchParams{Paths: []string{"sub-0001/b.js"}}); rpcErr != nil {
		t.Fatalf("fs/unwatch b.js: %v", rpcErr)
	}
	if got, want := h.watcher.WatchList(), []string{dir2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("WatchList after unwatching both in dir1: got %v, want %v", got, want)
	}

	// Unwatching sub-0002/c.js removes the last watch -> WatchList is empty.
	if _, rpcErr := callUnwatch(t, h, 1, unwatchParams{Paths: []string{"sub-0002/c.js"}}); rpcErr != nil {
		t.Fatalf("fs/unwatch c.js: %v", rpcErr)
	}
	if got := h.watcher.WatchList(); len(got) != 0 {
		t.Fatalf("WatchList after unwatching all: got %v (len=%d), want 0", got, len(got))
	}
}

func TestFSWatch_WriteWatchedFile(t *testing.T) {
	withShortWatchDebounce(t, 20*time.Millisecond)
	h, root, _ := newTestHandler(t)
	sink := newWatchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "src/app.js", "v1\n")
	writeFile(t, root, "src/unwatched.js", "u1\n")

	res, rpcErr := callWatch(t, h, 1, []string{"src/app.js"})
	if rpcErr != nil {
		t.Fatalf("fs/watch errored: %v", rpcErr)
	}
	if res == nil || !res.OK || res.Count != 1 || !reflect.DeepEqual(res.Watched, []string{"src/app.js"}) {
		t.Fatalf("unexpected watch result: %+v", res)
	}

	// Write an unsubscribed sibling in the same watched directory first, then the watched file.
	writeFile(t, root, "src/unwatched.js", "u2\n")
	writeFile(t, root, "src/app.js", "v2\n")

	got := sink.waitBatch(t, time.Second)
	if want := []string{"src/app.js"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fs/changed paths: got %v, want %v", got, want)
	}
	sink.assertQuiet(t, 60*time.Millisecond)
}

func TestFSWatch_BurstCoalesced(t *testing.T) {
	withShortWatchDebounce(t, 40*time.Millisecond)
	h, root, _ := newTestHandler(t)
	sink := newWatchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "a.js", "0\n")
	writeFile(t, root, "b.js", "0\n")

	if _, rpcErr := callWatch(t, h, 1, []string{"a.js", "b.js"}); rpcErr != nil {
		t.Fatalf("fs/watch errored: %v", rpcErr)
	}

	// Rapid burst of writes across both watched files inside the debounce window.
	for i := 0; i < 6; i++ {
		if err := os.WriteFile(filepath.Join(root, "a.js"), []byte("a-burst\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "b.js"), []byte("b-burst\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	got := sink.waitBatch(t, time.Second)
	if want := []string{"a.js", "b.js"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("coalesced batch: got %v, want %v", got, want)
	}
	// Must have been coalesced into a single push.
	sink.assertQuiet(t, 80*time.Millisecond)
}

func TestFSWatch_IgnoredDirsNoPush(t *testing.T) {
	withShortWatchDebounce(t, 20*time.Millisecond)
	h, root, _ := newTestHandler(t)
	sink := newWatchSink()
	h.SetNotifyHook(sink.hook)

	// Pre-create ignored trees and attempt to subscribe to them alongside a real file.
	writeFile(t, root, ".git/HEAD", "ref: refs/heads/main\n")
	writeFile(t, root, "node_modules/pkg/index.js", "module.exports = 1;\n")
	writeFile(t, root, ".vite/deps/chunk.js", "export {};\n")
	writeFile(t, root, "real.js", "v1\n")

	res, rpcErr := callWatch(t, h, 1, []string{
		".git/HEAD",
		"node_modules/pkg/index.js",
		".vite/deps/chunk.js",
		"real.js",
	})
	if rpcErr != nil {
		t.Fatalf("fs/watch errored: %v", rpcErr)
	}
	// Ignored paths are filtered out of subscriptions and never watched.
	if !reflect.DeepEqual(res.Watched, []string{"real.js"}) {
		t.Fatalf("watched list should exclude ignored dirs: got %v", res.Watched)
	}
	if got, want := h.watcher.WatchList(), []string{root}; !reflect.DeepEqual(got, want) {
		t.Fatalf("WatchList should only contain root: got %v, want %v", got, want)
	}

	// Modify files inside ignored directories only -> no push.
	writeFile(t, root, ".git/HEAD", "ref: refs/heads/planes\n")
	writeFile(t, root, "node_modules/pkg/index.js", "module.exports = 2;\n")
	writeFile(t, root, ".vite/deps/chunk.js", "export const x = 1;\n")
	sink.assertQuiet(t, 70*time.Millisecond)

	// Now touch the real watched file -> push arrives for real.js only.
	writeFile(t, root, "real.js", "v2\n")
	if got := sink.waitBatch(t, time.Second); !reflect.DeepEqual(got, []string{"real.js"}) {
		t.Fatalf("got %v, want [real.js]", got)
	}
}

func TestFSWatch_UnwatchAndDisplayGone(t *testing.T) {
	withShortWatchDebounce(t, 20*time.Millisecond)
	h, root, _ := newTestHandler(t)
	sink := newWatchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "d1/keep.js", "1\n")
	writeFile(t, root, "d2/drop.js", "1\n")

	if _, rpcErr := callWatch(t, h, 7, []string{"d1/keep.js", "d2/drop.js"}); rpcErr != nil {
		t.Fatalf("fs/watch: %v", rpcErr)
	}
	if got := len(h.watcher.WatchList()); got != 2 {
		t.Fatalf("WatchList len: got %d, want 2", got)
	}

	unRes, rpcErr := callUnwatch(t, h, 7, unwatchParams{Paths: []string{"d2/drop.js"}})
	if rpcErr != nil {
		t.Fatalf("fs/unwatch: %v", rpcErr)
	}
	if !reflect.DeepEqual(unRes.Watched, []string{"d1/keep.js"}) {
		t.Fatalf("remaining watched: got %v, want [d1/keep.js]", unRes.Watched)
	}
	if got := len(h.watcher.WatchList()); got != 1 {
		t.Fatalf("WatchList len after unwatch: got %d, want 1", got)
	}

	writeFile(t, root, "d2/drop.js", "2\n")
	writeFile(t, root, "d1/keep.js", "2\n")
	if got := sink.waitBatch(t, time.Second); !reflect.DeepEqual(got, []string{"d1/keep.js"}) {
		t.Fatalf("after unwatch: got %v, want [d1/keep.js]", got)
	}

	// Disconnect display 7; subsequent writes must not push and WatchList must be empty.
	h.watcher.DisplayGone(7)
	if got := len(h.watcher.WatchList()); got != 0 {
		t.Fatalf("WatchList len after DisplayGone: got %d, want 0", got)
	}
	writeFile(t, root, "d1/keep.js", "3\n")
	sink.assertQuiet(t, 70*time.Millisecond)
}

func TestFSWatch_NewFileInWatchedDirAndAddRoot(t *testing.T) {
	withShortWatchDebounce(t, 20*time.Millisecond)
	h, root, _ := newTestHandler(t)
	sink := newWatchSink()
	h.SetNotifyHook(sink.hook)

	// Subscribe to a not-yet-created file inside an existing directory; creation is filtered by name.
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, rpcErr := callWatch(t, h, 1, []string{"sub/created.js"}); rpcErr != nil {
		t.Fatalf("fs/watch sub/created.js: %v", rpcErr)
	}

	// Creating an unsubscribed file in the same directory produces no push; creating the subscribed file pushes.
	writeFile(t, root, "sub/other.js", "ignored\n")
	writeFile(t, root, "sub/created.js", "born\n")
	if got := sink.waitBatch(t, time.Second); !reflect.DeepEqual(got, []string{"sub/created.js"}) {
		t.Fatalf("new file in watched dir: got %v, want [sub/created.js]", got)
	}

	// Register a dynamic reach root via addRoot (adds 0 watches by itself), then subscribe a file in it.
	extraDir := outsideDir(t)
	extraResolved, _ := filepath.EvalSymlinks(extraDir)
	if err := os.MkdirAll(filepath.Join(extraResolved, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !h.addRoot(extraResolved) {
		t.Fatalf("expected addRoot(%s) to add new root", extraResolved)
	}
	if got := len(h.watcher.WatchList()); got != 1 {
		t.Fatalf("addRoot should not add watches: got %d, want 1", got)
	}
	extFile := filepath.ToSlash(filepath.Join(extraResolved, "sub/ext.js"))
	if _, rpcErr := callWatch(t, h, 1, []string{extFile}); rpcErr != nil {
		t.Fatalf("fs/watch in added root: %v", rpcErr)
	}
	if got := len(h.watcher.WatchList()); got != 2 {
		t.Fatalf("watching file in added root should add 1 watch: got %d, want 2", got)
	}
	writeFile(t, extraResolved, "sub/ext.js", "external edit\n")
	if got := sink.waitBatch(t, time.Second); !reflect.DeepEqual(got, []string{extFile}) {
		t.Fatalf("added root write: got %v, want [%s]", got, extFile)
	}
}

func TestFSWatch_MaxCapCountsDirectories(t *testing.T) {
	prevMax := maxWatchedPaths
	maxWatchedPaths = 2
	t.Cleanup(func() { maxWatchedPaths = prevMax })

	h, root, _ := newTestHandler(t)
	writeFile(t, root, "d1/1.js", "1")
	writeFile(t, root, "d1/2.js", "2")
	writeFile(t, root, "d2/3.js", "3")
	writeFile(t, root, "d3/4.js", "4")

	// 3 files across 2 directories fits within maxWatchedPaths=2.
	if _, rpcErr := callWatch(t, h, 1, []string{"d1/1.js", "d1/2.js", "d2/3.js"}); rpcErr != nil {
		t.Fatalf("watching 3 files in 2 dirs within cap=2 failed: %v", rpcErr)
	}
	if got := len(h.watcher.WatchList()); got != 2 {
		t.Fatalf("WatchList len: got %d, want 2", got)
	}

	// A file in a 3rd directory exceeds maxWatchedPaths=2 and is refused.
	if _, rpcErr := callWatch(t, h, 1, []string{"d3/4.js"}); rpcErr == nil {
		t.Fatal("expected error when exceeding maxWatchedPaths directory cap")
	}
	if got := len(h.watcher.WatchList()); got != 2 {
		t.Fatalf("WatchList len after cap refusal: got %d, want 2", got)
	}
}
