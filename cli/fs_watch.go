package main

// Relay file watcher (Slice 7 fallback: docs/planes/DESIGN.md §3.12).
//
// Agent edits that carry no inline file text in their transcript event (a Bash
// `sed -i`, a compiler/codegen step, an external tool writing a file) still
// need to land in open code grids on the display.
//
// FSWatcher watches ONLY what is subscribed: the parent directory of each
// subscribed file (one fsnotify/inotify watch per distinct directory,
// refcounted by subscription; events in that directory are filtered by exact
// canonical file path). It never walks roots recursively, and `fs/addRoot` adds
// no watches by itself.
//
// A display subscribes to the paths it currently has open:
//   fs/watch   {paths: [...]}            → {ok: true, watched: [...], count: N}
//   fs/unwatch {paths: [...], all?:bool} → {ok: true, watched: [...], count: N}
// Pushes (through FSHandler.notify → relay.NotifyDisplayRPC):
//   fs/changed {paths: [...]}
//
// Events on subscribed paths are debounced per path (`watchDebounce`,
// `--watch-debounce`, default 50ms) and coalesced into one `fs/changed`
// notification batch. The number of distinct watched directories is capped at
// `maxWatchedPaths` (`--watch-max`, default 4096) and subscriptions are cleared
// on display disconnect.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Tuning (vars so `serve` flags and tests can override them).
var (
	watchDebounce   = 50 * time.Millisecond
	maxWatchedPaths = 4096 // bounds distinct directories watched in fsnotify
)

// watchIgnoredDirs are directory names the file watcher never watches and never
// emits events for.
var watchIgnoredDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	".vite":        true,
	".glyph3d":     true,
}

type watchParams struct {
	Paths []string `json:"paths"`
}

type unwatchParams struct {
	Paths []string `json:"paths"`
	All   bool     `json:"all,omitempty"`
}

type watchResult struct {
	OK      bool     `json:"ok"`
	Watched []string `json:"watched"`
	Count   int      `json:"count"`
}

type fsChangedParams struct {
	Paths []string `json:"paths"`
}

// FSWatcher manages refcounted parent-directory fsnotify watches, per-display
// file subscriptions, and debounced fs/changed batch notifications.
type FSWatcher struct {
	h   *FSHandler
	fsw *fsnotify.Watcher

	mu sync.Mutex
	// dirRefs maps canonical parent directory path -> number of active
	// (display, canonFile) subscriptions residing in that directory.
	// A directory is watched in fsw iff dirRefs[dir] > 0.
	dirRefs map[string]int
	// subs maps displayGen -> canonical resolved file path -> set of wire path
	// strings the display used when subscribing.
	subs map[uint64]map[string]map[string]bool
	// pending holds canonical resolved file paths that have changed during the
	// current debounce window.
	pending    map[string]bool
	batchStart time.Time
	timer      *time.Timer
	closed     bool
}

// NewFSWatcher constructs and starts an FSWatcher for h with zero initial
// OS watches; directories are watched on demand as files are subscribed.
func NewFSWatcher(h *FSHandler) *FSWatcher {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("[fs-watch] fsnotify init failed: %v", err)
		return nil
	}
	w := &FSWatcher{
		h:       h,
		fsw:     fsw,
		dirRefs: make(map[string]int),
		subs:    make(map[uint64]map[string]map[string]bool),
		pending: make(map[string]bool),
	}
	go w.loop()
	return w
}

// Close stops the watcher and frees its OS file descriptors.
func (w *FSWatcher) Close() {
	if w == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.pending = make(map[string]bool)
	w.mu.Unlock()
	_ = w.fsw.Close()
}

// WatchList returns the sorted list of directories currently watched by the
// underlying fsnotify.Watcher.
func (w *FSWatcher) WatchList() []string {
	if w == nil || w.fsw == nil {
		return nil
	}
	list := w.fsw.WatchList()
	out := make([]string, len(list))
	copy(out, list)
	sort.Strings(out)
	return out
}

