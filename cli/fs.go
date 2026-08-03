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
	errStaleWrite       = -32008
	errWouldTruncate    = -32009
)

const (
	maxFileSize = 10 * 1024 * 1024 // 10MB
	maxRangeLen = 4 * 1024 * 1024  // 4MB — per-chunk cap for fs/readRange (the file itself may be far larger)
	rpcTimeout  = 10 * time.Second
)

// maxTreeEntries caps an fs/listTree walk; the response carries a truncated
// flag when it trips. A var, not a const, so tests can lower it.
var maxTreeEntries = 50000

// maxReadDirEntries caps a single fs/readDir response (a pathological flat
// directory — maildirs, cache dirs — shouldn't produce a multi-MB frame).
// The response carries a truncated flag when the cap trips. A var, not a
// const, so tests can lower it.
var maxReadDirEntries = 10000

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
	".jl":  true,
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
	".tf":         true, ".hcl": true,
	".nix":   true,
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
	"Makefile":       true,
	"makefile":       true,
	"GNUmakefile":    true,
	"Dockerfile":     true,
	"Containerfile":  true,
	"Rakefile":       true,
	"Gemfile":        true,
	"Podfile":        true,
	"Vagrantfile":    true,
	"Procfile":       true,
	"Justfile":       true,
	"CMakeLists.txt": true,
	"CLAUDE.md":      true,
	"LICENSE":        true,
	"COPYING":        true,
	"README":         true,
	"CHANGELOG":      true,
	"AUTHORS":        true,
	"CONTRIBUTORS":   true,
	".gitignore":     true,
	".gitattributes": true,
	".editorconfig":  true,
	".clang-format":  true,
	".clang-tidy":    true,
	".eslintrc":      true,
	".prettierrc":    true,
	".babelrc":       true,
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
	Length    int64  `json:"length"` // actual bytes returned (may be < requested at EOF)
	TotalSize int64  `json:"totalSize"`
	Content   string `json:"content"` // base64-encoded bytes
}

type listTreeParams struct {
	URI string `json:"uri"`
}

// listTreeResult is the fs/listTree response. Entries are relative to the
// walked directory (the resolved URI); Truncated reports that the
// maxTreeEntries cap stopped the walk early — never a silent partial.
type listTreeResult struct {
	Entries   []dirEntry `json:"entries"`
	Truncated bool       `json:"truncated"`
}

// readDirParams is the body of fs/readDir — the shallow browse primitive.
type readDirParams struct {
	URI string `json:"uri"`
}

// readDirEntry is one child in an fs/readDir result. Unlike listTree's
// dirEntry it carries a bare name (the parent path is in the result), and the
// listing is unfiltered: hidden files, binaries, everything the operator would
// see with ls -a.
type readDirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // file | directory | symlink
	Size int64  `json:"size"`
}

// readDirResult is the fs/readDir response. Path is the cleaned absolute
// directory that was listed (forward slashes on the wire); Truncated reports
// that the maxReadDirEntries cap trimmed the listing.
type readDirResult struct {
	Path      string         `json:"path"`
	Entries   []readDirEntry `json:"entries"`
	Truncated bool           `json:"truncated"`
}

type addRootParams struct {
	URI string `json:"uri"`
}

// addRootResult is the fs/addRoot response: the symlink-resolved root that was
// registered (or found already reachable — added=false), plus the current
// reach set so the client can refresh its picture in one round trip.
type addRootResult struct {
	Root       string   `json:"root"`
	Added      bool     `json:"added"`
	ExtraRoots []string `json:"extraRoots"`
}

