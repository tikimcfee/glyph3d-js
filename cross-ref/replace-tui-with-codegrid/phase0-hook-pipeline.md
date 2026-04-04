# Phase 0: Hook Pipeline Analysis

Agent: Hook Pipeline
Date: 2026-03-31

---

## 1. Hook Events from the Go Relay

Source: `cli/hook.go` (HookEvent struct + event handlers)

### Event Types

The Go CLI handles three event types from Claude Code's stdin:

| Event Name     | Handler              | Description                         |
|----------------|----------------------|-------------------------------------|
| `PreToolUse`   | `handlePreToolUse`   | Fires before a tool runs. **No-op** -- handler is empty. |
| `PostToolUse`  | `handlePostToolUse`  | Fires after a tool completes. This is the primary data source. |
| `Stop`         | `handleStop`         | Fires when Claude stops. Appends one line. |

### HookEvent JSON (what Claude Code sends on stdin)

```json
{
  "session_id": "abc123",
  "cwd": "/home/user/dev/glyph3d-js",
  "hook_event_name": "PostToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "/home/user/dev/glyph3d-js/src/index.js", "offset": 0, "limit": 100 },
  "tool_response": "...(raw output)...",
  "tool_use_id": "toolu_abc",
  "agent_id": "agent-0",
  "agent_type": "main"
}
```

Fields available but **not currently forwarded** to the browser: `session_id`, `tool_response`, `tool_use_id`, `agent_id`, `agent_type`. These are parsed into the struct but most are unused.

### PostToolUse Tool Dispatch

Each tool produces a **single emoji-prefixed text line** sent via `sendWindowAppend`:

| Tool Name | Data Extracted from `tool_input`         | Output Example                                          |
|-----------|------------------------------------------|---------------------------------------------------------|
| Read      | `file_path`, `offset`, `limit`           | `"Read src/index.js (lines 0-100)"`                     |
| Edit      | `file_path`, `old_string`, `new_string`  | `"Edit src/index.js (3->5 lines)"`                      |
| Write     | `file_path`                              | `"Write src/index.js"`                                  |
| Bash      | `command`, `description`                 | `"$ git status"` or `"Show working tree status"`        |
| Grep      | `pattern`, `path`                        | `"Grep /pattern/ in src/"`                              |
| Glob      | `pattern`                                | `"Glob **/*.js"`                                        |
| Agent     | (none from input; `agent_type` from event) | `"Launched main agent"`                                |
| (default) | `tool_name`                              | `"ToolSearch"` (just the tool name)                     |

Stop event output: `"Claude stopped"`

### Wire Protocol: What Actually Hits the WebSocket

`sendWindowAppend` sends **two commands** per hook event:

```
window.create claude 100 40 claude-activity
window.append claude <base64-encoded-text>
```

For Read events with offset/limit, a third command fires:

```
highlight.lines <relative-path> <startLine> <endLine>
```

Each command is a plain text string sent as a WebSocket text message. The relay wraps it into a JSON envelope for the display:

```json
{"from": "ctrl-0", "cmd": "window.append claude cGxhaW4gdGV4dA=="}
```

---

## 2. Relay Forwarding (relay.go)

The relay is role-based: "display" (browser, exactly one) and "controller" (CLI hooks, N).

**Controller -> Display flow:**
1. Hook process connects, gets assigned ID (e.g., `ctrl-0`)
2. Hook sends plain text commands (e.g., `window.append claude <b64>`)
3. Relay wraps in `{"from": "ctrl-0", "cmd": "..."}` and enqueues to display's write channel
4. Display writer goroutine sends it to the browser WebSocket

**Display -> Controller responses:**
After the browser executes the command via CommandRouter, it sends back:
```json
{"to": "ctrl-0", "response": "OK: window 'claude' appended (5 lines)"}
```

The hook process reads this ack but discards it (fire-and-forget pattern with 2s timeout).

