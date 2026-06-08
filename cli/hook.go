package main

import (
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
	switch event.ToolName {
	case "Read", "Edit", "Write":
		// File tools move the agent's visitor to the file (camera stays free).
		var input FilePathInput
		json.Unmarshal(event.ToolInput, &input)
		if input.FilePath == "" {
			return
		}
		action := map[string]string{"Read": "read", "Edit": "edit", "Write": "write"}[event.ToolName]
		sendActivity(conn, id, typ, action, relativize(input.FilePath, event.CWD))

	case "Bash":
		sendActivity(conn, id, typ, "bash", "")
	case "Grep":
		sendActivity(conn, id, typ, "grep", "")
	case "Glob":
		sendActivity(conn, id, typ, "glob", "")
	case "Agent":
		sendActivity(conn, id, typ, "subagent", "")
	default:
		sendActivity(conn, id, typ, strings.ToLower(event.ToolName), "")
	}
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

// sendActivity tells the viewer an agent acted. A relPath moves the agent's field
// visitor to that file (the camera is NOT touched); an empty path just keeps the
// visitor live and logs the action. This replaces the old camera.focus yank.
func sendActivity(conn *websocket.Conn, id, typ, action, relPath string) {
	if relPath != "" {
		sendCmd(conn, fmt.Sprintf("agent.activity %s %s %s %s", id, typ, action, relPath))
	} else {
		sendCmd(conn, fmt.Sprintf("agent.activity %s %s %s", id, typ, action))
	}
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
	if err != nil {
		return absPath
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