// rootsResult is the fs/roots response — what this handler is serving and can
// reach, plus the anchors a browser needs to orient (home dir, separator).
type rootsResult struct {
	Root       string   `json:"root"`
	ExtraRoots []string `json:"extraRoots"`
	Home       string   `json:"home"`
	Sep        string   `json:"sep"`
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

	// BaseMtime is the file mtime (UnixMilli) the client last synced this
	// buffer at — from the fs/readFile that loaded it, or the previous
	// fs/writeFile. The handler refuses the write if the file on disk has a
	// different mtime now (it changed under the editor). 0 = no base, no check.
	BaseMtime int64 `json:"baseMtime"`

	// AllowEmpty overrides the truncation barrier: by default the handler
	// refuses to overwrite an existing non-empty file with empty content.
	AllowEmpty bool `json:"allowEmpty"`
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

	// sessionsDir is the Claude Code transcript directory derived from the
	// served root (~/.claude/projects/<encoded-root> — see sessions.go). ""
	// when the home directory is unknown, and it may simply not exist; the
	// agentSessions/* methods treat an absent dir as empty, never an error.
	sessionsDir string

	// kimiIndex is the Kimi Code session index path (~/.kimi-code/
	// session_index.jsonl) — the second harness's archive, matched to the
	// served root by workDir. "" when home is unknown; a missing file is an
	// empty archive, same philosophy as sessionsDir.
	kimiIndex string

	// extraRoots are additional absolute, symlink-resolved directories the
	// handler may reach OUTSIDE the project root. Seeded at construction from
	// the temp dirs (/tmp, /var/tmp, $TMPDIR) plus the --reach flag, and widened
	// at runtime by fs/addRoot (the browser's "open this directory" selecting
	// outside the served root). resolvePath treats a path as reachable when it
	// lands under root OR any of these. Guarded by rootsMu — RPC handlers run
	// in their own goroutines.
	rootsMu    sync.RWMutex
	extraRoots []string

	// notify, if non-nil, is called on successful fs/writeFile to push an
	// fs/didChange JSON-RPC notification to the display. Wired by RunServer
	// / RunRelay to relay.NotifyDisplayRPC — this is the save-confirm round
	// trip (file.save → didChange → the browser reloads the affected grid).
	notify func(method string, params any)
}

// SetNotifyHook wires the FSHandler to the relay's display push channel.
// Safe to call at most once during server construction.
func (h *FSHandler) SetNotifyHook(fn func(method string, params any)) {
	h.notify = fn
}

// NewFSHandler creates a handler rooted at the given directory. The optional
// reach paths are extra directories the handler may read/write outside the
// project root (operator-supplied via --reach); the system temp dirs are always
// included so agent scratch in /tmp is reachable. Returns an error if root
// doesn't exist or isn't a directory.
func NewFSHandler(root string, reach []string) (*FSHandler, error) {
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

	// Temp dirs are reachable by default (the motivating case: agents writing
	// scratch to /tmp). os.TempDir honors $TMPDIR/$TMP/$TEMP. Append any
	// operator-supplied roots, resolve + dedupe, and drop ones already covered
	// by the project root so underAnyRoot stays cheap.
	candidates := append([]string{os.TempDir(), "/tmp", "/var/tmp"}, reach...)
	extra := make([]string, 0, len(candidates))
	seen := map[string]bool{resolved: true}
	for _, c := range candidates {
		r := evalRootOrEmpty(c)
		if r == "" || seen[r] || isUnder(r, resolved) {
			continue
		}
		seen[r] = true
		extra = append(extra, r)
	}

	return &FSHandler{root: resolved, extraRoots: extra, sessionsDir: agentSessionsDir(resolved), kimiIndex: kimiSessionIndexPath()}, nil
}

// evalRootOrEmpty resolves a candidate reach directory to its absolute,
// symlink-free form, or "" if it can't be resolved (doesn't exist / not a dir).
// Resolving symlinks here matters so the prefix check in underAnyRoot lines up
// with resolvePath's symlink-resolved targets (e.g. macOS /tmp → /private/tmp).
func evalRootOrEmpty(p string) string {
	if p == "" {
		return ""
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return ""
	}
	if info, err := os.Stat(resolved); err != nil || !info.IsDir() {
		return ""
	}
	return resolved
}

