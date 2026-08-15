package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// HookEvent is the JSON structure the agent harness sends on stdin. Claude Code and
// Kimi Code share the field names; kimi differs in the values: session_id is
// "session_<uuid>", there is NO transcript_path (the wire log resolves via the session
// index — see kimiWirePathForSession), no tool_response, no agent_id/agent_type.
type HookEvent struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath string          `json:"transcript_path"`
	CWD            string          `json:"cwd"`
	EventName      string          `json:"hook_event_name"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolResponse   json.RawMessage `json:"tool_response"`
	ToolUseID      string          `json:"tool_use_id"`
	AgentID        string          `json:"agent_id"`
	AgentType      string          `json:"agent_type"`
}

var debug bool

// kimiMode selects the kimi hook dialect (`glyph3d-cli hook --kimi`): same stdin shape,
// but the lane id derives kimi-style and live events tail the session's wire log
// instead of a claude transcript.
var kimiMode bool

func dbg(format string, args ...any) {
	if debug {
		log.Printf("[hook] "+format, args...)
	}
}

// hookCmd reads a hook event from stdin and sends viewer commands.
func hookCmd() {
	// Read stdin
	data, err := io.ReadAll(os.Stdin)
	if err != nil || len(data) == 0 {
		dbg("no stdin data (err=%v, len=%d)", err, len(data))
		os.Exit(0)
	}
	dbg("stdin: %s", string(data))

	var event HookEvent
	if err := json.Unmarshal(data, &event); err != nil {
		dbg("json parse error: %v", err)
		os.Exit(0)
	}
	dbg("event: %s tool=%s", event.EventName, event.ToolName)

	url := os.Getenv("GLYPH_WS_URL")
	if url == "" {
		url = "ws://localhost:8080"
	}

	// Connect to relay (quick timeout — don't block Claude)
	dbg("connecting to %s", url)
	conn, err := hookConnect(url)
	if err != nil {
		dbg("connect failed: %v", err)
		os.Exit(0)
	}
	defer conn.Close()
	dbg("connected")

	// Process the event
	if kimiMode {
		switch event.EventName {
		case "PostToolUse":
			// PostToolUse fires AFTER execution, so the tool.call AND tool.result
			// lines are already in the wire — flush whatever is new.
			forwardKimiWire(conn, &event)
		case "Stop":
			handleKimiStop(conn, &event)
		default:
			// PreToolUse stays a no-op; anything else is ignored.
			dbg("kimi: unhandled event: %s", event.EventName)
		}
	} else {
		switch event.EventName {
		case "PostToolUse":
			handlePostToolUse(conn, &event)
		case "PreToolUse":
			handlePreToolUse(conn, &event)
		case "Stop":
			handleStop(conn, &event)
		default:
			dbg("unhandled event: %s", event.EventName)
		}
	}

	dbg("done")
	os.Exit(0)
}

func hookConnect(url string) (*websocket.Conn, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 2 * time.Second,
	}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return nil, err
	}

	// Quick handshake
	conn.WriteMessage(websocket.TextMessage, []byte("ping"))
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, ack, _ := conn.ReadMessage()
	dbg("handshake ack: %s", string(ack))
	_, pong, _ := conn.ReadMessage()
	dbg("handshake pong: %s", string(pong))
	conn.SetReadDeadline(time.Time{})

	return conn, nil
}

// --- Event Handlers ---

func handlePostToolUse(conn *websocket.Conn, event *HookEvent) {
	id, typ := agentIdentity(event)
	// First flush the CONVERSATION that led here — the `text`/`thinking` blocks written to the
	// transcript since our last forward — so the agent's reasoning decks just AHEAD of the tool it
	// produced. Then ship the RAW tool event. ALL semantics — action/target/detail/result/meta, the
	// touched-line ranges, which tools are noise, message gist/role — live in the ONE JS registry
	// (packages/glyph3d-core/src/collections/toolRegistry.js), shared by this hook and the replay.
	// Adding or removing a tool, or changing how a message reads, never touches this file.
	forwardConversation(conn, event)
	sendTool(conn, id, typ, event.ToolName, event.ToolInput, event.ToolResponse, event.CWD)
}

// handlePreToolUse forwards the about-to-run tool. This is the ONE moment "the agent is
// waiting on a human" is visible live: a blocking call (AskUserQuestion, ExitPlanMode)
// has not returned, so no transcript line and no PostToolUse event exist yet — by the
// time they do, the answer is already in them. Pure transport, like every other handler
// here: EVERY pre-tool event ships, and the JS registry decides which ones block
// (toolRegistry's `blocking` flag, read by agentWaiting.js behind agent.pretool). The
// non-blocking majority is a page-side no-op that builds nothing.
func handlePreToolUse(conn *websocket.Conn, event *HookEvent) {
	id, typ := agentIdentity(event)
	sendPreTool(conn, id, typ, event.ToolName, event.ToolInput, event.CWD)
}

func handleStop(conn *websocket.Conn, event *HookEvent) {
	id, _ := agentIdentity(event)
	// Flush the turn's TRAILING prose — the final `text` block after the last tool, and any pure
	// reasoning turn that called no tool at all (which PostToolUse never sees) — before marking done.
	forwardConversation(conn, event)
	sendCmd(conn, fmt.Sprintf("agent.stop %s", id))
}

// --- Viewer Commands ---

// agentIdentity derives a stable per-agent id + type for the visitor multiplexer.
// Prefer the explicit agent fields (distinct per subagent when Claude Code provides
// them); otherwise fall back to a short slice of the session id so separate sessions
// still read as separate visitors. Tokens only (no spaces) — the bus splits on space.
func agentIdentity(event *HookEvent) (id, typ string) {
	id, typ = event.AgentID, event.AgentType
	if id == "" {
		if s := strings.ReplaceAll(event.SessionID, "-", ""); s != "" {
			if len(s) > 8 {
				s = s[:8]
			}
			id = s
		} else {
			id = "claude"
		}
	}
	if typ == "" {
		typ = "claude"
	}
	return id, typ
}

// sendTool ships the RAW tool event to the viewer:
//
//	agent.tool <id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]
//
// input/response ride as JSON STRINGS inside the `call` bundle (the hatch String-coerces
// non-string args, so a raw object would mangle — see systemCommands `call`); the verb's
// handler JSON.parses them and the ONE tool registry derives action/target/detail/result/meta.
// Trailing empties are trimmed so a fire with no input/response/cwd stays compact.
func sendTool(conn *websocket.Conn, id, typ, name string, input, response json.RawMessage, cwd string) {
	inStr, respStr := "", ""
	if len(input) > 0 {
		inStr = string(input)
	}
	if len(response) > 0 {
		respStr = string(response)
	}
	argv := []string{"agent.tool", id, typ, name, inStr, respStr, cwd}
	for len(argv) > 4 && argv[len(argv)-1] == "" {
		argv = argv[:len(argv)-1]
	}
	payload, err := json.Marshal(argv)
	if err != nil {
		dbg("tool marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// sendPreTool ships the about-to-run tool event to the viewer:
//
//	agent.pretool <id> <type> <ToolName> [inputJSON] [cwd]
//
// Same `call` framing and trailing-empty trim as sendTool; there is no response yet (that
// is the whole point of the event), so the argv is one field shorter.
func sendPreTool(conn *websocket.Conn, id, typ, name string, input json.RawMessage, cwd string) {
	inStr := ""
	if len(input) > 0 {
		inStr = string(input)
	}
	argv := []string{"agent.pretool", id, typ, name, inStr, cwd}
	for len(argv) > 4 && argv[len(argv)-1] == "" {
		argv = argv[:len(argv)-1]
	}
	payload, err := json.Marshal(argv)
	if err != nil {
		dbg("pretool marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// transcriptLine is the slice of a Claude Code transcript line we care about: an assistant message's
// content blocks. We read `text` (the agent's reply) and `thinking` (its reasoning); tool_use blocks
// arrive via the normal tool event, so we skip them here.
type transcriptLine struct {
	Message struct {
		Role    string `json:"role"`
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message"`
}

