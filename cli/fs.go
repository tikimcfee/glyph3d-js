package main

import (
	"encoding/json"
	"fmt"
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
)

const (
	maxFileSize    = 10 * 1024 * 1024 // 10MB
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

// ---- FSHandler ----

// writeFn sends a serialized message to the display. Set by the Relay.
type writeFn func(data []byte)

// FSHandler serves filesystem requests over JSON-RPC 2.0.
type FSHandler struct {
	root string // absolute path, symlinks resolved
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
			case "fs/listTree":
				h.handleListTree(write, rawID, params)
			case "fs/stat":
				h.handleStat(write, rawID, params)
			case "fs/setFilter":
				h.handleSetFilter(write, rawID, params)
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