// Watch subscribes display to the given file paths, adding fsnotify watches
// only for their parent directories (refcounted per subscription) and enforcing
// the --watch-max directory cap.
func (w *FSWatcher) Watch(display uint64, paths []string) ([]string, error) {
	if w == nil {
		return nil, fmt.Errorf("file watcher unavailable")
	}

	type resolvedSub struct {
		canon string
		dir   string
		wire  string
	}
	toAdd := make([]resolvedSub, 0, len(paths))
	for _, raw := range paths {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		resolved, err := w.h.resolvePath(raw)
		if err != nil {
			return nil, err
		}
		canon := canonicalWatchPath(resolved)
		if isWatchIgnoredPath(canon) {
			continue
		}
		dir := filepath.Dir(canon)
		if isWatchIgnoredPath(dir) {
			continue
		}
		info, err := os.Stat(dir)
		if err != nil {
			return nil, fmt.Errorf("watch parent directory not found for %s: %w", raw, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("watch parent is not a directory for %s: %s", raw, dir)
		}
		toAdd = append(toAdd, resolvedSub{
			canon: canon,
			dir:   dir,
			wire:  cleanWatchWirePath(raw),
		})
	}

	// Let fsnotify's reader goroutine flush any kernel events from writes that
	// happened prior to this Watch call so we can drain them before activating
	// the new subscriptions.
	runtime.Gosched()

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, fmt.Errorf("file watcher closed")
	}
	w.drainEventsLocked()

	dsubs := w.subs[display]
	if dsubs == nil {
		dsubs = make(map[string]map[string]bool)
	}

	// Determine which parent directories would acquire their first reference.
	newDirs := make([]string, 0)
	seenNewDir := make(map[string]bool)
	seenNewCanon := make(map[string]bool)
	for _, item := range toAdd {
		if dsubs[item.canon] != nil || seenNewCanon[item.canon] {
			continue
		}
		seenNewCanon[item.canon] = true
		if w.dirRefs[item.dir] == 0 && !seenNewDir[item.dir] {
			seenNewDir[item.dir] = true
			newDirs = append(newDirs, item.dir)
		}
	}

	if len(w.dirRefs)+len(newDirs) > maxWatchedPaths {
		return nil, fmt.Errorf("watch cap reached: %d directories exceeds max %d (--watch-max)", len(w.dirRefs)+len(newDirs), maxWatchedPaths)
	}

	// Register OS watches for newly referenced parent directories first; roll
	// back if any Add fails so state stays consistent.
	addedDirs := make([]string, 0, len(newDirs))
	for _, dir := range newDirs {
		if err := w.fsw.Add(dir); err != nil {
			for _, prev := range addedDirs {
				_ = w.fsw.Remove(prev)
			}
			return nil, fmt.Errorf("watch directory %s: %w", dir, err)
		}
		addedDirs = append(addedDirs, dir)
	}

	w.subs[display] = dsubs
	for _, item := range toAdd {
		wires := dsubs[item.canon]
		if wires == nil {
			wires = make(map[string]bool)
			dsubs[item.canon] = wires
			w.dirRefs[item.dir]++
		}
		wires[item.wire] = true
	}

	return w.watchedListLocked(display), nil
}

// Unwatch removes paths (or all paths when all is true or paths is nil) from
// display's subscription set, removing parent directory watches whose refcount
// reaches zero. Returns the remaining watched wire paths.
func (w *FSWatcher) Unwatch(display uint64, paths []string, all bool) []string {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	dsubs := w.subs[display]
	if dsubs == nil {
		return []string{}
	}

	if all || paths == nil {
		for canon := range dsubs {
			w.removeSubLocked(dsubs, canon)
		}
		delete(w.subs, display)
		w.prunePendingLocked()
		return []string{}
	}

	for _, raw := range paths {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		wire := cleanWatchWirePath(raw)
		if resolved, err := w.h.resolvePath(raw); err == nil {
			canon := canonicalWatchPath(resolved)
			w.removeSubLocked(dsubs, canon)
		}
		for canon, wires := range dsubs {
			delete(wires, wire)
			if len(wires) == 0 {
				w.removeSubLocked(dsubs, canon)
			}
		}
	}
	if len(dsubs) == 0 {
		delete(w.subs, display)
	}
	w.prunePendingLocked()
	return w.watchedListLocked(display)
}

// DisplayGone drops all watched-path subscriptions for a disconnected display
// and releases any parent directory watches whose refcount drops to zero.
func (w *FSWatcher) DisplayGone(display uint64) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	dsubs := w.subs[display]
	if dsubs == nil {
		return
	}
	for canon := range dsubs {
		w.removeSubLocked(dsubs, canon)
	}
	delete(w.subs, display)
	w.prunePendingLocked()
}

// removeSubLocked deletes canon from dsubs and decrements its parent
// directory's refcount, removing the fsnotify watch when the refcount hits 0.
func (w *FSWatcher) removeSubLocked(dsubs map[string]map[string]bool, canon string) {
	if _, exists := dsubs[canon]; !exists {
		return
	}
	delete(dsubs, canon)
	dir := filepath.Dir(canon)
	if w.dirRefs[dir] > 1 {
		w.dirRefs[dir]--
	} else {
		delete(w.dirRefs, dir)
		if !w.closed && w.fsw != nil {
			_ = w.fsw.Remove(dir)
		}
	}
}

