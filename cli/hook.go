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
	SessionID     string          `json:"session_id"`
	CWD           string          `json:"cwd"`
	EventName     string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	ToolInput     json.RawMessage `json:"tool_input"`
	ToolResponse  json.RawMessage `json:"tool_response"`
	ToolUseID     string          `json:"tool_use_id"`
	AgentID       string          `json:"agent_id"`
	AgentType     string          `json:"agent_type"`
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

// hookCmd reads a Claude Code hook event from stdin and sends viewer commands.
func hookCmd() {
	// Read stdin
	data, err := io.ReadAll(os.Stdin)
	if err != nil || len(data) == 0 {
		os.Exit(0) // No input, nothing to do
	}

	var event HookEvent
	if err := json.Unmarshal(data, &event); err != nil {
		os.Exit(0) // Can't parse, don't block Claude
	}

	url := os.Getenv("GLYPH_WS_URL")
	if url == "" {
		url = "ws://localhost:8765"
	}

	// Connect to relay (quick timeout — don't block Claude)
	conn, err := hookConnect(url)
	if err != nil {
		// Relay not running — silently exit, don't block Claude
		os.Exit(0)
	}
	defer conn.Close()

	// Process the event
	switch event.EventName {
	case "PostToolUse":
		handlePostToolUse(conn, &event)
	case "PreToolUse":
		handlePreToolUse(conn, &event)
	case "Stop":
		handleStop(conn, &event)
	}

	// Always exit 0 — never block Claude
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
	conn.ReadMessage() // ack
	conn.ReadMessage() // pong
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

		// Highlight the file in the viewer
		lines := fmt.Sprintf("lines %d-%d", input.Offset, input.Offset+input.Limit)
		if input.Offset == 0 && input.Limit == 0 {
			lines = "full file"
		}
		msg := fmt.Sprintf("📖 Read %s (%s)", relPath, lines)
		sendWindowAppend(conn, msg)

		// Try to highlight the file in the 3D scene
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
		desc := input.Description
		if desc != "" {
			msg := fmt.Sprintf("⚡ %s", desc)
			sendWindowAppend(conn, msg)
		} else {
			msg := fmt.Sprintf("⚡ $ %s", cmd)
			sendWindowAppend(conn, msg)
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
		msg := fmt.Sprintf("📂 Glob %s", input.Pattern)
		sendWindowAppend(conn, msg)

	case "Agent":
		msg := "🤖 Launched subagent"
		if event.AgentType != "" {
			msg = fmt.Sprintf("🤖 Launched %s agent", event.AgentType)
		}
		sendWindowAppend(conn, msg)

	default:
		msg := fmt.Sprintf("🔧 %s", event.ToolName)
		sendWindowAppend(conn, msg)
	}
}

func handlePreToolUse(conn *websocket.Conn, event *HookEvent) {
	// Pre-tool: we could show "about to..." messages, but keep it quiet for now.
	// The PostToolUse handler covers the important stuff.
}

func handleStop(conn *websocket.Conn, event *HookEvent) {
	sendWindowAppend(conn, "⏹  Claude stopped")
}

// --- Viewer Commands ---

func sendWindowAppend(conn *websocket.Conn, text string) {
	// Ensure window exists, then append
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
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	conn.WriteMessage(websocket.TextMessage, []byte(cmd))

	// Read response (don't block long)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	conn.ReadMessage()
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

// hookCmdEntry is the entry point called from main.
func hookCmdEntry() {
	// Suppress log output — don't pollute Claude's stderr
	log.SetOutput(io.Discard)
	hookCmd()
}
