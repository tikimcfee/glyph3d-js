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
// object per line) maps them to a project root. A third — the Antigravity CLI
// (agy) — keeps conversations under ~/.gemini/antigravity-cli/brain/<id>/ and
// is attributed to a root through its own history + subagent index files (see
// the agy section). agentSessions/list merges every harness (each entry
// tagged), agentSessions/read takes an optional `harness` param (default
// "claude") — same transport, same window rules.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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

// ---- Antigravity CLI archive (harness #3) ----
//
// agy keeps each conversation in ~/.gemini/antigravity-cli/brain/<conversation-id>/,
// its transcript at .system_generated/logs/transcript_full.jsonl. The brain dirs
// are NOT keyed by project, and the transcript itself names no workspace (run_command
// args carry a per-command Cwd at best), so — exactly like kimi — agy's own index
// files decide which conversations belong to the served root:
//
//   - history.jsonl (one {"display","workspace","conversationId"?,...} per typed
//     prompt): a conversation whose prompts were typed in the root. A conversation
//     whose only history lines lack conversationId (agy omits it on some first
//     prompts) can't be attributed and stays unlisted.
//   - brain/<parent>/.system_generated/subagents/<child>.json
//     ({"conversationId","subagentDescriptor":{"role"},"workspaceUris":["file://…"]}):
//     a subagent conversation working in the root. Subagents never type prompts,
//     so this is their only attribution; they list as conversations of their own.
//   - annotations/<id>.pbtxt (`title:"…"`): the conversation's title, read back as
//     the read result's title (a subagent without one is titled by its role).
//
// Matching is exact (filepath.Clean(workspace) == root), like kimi's workDir.

// agyHomeDir is the Antigravity CLI's state dir: ~/.gemini/antigravity-cli. ""
// when home is unknown; a missing dir simply means no agy conversations.
func agyHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".gemini", "antigravity-cli")
}

// agyTranscriptPath is the one transcript an agy conversation is opened from.
func agyTranscriptPath(agyHome, id string) string {
	return filepath.Join(agyHome, "brain", id, ".system_generated", "logs", "transcript_full.jsonl")
}

// agyConversation is one conversation attributed to the served root.
type agyConversation struct {
	ID    string
	Title string
}

// readAgyConversations lists the conversations whose workspace is root, from
// agy's index files (see the section comment), in first-attributed order.
// Missing/unreadable index files contribute nothing, never an error; malformed
// lines and ids outside the session-id alphabet drop.
func readAgyConversations(agyHome, root string) []agyConversation {
	if agyHome == "" {
		return nil
	}
	var out []agyConversation
	at := map[string]int{} // id -> index in out
	add := func(id, title string) {
		if !sessionIDRe.MatchString(id) {
			return
		}
		if i, ok := at[id]; ok {
			if out[i].Title == "" {
				out[i].Title = title
			}
			return
		}
		at[id] = len(out)
		out = append(out, agyConversation{ID: id, Title: title})
	}

	if data, err := os.ReadFile(filepath.Join(agyHome, "history.jsonl")); err == nil {
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			var e struct {
				ConversationID string `json:"conversationId"`
				Workspace      string `json:"workspace"`
			}
			if len(bytes.TrimSpace(line)) == 0 || json.Unmarshal(line, &e) != nil {
				continue
			}
			if e.ConversationID != "" && e.Workspace != "" && filepath.Clean(e.Workspace) == root {
				add(e.ConversationID, "")
			}
		}
	}

	brain := filepath.Join(agyHome, "brain")
	if parents, err := os.ReadDir(brain); err == nil {
		for _, p := range parents {
			if !p.IsDir() {
				continue
			}
			subDir := filepath.Join(brain, p.Name(), ".system_generated", "subagents")
			subs, err := os.ReadDir(subDir)
			if err != nil {
				continue
			}
			for _, s := range subs {
				if s.IsDir() || !strings.HasSuffix(s.Name(), ".json") {
					continue
				}
				data, err := os.ReadFile(filepath.Join(subDir, s.Name()))
				if err != nil {
					continue
				}
				var d struct {
					ConversationID string `json:"conversationId"`
					Descriptor     struct {
						Role string `json:"role"`
					} `json:"subagentDescriptor"`
					WorkspaceURIs []string `json:"workspaceUris"`
				}
				if json.Unmarshal(data, &d) != nil || d.ConversationID == "" {
					continue
				}
				for _, u := range d.WorkspaceURIs {
					if fileURIPath(u) == root {
						add(d.ConversationID, d.Descriptor.Role)
						break
					}
				}
			}
		}
	}

	// The annotation title (agy's own name for the conversation) beats a role.
	for i := range out {
		data, err := os.ReadFile(filepath.Join(agyHome, "annotations", out[i].ID+".pbtxt"))
		if err != nil {
			continue
		}
		if t := agyAnnotationTitle(data); t != "" {
			out[i].Title = t
		}
	}
	return out
}

