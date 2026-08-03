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
//
// A second harness — Kimi Code — archives beside it: sessions live at
// ~/.kimi-code/sessions/<workspace>/<session-id>/agents/main/wire.jsonl, and
// ~/.kimi-code/session_index.jsonl (one {"sessionId","sessionDir","workDir"}
// object per line) maps them to a project root. agentSessions/list merges both
// harnesses (each entry tagged), agentSessions/read takes an optional
// `harness` param (default "claude") — same transport, same window rules.

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
// keeps the Join in handleAgentSessionsRead inside the sessions dir. Kimi ids
// ("session_<uuid>") carry an underscore, so '_' is in the alphabet too.
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

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

// ---- Kimi Code archive (harness #2) ----

// kimiSessionIndexPath is where Kimi Code keeps its session index:
// ~/.kimi-code/session_index.jsonl, one {"sessionId","sessionDir","workDir"}
// object per line. The workspace dir names under ~/.kimi-code/sessions carry
// an opaque hash suffix, so the index — never path derivation — is how a
// served root finds its kimi transcripts. "" when home is unknown; a missing
// file simply means no kimi sessions.
func kimiSessionIndexPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".kimi-code", "session_index.jsonl")
}

// kimiSessionIndexEntry is one line of Kimi Code's session_index.jsonl.
type kimiSessionIndexEntry struct {
	SessionID  string `json:"sessionId"`
	SessionDir string `json:"sessionDir"`
	WorkDir    string `json:"workDir"`
}

// kimiWirePath is the one transcript a kimi session is opened from: the MAIN
// agent's wire log (agents/agent-N are subagents — the JS adapter skipping
// them mirrors the Claude adapter's sidechain skip).
func kimiWirePath(sessionDir string) string {
	return filepath.Join(sessionDir, "agents", "main", "wire.jsonl")
}

// readKimiSessionIndex parses the kimi session index, keeping entries whose
// workDir is the served root. A missing/unreadable index (kimi never ran for
// this root) yields nil, never an error; malformed lines drop.
func readKimiSessionIndex(indexPath, root string) []kimiSessionIndexEntry {
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return nil
	}
	var out []kimiSessionIndexEntry
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var e kimiSessionIndexEntry
		if json.Unmarshal(line, &e) != nil || e.SessionID == "" || e.SessionDir == "" {
			continue
		}
		if filepath.Clean(e.WorkDir) != root {
			continue
		}
		out = append(out, e)
	}
	return out
}

// ---- Types matching the JS side ----

// agentSessionInfo is one transcript in an agentSessions/list result. Harness
// tags which agent harness wrote it ("claude" | "kimi").
type agentSessionInfo struct {
	ID      string `json:"id"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"` // UnixMilli
	Harness string `json:"harness"`
}

// agentSessionsListResult is the agentSessions/list response. Dir is the
// derived Claude transcript directory (it may not exist); Sessions is
// newest-first across BOTH harnesses.
type agentSessionsListResult struct {
	Dir      string             `json:"dir"`
	Sessions []agentSessionInfo `json:"sessions"`
}

// agentSessionsReadParams is the body of agentSessions/read. TailBytes = 0
// reads the whole transcript (bounded by maxSessionReadSize); > 0 reads only
// the final TailBytes bytes, advanced to the first line boundary. Harness
// selects the archive (default "claude").
type agentSessionsReadParams struct {
	ID        string `json:"id"`
	TailBytes int64  `json:"tailBytes"`
	Harness   string `json:"harness"`
}

// agentSessionsReadResult is the agentSessions/read response. Content is the
// transcript's raw JSONL text — unparsed; Size and Mtime describe the whole
// file on disk, so a poller can diff them against its last read; Truncated
// reports that Content is a line-aligned tail, not the whole file. Cwd is the
// session's working directory when the harness's index knows it (kimi — the
// wire transcript doesn't reliably carry one); claude leaves it empty.
type agentSessionsReadResult struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"` // UnixMilli
	Truncated bool   `json:"truncated"`
	Cwd       string `json:"cwd,omitempty"`
}

// ---- Method Handlers ----