// forwardConversation ships the assistant prose appended to the session transcript since our last
// forward — one `agent.message` per `text`/`thinking` block — so the trail decks reasoning + speech
// alongside the tool actions. The hook already runs on every tool call and on Stop and already knows
// transcript_path, so this rides the EXISTING path: no tailer, no second connection.
//
// A per-session byte cursor (flock'd against concurrent parallel-tool hooks) tracks how far we've
// read. FIRST SIGHT initializes the cursor to EOF and forwards nothing — we stream the live forward
// from here on, never dump the whole back-history (that's the replay tool's job). Pure transport:
// kind→action and the gist live in the JS registry (normalizeMessage, behind agent.message).
func forwardConversation(conn *websocket.Conn, event *HookEvent) {
	if os.Getenv("GLYPH_CONV") == "off" {
		return
	}
	path := event.TranscriptPath
	if path == "" {
		dbg("conv: no transcript_path")
		return
	}
	id, typ := agentIdentity(event)
	includeThink := os.Getenv("GLYPH_CONV_THINK") != "off"

	// The cursor file doubles as the lock: flock it exclusively so two parallel-tool hook processes
	// can't read the same offset and double-forward (or race past unread lines).
	cursorPath := filepath.Join(os.TempDir(), "glyph-conv-"+sanitizeID(event.SessionID)+".cursor")
	lock, err := os.OpenFile(cursorPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		dbg("conv: cursor open: %v", err)
		return
	}
	defer lock.Close()
	unlock, err := flockExclusive(lock)
	if err != nil {
		dbg("conv: flock: %v", err)
		return
	}
	defer unlock()

	cur, _ := io.ReadAll(lock)
	offset, _ := strconv.ParseInt(strings.TrimSpace(string(cur)), 10, 64)

	f, err := os.Open(path)
	if err != nil {
		dbg("conv: open transcript: %v", err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return
	}
	size := info.Size()

	// First sight (cursor file freshly created → no bytes yet): start from the current end, so we
	// only forward what's written AFTER now. A genuinely-empty transcript falls through to "nothing new".
	if len(cur) == 0 && size > 0 {
		// First sight doubles as the ONCE-PER-SESSION agent.meta flush: the transcript's provenance
		// (slug, model, cwd, gitBranch, aiTitle) lives at its HEAD, which the live tail never
		// re-reads, so harvest it from the existing bytes before jumping to EOF. The cursor file's
		// existence is the sent-already flag — a fresh one means meta has not gone out yet.
		if head, err := io.ReadAll(f); err == nil {
			sendAgentMeta(conn, id, harvestClaudeMeta(head))
		}
		writeCursor(lock, size)
		dbg("conv: first sight, cursor → EOF (%d)", size)
		return
	}
	if offset > size {
		offset = 0 // transcript truncated/rotated — resync from the top
	}
	if offset >= size {
		return // nothing new
	}

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return
	}
	data, _ := io.ReadAll(f)
	nl := bytes.LastIndexByte(data, '\n')
	if nl < 0 {
		return // no complete new line yet — leave it for next time
	}
	for _, line := range bytes.Split(data[:nl+1], []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var tl transcriptLine
		if err := json.Unmarshal(line, &tl); err != nil {
			continue
		}
		if tl.Message.Role != "assistant" {
			continue
		}
		for _, b := range tl.Message.Content {
			switch b.Type {
			case "text":
				if strings.TrimSpace(b.Text) != "" {
					sendMessage(conn, id, typ, "text", b.Text)
				}
			case "thinking":
				if includeThink && strings.TrimSpace(b.Thinking) != "" {
					sendMessage(conn, id, typ, "thinking", b.Thinking)
				}
			}
		}
	}
	writeCursor(lock, offset+int64(nl)+1)
}