**Key relay events** sent to display (not from hooks):
- `{"event": "client_connected", "clientId": "ctrl-0"}`
- `{"event": "client_disconnected", "clientId": "ctrl-0"}`

---

## 3. Command Handler Analysis: Who Uses TUI Windows?

### Handlers That Create/Write TUI Windows

**windowCommands.js** -- The full TUI window lifecycle:
- `window.create <id> [cols] [rows] [title] [--scale N]` -- creates TUIWindow, registers in registry as type `'window'`
- `window.write <id> <base64>` -- replace all content (`win.write(text)`)
- `window.append <id> <base64>` -- append one line (`win.appendLine(text)`)
- `window.clear <id>` -- clear buffer
- `window.close <id>` -- dispose and unregister
- `window.list` / `window.resize` / `window.move` / `window.scroll` / `window.scale`

This is the **only handler file that imports TUIWindowManager** and calls `TUIWindow` methods.

**orchestrationCommands.js** -- Spatial tracking (window-to-grid pairing):
- `window.track <window-id> <grid-index>` -- positions a window's grid adjacent to a code grid, applies highlight
- `window.untrack <window-id>` -- restores original state
- `window.track.list` -- lists tracking pairs

This file references window grids via the registry (`ctx.registry.get(windowId)`) but does not call TUIWindow-specific methods. It only reads `.position` and `._background` from the underlying grid.

### Handlers That Reference Windows Indirectly

**agentLayoutCommands.js** -- Finds agent/window grids via registry:
```js
const entries = [
    ...registry.findByType('agent'),
    ...registry.findByType('window'),
];
```
Operates on `.position`, `.scale`, `.getBounds()`, `.getCollection().setGroupColor()`. No TUIWindow-specific API.

**sceneCommands.js** -- `scene.clear_windows` calls `ctx.windowManager.clearAll()`. Also reads `ctx.windowManager.count` in `scene.info`.

**systemCommands.js** -- `status` reads `ctx.windowManager.count` for display.

### Handlers That Do NOT Use TUI Windows

All of the following are purely grid/camera/spatial operations with **zero TUI window dependency**:
- `highlightCommands.js` -- glyph-level highlighting on code grids
- `cameraCommands.js` -- camera position/orientation
- `gridCommands.js` -- grid CRUD and introspection
- `layoutCommands.js` -- layout mode info
- `searchCommands.js` -- filename search
- `selectCommands.js` -- file selection state
- `annotationCommands.js` -- labels, annotations, grid highlight, camera animate
- `spatialCommands.js` -- bounds, anchors, distance, overlap
- `compositionCommands.js` -- align, attach, stack
- `navigationCommands.js` -- camera framing, tours (camera.frame, tour.*)
- `tourCommands.js` -- tour sequencer (tour.load, tour.next, etc.)
- `registryCommands.js` -- registry queries
- `terminalCommands.js` -- uses TerminalGrid (separate from TUIWindow entirely)

Note: Many handlers import `TUIFormatter.js` for `box()`, `table()`, `kvLines()` -- but these are pure string formatters returning plain text. They format command *responses*, not window content.

---

## 4. Update Frequency and Timing

**One event per tool call.** Each Claude Code tool invocation fires exactly one PostToolUse hook. There is no streaming -- the hook process runs, sends 2-3 commands, and exits.

**Burst pattern:** During active Claude sessions, tool calls arrive in rapid succession. A typical sequence:
```
Grep -> Glob -> Read -> Read -> Read -> Edit -> Bash
```
That's 7 hook invocations, each sending 2 commands (window.create + window.append), in ~2-5 seconds. The relay's write channel (capacity 64) absorbs bursts.

**No debouncing needed.** Each event is a discrete, complete line. No partial data or streaming chunks.

**The `window.create` is sent on EVERY hook event** (idempotent -- the handler returns early with ERR if the window exists). This is wasteful but harmless.

---

## 5. Actual Text Written to the Window

