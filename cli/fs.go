package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// JSON-RPC error codes (mirrored in src/services/data/types.js)
const (
	errFileNotFound     = -32001
	errPermissionDenied = -32002
	errIsDirectory      = -32003
	errFileTooLarge     = -32004
	errNotText          = -32005
	errWriteFailed      = -32006
	errInvalidEncoding  = -32007
)

const (
	maxFileSize    = 10 * 1024 * 1024 // 10MB
	maxRangeLen    = 4 * 1024 * 1024  // 4MB — per-chunk cap for fs/readRange (the file itself may be far larger)
	maxTreeEntries = 50000
	rpcTimeout     = 10 * time.Second
)

// Directories to skip during tree walk.
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"__pycache__":  true,
	".cache":       true,
	".tox":         true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	".build":       true,
	".swiftpm":     true,
	"Pods":         true,
	"DerivedData":  true,
	"target":       true,
}

// Whitelist of known source-code / text file extensions.
// Files without a matching extension are excluded from listTree results.
// Extensionless files with known names (Makefile, Dockerfile, etc.) are
// handled separately in isTextFile().
var textExts = map[string]bool{
	// Systems / native
	".c": true, ".h": true, ".cpp": true, ".cc": true, ".cxx": true,
	".hpp": true, ".hh": true, ".hxx": true,
	".m": true, ".mm": true,
	".swift": true, ".metal": true,
	".cs": true, ".fs": true, ".fsx": true,
	".rs": true, ".go": true, ".zig": true, ".nim": true,
	".java": true, ".kt": true, ".kts": true, ".scala": true, ".groovy": true, ".gradle": true,
	".d": true, ".v": true, ".vhdl": true, ".sv": true,

	// Scripting
	".py": true, ".pyi": true, ".pyw": true,
	".rb": true, ".erb": true, ".rake": true,
	".pl": true, ".pm": true,
	".lua": true,
	".php": true, ".phtml": true,
	".r": true, ".R": true,
	".jl": true,
	".tcl": true,

	// Shell
	".sh": true, ".bash": true, ".zsh": true, ".fish": true,
	".bat": true, ".cmd": true, ".ps1": true, ".psm1": true,

	// Web
	".js": true, ".mjs": true, ".cjs": true,
	".ts": true, ".tsx": true, ".jsx": true,
	".html": true, ".htm": true, ".xhtml": true,
	".css": true, ".scss": true, ".sass": true, ".less": true, ".styl": true,
	".vue": true, ".svelte": true, ".astro": true,

	// Functional / ML
	".hs": true, ".lhs": true,
	".ml": true, ".mli": true, ".mll": true, ".mly": true,
	".ex": true, ".exs": true, ".erl": true, ".hrl": true,
	".clj": true, ".cljs": true, ".cljc": true, ".edn": true,
	".lisp": true, ".cl": true, ".el": true, ".scm": true, ".rkt": true,

	// Data / config
	".json": true, ".jsonc": true, ".json5": true,
	".yaml": true, ".yml": true,
	".toml": true, ".ini": true, ".cfg": true, ".conf": true,
	".xml": true, ".xsl": true, ".xsd": true, ".dtd": true,
	".plist": true, ".xcscheme": true, ".xcworkspacedata": true,
	".pbxproj": true, ".storyboard": true, ".xib": true,
	".properties": true, ".env": true, ".editorconfig": true,
	".csv": true, ".tsv": true,

	// Markup / docs
	".md": true, ".markdown": true, ".rst": true, ".adoc": true,
	".txt": true, ".text": true, ".rtf": true,
	".tex": true, ".bib": true,
	".org": true,

	// Build / CI
	".cmake": true, ".make": true, ".mk": true,
	".dockerfile": true,
	".tf": true, ".hcl": true,
	".nix": true,
	".bazel": true, ".bzl": true,

	// Package manifests / lock files
	".lock": true, ".resolved": true,

	// Misc
	".sql": true, ".graphql": true, ".gql": true, ".proto": true,
	".glsl": true, ".vert": true, ".frag": true, ".wgsl": true, ".hlsl": true,
	".diff": true, ".patch": true,
	".gitignore": true, ".gitattributes": true, ".gitmodules": true,
	".dockerignore": true, ".npmignore": true, ".eslintignore": true,
	".cursorrules": true,
}