// agyAnnotationTitle pulls the `title:"…"` field out of an annotation file
// (protobuf text format; its string escapes are a subset of Go's). "" when absent
// or undecodable.
func agyAnnotationTitle(data []byte) string {
	s := string(data)
	i := strings.Index(s, `title:"`)
	if i < 0 {
		return ""
	}
	q, err := strconv.QuotedPrefix(s[i+len("title:"):])
	if err != nil {
		return ""
	}
	t, err := strconv.Unquote(q)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(t)
}

// fileURIPath maps a file:// URI to a clean local path ("" for anything else).
// A Windows drive URI (file:///C:/x) loses the slash before its drive letter.
func fileURIPath(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" || u.Path == "" {
		return ""
	}
	p := u.Path
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return filepath.Clean(filepath.FromSlash(p))
}

// ---- Types matching the JS side ----

// agentSessionInfo is one transcript in an agentSessions/list result. Harness
// tags which agent harness wrote it ("claude" | "kimi" | "agy").
type agentSessionInfo struct {
	ID      string `json:"id"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"` // UnixMilli
	Harness string `json:"harness"`
}

// agentSessionsListResult is the agentSessions/list response. Dir is the
// derived Claude transcript directory (it may not exist); Sessions is
// newest-first across every harness.
type agentSessionsListResult struct {
	Dir      string             `json:"dir"`
	Sessions []agentSessionInfo `json:"sessions"`
}

// transcriptWindow selects the bytes of a transcript read — the window shared
// by agentSessions/read and gomux/read. TailBytes = 0 reads the whole
// transcript (bounded by maxSessionReadSize); > 0 reads only the final
// TailBytes bytes, advanced to the first line boundary. FromOffset (a pointer
// — 0 is a meaningful start) selects a cursor window instead:
// [fromOffset, fromOffset+maxBytes) (maxBytes 0 = to EOF), same boundary
// advance — the client pages BACK through a transcript by minting the next
// cursor from the previous response's offset. TailBytes and FromOffset are
// mutually exclusive.
type transcriptWindow struct {
	TailBytes  int64  `json:"tailBytes"`
	FromOffset *int64 `json:"fromOffset"`
	MaxBytes   int64  `json:"maxBytes"`
	Binary     bool   `json:"binary"` // answer on the binary result plane (raw transcript bytes)
}

// agentSessionsReadParams is the body of agentSessions/read: an archive id,
// the window, and Harness selecting the archive (default "claude").
type agentSessionsReadParams struct {
	ID      string `json:"id"`
	Harness string `json:"harness"`
	transcriptWindow
}

// agentSessionsReadResult is the agentSessions/read response. Content is the
// transcript's raw JSONL text — unparsed; Size and Mtime describe the whole
// file on disk, so a poller can diff them against its last read; Truncated
// reports that Content is a line-aligned window, not the whole file. Offset
// is the ABSOLUTE byte position Content starts at (after the line-boundary
// advance) — the client's next backward cursor. Cwd is the session's working
// directory when the harness's index knows it (kimi's workDir — the wire
// transcript doesn't reliably carry one; agy's matched workspace); claude
// leaves it empty. Title is the index's name for the conversation (agy only).
type agentSessionsReadResult struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"` // UnixMilli
	Offset    int64  `json:"offset"`
	Truncated bool   `json:"truncated"`
	Cwd       string `json:"cwd,omitempty"`
	Title     string `json:"title,omitempty"`
}