// handleAgentSessionsList lists the served root's transcripts, newest-first,
// from BOTH harnesses (claude entries from the projects dir, kimi entries from
// the session index filtered to this root). Absent (or unreadable) sources are
// an empty list, never an error — running without either harness around is
// normal.
func (h *FSHandler) handleAgentSessionsList(write writeFn, id json.RawMessage, raw json.RawMessage) {
	result := agentSessionsListResult{
		Dir:      filepath.ToSlash(h.sessionsDir),
		Sessions: []agentSessionInfo{},
	}
	if h.sessionsDir != "" {
		if entries, err := os.ReadDir(h.sessionsDir); err == nil {
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
					ID:      sid,
					Size:    info.Size(),
					Mtime:   info.ModTime().UnixMilli(),
					Harness: "claude",
				})
			}
		}
	}
	// Kimi: same listing, sourced from the session index. An entry whose main
	// wire log is missing can't be read, so it doesn't list either.
	if h.kimiIndex != "" {
		for _, e := range readKimiSessionIndex(h.kimiIndex, h.root) {
			if !sessionIDRe.MatchString(e.SessionID) {
				continue
			}
			info, err := os.Stat(kimiWirePath(e.SessionDir))
			if err != nil || info.IsDir() {
				continue
			}
			result.Sessions = append(result.Sessions, agentSessionInfo{
				ID:      e.SessionID,
				Size:    info.Size(),
				Mtime:   info.ModTime().UnixMilli(),
				Harness: "kimi",
			})
		}
	}
	sort.SliceStable(result.Sessions, func(i, j int) bool {
		return result.Sessions[i].Mtime > result.Sessions[j].Mtime
	})
	h.sendRPCResult(write, id, result)
}

// handleAgentSessionsRead serves one transcript's raw bytes.
//
// Shape:  { id, tailBytes?, harness? }  ->  { id, content, size, mtime, truncated, cwd? }
// The window is the whole file, narrowed to the final tailBytes when given,
// and bounded by maxSessionReadSize either way. A window that starts mid-file
// advances past its first newline so content begins on a JSONL line boundary
// (which is also a UTF-8 boundary); truncated=true marks any such tail.
// Harness (default "claude") picks the archive the id resolves against.
func (h *FSHandler) handleAgentSessionsRead(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p agentSessionsReadParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if !sessionIDRe.MatchString(p.ID) {
		h.sendRPCError(write, id, -32602, "invalid session id (want [A-Za-z0-9_-]{1,128}): "+p.ID, map[string]string{"id": p.ID})
		return
	}
	if p.TailBytes < 0 {
		h.sendRPCError(write, id, -32602, "tailBytes must be non-negative", map[string]string{"id": p.ID})
		return
	}
	harness := p.Harness
	if harness == "" {
		harness = "claude"
	}

	// Resolve the transcript path for the requested harness. Both resolutions
	// end in a containment re-check — belt and braces against a future loosening
	// of the id alphabet, and (kimi) against a sessionDir read from a
	// user-writable index pointing outside the kimi home.
	var path, cwd string
	switch harness {
	case "claude":
		if h.sessionsDir == "" {
			h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
			return
		}
		path = filepath.Join(h.sessionsDir, p.ID+".jsonl")
		if !isUnder(path, h.sessionsDir) {
			h.sendRPCError(write, id, errPermissionDenied, "session id escapes sessions dir: "+p.ID, map[string]string{"id": p.ID})
			return
		}
	case "kimi":
		if h.kimiIndex == "" {
			h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
			return
		}
		var found *kimiSessionIndexEntry
		for _, e := range readKimiSessionIndex(h.kimiIndex, h.root) {
			if e.SessionID == p.ID {
				found = &e
				break
			}
		}
		if found == nil {
			h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
			return
		}
		path = kimiWirePath(found.SessionDir)
		cwd = found.WorkDir
		if !isUnder(path, filepath.Dir(h.kimiIndex)) {
			h.sendRPCError(write, id, errPermissionDenied, "session dir escapes kimi home: "+p.ID, map[string]string{"id": p.ID})
			return
		}
	default:
		h.sendRPCError(write, id, -32602, "unknown harness (want claude|kimi): "+harness, map[string]string{"id": p.ID})
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
		Cwd:       cwd,
	})
}
