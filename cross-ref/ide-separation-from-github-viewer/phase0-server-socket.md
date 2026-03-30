# Server/Socket Architecture Analysis: IDE Separation Plan

## Executive Summary

The glyph3d-js server/socket layer consists of **two independent transport bridges** that serve different client types, plus shared command infrastructure. The **WebSocket relay servers must stay with github-viewer** (they are display-side), but the **CLI/agent infrastructure can move to IDE**. However, they share a **common command protocol** that should remain unified.

### Architectural Layers

```
github-viewer (browser display):
  WebSocketBridge → CliConnection (controller)
  Relay Server (ws-relay.mjs / ws-relay.py)
  CommandRouter + Commands
  ViewerAPI (window.viewer)
  
IDE (Node.js agent):
  AgentWindowManager → CliConnection (controller)
  AgentWindow (text I/O)
  agent-hook.mjs CLI
```

Both converge on the same relay protocol; commands flow through shared CommandRouter.

---

## 1. WebSocket Relay Servers: STAY WITH GITHUB-VIEWER

**Location:** `/home/user/dev/glyph3d-js/examples/github-viewer/ws-relay.mjs` (Node), `.py` (Python)

### What They Do

- **Single-display + N-controller pattern**: Browser (display) connects first, registers as `"DISPLAY"`. CLIs/agents (controllers) connect and send commands via relay.
- **Message routing**: Controllers send raw command strings; relay wraps as `{"from": clientId, "cmd": "..."}` to display.
- **Response routing**: Display sends `{"to": clientId, "response": "...", "data": {...}}` back to controller.
- **Client lifecycle**: Relay notifies display of controller connect/disconnect via events.
- **Port**: 8765 (configurable via `--port`)

### Key Functions

| File | Function | Purpose |
|------|----------|---------|
| ws-relay.mjs:58-147 | WebSocketServer event handlers | Connection, message routing, cleanup |
| ws-relay.mjs:34-45 | getLanAddresses() | Detect LAN IPs for phone/tablet control |
| ws-relay.mjs:48-55 | sendJSON(), notifyDisplay() | Async-safe message delivery |
| ws-relay.py:172-216 | main() async handler | Python equivalent (same protocol) |

### Why They Stay With github-viewer

1. **Display-side responsibility**: Relay manages the browser connection and command dispatch
2. **LAN accessibility**: Both relay variants include LAN IP detection (lines 34-45 in .mjs, 44-68 in .py)
3. **Phone/tablet support**: UI decision (which display device to connect)
4. **Package.json scripts** (lines 21-23):
   ```json
   "ws": "node examples/github-viewer/ws-relay.mjs",
   "ws:py": "python3 examples/github-viewer/ws-relay.py",
   "relay": "node examples/github-viewer/ws-relay.mjs",
   ```
   These are tightly bound to the viewer example and should remain there.

---

## 2. Browser-Side Transport: WebSocketBridge (STAYS, VIEWER-SPECIFIC)

**Location:** `/home/user/dev/glyph3d-js/examples/github-viewer/websocket/WebSocketBridge.js`

### What It Does

- Connects to relay as `"DISPLAY"` client (line 282: `ws.send('DISPLAY')`)
- Routes incoming controller commands through CommandRouter (line 361: `this.router.execute()`)
- Sends responses back to controller (line 374)
- Manages client lifecycle (lines 337-356: tracks connected controllers)
- UI status bar showing connection state and LAN address (lines 189-263)
- Auto-reconnect with exponential backoff (lines 306-314)

### Key Methods

| Method | Line | Purpose |
|--------|------|---------|
| constructor() | 24 | LAN detection, status bar setup |
| connect() | 66 | Open relay connection |
| connectLAN() | 78 | Use detected LAN IP |
| _handleMessage() | 321 | Route controller commands + client notifications |
| getLanAddress() | 169 | Return detected LAN IP for external display |
| getConnectionInfo() | 177 | Full connection state (for API) |

### Why It Stays With github-viewer

1. **Display-only concern**: Handles browser-specific DOM (status bar, window.location detection)
2. **LAN detection via RTCPeerConnection** (lines 142-163) — browser API, not portable
3. **Single instance per viewer**: One display per relay connection
4. **Embedded in GitHubRepoViewer initialization** (GitHubRepoViewer.js:357)