// ---- Method Handlers ----

// handleAgentSessionsList lists the served root's transcripts, newest-first,
// from every harness (claude entries from the projects dir, kimi entries from
// the session index filtered to this root, agy entries from its history and
// subagent index). Absent (or unreadable) sources are an empty list, never an
// error — running without any harness around is normal.
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
	// agy: conversations attributed to this root by its index files; a brain
	// dir with no transcript (a conversation that never got a step) can't be
	// read, so it doesn't list.
	for _, c := range readAgyConversations(h.agyHome, h.root) {
		info, err := os.Stat(agyTranscriptPath(h.agyHome, c.ID))
		if err != nil || info.IsDir() {
			continue
		}
		result.Sessions = append(result.Sessions, agentSessionInfo{
			ID:      c.ID,
			Size:    info.Size(),
			Mtime:   info.ModTime().UnixMilli(),
			Harness: "agy",
		})
	}
	sort.SliceStable(result.Sessions, func(i, j int) bool {
		return result.Sessions[i].Mtime > result.Sessions[j].Mtime
	})
	h.sendRPCResult(write, id, result)
}

// handleAgentSessionsRead serves one transcript's raw bytes.
//
// Shape:  { id, tailBytes?, fromOffset?, maxBytes?, harness?, binary? }
//
//	->  { id, content, size, mtime, offset, truncated, cwd?, title? }
//
// The window is the whole file, narrowed to the final tailBytes when given,
// or to the cursor window [fromOffset, fromOffset+maxBytes) — and bounded by
// maxSessionReadSize any way (the bound keeps the window's END: the newest
// bytes are the useful ones). A window that starts mid-file advances past its
// first newline so content begins on a JSONL line boundary (which is also a
// UTF-8 boundary); truncated=true marks any such window, and offset reports
// the absolute byte the content starts at — the next backward cursor.
// Harness (default "claude") picks the archive the id resolves against.
// binary=true answers on the binary result plane: the header carries every
// field but content, and the transcript crosses as raw bytes — a 30MB
// transcript skips the JSON escaping + giant-message parse entirely.
func (h *FSHandler) handleAgentSessionsRead(write writeFn, writeBin writeBinFn, id json.RawMessage, raw json.RawMessage) {
	var p agentSessionsReadParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if !sessionIDRe.MatchString(p.ID) {
		h.sendRPCError(write, id, -32602, "invalid session id (want [A-Za-z0-9_-]{1,128}): "+p.ID, map[string]string{"id": p.ID})
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
	var path, cwd, title string
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
	case "agy":
		// Only a conversation attributed to this root resolves — the same index
		// lookup the list ran, so an id from another workspace is not-found here.
		var found *agyConversation
		for _, c := range readAgyConversations(h.agyHome, h.root) {
			if c.ID == p.ID {
				found = &c
				break
			}
		}
		if found == nil {
			h.sendRPCError(write, id, errFileNotFound, "session not found: "+p.ID, map[string]string{"id": p.ID})
			return
		}
		path = agyTranscriptPath(h.agyHome, found.ID)
		cwd = h.root
		title = found.Title
		if !isUnder(path, filepath.Join(h.agyHome, "brain")) {
			h.sendRPCError(write, id, errPermissionDenied, "session id escapes agy brain dir: "+p.ID, map[string]string{"id": p.ID})
			return
		}
	default:
		h.sendRPCError(write, id, -32602, "unknown harness (want claude|kimi|agy): "+harness, map[string]string{"id": p.ID})
		return
	}
	h.serveTranscriptWindow(write, writeBin, id, p.ID, path, cwd, title, p.transcriptWindow)
}