// sendMessage ships one conversation block to the trail (raw transport):
//
//	agent.message <id> <type> <kind> <text>
//
// text rides the `call` bundle (base64) so its newlines/quotes survive the bus tokenizer, exactly
// like sendTool's input/response. kind is the transcript block type ('text'|'thinking'); the JS
// registry maps it to a say/think moment.
func sendMessage(conn *websocket.Conn, id, typ, kind, text string) {
	payload, err := json.Marshal([]string{"agent.message", id, typ, kind, text})
	if err != nil {
		dbg("message marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// agentMeta is the session provenance pushed to a LIVE lane (archived lanes get the
// same shape from the JS adapter's parse): session name (slug), human title (aiTitle),
// model, working dir, branch. Field names match the adapter's meta object so the
// agent.meta handler can merge them blindly.
type agentMeta struct {
	Harness   string `json:"harness"`
	Slug      string `json:"slug,omitempty"`
	Title     string `json:"title,omitempty"`
	Model     string `json:"model,omitempty"`
	CWD       string `json:"cwd,omitempty"`
	GitBranch string `json:"gitBranch,omitempty"`
}

// transcriptMetaLine is the slice of a transcript line the meta harvest reads: slug/cwd/
// gitBranch ride ordinary message lines, aiTitle rides `{"type":"ai-title"}` lines, and
// the model lives on assistant messages (message.model).
type transcriptMetaLine struct {
	Slug      string `json:"slug"`
	CWD       string `json:"cwd"`
	GitBranch string `json:"gitBranch"`
	AITitle   string `json:"aiTitle"`
	Message   struct {
		Model string `json:"model"`
	} `json:"message"`
}

// harvestClaudeMeta scans transcript bytes for the FIRST sighting of each provenance
// field (they repeat on later lines; the earliest is the session's identity). Stops
// once every field is found.
func harvestClaudeMeta(data []byte) agentMeta {
	meta := agentMeta{Harness: "claude"}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var ml transcriptMetaLine
		if json.Unmarshal(line, &ml) != nil {
			continue
		}
		if meta.Slug == "" {
			meta.Slug = ml.Slug
		}
		if meta.CWD == "" {
			meta.CWD = ml.CWD
		}
		if meta.GitBranch == "" {
			meta.GitBranch = ml.GitBranch
		}
		if meta.Title == "" {
			meta.Title = ml.AITitle
		}
		if meta.Model == "" {
			meta.Model = ml.Message.Model
		}
		if meta.Slug != "" && meta.CWD != "" && meta.GitBranch != "" && meta.Title != "" && meta.Model != "" {
			break
		}
	}
	return meta
}

// sendAgentMeta ships the session's provenance ONCE per session (first sight — see
// forwardConversation):
//
//	agent.meta <id> <json>
//
// The JSON string rides inside the `call` bundle exactly like sendTool's args; the
// verb's handler merges it onto the lane's meta and rebakes the lane's nameplate.
func sendAgentMeta(conn *websocket.Conn, id string, meta agentMeta) {
	js, err := json.Marshal(meta)
	if err != nil {
		dbg("meta marshal error: %v", err)
		return
	}
	payload, err := json.Marshal([]string{"agent.meta", id, string(js)})
	if err != nil {
		dbg("meta marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// --- Kimi Code mode (--kimi) ---

// kimiAgentIdForSession derives a live kimi lane id. LOCKSTEP with the JS adapter's
// kimiAgentIdForSession (sessionAdapter.js) — live lanes and archive-opened lanes must
// converge on the same book: strip a leading "session_", strip ALL dashes, take the
// first 8 chars; empty → "kimi".
func kimiAgentIdForSession(sessionID string) string {
	s := strings.TrimPrefix(sessionID, "session_")
	s = strings.ReplaceAll(s, "-", "")
	if len(s) > 8 {
		s = s[:8]
	}
	if s == "" {
		return "kimi"
	}
	return s
}

// kimiIndexPath resolves the kimi session index; a var so tests can point it at a
// fixture (mirrors maxSessionReadSize in sessions.go).
var kimiIndexPath = kimiSessionIndexPath

// kimiWirePathForSession resolves a live kimi session's MAIN wire log
// (<sessionDir>/agents/main/wire.jsonl) from the session index — the kimi hook payload
// carries no transcript_path, and the workspace dirs carry opaque hash suffixes, so the
// index is the only way in. Minimal by-sessionId re-read of the index
// (readKimiSessionIndex's workDir filter serves the archive listing, not this lookup).
// The index is user-writable, so the resolved wire path must stay UNDER sessionDir.
func kimiWirePathForSession(indexPath, sessionID string) (string, error) {
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return "", err
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var e kimiSessionIndexEntry
		if json.Unmarshal(line, &e) != nil || e.SessionID == "" || e.SessionDir == "" {
			continue
		}
		if e.SessionID != sessionID {
			continue
		}
		dir := filepath.Clean(e.SessionDir)
		wire := kimiWirePath(dir)
		if wire == dir || !isUnder(wire, dir) {
			return "", fmt.Errorf("kimi wire path escapes session dir: %s", sessionID)
		}
		return wire, nil
	}
	return "", fmt.Errorf("no kimi index entry for %s", sessionID)
}

// forwardKimiWire ships the wire-log lines appended since our last poke — one
// agent.kimi-wire per raw line — so a live kimi lane decks the SAME dialect the archive
// adapter parses (live == archive; the ONE translator, and all meta harvesting off
// llm.request/metadata lines, lives JS-side). Same mechanics as forwardConversation:
// flock'd per-session byte cursor. FIRST SIGHT replays from offset 0 — unlike claude
// (whose hook payload carries the tool event itself), the kimi tail is the ONLY ingress,
// so jumping to EOF would silently drop the session's opening events; replaying also
// backfills a book when the display attaches mid-session.
func forwardKimiWire(conn *websocket.Conn, event *HookEvent) {
	laneID := kimiAgentIdForSession(event.SessionID)
	wire, err := kimiWirePathForSession(kimiIndexPath(), event.SessionID)
	if err != nil {
		dbg("kimi: wire path: %v", err)
		return
	}
	cursorPath := filepath.Join(os.TempDir(), "glyph-kimi-"+sanitizeID(event.SessionID)+".cursor")
	tailWireLines(cursorPath, wire, func(line []byte) {
		sendKimiWire(conn, laneID, line)
	})
}

// tailWireLines sends every COMPLETE line appended to path since the cursor's offset,
// then advances the cursor. The cursor file doubles as the flock target against
// concurrent hook processes. First sight (fresh cursor) replays from offset 0 — the
// kimi payload carries no events of its own, so the tail is the whole stream (see
// forwardKimiWire); per-session cursors make that replay happen exactly once.
func tailWireLines(cursorPath, path string, send func(line []byte)) {
	lock, err := os.OpenFile(cursorPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		dbg("kimi: cursor open: %v", err)
		return
	}
	defer lock.Close()
	unlock, err := flockExclusive(lock)
	if err != nil {
		dbg("kimi: flock: %v", err)
		return
	}
	defer unlock()

	cur, _ := io.ReadAll(lock)
	offset, _ := strconv.ParseInt(strings.TrimSpace(string(cur)), 10, 64)

	f, err := os.Open(path)
	if err != nil {
		dbg("kimi: open wire: %v", err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return
	}
	size := info.Size()

	if len(cur) == 0 && size > 0 {
		dbg("kimi: first sight, replaying from 0 (%d)", size)
		// fall through with offset 0 — the kimi tail is the ONLY ingress (the
		// hook payload carries no events), so first sight replays the wire from
		// the top; the per-session cursor makes that a once-per-session backfill.
	}
	if offset > size {
		offset = 0 // wire truncated/rotated — resync from the top
	}
	if offset >= size {
		return // nothing new
	}

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return
	}
	data, _ := io.ReadAll(f)
	nl := bytes.LastIndexByte(data, '\n')
	if nl < 0 {
		return // no complete new line yet — leave it for next time
	}
	for _, line := range bytes.Split(data[:nl+1], []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		send(line)
	}
	writeCursor(lock, offset+int64(nl)+1)
}

// sendKimiWire ships one raw wire line to the lane:
//
//	agent.kimi-wire <laneId> <b64 line>
//
// The line base64s into the `call` bundle so its quotes/commas survive both the bus
// tokenizer and the argv JSON; the verb's handler feeds it through the shared
// wire-line translator and emits agent.tool/agent.message into the lane.
func sendKimiWire(conn *websocket.Conn, laneID string, line []byte) {
	payload, err := json.Marshal([]string{"agent.kimi-wire", laneID, base64.StdEncoding.EncodeToString(line)})
	if err != nil {
		dbg("kimi wire marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// handleKimiStop flushes the wire tail one last time (the turn's trailing lines that
// the last PostToolUse predates) before marking the lane done.
func handleKimiStop(conn *websocket.Conn, event *HookEvent) {
	forwardKimiWire(conn, event)
	sendCmd(conn, fmt.Sprintf("agent.stop %s", kimiAgentIdForSession(event.SessionID)))
}

// writeCursor rewrites the flock'd cursor file with the new byte offset.
func writeCursor(f *os.File, off int64) {
	if err := f.Truncate(0); err != nil {
		return
	}
	f.Seek(0, io.SeekStart)
	f.WriteString(strconv.FormatInt(off, 10))
}

// sanitizeID keeps a session id safe for a temp filename (alnum kept, everything else → '-').
func sanitizeID(s string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '-'
	}, s)
}

func sendCmd(conn *websocket.Conn, cmd string) {
	dbg("send: %s", cmd)
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
		dbg("write error: %v", err)
		return
	}

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, resp, err := conn.ReadMessage()
	if err != nil {
		dbg("read error: %v", err)
	} else {
		dbg("recv: %s", string(resp))
	}
	conn.SetReadDeadline(time.Time{})
}

const hookLogPath = "/tmp/glyph-hook.log"

// hookCmdEntry is the entry point called from main.
func hookCmdEntry() {
	// Check for --debug flag (also logs to stderr) and --kimi (kimi hook dialect).
	for _, arg := range os.Args[2:] {
		if arg == "--debug" || arg == "-d" {
			debug = true
		}
		if arg == "--kimi" {
			kimiMode = true
		}
	}

	// Always log to file so Claude can read it for diagnostics.
	// With --debug, also copy to stderr for live terminal viewing.
	logFile, err := os.OpenFile(hookLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		// Can't open log — still run, just no file logging
		if !debug {
			log.SetOutput(io.Discard)
		}
	} else {
		defer logFile.Close()
		if debug {
			log.SetOutput(io.MultiWriter(os.Stderr, logFile))
		} else {
			log.SetOutput(logFile)
		}
		// Always enable debug logging when writing to file
		debug = true
	}

	log.SetFlags(log.Ltime | log.Lmicroseconds)
	hookCmd()
}