func (w *FSWatcher) watchedListLocked(display uint64) []string {
	dsubs := w.subs[display]
	if len(dsubs) == 0 {
		return []string{}
	}
	seen := make(map[string]bool)
	out := make([]string, 0, len(dsubs))
	for _, wires := range dsubs {
		for wire := range wires {
			if !seen[wire] {
				seen[wire] = true
				out = append(out, wire)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (w *FSWatcher) isSubscribedLocked(canon string) bool {
	for _, dsubs := range w.subs {
		if len(dsubs[canon]) > 0 {
			return true
		}
	}
	return false
}

func (w *FSWatcher) prunePendingLocked() {
	for canon := range w.pending {
		if !w.isSubscribedLocked(canon) {
			delete(w.pending, canon)
		}
	}
	if len(w.pending) == 0 && w.timer != nil {
		w.timer.Stop()
		w.timer = nil
		w.batchStart = time.Time{}
	}
}

func (w *FSWatcher) drainEventsLocked() {
	if w.closed || w.fsw == nil {
		return
	}
	for {
		select {
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			w.handleEventLocked(ev)
		default:
			return
		}
	}
}

func (w *FSWatcher) loop() {
	for {
		select {
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			w.mu.Lock()
			w.handleEventLocked(ev)
			w.mu.Unlock()
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			log.Printf("[fs-watch] error: %v", err)
		}
	}
}

func (w *FSWatcher) handleEventLocked(ev fsnotify.Event) {
	if w.closed {
		return
	}
	// Pure Chmod events carry no content or existence change.
	if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
		return
	}
	if ev.Name == "" || isWatchIgnoredPath(ev.Name) {
		return
	}
	canon := canonicalWatchPath(ev.Name)
	if isWatchIgnoredPath(canon) {
		return
	}
	w.noteFileEventLocked(canon)
}

func (w *FSWatcher) noteFileEventLocked(canon string) {
	if !w.isSubscribedLocked(canon) {
		return
	}
	now := time.Now()
	if len(w.pending) == 0 {
		w.batchStart = now
	}
	w.pending[canon] = true

	debounce := watchDebounce
	if debounce <= 0 {
		debounce = 50 * time.Millisecond
	}
	// Coalesce bursts by resetting the debounce timer, bounded by 4*debounce so
	// continuous writes still flush periodically.
	if w.timer == nil {
		w.timer = time.AfterFunc(debounce, w.flush)
	} else if now.Sub(w.batchStart) < 4*debounce {
		w.timer.Reset(debounce)
	}
}

func (w *FSWatcher) flush() {
	w.mu.Lock()
	if w.closed || len(w.pending) == 0 {
		w.timer = nil
		w.batchStart = time.Time{}
		w.mu.Unlock()
		return
	}

	wireSet := make(map[string]bool)
	for canon := range w.pending {
		for _, dsubs := range w.subs {
			for wire := range dsubs[canon] {
				wireSet[wire] = true
			}
		}
	}
	w.pending = make(map[string]bool)
	w.timer = nil
	w.batchStart = time.Time{}
	notify := w.h.notify
	w.mu.Unlock()

	if len(wireSet) == 0 || notify == nil {
		return
	}
	paths := make([]string, 0, len(wireSet))
	for p := range wireSet {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	notify("fs/changed", fsChangedParams{Paths: paths})
}

// isWatchIgnoredPath reports whether any path component of p is in watchIgnoredDirs.
func isWatchIgnoredPath(p string) bool {
	slash := filepath.ToSlash(p)
	for _, part := range strings.Split(slash, "/") {
		if part != "" && watchIgnoredDirs[part] {
			return true
		}
	}
	return false
}

// cleanWatchWirePath normalizes a caller-supplied path string for wire echo in
// fs/changed (strips an optional file:// prefix and normalizes slashes).
func cleanWatchWirePath(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "file://")
	return filepath.ToSlash(s)
}

// canonicalWatchPath resolves symlinks on the longest existing prefix of p so
// paths subscribed before creation match fsnotify events after creation.
func canonicalWatchPath(p string) string {
	cleaned := filepath.Clean(p)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return filepath.Clean(resolved)
	}
	dir := cleaned
	var tail []string
	for {
		parent := filepath.Dir(dir)
		base := filepath.Base(dir)
		if parent == dir {
			break
		}
		tail = append(tail, base)
		dir = parent
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return filepath.Clean(resolved)
		}
	}
	return cleaned
}

// ---- JSON-RPC Handlers on FSHandler ----

func (h *FSHandler) handleWatch(write writeFn, id json.RawMessage, raw json.RawMessage, display uint64) {
	var p watchParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if h.watcher == nil {
		h.sendRPCError(write, id, -32000, "file watcher unavailable", nil)
		return
	}
	watched, err := h.watcher.Watch(display, p.Paths)
	if err != nil {
		code := -32000
		if strings.Contains(err.Error(), "path traversal") || strings.Contains(err.Error(), "escapes reachable roots") {
			code = errPermissionDenied
		}
		h.sendRPCError(write, id, code, err.Error(), nil)
		return
	}
	h.sendRPCResult(write, id, watchResult{
		OK:      true,
		Watched: watched,
		Count:   len(watched),
	})
}

func (h *FSHandler) handleUnwatch(write writeFn, id json.RawMessage, raw json.RawMessage, display uint64) {
	var p unwatchParams
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &p); err != nil {
			h.sendRPCError(write, id, -32602, "invalid params", nil)
			return
		}
	}
	if h.watcher == nil {
		h.sendRPCError(write, id, -32000, "file watcher unavailable", nil)
		return
	}
	watched := h.watcher.Unwatch(display, p.Paths, p.All)
	h.sendRPCResult(write, id, watchResult{
		OK:      true,
		Watched: watched,
		Count:   len(watched),
	})
}