// Extensionless files that are known text.
var textNames = map[string]bool{
	"Makefile":     true,
	"makefile":     true,
	"GNUmakefile":  true,
	"Dockerfile":   true,
	"Containerfile": true,
	"Rakefile":     true,
	"Gemfile":      true,
	"Podfile":      true,
	"Vagrantfile":  true,
	"Procfile":     true,
	"Justfile":     true,
	"CMakeLists.txt": true,
	"CLAUDE.md":    true,
	"LICENSE":      true,
	"COPYING":      true,
	"README":       true,
	"CHANGELOG":    true,
	"AUTHORS":      true,
	"CONTRIBUTORS": true,
	".gitignore":   true,
	".gitattributes": true,
	".editorconfig": true,
	".clang-format": true,
	".clang-tidy":  true,
	".eslintrc":    true,
	".prettierrc":  true,
	".babelrc":     true,
}

// fileFilter holds a thread-safe, runtime-replaceable copy of the whitelist.
// The read path (isTextFile, called per file during WalkDir) takes RLock.
// The write path (fs/setFilter RPC) takes full Lock and swaps the maps.
type fileFilter struct {
	mu    sync.RWMutex
	exts  map[string]bool
	names map[string]bool
}

var globalFilter = &fileFilter{
	exts:  textExts,
	names: textNames,
}

// isTextFile returns true if the file should be included in tree results.
func isTextFile(name string) bool {
	globalFilter.mu.RLock()
	defer globalFilter.mu.RUnlock()
	ext := strings.ToLower(filepath.Ext(name))
	if ext != "" {
		return globalFilter.exts[ext]
	}
	return globalFilter.names[name]
}

func (f *fileFilter) setFilter(exts []string, names []string) {
	newExts := make(map[string]bool, len(exts))
	for _, e := range exts {
		newExts[strings.ToLower(e)] = true
	}
	newNames := make(map[string]bool, len(names))
	for _, n := range names {
		newNames[n] = true
	}
	f.mu.Lock()
	f.exts = newExts
	f.names = newNames
	f.mu.Unlock()
}

// ---- Types matching the JS side ----

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type fileStat struct {
	Type     string `json:"type"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtime"`
	Readonly bool   `json:"readonly,omitempty"`
}

type fileContent struct {
	URI     string   `json:"uri"`
	Content string   `json:"content"`
	Stat    fileStat `json:"stat"`
}

type dirEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

type readFileParams struct {
	URI string `json:"uri"`
}

// readRangeParams is the body of fs/readRange — a raw, binary-safe byte tap.
// Unlike fs/readFile it does NOT gate on total file size or UTF-8 validity;
// it returns base64-encoded bytes from [offset, offset+length). This is the
// demand-paging primitive for the memory viewer: the file is the address
// space, each call faults in one page-sized window.
type readRangeParams struct {
	URI    string `json:"uri"`
	Offset int64  `json:"offset"`
	Length int64  `json:"length"`
}

// rangeContent is the fs/readRange result. Content is base64; TotalSize is the
// full file size so the client knows the extent of the address space it is
// windowing into.
type rangeContent struct {
	URI       string `json:"uri"`
	Offset    int64  `json:"offset"`
	Length    int64  `json:"length"`  // actual bytes returned (may be < requested at EOF)
	TotalSize int64  `json:"totalSize"`
	Content   string `json:"content"` // base64-encoded bytes
}

type listTreeParams struct {
	URI string `json:"uri"`
}

type setFilterParams struct {
	Exts  []string `json:"exts"`
	Names []string `json:"names"`
}

type statParams struct {
	URI string `json:"uri"`
}