// isUnder reports whether path is root itself or lives beneath it. The
// separator-boundary check stops "/a/b" from matching sibling "/a/bc".
func isUnder(path, root string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

// underAnyRoot reports whether path is reachable — under the project root or any
// extra reach root.
func (h *FSHandler) underAnyRoot(path string) bool {
	if isUnder(path, h.root) {
		return true
	}
	h.rootsMu.RLock()
	defer h.rootsMu.RUnlock()
	for _, r := range h.extraRoots {
		if isUnder(path, r) {
			return true
		}
	}
	return false
}

// Roots returns the project root and a snapshot of the extra reach roots.
func (h *FSHandler) Roots() (string, []string) {
	h.rootsMu.RLock()
	defer h.rootsMu.RUnlock()
	extra := make([]string, len(h.extraRoots))
	copy(extra, h.extraRoots)
	return h.root, extra
}

// addRoot registers an absolute, symlink-resolved directory as a reach root.
// Returns false when the path is already reachable (under the project root or
// an existing reach root, or an exact duplicate) — a no-op, not an error.
func (h *FSHandler) addRoot(resolved string) bool {
	if isUnder(resolved, h.root) {
		return false
	}
	h.rootsMu.Lock()
	defer h.rootsMu.Unlock()
	for _, r := range h.extraRoots {
		if isUnder(resolved, r) {
			return false
		}
	}
	h.extraRoots = append(h.extraRoots, resolved)
	return true
}

// evalSymlinksOrSelf resolves symlinks in p, falling back to p unchanged when it
// doesn't exist yet (the write-a-new-file / stat-of-absent case).
func evalSymlinksOrSelf(p string) string {
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return p
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
			case "fs/readDir":
				h.handleReadDir(write, rawID, params)
			case "fs/addRoot":
				h.handleAddRoot(write, rawID, params)
			case "fs/roots":
				h.handleRoots(write, rawID, params)
			case "fs/stat":
				h.handleStat(write, rawID, params)
			case "fs/setFilter":
				h.handleSetFilter(write, rawID, params)
			case "fs/writeFile":
				h.handleWriteFile(write, rawID, params)
			case "agentSessions/list":
				h.handleAgentSessionsList(write, rawID, params)
			case "agentSessions/read":
				h.handleAgentSessionsRead(write, rawID, params)
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

// errWalkTruncated is the walk-abort sentinel for the maxTreeEntries cap —
// distinguished from real walk errors so truncation is reported as data, not
// swallowed as a log line.
var errWalkTruncated = fmt.Errorf("tree entry limit exceeded (%d)", maxTreeEntries)

func (h *FSHandler) handleListTree(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p listTreeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	// The URI names the directory to walk — "file:///" (or empty) is the served
	// root, anything else resolves with the same precedence rules as content
	// read/write (resolvePath), so a walk can only enter registered roots.
	// Directories outside become walkable after fs/addRoot.
	base, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}
	info, err := os.Stat(base)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if !info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "not a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	entries := make([]dirEntry, 0, 512)
	count := 0

	walkErr := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip errors (permission denied, etc.)
		}

		// Skip excluded directories
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			// Don't include the walked root itself
			if path == base {
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
			return errWalkTruncated
		}

		rel, _ := filepath.Rel(base, path)
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
			Path: filepath.ToSlash(rel),
			Type: entryType,
			Size: size,
		})
		return nil
	})

	truncated := walkErr == errWalkTruncated
	if walkErr != nil && !truncated {
		log.Printf("[fs] listTree walk error: %v", walkErr)
	}
	if truncated {
		log.Printf("[fs] listTree truncated at %d entries: %s", maxTreeEntries, base)
	}

	h.sendRPCResult(write, id, listTreeResult{Entries: entries, Truncated: truncated})
}

// handleReadDir serves a shallow, unfiltered listing of one directory — the
// browse primitive behind the IDE's file browser. It deliberately maps the URI
// with uriToPath, NOT resolvePath: browsing takes literal absolute paths only,
// so it can never mis-resolve through the root-relative existence
// disambiguation, and it is deliberately wider than the read/write sandbox —
// a single-operator tool listing what the operator could already `ls`.
// Selection stays browse-wide; file CONTENT read/write stays root-gated.
func (h *FSHandler) handleReadDir(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p readDirParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	dir, err := uriToPath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, -32602, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	info, err := os.Stat(dir)
	if err != nil {
		if os.IsPermission(err) {
			h.sendRPCError(write, id, errPermissionDenied, "permission denied: "+p.URI, map[string]string{"uri": p.URI})
			return
		}
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if !info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "not a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	children, err := os.ReadDir(dir)
	if err != nil {
		if os.IsPermission(err) {
			h.sendRPCError(write, id, errPermissionDenied, "permission denied: "+p.URI, map[string]string{"uri": p.URI})
			return
		}
		h.sendRPCError(write, id, errFileNotFound, "read dir error: "+err.Error(), map[string]string{"uri": p.URI})
		return
	}

	result := readDirResult{Path: filepath.ToSlash(dir), Entries: make([]readDirEntry, 0, len(children))}
	for _, d := range children {
		if len(result.Entries) >= maxReadDirEntries {
			result.Truncated = true
			break
		}
		entryType := "file"
		if d.IsDir() {
			entryType = "directory"
		} else if d.Type()&os.ModeSymlink != 0 {
			entryType = "symlink"
		}
		var size int64
		// Info is lstat-shaped for ReadDir entries: symlinks report the link
		// itself, and a dangling symlink still lists (its target's absence is
		// the browser's problem to render, not ours to hide).
		if !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				size = fi.Size()
			}
		}
		result.Entries = append(result.Entries, readDirEntry{Name: d.Name(), Type: entryType, Size: size})
	}
	h.sendRPCResult(write, id, result)
}