// serveTranscriptWindow answers a transcript read: the window of the file at
// path (already resolved and contained by the caller), as raw bytes. `name`
// is the caller's address for the transcript — echoed as the result's id and
// in every error; cwd and title ride along when the caller's index knows them.
// The window rules are transcriptWindow's.
func (h *FSHandler) serveTranscriptWindow(write writeFn, writeBin writeBinFn, id json.RawMessage, name, path, cwd, title string, p transcriptWindow) {
	if p.TailBytes < 0 {
		h.sendRPCError(write, id, -32602, "tailBytes must be non-negative", map[string]string{"id": name})
		return
	}
	if p.FromOffset != nil && *p.FromOffset < 0 {
		h.sendRPCError(write, id, -32602, "fromOffset must be non-negative", map[string]string{"id": name})
		return
	}
	if p.FromOffset != nil && p.TailBytes > 0 {
		h.sendRPCError(write, id, -32602, "tailBytes and fromOffset are mutually exclusive", map[string]string{"id": name})
		return
	}
	if p.MaxBytes < 0 || (p.MaxBytes > 0 && p.FromOffset == nil) {
		h.sendRPCError(write, id, -32602, "maxBytes must be non-negative and requires fromOffset", map[string]string{"id": name})
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "session not found: "+name, map[string]string{"id": name})
		return
	}
	if info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "is a directory: "+name, map[string]string{"id": name})
		return
	}
	size := info.Size()

	// Window selection: whole file by default, the final tailBytes on request,
	// or the cursor window [fromOffset, fromOffset+maxBytes). maxSessionReadSize
	// is the ceiling for all three; it keeps the window's END (newest bytes).
	start, end := int64(0), size
	switch {
	case p.FromOffset != nil:
		start = min(*p.FromOffset, size)
		if p.MaxBytes > 0 {
			end = min(size, start+p.MaxBytes)
		}
	case p.TailBytes > 0 && p.TailBytes < size:
		start = size - p.TailBytes
	}
	if end-start > maxSessionReadSize {
		start = end - maxSessionReadSize
	}

	f, err := os.Open(path)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "open error: "+err.Error(), map[string]string{"id": name})
		return
	}
	defer f.Close()

	// A mid-file window reads from one byte EARLIER than requested: a '\n' at
	// start-1 means the window already begins on a record boundary (a cursor
	// minted from a previous response's offset) — advancing again would drop a
	// whole record. Anything else is an arbitrary landing — advance to the byte
	// after the first newline; a window with no newline is one partial line:
	// return nothing rather than a torn line. offset tracks where the returned
	// content actually begins — the client's next backward cursor.
	truncated := start > 0 || end < size
	offset := start
	readStart := start
	if start > 0 {
		readStart = start - 1
	}
	buf := make([]byte, end-readStart)
	got, err := f.ReadAt(buf, readStart)
	// A live transcript can move under us between Stat and ReadAt; a short
	// read at EOF is a consistent smaller snapshot, not a failure.
	if err != nil && err != io.EOF {
		h.sendRPCError(write, id, errFileNotFound, "read error: "+err.Error(), map[string]string{"id": name})
		return
	}
	buf = buf[:got]
	if start > 0 {
		if len(buf) > 0 && buf[0] == '\n' {
			buf = buf[1:]
		} else if nl := bytes.IndexByte(buf, '\n'); nl >= 0 {
			buf = buf[nl+1:]
			offset = readStart + int64(nl) + 1
		} else {
			offset = readStart + int64(len(buf))
			buf = nil
		}
	}

	if p.Binary {
		hdr := map[string]any{
			"id": name, "size": size, "mtime": info.ModTime().UnixMilli(), "offset": offset, "truncated": truncated,
		}
		if cwd != "" {
			hdr["cwd"] = cwd
		}
		if title != "" {
			hdr["title"] = title
		}
		sendRPCBinaryResult(writeBin, id, hdr, buf)
		return
	}

	h.sendRPCResult(write, id, agentSessionsReadResult{
		ID:        name,
		Content:   string(buf),
		Size:      size,
		Mtime:     info.ModTime().UnixMilli(),
		Offset:    offset,
		Truncated: truncated,
		Cwd:       cwd,
		Title:     title,
	})
}