// writeFileParams is the body of the fs/writeFile JSON-RPC request.
// Encoding defaults to "utf8" when omitted; "base64" lets clients send
// binary payloads though today's viewer only emits UTF-8 text from grids.
type writeFileParams struct {
	URI      string `json:"uri"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

// writeFileResult is returned on successful fs/writeFile.
type writeFileResult struct {
	URI          string `json:"uri"`
	BytesWritten int64  `json:"bytesWritten"`
	Mtime        int64  `json:"mtime"`
}

// ---- FSHandler ----

// writeFn sends a serialized message to the display. Set by the Relay.
type writeFn func(data []byte)

// FSHandler serves filesystem requests over JSON-RPC 2.0.
type FSHandler struct {
	root string // absolute path, symlinks resolved

	// notify, if non-nil, is called on successful fs/writeFile to push an
	// fs/didChange JSON-RPC notification to the display. Wired by RunServer
	// / RunRelay to relay.NotifyDisplayRPC. When the server is running with
	// --local (LiveReloader watching app/ + src/), the watcher may ALSO
	// fire for the same path — the browser-side handler is idempotent
	// (it just reloads), so the dupe is harmless.
	notify func(method string, params any)
}

// SetNotifyHook wires the FSHandler to the relay's display push channel.
// Safe to call at most once during server construction.
func (h *FSHandler) SetNotifyHook(fn func(method string, params any)) {
	h.notify = fn
}

// NewFSHandler creates a handler rooted at the given directory.
// Returns an error if the path doesn't exist or isn't a directory.
func NewFSHandler(root string) (*FSHandler, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("eval symlinks: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("stat root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("root is not a directory: %s", resolved)
	}
	return &FSHandler{root: resolved}, nil
}

// Handle dispatches a JSON-RPC request to the appropriate method.
// Runs the handler in a goroutine with a timeout so it never blocks
// the WebSocket read loop. Writes go through the provided writeFn.
func (h *FSHandler) Handle(method string, rawID json.RawMessage, params json.RawMessage, write writeFn) {
	go func() {
		done := make(chan struct{})
		go func() {
			defer close(done)
			switch method {
			case "fs/readFile":
				h.handleReadFile(write, rawID, params)
			case "fs/readRange":
				h.handleReadRange(write, rawID, params)
			case "fs/listTree":
				h.handleListTree(write, rawID, params)
			case "fs/stat":
				h.handleStat(write, rawID, params)
			case "fs/setFilter":
				h.handleSetFilter(write, rawID, params)
			case "fs/writeFile":
				h.handleWriteFile(write, rawID, params)
			default:
				h.sendRPCError(write, rawID, -32601, "method not found: "+method, nil)
			}
		}()

		select {
		case <-done:
		case <-time.After(rpcTimeout):
			h.sendRPCError(write, rawID, -32000, "request timed out", nil)
		}
	}()
}

// ---- Method Handlers ----

func (h *FSHandler) handleReadFile(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p readFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	resolved, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	info, err := os.Stat(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "file not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "is a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if info.Size() > maxFileSize {
		h.sendRPCError(write, id, errFileTooLarge, fmt.Sprintf("file too large (%d bytes, max %d): %s", info.Size(), maxFileSize, p.URI), map[string]string{"uri": p.URI})
		return
	}

	data, err := os.ReadFile(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "read error: "+err.Error(), map[string]string{"uri": p.URI})
		return
	}

	// Reject non-UTF-8 content (binary files that slipped past extension filters)
	if !utf8.Valid(data) {
		h.sendRPCError(write, id, errNotText, "file is not valid UTF-8 text: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	result := fileContent{
		URI:     p.URI,
		Content: string(data),
		Stat: fileStat{
			Type:  "file",
			Size:  info.Size(),
			Mtime: info.ModTime().UnixMilli(),
		},
	}
	h.sendRPCResult(write, id, result)
}

// handleReadRange serves a raw byte window from a file — the memory-viewer tap.
//
// Shape:  { uri, offset, length }  ->  { uri, offset, length, totalSize, content(base64) }
// Unlike readFile it tolerates binary and arbitrarily large files: it only
// reads [offset, offset+length) (capped at maxRangeLen per call) via ReadAt,
// so a 1GB file is windowed, never slurped. EOF short-reads are not an error —
// the returned Length reflects how many bytes actually landed.
func (h *FSHandler) handleReadRange(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p readRangeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if p.Offset < 0 || p.Length < 0 {
		h.sendRPCError(write, id, -32602, "offset and length must be non-negative", map[string]string{"uri": p.URI})
		return
	}
	n := p.Length
	if n > maxRangeLen {
		n = maxRangeLen
	}

	resolved, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	info, err := os.Stat(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "file not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "is a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	f, err := os.Open(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "open error: "+err.Error(), map[string]string{"uri": p.URI})
		return
	}
	defer f.Close()

	buf := make([]byte, n)
	got, err := f.ReadAt(buf, p.Offset)
	// ReadAt reports io.EOF when it fills fewer than len(buf) bytes at end of
	// file — that's expected for the tail window, not a failure. Any other
	// error is real.
	if err != nil && err != io.EOF {
		h.sendRPCError(write, id, errFileNotFound, "read error: "+err.Error(), map[string]string{"uri": p.URI})
		return
	}

	result := rangeContent{
		URI:       p.URI,
		Offset:    p.Offset,
		Length:    int64(got),
		TotalSize: info.Size(),
		Content:   base64.StdEncoding.EncodeToString(buf[:got]),
	}
	h.sendRPCResult(write, id, result)
}

func (h *FSHandler) handleListTree(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p listTreeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	// For listTree, the URI is typically "file:///" meaning "the root".
	// We walk from h.root.
	entries := make([]dirEntry, 0, 512)
	count := 0

	err := filepath.WalkDir(h.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip errors (permission denied, etc.)
		}

		// Skip excluded directories
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			// Don't include the root itself
			if path == h.root {
				return nil
			}
		}

		// Whitelist: only include known text files
		if !d.IsDir() && !isTextFile(d.Name()) {
			return nil
		}

		// Cap entry count
		count++
		if count > maxTreeEntries {
			return fmt.Errorf("tree entry limit exceeded (%d)", maxTreeEntries)
		}

		rel, _ := filepath.Rel(h.root, path)
		entryType := "file"
		if d.IsDir() {
			entryType = "directory"
		} else if d.Type()&os.ModeSymlink != 0 {
			entryType = "symlink"
		}

		var size int64
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				size = info.Size()
			}
		}

		entries = append(entries, dirEntry{
			Path: rel,
			Type: entryType,
			Size: size,
		})
		return nil
	})

	if err != nil {
		log.Printf("[fs] listTree walk error: %v", err)
	}

	h.sendRPCResult(write, id, entries)
}

func (h *FSHandler) handleStat(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p statParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	resolved, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	info, err := os.Stat(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	entryType := "file"
	if info.IsDir() {
		entryType = "directory"
	} else if info.Mode()&os.ModeSymlink != 0 {
		entryType = "symlink"
	}

	result := fileStat{
		Type:  entryType,
		Size:  info.Size(),
		Mtime: info.ModTime().UnixMilli(),
	}
	h.sendRPCResult(write, id, result)
}

func (h *FSHandler) handleSetFilter(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p setFilterParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	globalFilter.setFilter(p.Exts, p.Names)
	log.Printf("[fs] filter updated: %d extensions, %d names", len(p.Exts), len(p.Names))
	h.sendRPCResult(write, id, map[string]any{"ok": true})
}

// handleWriteFile persists a UTF-8 or base64 payload to a resolved path.
//
// Shape:   { uri, content, encoding? }  ->  { uri, bytesWritten, mtime }
// Safety:  resolvePath enforces the project-root boundary (same as read).
//          Refuses directories, refuses payloads over maxFileSize, and
//          refuses utf-8 payloads that don't actually decode cleanly.
// Atomicity: writes to "<target>.glyph3d.tmp" then os.Rename over the
//          final path — on Linux this is atomic for same-filesystem
//          replacement. If the rename fails the tmp is cleaned up.
// Notification: on success, if a notify hook is wired, emits an
//          fs/didChange RPC to the display so any open editor can
//          round-trip-confirm the write (editable-3d-ide L0).
func (h *FSHandler) handleWriteFile(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p writeFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	// Decode payload into a []byte. Default encoding is utf8.
	var data []byte
	switch p.Encoding {
	case "", "utf8", "utf-8", "UTF-8":
		// Validate the string is genuine UTF-8 — the JSON layer only
		// guarantees valid JSON escaping, not that the resulting Go
		// string is a useful UTF-8 payload. Reject binary sneaking in.
		if !utf8.ValidString(p.Content) {
			h.sendRPCError(write, id, errNotText, "content is not valid UTF-8", map[string]string{"uri": p.URI})
			return
		}
		data = []byte(p.Content)
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(p.Content)
		if err != nil {
			h.sendRPCError(write, id, errInvalidEncoding, "base64 decode failed: "+err.Error(), map[string]string{"uri": p.URI})
			return
		}
		data = decoded
	default:
		h.sendRPCError(write, id, errInvalidEncoding, "unsupported encoding: "+p.Encoding, map[string]string{"uri": p.URI, "encoding": p.Encoding})
		return
	}

	if int64(len(data)) > maxFileSize {
		h.sendRPCError(write, id, errFileTooLarge, fmt.Sprintf("content too large (%d bytes, max %d)", len(data), maxFileSize), map[string]string{"uri": p.URI})
		return
	}

	resolved, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	// If the target already exists, refuse if it's a directory. If it
	// doesn't exist, that's fine — writeFile creates new files. We do
	// NOT auto-mkdir parent directories yet (adds surface area; can be a
	// flag in a later phase if a real need appears).
	if info, err := os.Stat(resolved); err == nil && info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "is a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	tmp := resolved + ".glyph3d.tmp"

	// Write the full payload to tmp, then rename. 0644 matches the
	// permissions os.ReadFile/os.WriteFile typically produce; if the
	// destination already existed with different perms, os.Rename
	// preserves the original inode's metadata only on some OSes —
	// acceptable for L0; can be tightened with a stat+chmod pass later.
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		h.sendRPCError(write, id, errWriteFailed, "tmp write failed: "+err.Error(), map[string]string{"uri": p.URI, "tmp": tmp})
		return
	}
	if err := os.Rename(tmp, resolved); err != nil {
		// Clean up the orphaned tmp. Deliberately ignore the remove
		// error — we're already in a failure path, the rename error is
		// the one the caller needs.
		_ = os.Remove(tmp)
		h.sendRPCError(write, id, errWriteFailed, "rename failed: "+err.Error(), map[string]string{"uri": p.URI})
		return
	}

	// Stat the result so we can return mtime — some clients use it as
	// a freshness token for the in-memory grid.
	info, statErr := os.Stat(resolved)
	var mtime int64
	if statErr == nil {
		mtime = info.ModTime().UnixMilli()
	}

	result := writeFileResult{
		URI:          p.URI,
		BytesWritten: int64(len(data)),
		Mtime:        mtime,
	}
	h.sendRPCResult(write, id, result)

	// Echo back as an fs/didChange notification so the browser can
	// decide whether to reload the grid that owns this URI. Only fires
	// when the server wired a notify hook (relay.NotifyDisplayRPC).
	if h.notify != nil {
		rel := p.URI
		if strings.HasPrefix(rel, "file://") {
			rel = strings.TrimPrefix(rel, "file://")
		}
		h.notify("fs/didChange", map[string]string{
			"path":  rel,
			"event": "write",
		})
	}

	log.Printf("[fs] wrote %d bytes to %s", len(data), p.URI)
}

// ---- Path Security ----

// resolvePath strips the "file://" prefix, joins with root, resolves symlinks,
// and verifies the result is under root. Rejects ".." traversal.
func (h *FSHandler) resolvePath(uri string) (string, error) {
	// Strip file:// prefix
	path := uri
	if strings.HasPrefix(path, "file://") {
		path = strings.TrimPrefix(path, "file://")
	}

	// Reject obvious traversal
	if strings.Contains(path, "..") {
		return "", fmt.Errorf("path traversal rejected: %s", uri)
	}

	// Clean and join with root
	path = filepath.Clean(path)
	if filepath.IsAbs(path) {
		// Absolute path: strip leading "/" so it becomes relative to root
		path = strings.TrimPrefix(path, "/")
	}
	full := filepath.Join(h.root, path)

	// Resolve symlinks and verify still under root
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		// File might not exist yet (for stat calls); try parent
		resolved = full
	}
	if !strings.HasPrefix(resolved, h.root) {
		return "", fmt.Errorf("path escapes root: %s → %s", uri, resolved)
	}

	return resolved, nil
}

// ---- JSON-RPC Response Helpers ----

func (h *FSHandler) sendRPCResult(write writeFn, id json.RawMessage, result any) {
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"result":  result,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("[fs] marshal result error: %v", err)
		return
	}
	write(data)
}

func (h *FSHandler) sendRPCError(write writeFn, id json.RawMessage, code int, message string, errorData any) {
	errObj := map[string]any{
		"code":    code,
		"message": message,
	}
	if errorData != nil {
		errObj["data"] = errorData
	}
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"error":   errObj,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("[fs] marshal error response error: %v", err)
		return
	}
	write(data)
}
