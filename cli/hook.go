package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
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
	// Pure transport: ship the RAW tool event. ALL semantics — action/target/detail/result/meta,
	// the touched-line ranges, which tools are noise — live in the ONE JS tool registry
	// (packages/glyph3d-core/src/collections/toolRegistry.js), shared by this hook and the replay.
	// Adding or removing a tool never touches this file.
	sendTool(conn, id, typ, event.ToolName, event.ToolInput, event.ToolResponse, event.CWD)
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