The hook writes **plain text lines** with emoji prefixes. No ANSI, no formatting, no tables, no boxes. Examples:

```
Read src/GlyphAtlas.js (full file)
Edit src/collections/CodeGrid.js (3->5 lines)
Write src/index.js
$ git status
Show working tree status
Grep /pattern/ in src/
Glob **/*.js
Launched main agent
ToolSearch
Claude stopped
```

Each is a single line. The window accumulates these as a scrollable log. The `window.create` call sets 100 cols x 40 rows, which is generous for single-line entries.

---

## 6. Minimal Replacement API Surface

Based on what `windowCommands.js` and the hook actually call, the replacement wrapper needs:

### Must-Have (used by hook pipeline)

| Method | Called By | Purpose |
|--------|-----------|---------|
| `constructor(id, scene, atlas, opts)` | `window.create` | Create wrapper + underlying CodeGrid |
| `appendLine(text)` | `window.append` | Add one line, auto-scroll |
| `write(text)` | `window.write` | Replace all content |
| `clear()` | `window.clear` | Empty the buffer |
| `dispose()` | `window.close` | Clean up GPU resources |
| `.grid` (property) | Registry, orchestration | Access underlying CodeGrid for scene operations |
| `.historyLength` (getter) | `window.append`, `window.write` response | Line count for status |
| `.id` (property) | Identification | Window ID |

### Used by Window Commands

| Method | Called By | Purpose |
|--------|-----------|---------|
| `resize(cols, rows)` | `window.resize` | Change dimensions |
| `getPosition()` | `window.create`, `window.list` | Read position |
| `setPosition(x,y,z)` | `window.move` | Set position |
| `setScale(factor)` | `window.scale` | Set scale |
| `scrollUp(n)` / `scrollDown(n)` / `scrollToBottom()` | `window.scroll` | Scroll viewport |
| `.scrollOffset` (property) | `window.scroll` response | Current scroll state |
| `.cols` / `.rows` | `window.list` | Dimensions |
| `.title` | `window.list` | Display name |
| `getVisibleLines()` | `window.list` | Non-empty line count |

### Not Needed by Replacement

- `cursorRow` / `cursorCol` -- cursor tracking (unused by commands)
- Box-drawing chrome (TUIFormatter borders around content)
- ANSI stripping (hook sends clean text)
- Filename display (`showFilename` on CodeGrid -- could be kept or dropped)

---

## 7. Dynamic Window Creation

**Yes, windows are created dynamically.** The hook calls `window.create claude ...` on every event, relying on the handler's idempotent check. In the current design:

- There is exactly **one** window per agent session (ID `"claude"`, hardcoded in `hook.go` as `agentWindowID`)
- The window is created lazily on the first hook event
- It persists until the page reloads or `window.close claude` is called

However, the window command system supports arbitrary IDs, so **multiple concurrent agent windows** are architecturally possible if `hook.go` used unique IDs per session/agent.

The `terminalCommands.js` system creates a separate class (TerminalGrid) with its own registry, which is completely independent.

---

## 8. Data Flow Summary

```
Claude Code tool call
    |
    v
hook.go (stdin JSON -> parse -> format one-line summary)
    |
    v
WebSocket to relay (plain text commands)
    |
    v
relay.go (wrap in {"from":"ctrl-N","cmd":"..."} envelope)
    |
    v
WebSocketBridge._handleMessage (browser)
    |
    v
CommandRouter.execute("window.append claude <b64>")
    |
    v
windowCommands.js handler -> TUIWindowManager -> TUIWindow.appendLine()
    |
    v
TUIWindow._render() -> CodeGrid.loadText() -> GPU
```

The replacement target is the last two steps: swap TUIWindow/TUIWindowManager for a thinner wrapper that calls CodeGrid directly without the terminal-emulation overhead (cursor, ANSI, box-drawing chrome, fixed rows/cols viewport).