// handleAddRoot registers a directory as a runtime reach root — the dynamic
// form of --reach, invoked when the operator opens a directory outside the
// served root. After this, resolvePath admits reads/writes under it and
// listTree can walk it.
func (h *FSHandler) handleAddRoot(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p addRootParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}

	dir, err := uriToPath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, -32602, err.Error(), map[string]string{"uri": p.URI})
		return
	}

	// The root must exist and be a directory; store its symlink-resolved form
	// so underAnyRoot's prefix checks line up with resolvePath's resolved
	// candidates (macOS /tmp → /private/tmp and friends).
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	info, err := os.Stat(resolved)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if !info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "not a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}

	added := h.addRoot(resolved)
	if added {
		log.Printf("[fs] reach root added: %s", resolved)
	}
	_, extra := h.Roots()
	h.sendRPCResult(write, id, addRootResult{
		Root:       filepath.ToSlash(resolved),
		Added:      added,
		ExtraRoots: toSlashAll(extra),
	})
}

// handleRoots reports what the handler serves and can reach — the browser's
// one source of truth for "what am I attached to" (served root, reach set)
// and its browse anchors (home directory, path separator).
func (h *FSHandler) handleRoots(write writeFn, id json.RawMessage, raw json.RawMessage) {
	home, _ := os.UserHomeDir()
	root, extra := h.Roots()
	h.sendRPCResult(write, id, rootsResult{
		Root:       filepath.ToSlash(root),
		ExtraRoots: toSlashAll(extra),
		Home:       filepath.ToSlash(home),
		Sep:        string(filepath.Separator),
	})
}