---

## 3. Node.js CLI Transport: CliConnection (PORTABLE, BUT SHARED PATTERN)

**Location:** `/home/user/dev/glyph3d-js/examples/github-viewer/cli/CliConnection.mjs`

### What It Does

- Node.js WebSocket client connecting as a "controller" (relay protocol role)
- Sends raw command strings (line 102: `this.ws.send(cmd)`)
- Parses JSON responses with optional data payloads (lines 59-60)
- Manages registration handshake: `ping` → relay ack → discard pong (lines 32-50)
- Single in-flight command pattern (lines 85-103)

### Key Methods

| Method | Line | Purpose |
|--------|------|---------|
| connect() | 25 | Handshake: send ping, wait for ack + pong |
| send() | 85 | Async command send with timeout |
| (message handler) | 35-64 | Parse registration + command responses |

### Usage Pattern

```javascript
const conn = new CliConnection('ws://localhost:8765');
await conn.connect();  // Register as ctrl-N
const result = await conn.send('grid.list');
// result = { text: "...", data: {...} }
```

### Can Move to IDE?

**Yes, but**: This is a generic protocol client. If IDE becomes a separate example, this file should either:
1. **Stay in github-viewer/cli/** (shared client library)
2. **Move to ide/cli/** with symlink back
3. **Become shared/cli/** (new shared infrastructure)

**Decision point**: Depends on whether IDE will import from github-viewer or have its own CLI structure.

---

## 4. Agent-Side Abstractions: AgentWindow(Manager) (VIEWER-SPECIFIC NOW, PORTABLE IF GENERALIZED)

**Location:**
- `/home/user/dev/glyph3d-js/examples/github-viewer/cli/AgentWindow.mjs` (single window abstraction)
- `/home/user/dev/glyph3d-js/examples/github-viewer/cli/AgentWindowManager.mjs` (multi-window lifecycle)

### AgentWindow (lines 8-80)

Single 3D text grid panel controlled from Node.js.

| Method | Line | Purpose |
|--------|------|---------|
| write() | 31 | Replace entire grid text (base64-encoded) |
| append() | 45 | Append lines, trim to maxLines |
| clear() | 60 | Erase all content |
| setTitle() | 73 | Update first-line header |

All I/O is async (returns Promise<{text, data}>).

### AgentWindowManager (lines 35-100+)

Manages multiple AgentWindow instances over a single CliConnection.

| Method | Line | Purpose |
|--------|------|---------|
| constructor() | 39 | Init with relay URL |
| connect() | 59 | Establish CliConnection once |
| createWindow() | 75 | Create new grid in viewer, track index |
| arrangeAgents() | (not shown) | Layout multiple windows (row/col/grid) |
| setPhaseLayout() | (not shown) | Color-coded layout for cross-ref phases |
| closeAll() | (not shown) | Cleanup on shutdown |

Command serialization via `_enqueue()` (line 85) ensures one command at a time (CliConnection limitation).

Phase-specific colors (lines 26-33) are IDE-cross-ref semantics, not viewer-specific.

### Should These Move?

**AgentWindow + AgentWindowManager**: Likely **move to IDE** if IDE becomes independent.

**Reasons to move:**
1. They are **agent-facing abstractions**, not viewer-facing
2. Phase colors (PHASE_0, PHASE_1, etc.) are cross-ref semantics, not github-viewer concepts
3. Could be reused by other agents (not just IDE)

**Reasons to keep (shared):**
1. Only entry point to update agent windows; if another IDE variant exists, duplication is bad
2. Encapsulates relay protocol knowledge (could be useful for other tools)

**Recommendation**: Move to `ide/` directory, but keep the CLI tools (`glyph-cli.mjs`, `agent-hook.mjs`) available as shared examples in github-viewer.

---

## 5. Command Infrastructure: CommandRouter + Commands (SHARED CORE)

**Location:** `/home/user/dev/glyph3d-js/examples/github-viewer/websocket/`

### Ownership

- **CommandRouter** (CommandRouter.js, lines 14-170): generic command parser and dispatcher
  - Protocol-agnostic: takes command string, returns `{text, data}`
  - Used by: WebSocketBridge, glyph-cli.mjs, agent-hook.mjs
  
- **Commands** (websocket/commands/*.js): 300+ lines of grid, camera, layout, annotation logic
  - Platform-independent: no DOM, no Three.js scene mutations directly
  - Handlers receive context bag (scene, camera, registry, etc.)
  - Return `{text, data}` for both TUI + programmatic clients

### Which Commands?

**Viewer-specific** (github-viewer only):
- `camera.*` (CameraController, animation, positioning) — lines 6-7 in cameraCommands.js
- `scene.*` (background, annotations, colors) — depends on viewer's BackdropManager, CodeColorManager
- `layout.*` (hierarchical, spiral, treemap) — these managers are viewer-owned
- `grid.*` (CodeGrid operations) — but CodeGrid itself is library code (src/collections/)

**Portable** (useful for IDE, other tools):
- `grid.create`, `grid.text`, `grid.list` — basic grid operations
- `window.write`, `window.append` — TUI window operations
- `status`, `help` — introspection

### Integration Point

GitHubRepoViewer.js:357 calls `initCommandCenter()` which:
1. Builds context from viewer (line 131-119)
2. Creates CommandRouter (line 136)
3. Registers all commands (line 137)
4. Creates WebSocketBridge (line 145)
5. Creates ViewerAPI (line 153)

If IDE separates, it will:
1. Create its own context (smaller: just agent windows, maybe no camera)
2. Reuse CommandRouter class (portable)
3. Register only IDE-relevant commands (subset of the 20+ command files)
4. Skip WebSocketBridge (doesn't need display role)
5. Possibly reuse ViewerAPI pattern for programmatic access

---

## 6. CLI Tooling: glyph-cli.mjs + agent-hook.mjs (PORTABLE, EXAMPLE-INDEPENDENT)

### glyph-cli.mjs (lines 1-50+)

Generic WebSocket CLI controller. Can connect to any relay.

**Modes:**
- One-shot: `glyph-cli.mjs grid.list`
- REPL: `glyph-cli.mjs` (interactive)
- Pipe: `echo "status" | glyph-cli.mjs`

**Flags:** `--host`, `--port`, `--json`

**Used by:** Anyone who wants a terminal interface to the viewer.

**Should move?** No — this is a utility tool. Keep it in github-viewer/cli as a reference implementation.

### agent-hook.mjs (lines 1-80+)

Push text updates to agent windows from agent code.

**Usage:**
```bash
node agent-hook.mjs --agent "protocol" --text "Phase 0 complete"
echo "analysis" | node agent-hook.mjs --agent "transport"
node agent-hook.mjs --close-all
```

**What it does:**
1. Parse flags (agent label, text/file, color, position, close)
2. Create AgentWindowManager
3. Connect to relay
4. Call `createWindow()`, `append()`, or `close()`

**Should move?** Only if AgentWindowManager moves. If both move together, agent-hook becomes an IDE utility. Otherwise, keep as example.

---

## 7. Viewer-Specific: ViewerAPI + TUI Classes (STAYS)

### ViewerAPI (ViewerAPI.js, lines 14-85+)

Public JavaScript API exposed as `window.viewer`.

```javascript
await viewer.exec('camera.info')          // raw command
await viewer.select('src/index.js')       // typed method
viewer.commands()                         // list all
```

**Why it stays:** Browser-only (window.viewer), tightly bound to viewer context.

### TUI Classes (TUI*.js, ~200 lines)

- **TUIWindow** (TUIWindow.js): Single terminal pane, backed by CodeGrid
- **TUIWindowManager** (TUIWindowManager.js): Multiple terminal windows
- **TUIFocusManager** (TUIFocusManager.js): Keyboard routing between windows
- **TUIFormatter** (TUIFormatter.js): Box drawing, table formatting

**Why they stay:** These manage the **in-viewer terminal windows** (not agent windows). They are browser UI components, not portable to IDE.

---

## 8. Integration Points & Dependencies

### github-viewer → websocket

```
GitHubRepoViewer.js
  imports initCommandCenter from websocket/index.js
  passes viewer instance to initCommandCenter()
  builds context from viewer properties
  creates router, bridge, API
```

### github-viewer → cli (if used)

```
glyph-cli.mjs
  imports CliConnection from cli/CliConnection.mjs
  optionally imports AgentWindowManager (only if --agent flag)
  
agent-hook.mjs
  imports AgentWindowManager from cli/AgentWindowManager.mjs
  imports AgentWindow from cli/AgentWindow.mjs
```

### Shared dependencies

- CommandRouter (no external deps beyond base JS)
- WebSocketBridge (browser DOM, WebSocket API)
- CliConnection (ws package, Node.js only)
- AgentWindowManager / AgentWindow (CliConnection + protocol knowledge)

---

## 9. Movement Plan: IDE Separation

### Phase 0 Actions

1. **Leave in github-viewer:**
   - `ws-relay.mjs`, `ws-relay.py`
   - `websocket/` (CommandRouter, WebSocketBridge, ViewerAPI, TUI*, commands/)
   - `cli/glyph-cli.mjs`, `cli/agent-hook.mjs` (as reference examples)
   - Package.json scripts (`npm run ws`, `npm run relay`)

2. **Copy/Move to IDE:**
   - `cli/CliConnection.mjs` (or create ide/cli/CliConnection.mjs with symlink/import)
   - `cli/AgentWindow.mjs` → `ide/cli/AgentWindow.mjs`
   - `cli/AgentWindowManager.mjs` → `ide/cli/AgentWindowManager.mjs`
   - Subset of commands relevant to IDE (not camera, layout, scene)

3. **Unified codebase concern:**
   - CommandRouter remains the protocol hub
   - Both github-viewer and IDE register commands into their own CommandRouter
   - Both connect via relay using CliConnection class
   - **If CliConnection changes, both must update** (keep in sync or share)

### Package.json Alignment

**Current** (line 21-24):
```json
"scripts": {
  "ws": "node examples/github-viewer/ws-relay.mjs",
  "cli": "node examples/github-viewer/cli/glyph-cli.mjs"
}
```

**After separation:**
```json
"scripts": {
  "ws": "node examples/github-viewer/ws-relay.mjs",
  "cli": "node examples/github-viewer/cli/glyph-cli.mjs",
  "ide": "node examples/ide/index.mjs"  // NEW
}
```

---

## 10. Summary Table

| Component | Current Path | Should Move? | Reason |
|-----------|--------------|--------------|--------|
| ws-relay.mjs | github-viewer/ | NO | Display-side responsibility, LAN detection |
| ws-relay.py | github-viewer/ | NO | Same as above |
| WebSocketBridge | websocket/ | NO | Browser DOM, display-only |
| CommandRouter | websocket/ | **SHARED** | Protocol hub, both clients use |
| Commands (20+ files) | websocket/commands/ | **SHARED** | Subset for IDE, full set for viewer |
| ViewerAPI | websocket/ | NO | window.viewer, browser-only |
| TUI* classes | websocket/ | NO | In-viewer terminal windows |
| CliConnection | cli/ | **SHARED** | Portable; could symlink or duplicate |
| AgentWindow | cli/ | YES (IDE) | Agent-facing abstraction |
| AgentWindowManager | cli/ | YES (IDE) | Agent window lifecycle |
| glyph-cli.mjs | cli/ | KEEP | Reference CLI tool |
| agent-hook.mjs | cli/ | KEEP | Reference agent hook tool |

---

## Architectural Decision

**The relay and display logic stay coupled to github-viewer.** The IDE becomes a separate **controller client** that speaks the same relay protocol via CliConnection. The CommandRouter remains the semantic hub but both examples own their command subsets.

**Key file flows:**

1. **github-viewer start:** `npm run ws` → relay listens on 8765
2. **Browser:** Open viewer → WebSocketBridge connects → display role
3. **IDE agent:** Import AgentWindowManager → connect via relay → create windows
4. **Cross-ref:** IDE agents update their windows via agent-hook or AgentWindowManager API

All roads lead to the relay protocol and CommandRouter.
