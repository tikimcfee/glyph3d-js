package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// HookEvent is the JSON structure Claude Code sends on stdin.
type HookEvent struct {
	SessionID    string          `json:"session_id"`
	CWD          string          `json:"cwd"`
	EventName    string          `json:"hook_event_name"`
	ToolName     string          `json:"tool_name"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
	ToolUseID    string          `json:"tool_use_id"`
	AgentID      string          `json:"agent_id"`
	AgentType    string          `json:"agent_type"`
}

// FilePathInput is all we need from Read/Edit/Write tool inputs: the file the agent
// touched. The visitor moves to that file; the camera stays where the user put it.
type FilePathInput struct {
	FilePath string `json:"file_path"`
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
	action := actionVerb(event.ToolName)

	// File tools move the visitor TO the file — the path is the target (camera stays free).
	// Everything else carries its meaningful argument as `detail`: the bash command, the
	// grep pattern, the subagent's task. Both pull from the same raw ToolInput the hook
	// already receives; we just stop throwing it away.
	target := ""
	switch event.ToolName {
	case "Read", "Edit", "Write":
		var input FilePathInput
		json.Unmarshal(event.ToolInput, &input)
		if input.FilePath == "" {
			return
		}
		target = relativize(input.FilePath, event.CWD)
	}

	// Ship raw — the trail renders these in grids whose layout system does its own
	// line-splitting + windowing, so the hook truncates nothing. A file's content IS its
	// snapshot, so file tools carry no result (matches the replay).
	detail := extractDetail(event.ToolName, event.ToolInput)
	result := ""
	switch event.ToolName {
	case "Read", "Edit", "Write":
	default:
		result = extractResult(event.ToolResponse)
	}
	sendActivity(conn, id, typ, action, target, detail, result)
}

// actionVerb normalizes a tool name to the short lifecycle verb shown on the visitor card.
func actionVerb(tool string) string {
	switch tool {
	case "Read":
		return "read"
	case "Edit":
		return "edit"
	case "Write":
		return "write"
	case "Agent":
		return "subagent"
	default:
		return strings.ToLower(tool)
	}
}

// extractDetail pulls the one meaningful argument out of a tool's input — the thing a human
// watching the field wants to see. Tolerant by design: a generic decode + key-preference,
// so a tool we've never special-cased still surfaces SOMETHING rather than a bare verb.
func extractDetail(tool string, raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if s, ok := m[k].(string); ok && s != "" {
				return s
			}
		}
		return ""
	}
	switch tool {
	case "Bash":
		return pick("command")
	case "Grep":
		return pick("pattern")
	case "Glob":
		return pick("pattern")
	case "Task", "Agent":
		return pick("description", "prompt")
	case "WebFetch":
		return pick("url")
	case "WebSearch":
		return pick("query")
	case "Read", "Edit", "Write":
		return "" // the file path is the target, not the detail
	default:
		// Unknown tool: surface the first recognizable scalar so the card still says something.
		return pick("command", "pattern", "query", "url", "description", "prompt", "path", "file_path", "name")
	}
}

// extractResult pulls the FULL output text from a tool response (a bare string or a structured
// object), preferring an error if present. Raw — the trail renders it in a grid that does its own
// line-splitting + windowing, so nothing is truncated here.
func extractResult(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	if b, ok := m["is_error"].(bool); ok && b {
		if e, ok := m["error"].(string); ok && e != "" {
			return "error: " + e
		}
		return "error"
	}
	if e, ok := m["error"].(string); ok && e != "" {
		return "error: " + e
	}
	for _, k := range []string{"stdout", "content", "result", "output"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func handlePreToolUse(conn *websocket.Conn, event *HookEvent) {
	// Quiet for now — PostToolUse covers everything
}

func handleStop(conn *websocket.Conn, event *HookEvent) {
	id, _ := agentIdentity(event)
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

// sendActivity tells the viewer an agent acted, carrying the full record:
//
//	agent.activity <id> <type> <action> [target] [detail] [result]
//
// A `target` (a file path) moves the visitor to that file; `detail`/`result` fill its
// card. The camera is never touched. Two serializations of the SAME verb: when every
// field is whitespace/quote-free we send the plain readable line (keeps the relay log
// legible for the high-frequency file-op case); otherwise we route the record through
// the `call` hatch (base64'd JSON arg vector), which survives the bus tokenizer intact.
func sendActivity(conn *websocket.Conn, id, typ, action, target, detail, result string) {
	if bareSafe(target) && detail == "" && result == "" {
		if target != "" {
			sendCmd(conn, fmt.Sprintf("agent.activity %s %s %s %s", id, typ, action, target))
		} else {
			sendCmd(conn, fmt.Sprintf("agent.activity %s %s %s", id, typ, action))
		}
		return
	}
	// Structured path: positional arg vector, trailing empties trimmed, base64'd via `call`.
	argv := []string{"agent.activity", id, typ, action, target, detail, result}
	for len(argv) > 4 && argv[len(argv)-1] == "" {
		argv = argv[:len(argv)-1]
	}
	payload, err := json.Marshal(argv)
	if err != nil {
		dbg("activity marshal error: %v", err)
		return
	}
	sendCmd(conn, "call "+base64.StdEncoding.EncodeToString(payload))
}

// bareSafe reports whether a token can ride the plain command line without quoting —
// no whitespace, quotes, or backslashes that the bus tokenizer would mangle.
func bareSafe(s string) bool {
	return !strings.ContainsAny(s, " \t\n\r\"\\")
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

// --- Helpers ---

func relativize(absPath, cwd string) string {
	if cwd == "" {
		return absPath
	}
	rel, err := filepath.Rel(cwd, absPath)
	if err != nil || strings.HasPrefix(rel, "..") {
		return absPath // outside the project root — keep it absolute (a /tmp file the relay reaches)
	}
	return rel
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
