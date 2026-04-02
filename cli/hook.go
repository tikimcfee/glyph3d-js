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

// Tool input shapes we care about
type ReadInput struct {
	FilePath string `json:"file_path"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
}

type EditInput struct {
	FilePath  string `json:"file_path"`
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
}

type WriteInput struct {
	FilePath string `json:"file_path"`
}

type BashInput struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

type GrepInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

type GlobInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

const agentWindowID = "claude"

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
	switch event.ToolName {
	case "Read":
		var input ReadInput
		json.Unmarshal(event.ToolInput, &input)
		if input.FilePath == "" {
			return
		}
		relPath := relativize(input.FilePath, event.CWD)

		lines := fmt.Sprintf("lines %d-%d", input.Offset, input.Offset+input.Limit)
		if input.Offset == 0 && input.Limit == 0 {
			lines = "full file"
		}
		msg := fmt.Sprintf("📖 Read %s (%s)", relPath, lines)
		sendWindowAppend(conn, msg)

		if input.Offset > 0 || input.Limit > 0 {
			end := input.Offset + input.Limit
			if input.Limit == 0 {
				end = input.Offset + 50
			}
			sendHighlight(conn, relPath, input.Offset, end)
		}

	case "Edit":
		var input EditInput
		json.Unmarshal(event.ToolInput, &input)
		if input.FilePath == "" {
			return
		}
		relPath := relativize(input.FilePath, event.CWD)
		oldLines := strings.Count(input.OldString, "\n") + 1
		newLines := strings.Count(input.NewString, "\n") + 1
		msg := fmt.Sprintf("✏️  Edit %s (%d→%d lines)", relPath, oldLines, newLines)
		sendWindowAppend(conn, msg)

	case "Write":
		var input WriteInput
		json.Unmarshal(event.ToolInput, &input)
		if input.FilePath == "" {
			return
		}
		relPath := relativize(input.FilePath, event.CWD)
		msg := fmt.Sprintf("📝 Write %s", relPath)
		sendWindowAppend(conn, msg)

	case "Bash":
		var input BashInput
		json.Unmarshal(event.ToolInput, &input)
		cmd := input.Command
		if len(cmd) > 80 {
			cmd = cmd[:77] + "..."
		}
		if input.Description != "" {
			sendWindowAppend(conn, fmt.Sprintf("⚡ %s", input.Description))
		} else {
			sendWindowAppend(conn, fmt.Sprintf("⚡ $ %s", cmd))
		}

	case "Grep":
		var input GrepInput
		json.Unmarshal(event.ToolInput, &input)
		msg := fmt.Sprintf("🔍 Grep /%s/", input.Pattern)
		if input.Path != "" {
			msg += fmt.Sprintf(" in %s", relativize(input.Path, event.CWD))
		}
		sendWindowAppend(conn, msg)

	case "Glob":
		var input GlobInput
		json.Unmarshal(event.ToolInput, &input)
		sendWindowAppend(conn, fmt.Sprintf("📂 Glob %s", input.Pattern))

	case "Agent":
		msg := "🤖 Launched subagent"
		if event.AgentType != "" {
			msg = fmt.Sprintf("🤖 Launched %s agent", event.AgentType)
		}
		sendWindowAppend(conn, msg)

	default:
		sendWindowAppend(conn, fmt.Sprintf("🔧 %s", event.ToolName))
	}
}

func handlePreToolUse(conn *websocket.Conn, event *HookEvent) {
	// Quiet for now — PostToolUse covers everything
}

func handleStop(conn *websocket.Conn, event *HookEvent) {
	sendWindowAppend(conn, "⏹  Claude stopped")
}

// --- Viewer Commands ---

func sendWindowAppend(conn *websocket.Conn, text string) {
	ensureCmd := fmt.Sprintf("window.create %s 100 40 claude-activity", agentWindowID)
	sendCmd(conn, ensureCmd)

	encoded := base64.StdEncoding.EncodeToString([]byte(text))
	cmd := fmt.Sprintf("window.append %s %s", agentWindowID, encoded)
	sendCmd(conn, cmd)
}

func sendHighlight(conn *websocket.Conn, filePath string, startLine, endLine int) {
	cmd := fmt.Sprintf("highlight.lines %s %d %d", filePath, startLine, endLine)
	sendCmd(conn, cmd)
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
