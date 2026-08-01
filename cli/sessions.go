package main

// Agent-session transcript access — read-only JSON-RPC over the relay bridge.
//
// Claude Code appends each session's transcript to
// ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl. The two
// agentSessions/* methods expose that directory for the served root: list the
// transcripts, read one (whole or a tail window). PURE TRANSPORT, the same
// philosophy as hook.go's forwardConversation: the relay ships raw bytes and
// stat facts, ZERO parsing or semantics server-side — every JSONL line's
// meaning lives in the JS registry that consumes it.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// maxSessionReadSize caps the transcript bytes one agentSessions/read response
// may carry. A larger file reads as its FINAL maxSessionReadSize bytes
// (line-aligned, truncated=true) — a transcript's newest entries are the
// useful end, and a read-only viewer prefers a bounded tail over an error.
// A var, not a const, so tests can lower it.
var maxSessionReadSize = int64(64 * 1024 * 1024) // 64MB

// sessionIDRe is the whole addressing contract for a transcript: the id is the
// filename minus .jsonl, and this alphabet (no separators, no dots) is what
// keeps the Join in handleAgentSessionsRead inside the sessions dir.
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)

// agentSessionsDir derives the Claude Code transcript directory for a project
// root: ~/.claude/projects/<encoded>, where <encoded> is the absolute project
// path with every character outside [A-Za-z0-9] replaced by '-'. Verified
// against disk: /home/ivan/dev/glyph3d-js → -home-ivan-dev-glyph3d-js, and
// underscores map the same way (/home/ivan/dev/media_gen →
// -home-ivan-dev-media-gen). Returns "" when the home directory is unknown;
// the dir not existing is fine either way — the agentSessions/* methods answer
// an absent dir gracefully (empty list / not-found), never with a hard error.
func agentSessionsDir(root string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects", encodeClaudeProjectDir(root))
}

// encodeClaudeProjectDir maps an absolute path to Claude Code's project-dir
// name: every rune outside [A-Za-z0-9] becomes one '-'.
func encodeClaudeProjectDir(p string) string {
	var b strings.Builder
	b.Grow(len(p))
	for _, r := range p {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// ---- Types matching the JS side ----

// agentSessionInfo is one transcript in an agentSessions/list result.
type agentSessionInfo struct {
	ID    string `json:"id"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // UnixMilli
}

// agentSessionsListResult is the agentSessions/list response. Dir is the
// derived transcript directory (it may not exist); Sessions is newest-first.
type agentSessionsListResult struct {
	Dir      string             `json:"dir"`
	Sessions []agentSessionInfo `json:"sessions"`
}

// agentSessionsReadParams is the body of agentSessions/read. TailBytes = 0
// reads the whole transcript (bounded by maxSessionReadSize); > 0 reads only
// the final TailBytes bytes, advanced to the first line boundary.
type agentSessionsReadParams struct {
	ID        string `json:"id"`
	TailBytes int64  `json:"tailBytes"`
}

// agentSessionsReadResult is the agentSessions/read response. Content is the
// transcript's raw JSONL text — unparsed; Size and Mtime describe the whole
// file on disk, so a poller can diff them against its last read; Truncated
// reports that Content is a line-aligned tail, not the whole file.
type agentSessionsReadResult struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"` // UnixMilli
	Truncated bool   `json:"truncated"`
}

// ---- Method Handlers ----

// handleAgentSessionsList lists the served root's transcripts, newest-first.
// An absent (or unreadable) sessions dir is an empty list, never an error —
// running without Claude Code around is normal.
func (h *FSHandler) handleAgentSessionsList(write writeFn, id json.RawMessage, raw json.RawMessage) {
	result := agentSessionsListResult{
		Dir:      filepath.ToSlash(h.sessionsDir),
		Sessions: []agentSessionInfo{},
	}
	if h.sessionsDir == "" {
		h.sendRPCResult(write, id, result)
		return
	}
	entries, err := os.ReadDir(h.sessionsDir)
	if err != nil {
		h.sendRPCResult(write, id, result)
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		sid := strings.TrimSuffix(name, ".jsonl")
		// Only ids agentSessions/read can address get listed — a name outside
		// the id alphabet stays invisible rather than listed-but-unreadable.
		if !sessionIDRe.MatchString(sid) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		result.Sessions = append(result.Sessions, agentSessionInfo{
			ID:    sid,
			Size:  info.Size(),
			Mtime: info.ModTime().UnixMilli(),
		})
	}
	sort.SliceStable(result.Sessions, func(i, j int) bool {
		return result.Sessions[i].Mtime > result.Sessions[j].Mtime
	})
	h.sendRPCResult(write, id, result)
}

// handleAgentSessionsRead serves one transcript's raw bytes.
//
// Shape:  { id, tailBytes? }  ->  { id, content, size, mtime, truncated }
// The window is the whole file, narrowed to the final tailBytes when given,
// and bounded by maxSessionReadSize either way. A window that starts mid-file
// advances past its first newline so content begins on a JSONL line boundary
// (which is also a UTF-8 boundary); truncated=true marks any such tail.
func (h *FSHandler) handleAgentSessionsRead(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p agentSessionsReadParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if !sessionIDRe.MatchString(p.ID) {
		h.sendRPCError(write, id, -32602, "invalid session id (want [A-Za-z0-9-]{1,128}): "+p.ID, map[string]string{"id": p.ID})
		return
	}
	if p.TailBytes < 0 {
		h.sendRPCError(write, id, -32602, "tailBytes must be non-negative", map[string]string{"id": p.ID})
		return
	}
	if h.sessionsDir == "" {
		h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
		return
	}

	// The id alphabet forbids path separators and dots, so this Join cannot
	// escape; the containment re-check is belt and braces against any future
	// loosening of the pattern.
	path := filepath.Join(h.sessionsDir, p.ID+".jsonl")
	if !isUnder(path, h.sessionsDir) {
		h.sendRPCError(write, id, errPermissionDenied, "session id escapes sessions dir: "+p.ID, map[string]string{"id": p.ID})
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
		return
	}
	if info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "is a directory: "+p.ID, map[string]string{"id": p.ID})
		return
	}
	size := info.Size()

	// Window selection: whole file by default, the final tailBytes on request,
	// maxSessionReadSize as the ceiling for both.
	start := int64(0)
	if p.TailBytes > 0 && p.TailBytes < size {
		start = size - p.TailBytes
	}
	if size-start > maxSessionReadSize {
		start = size - maxSessionReadSize
	}

	f, err := os.Open(path)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "open error: "+err.Error(), map[string]string{"id": p.ID})
		return
	}
	defer f.Close()

	buf := make([]byte, size-start)
	got, err := f.ReadAt(buf, start)
	// A live transcript can move under us between Stat and ReadAt; a short
	// read at EOF is a consistent smaller snapshot, not a failure.
	if err != nil && err != io.EOF {
		h.sendRPCError(write, id, errFileNotFound, "read error: "+err.Error(), map[string]string{"id": p.ID})
		return
	}
	buf = buf[:got]

	// A mid-file window starts at an arbitrary byte — advance to the byte
	// after the first newline. A window with no newline is one partial line:
	// return nothing rather than a torn line.
	truncated := start > 0
	if truncated {
		if nl := bytes.IndexByte(buf, '\n'); nl >= 0 {
			buf = buf[nl+1:]
		} else {
			buf = nil
		}
	}

	h.sendRPCResult(write, id, agentSessionsReadResult{
		ID:        p.ID,
		Content:   string(buf),
		Size:      size,
		Mtime:     info.ModTime().UnixMilli(),
		Truncated: truncated,
	})
}