// toSlashAll maps filepath.ToSlash over a fresh slice — wire form is always
// forward slashes; only URI/display boundaries convert.
func toSlashAll(paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = filepath.ToSlash(p)
	}
	return out
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
// Shape:   { uri, content, encoding?, baseMtime?, allowEmpty? }  ->  { uri, bytesWritten, mtime }
// Safety:  resolvePath enforces the project-root boundary (same as read).
//
//	Refuses directories, refuses payloads over maxFileSize, and
//	refuses utf-8 payloads that don't actually decode cleanly.
//
// Correctness barriers:
//   - stale write: if baseMtime is set and the file's mtime has moved
//     since, refuse (errStaleWrite) rather than clobber an external
//     change with a stale buffer.
//   - truncation: refuse to overwrite a non-empty file with empty
//     content unless allowEmpty is set (errWouldTruncate).
//
// Durability: atomicReplace writes a temp in the target's directory, fsyncs it,
// then renames over the target — atomic and crash-safe against zero-length
// files (renameio on Unix; temp + fsync + MoveFileEx on Windows). On Unix the
// existing file's mode is preserved and the parent directory is fsynced
// best-effort.
//
// Notification: on success, if a notify hook is wired, emits an
//
//	fs/didChange RPC to the display so any open editor can
//	round-trip-confirm the write (editable-3d-ide L0).
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

	// Stat the target once — it drives three checks here (refuse a directory,
	// detect a stale write, guard against catastrophic truncation) and a
	// fourth inside renameio (preserve the existing file's mode). A stat error
	// means the path doesn't exist yet — a fresh create, where all three skip.
	// We do NOT auto-mkdir parent directories yet (adds surface area; can be a
	// flag in a later phase if a real need appears).
	var existed bool
	var curSize, curMtime int64
	if info, err := os.Stat(resolved); err == nil {
		if info.IsDir() {
			h.sendRPCError(write, id, errIsDirectory, "is a directory: "+p.URI, map[string]string{"uri": p.URI})
			return
		}
		existed = true
		curSize = info.Size()
		curMtime = info.ModTime().UnixMilli()
	}

	// Barrier 1 — stale write / lost update. BaseMtime is the mtime the client
	// last synced this buffer at; if the file on disk has moved since (git pull,
	// a formatter, another agent), refuse rather than clobber that change with
	// our stale buffer. 0 means the client has no base → skip the check.
	if existed && p.BaseMtime != 0 && p.BaseMtime != curMtime {
		h.sendRPCError(write, id, errStaleWrite, "file changed on disk since it was opened: "+p.URI,
			map[string]any{"uri": p.URI, "baseMtime": p.BaseMtime, "currentMtime": curMtime})
		return
	}

	// Barrier 2 — catastrophic truncation. Refuse to durably overwrite a
	// non-empty file with nothing unless the caller opts in. Catches a buffer
	// bug emptying the payload and atomically wiping a real file; clearing a
	// file on purpose is a deliberate AllowEmpty.
	if existed && curSize > 0 && len(data) == 0 && !p.AllowEmpty {
		h.sendRPCError(write, id, errWouldTruncate,
			"refusing to overwrite a non-empty file with empty content (set allowEmpty to override): "+p.URI,
			map[string]any{"uri": p.URI, "currentSize": curSize})
		return
	}

	// Durable atomic replace. atomicReplace is platform-specific (see
	// fs_atomic_unix.go / fs_atomic_windows.go): on Unix it's renameio — a
	// randomly-named temp in the target dir, fsync'd, renamed over the target,
	// the existing mode preserved, parent dir fsync'd; on Windows it's the
	// closest safe approximation (temp + fsync + MoveFileEx replace). Either way
	// the fsync-before-rename rules out a zero-length file after a crash.
	if err := atomicReplace(resolved, data); err != nil {
		h.sendRPCError(write, id, errWriteFailed, "atomic write failed: "+err.Error(), map[string]string{"uri": p.URI})
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

// resolvePath maps a file:// URI to a concrete on-disk path, enforcing the
// reachability boundary: the result must live under the project root or one of
// the extra reach roots (e.g. /tmp).
//
// The canonical URI form is file:///<path>, so once "file://" is stripped every
// path carries a leading "/" and looks absolute — we cannot tell a root-relative
// "tmp/foo" from a genuinely-absolute "/tmp/foo" by syntax. We disambiguate by
// existence, with the project root taking precedence:
//
//  1. <root>/<path> exists           → that. The project always wins, so a repo
//     with its own top-level tmp/ still
//     addresses its own files (backward compat).
//  2. <path> is under a reach root   → that. The escape hatch: a file an agent
//     dropped in /tmp resolves to /tmp/foo.
//  3. otherwise                      → <root>/<path>. Default to in-project so a
//     NEW file (write/stat of a not-yet-created
//     path) lands under the project root.
//
// ".." traversal is rejected up front, and every candidate is symlink-resolved
// then re-checked against the allowed roots so a symlink can't tunnel out.
func (h *FSHandler) resolvePath(uri string) (string, error) {
	path := uri
	if strings.HasPrefix(path, "file://") {
		path = strings.TrimPrefix(path, "file://")
	}
	if strings.Contains(path, "..") {
		return "", fmt.Errorf("path traversal rejected: %s", uri)
	}
	path = filepath.Clean(path)

	// Candidate 1 — root-relative: strip the leading slash the file:/// form
	// always carries, then join under the project root.
	rel := strings.TrimPrefix(path, "/")
	rootCand := evalSymlinksOrSelf(filepath.Join(h.root, rel))

	// Candidate 2 — literal absolute path: the reach hatch into /tmp & friends.
	var absCand string
	if filepath.IsAbs(path) {
		absCand = evalSymlinksOrSelf(path)
	}

	// 1: an existing project file always wins.
	if h.underAnyRoot(rootCand) && pathExists(rootCand) {
		return rootCand, nil
	}
	// 2: reach out to an absolute path under an extra root (exists, or a
	//    not-yet-created write target whose root is allowed).
	if absCand != "" && h.underAnyRoot(absCand) {
		return absCand, nil
	}
	// 3: default to the project-relative path so new files land in-project.
	if h.underAnyRoot(rootCand) {
		return rootCand, nil
	}
	return "", fmt.Errorf("path escapes reachable roots: %s → %s", uri, rootCand)
}

// pathExists reports whether a path currently resolves to something on disk.
func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// isWindows gates the drive-letter URI form in uriToPath.
var isWindows = os.PathSeparator == '\\'

// stripLeadingDriveSlash turns the URI-path form of a Windows drive path
// ("/C:/dev/x") into the bare drive form ("C:/dev/x") so filepath.IsAbs holds.
// Anything else passes through untouched.
func stripLeadingDriveSlash(p string) string {
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		c := p[1]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			return p[1:]
		}
	}
	return p
}

// uriToPath maps a file:// URI (or bare path) to the literal absolute path it
// names. This is the browse mapping — fs/readDir and fs/addRoot — with NO
// root-relative disambiguation and NO reachability gate: the operator is
// pointing at the real filesystem, and a literal-absolute contract means
// browsing can never mis-resolve. ".." is rejected (same string rule as
// resolvePath) and relative paths are refused outright.
func uriToPath(uri string) (string, error) {
	p := strings.TrimPrefix(uri, "file://")
	if strings.Contains(p, "..") {
		return "", fmt.Errorf("path traversal rejected: %s", uri)
	}
	if isWindows {
		p = stripLeadingDriveSlash(p)
	}
	p = filepath.Clean(filepath.FromSlash(p))
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("absolute path required: %s", uri)
	}
	return p, nil
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
