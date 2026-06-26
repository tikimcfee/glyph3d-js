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

// HookEvent is the JSON structure Claude Code sends on stdin.
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

func dbg(format string, args ...any) {
	if debug {
		log.Printf("[hook] "+format, args...)
	}
}

// hookCmd reads a Claude Code hook event from stdin and sends viewer commands.
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

func handlePreToolUse(conn *websocket.Conn, event *HookEvent) {
	// Quiet for now — PostToolUse covers everything
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
	// Check for --debug flag (also logs to stderr)
	for _, arg := range os.Args[2:] {
		if arg == "--debug" || arg == "-d" {
			debug = true
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
