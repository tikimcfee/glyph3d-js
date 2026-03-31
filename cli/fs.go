package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// JSON-RPC error codes (mirrored in src/services/data/types.js)
const (
	errFileNotFound     = -32001
	errPermissionDenied = -32002
	errIsDirectory      = -32003
	errFileTooLarge     = -32004
)

const (
	maxFileSize    = 10 * 1024 * 1024 // 10MB
	maxTreeEntries = 50000
	rpcTimeout     = 10 * time.Second
)

// Directories and extensions to skip during tree walk.
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"__pycache__":  true,
	".cache":       true,
	".tox":         true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
}

var binaryExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".bmp": true,
	".ico": true, ".webp": true, ".tiff": true, ".psd": true,
	".mp3": true, ".mp4": true, ".wav": true, ".ogg": true, ".flac": true,
	".avi": true, ".mov": true, ".mkv": true, ".webm": true,
	".zip": true, ".tar": true, ".gz": true, ".bz2": true, ".xz": true,
	".7z": true, ".rar": true,
	".exe": true, ".dll": true, ".so": true, ".dylib": true, ".o": true,
	".a": true, ".bin": true, ".wasm": true,
	".pyc": true, ".class": true, ".jar": true,
	".ttf": true, ".otf": true, ".woff": true, ".woff2": true,
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
	".db": true, ".sqlite": true, ".sqlite3": true,
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

		// Skip binary files
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if !d.IsDir() && binaryExts[ext] {
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
