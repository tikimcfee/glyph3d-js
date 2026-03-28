# Phase 0: Protocol Analysis — WebSocket CLI-to-Viewer Wire Format

## 1. Current Wire Protocol

### 1.1 Relay Topology

```
  CLI (controller)          Relay (ws-relay.mjs)          Browser (display)
  ================          ====================          ==================
       |                           |                             |
       |--- raw string ----------->|                             |
       |   (first msg = command)   |                             |
       |<-- "OK: connected as      |                             |
       |     ctrl-0" ------------- |                             |
       |                           |--- {"from":"ctrl-0",        |
       |--- "grid.list" --------->|     "cmd":"grid.list"} ---->|
       |                           |                             |
       |                           |<-- {"to":"ctrl-0",          |
       |<-- {"response":"...",     |     "response":"...",       |
       |     "data":{...}} --------|     "data":{...}} ---------|
```

### 1.2 Role Registration

**Controller** (CLI): First message is anything except `"DISPLAY"`. The relay:
1. Assigns a client ID (`ctrl-0`, `ctrl-1`, ...).
2. Sends back `"OK: connected as ctrl-0"` as a plain string.
3. Treats the first message itself as a command and forwards it to the display.

**Display** (browser): First message must be exactly `"DISPLAY"`. The relay:
1. Sends back `{"ok": true, "role": "display", "controllers": ["ctrl-0", ...]}`.
2. Only one display allowed; second connection gets `{"error": "display already connected"}` and is closed.

### 1.3 Controller-to-Display Message Flow

Controllers send **flat string commands**:
```
grid.list
camera.move 0 50 100
grid.color 2 1.0 0.5 0.0
```

The relay wraps these for the display:
```json
{"from": "ctrl-0", "cmd": "grid.list"}
```

### 1.4 Display-to-Controller Response Flow

The browser's `WebSocketBridge._handleMessage()` routes the command through `CommandRouter.execute()`, which returns `{text: string, data: any}`. The bridge sends back:

```json
{"to": "ctrl-0", "response": "OK: 5 grids", "data": {"grids": [...], "count": 5}}
```

The relay then delivers to the target controller:
- **If `data` is present**: sends JSON `{"response": "...", "data": {...}}`
- **If `data` is absent**: sends the `response` string as plain text

### 1.5 Relay-Only Commands

Handled by the relay without forwarding to the display:
- `ping` -> `"pong"`
- `whoami` -> `"You are ctrl-0. Display: connected"`

### 1.6 Error Conditions in Current Protocol

| Condition | Source | Format |
|---|---|---|
| No display connected | Relay | `"ERR: no display connected. Open the viewer in a browser first."` |
| Display slot taken | Relay | `{"error": "display already connected"}` |
| Unknown command | CommandRouter | `{"response": "ERR: unknown command 'foo'. Try 'help'.", "data": null}` |
| Ambiguous command | CommandRouter | `{"response": "ERR: ambiguous command 'g'. Matches: grid.list, grid.info", "data": {"matches": [...]}}` |
| Invalid arguments | Command handler | `{"response": "ERR: usage: grid.color <index> <r> <g> <b>", "data": null}` |
| Handler exception | CommandRouter._run | `{"response": "ERR: <message>", "data": null}` |

### 1.7 What Works

- Simple request/response for read-only queries (grid.list, camera.info, status).
- Simple mutations with immediate effect (camera.move, grid.color, grid.visibility).
- Dual-format responses: TUI text for humans, structured JSON for programmatic clients.
- Partial-match autocomplete reduces typing.
- Shell-style quoting supports filenames with spaces.

### 1.8 What Is Missing for Grid CRUD

1. **No `grid.create` command.** The only way to create grids is through `GitHubRepoViewer.createGridForFileAsync()`, which is not exposed via any command.

2. **No `grid.remove` command.** `clearGrids()` exists but wipes everything. No single-grid removal.

3. **No `grid.update` / `grid.setText` command.** `CodeGrid.loadText()` and `loadTextAsync()` exist but are not wired to commands.

4. **No `grid.position` command.** Position is set during layout but cannot be changed via command. `grid.info` reads position but there is no setter.

5. **No `grid.scale` command.** Scale is set at construction (`gridScale` config) but not mutable via command.

6. **No batch/transaction mechanism.** Creating a grid typically requires: create + set position + set color + optionally set visibility. Each would be a separate round-trip. The `CommandRouter.executeBatch()` method exists but is not exposed over the wire.

7. **No streaming for large content.** Sending a 10,000-line file as a single WebSocket message may work (WebSocket frames can be large) but there is no chunking protocol.

8. **No request IDs.** Commands are correlated by client ID only. If a CLI sends two commands rapidly, responses arrive in order (CommandRouter processes sequentially per `_handleMessage` await chain), but there is no explicit correlation ID to match response to request.

9. **Context bag lacks grid mutation methods.** The `buildContext()` in `websocket/index.js` provides `getGrids()` (read-only accessor) but no `addGrid()`, `removeGrid()`, or reference to `scene`/`atlas` for grid construction. (Actually `scene` and `atlas` ARE in the context, but `viewer.grids` array push/splice is not.)

---

## 2. New Commands Needed

### 2.1 Command Naming Convention

Follow existing dot-namespace pattern: `grid.*`. New commands:

| Command | Purpose |
|---|---|
| `grid.create` | Create a new grid with text content |
| `grid.remove` | Remove a grid from the scene |
| `grid.settext` | Replace a grid's text content |
| `grid.position` | Set a grid's position |
| `grid.scale` | Set a grid's scale |
| `batch` | Execute multiple commands atomically |

### 2.2 `grid.create`

**Usage**: `grid.create <filename> "<content>"`

The filename is required (used as label). Content is a double-quoted string. For multi-line content, the CLI must encode newlines as `\n` within the quoted string (the CommandRouter parser supports backslash escaping).

**Wire message (controller -> relay)**:
```
grid.create hello.txt "Hello, World!\nThis is line 2."
```

**Relay envelope (relay -> display)**:
```json
{"from": "ctrl-0", "cmd": "grid.create hello.txt \"Hello, World!\\nThis is line 2.\""}
```

**CommandRouter parsing**: The `parse()` method handles double-quoted strings. Tokens:
```
["grid.create", "hello.txt", "Hello, World!\nThis is line 2."]
```

Note: The parser strips quotes and handles `\\` -> `\`, but it does NOT interpret `\n` as newline. The command handler must do that.

**Response (display -> relay -> controller)**:
```json
{
  "response": "OK: created grid 5 'hello.txt' (2 lines, 30 glyphs)",
  "data": {
    "index": 5,
    "filename": "hello.txt",
    "lines": 2,
    "glyphs": 30,
    "position": {"x": 0, "y": 0, "z": 0}
  }
}
```

**Error responses**:
```json
{"response": "ERR: usage: grid.create <filename> <content>", "data": null}
{"response": "ERR: grid creation failed: atlas not initialized", "data": null}
```

**Handler implementation requirements**:
- Needs `ctx.scene` and `ctx.atlas` (already in context) to construct `new CodeGrid(scene, atlas)`.
- Needs a way to push onto the grids array. Add `ctx.addGrid(grid)` to the context bag, backed by `viewer.grids.push(grid); scene.add(grid)`.
- Should call `grid.loadFileAsync(filename, content)` for worker-path rendering.
- Should interpret `\n` literals in content string as actual newlines.

### 2.3 `grid.remove`

**Usage**: `grid.remove <index>`

**Wire message**:
```
grid.remove 3
```

**Response**:
```json
{
  "response": "OK: removed grid 3 'utils.js'",
  "data": {
    "removed": {"index": 3, "filename": "utils.js"},
    "remaining": 4
  }
}
```

**Error responses**:
```json
{"response": "ERR: usage: grid.remove <index>", "data": null}
{"response": "ERR: invalid grid index 99 (0-4)", "data": null}
```

**Handler requirements**:
- Needs `ctx.removeGrid(index)` backed by: `grid.dispose(); scene.remove(grid); grids.splice(index, 1)`.
- Note: removing a grid changes the indices of all subsequent grids. The response should warn the CLI about this.

### 2.4 `grid.settext`

**Usage**: `grid.settext <index> "<content>"`

Replaces all text content in an existing grid.

**Wire message**:
```
grid.settext 0 "new content\nline 2"
```

**Response**:
```json
{
  "response": "OK: grid 0 text updated (2 lines, 22 glyphs)",
  "data": {
    "index": 0,
    "lines": 2,
    "glyphs": 22
  }
}
```

**Handler requirements**:
- Calls `grid.loadTextAsync(content)` (async, uses workers).
- Preserves filename.

### 2.5 `grid.position`

**Usage**: `grid.position <index> <x> <y> <z>`

**Wire message**:
```
grid.position 0 10 -5 0
```

**Response**:
```json
{
  "response": "OK: grid 0 position set to (10, -5, 0)",
  "data": {"index": 0, "position": {"x": 10, "y": -5, "z": 0}}
}
```

### 2.6 `grid.scale`

**Usage**: `grid.scale <index> <factor>`

Uniform scale applied to the grid's Object3D.

**Wire message**:
```
grid.scale 0 2.0
```

**Response**:
```json
{
  "response": "OK: grid 0 scale set to 2.0",
  "data": {"index": 0, "scale": 2.0}
}
```

### 2.7 `batch`

**Usage**: `batch <json-array-of-commands>`

Executes multiple commands sequentially in a single round-trip. Leverages the existing `CommandRouter.executeBatch()` method.

**Wire message**:
```
batch ["grid.create hello.txt \"Hello\"","grid.position 0 10 0 0","grid.color 0 1 0.5 0"]
```

**Response**:
```json
{
  "response": "OK: batch completed (3/3 succeeded)",
  "data": {
    "results": [
      {"text": "OK: created grid 0 'hello.txt' (1 lines, 5 glyphs)", "data": {"index": 0, "filename": "hello.txt", "lines": 1, "glyphs": 5}},
      {"text": "OK: grid 0 position set to (10, 0, 0)", "data": {"index": 0, "position": {"x": 10, "y": 0, "z": 0}}},
      {"text": "OK: grid 0 color set to (1, 0.5, 0)", "data": {"index": 0, "color": {"r": 1, "g": 0.5, "b": 0}}}
    ],
    "succeeded": 3,
    "failed": 0
  }
}
```

If any command fails, the batch continues (no rollback) but reports the failure:
```json
{
  "response": "OK: batch completed (2/3 succeeded, 1 failed)",
  "data": {
    "results": [
      {"text": "OK: ...", "data": {...}},
      {"text": "ERR: invalid grid index 99", "data": null},
      {"text": "OK: ...", "data": {...}}
    ],
    "succeeded": 2,
    "failed": 1
  }
}
```

---

## 3. Message Flow Diagrams

### 3.1 "Create Grid with Content" — Full Path

```
CLI                        Relay                      Browser
 |                           |                           |
 |  (1) TCP connect          |                           |
 |=========================>|                           |
 |                           |                           |
 |  (2) "grid.create demo.txt \"Hello\\nWorld\""         |
 |-------------------------->|                           |
 |                           |                           |
 |  (3) "OK: connected       |                           |
 |       as ctrl-0"          |                           |
 |<--------------------------|                           |
 |                           |  (4) {"from":"ctrl-0",    |
 |                           |   "cmd":"grid.create ..."}|
 |                           |-------------------------->|
 |                           |                           |
 |                           |     WebSocketBridge       |
 |                           |     ._handleMessage()     |
 |                           |           |               |
 |                           |     CommandRouter         |
 |                           |     .execute(cmd)         |
 |                           |           |               |
 |                           |     grid.create handler:  |
 |                           |       parse(args)         |
 |                           |       new CodeGrid(scene, |
 |                           |         atlas)            |
 |                           |       grid.loadFileAsync( |
 |                           |         "demo.txt",       |
 |                           |         "Hello\nWorld")   |
 |                           |       ctx.addGrid(grid)   |
 |                           |       scene.add(grid)     |
 |                           |       return {text, data} |
 |                           |                           |
 |                           |  (5) {"to":"ctrl-0",      |
 |                           |   "response":"OK: ...",   |
 |                           |   "data":{...}}           |
 |                           |<--------------------------|
 |                           |                           |
 |  (6) {"response":"OK:    |                           |
 |   created grid 0 ...",    |                           |
 |   "data":{"index":0,...}} |                           |
 |<--------------------------|                           |
```

Note: Steps (2) and (3) happen in the same message cycle. The relay processes the first message as both registration and command. The CLI receives the connection ack first, then the command response separately.

### 3.2 Batch Create + Style — Single Round-Trip

```
CLI                        Relay                      Browser
 |                           |                           |
 |  batch ["grid.create      |                           |
 |   greet.txt \"Hello\"",   |                           |
 |   "grid.position 0        |                           |
 |    5 0 0",                |                           |
 |   "grid.color 0            |                           |
 |    0 1 0.5"]              |                           |
 |-------------------------->|                           |
 |                           |  {"from":"ctrl-0",        |
 |                           |   "cmd":"batch [...]"}    |
 |                           |-------------------------->|
 |                           |                           |
 |                           |   batch handler:          |
 |                           |     executeBatch([        |
 |                           |       "grid.create ...",  |
 |                           |       "grid.position ...",|
 |                           |       "grid.color ..."    |
 |                           |     ])                    |
 |                           |                           |
 |                           |  {"to":"ctrl-0",          |
 |                           |   "response":"OK: batch   |
 |                           |    completed (3/3)",      |
 |                           |   "data":{"results":[...],|
 |                           |    "succeeded":3}}        |
 |                           |<--------------------------|
 |                           |                           |
 |  {"response":"OK: ...",   |                           |
 |   "data":{"results":[...]}}                           |
 |<--------------------------|                           |
```

---

## 4. Error Protocol

### 4.1 Error Classification

All errors follow the existing convention: the `response` text starts with `"ERR: "`. Structured data is `null` on error (or contains diagnostic info like `matches` for ambiguous commands).

Proposed standardization for the CLI to parse programmatically:

| Error Type | Text Prefix | `data` Shape |
|---|---|---|
| Usage error | `ERR: usage: ...` | `null` |
| Not found | `ERR: invalid grid index ...` / `ERR: file not found ...` | `null` |
| Ambiguous | `ERR: ambiguous command ...` | `{"matches": ["cmd1", "cmd2"]}` |
| System error | `ERR: <exception message>` | `null` |
| Relay error | Plain string: `"ERR: no display connected..."` | N/A (no JSON wrapper) |

### 4.2 CLI Error Detection

The CLI should detect errors by checking:

1. **Plain string responses** (no JSON): check if string starts with `"ERR: "`.
2. **JSON responses**: check if `response` field starts with `"ERR: "`, or check if `data` is `null` when data was expected.

### 4.3 Relay-Level vs Application-Level Errors

This is a critical distinction:

- **Relay-level errors** arrive as plain strings (`"ERR: no display connected..."`). They have no JSON wrapper and no `data` field. The relay itself generates these.
- **Application-level errors** arrive as JSON `{"response": "ERR: ...", "data": null}` from the display via the relay.

The CLI must handle both formats. Detection:
```
if message starts with '{' -> JSON parse -> check response field
else -> plain string, may be error or relay ack
```

### 4.4 Proposed Error Envelope (Future Enhancement)

For better programmatic handling, a future version could add an explicit error field:

```json
{
  "response": "ERR: invalid grid index 99 (0-4)",
  "data": null,
  "error": {
    "code": "INVALID_INDEX",
    "message": "invalid grid index 99 (0-4)",
    "command": "grid.remove",
    "args": ["99"]
  }
}
```

This is NOT required for v1 — the `"ERR: "` prefix convention is sufficient and matches what already exists.

---

## 5. Streaming and Batching

### 5.1 Single-Message Payload Limits

WebSocket has no inherent message size limit (the protocol supports up to 2^63 bytes per frame). In practice:
- Node.js `ws` library: default `maxPayload` is 100 MiB.
- Browser WebSocket: no configurable limit, but browser engines typically handle multi-MB messages fine.

A 10,000-line source file at ~80 chars/line is ~800 KB as a string. This fits comfortably in a single WebSocket message. For v1, **no chunking is needed**.

### 5.2 Batch Command

The `batch` command (section 2.7) solves the multi-step coordination problem. The key scenarios:

**Create and position a grid** (2 commands, 1 round-trip):
```
batch ["grid.create foo.js \"content\"","grid.position 0 10 0 0"]
```

**Create multiple grids** (N commands, 1 round-trip):
```
batch ["grid.create a.js \"aaa\"","grid.create b.js \"bbb\"","grid.create c.js \"ccc\""]
```

**Atomicity note**: Batch is NOT transactional. If `grid.create` succeeds but `grid.position` fails, the grid exists without the position. The CLI should check `data.failed > 0` and handle partial success.

### 5.3 Command Sequencing Within a Connection

The relay forwards commands to the display one at a time per controller. The browser-side `_handleMessage` awaits the `router.execute()` result before sending the response. This means:

- Commands from a single controller are **strictly ordered**.
- Commands from different controllers may **interleave** at the display.
- The CLI can safely send commands back-to-back without waiting for responses, and responses will arrive in order.

However, if the CLI needs to use a returned value (e.g., the index of a newly created grid), it must wait for the response before sending the next command. The `batch` command avoids this by executing all commands in the display's event loop.

### 5.4 Large Content Upload Pattern

For files too large to comfortably inline in a command string (>1MB), a two-phase approach could work in a future version:

1. `grid.create foo.js --empty` (creates grid with no content, returns index)
2. `grid.upload <index> <base64-encoded-content>` (streams content to existing grid)

This is NOT needed for v1. The single-message approach handles realistic code files.

---

## 6. Hello Demo — Exact Wire Messages

This section shows the exact bytes on the wire for creating a grid that displays "Hello" in the 3D viewer.

### 6.1 Prerequisites

- Relay server running: `node examples/github-viewer/ws-relay.mjs`
- Browser has the viewer open and connected as display.

### 6.2 Connection (CLI -> Relay)

**CLI opens WebSocket connection to `ws://localhost:8765`.**

**CLI sends (first message — both registration and command)**:
```
grid.create hello.txt "Hello"
```

**Relay responds (plain string)**:
```
OK: connected as ctrl-0
```

**Relay forwards to display (JSON)**:
```json
{"from":"ctrl-0","cmd":"grid.create hello.txt \"Hello\""}
```

### 6.3 Command Execution (Browser)

`WebSocketBridge._handleMessage` receives the envelope, extracts `cmd`:
```
grid.create hello.txt "Hello"
```

`CommandRouter.parse()` tokenizes:
```
["grid.create", "hello.txt", "Hello"]
```

`CommandRouter.execute()` finds the `grid.create` handler, calls it with:
```
args = ["hello.txt", "Hello"]
ctx  = { scene, atlas, addGrid, getGrids, ... }
```

Handler:
1. `filename = "hello.txt"`
2. `content = "Hello"` (no `\n` escapes to expand)
3. `grid = new CodeGrid(ctx.scene, ctx.atlas)`
4. `await grid.loadFileAsync("hello.txt", "Hello")`
5. `ctx.addGrid(grid)` -> pushes to `viewer.grids`, adds to scene
6. Returns `{text, data}`

### 6.4 Response (Browser -> Relay -> CLI)

**Browser sends to relay**:
```json
{"to":"ctrl-0","response":"OK: created grid 0 'hello.txt' (1 lines, 5 glyphs)","data":{"index":0,"filename":"hello.txt","lines":1,"glyphs":5,"position":{"x":0,"y":0,"z":0}}}
```

**Relay delivers to CLI** (since `data` is present, sends as JSON):
```json
{"response":"OK: created grid 0 'hello.txt' (1 lines, 5 glyphs)","data":{"index":0,"filename":"hello.txt","lines":1,"glyphs":5,"position":{"x":0,"y":0,"z":0}}}
```

### 6.5 With Position and Color (Batch)

To create "Hello" at position (10, 5, 0) in cyan:

**CLI sends**:
```
batch ["grid.create hello.txt \"Hello\"","grid.position 0 10 5 0","grid.color 0 0 1 1"]
```

**Relay forwards to display**:
```json
{"from":"ctrl-0","cmd":"batch [\"grid.create hello.txt \\\"Hello\\\"\",\"grid.position 0 10 5 0\",\"grid.color 0 0 1 1\"]"}
```

**Display processes three commands sequentially, responds**:
```json
{"to":"ctrl-0","response":"OK: batch completed (3/3 succeeded)","data":{"results":[{"text":"OK: created grid 0 'hello.txt' (1 lines, 5 glyphs)","data":{"index":0,"filename":"hello.txt","lines":1,"glyphs":5,"position":{"x":0,"y":0,"z":0}}},{"text":"OK: grid 0 position set to (10, 5, 0)","data":{"index":0,"position":{"x":10,"y":5,"z":0}}},{"text":"OK: grid 0 color set to (0, 1, 1)","data":{"index":0,"color":{"r":0,"g":1,"b":1}}}],"succeeded":3,"failed":0}}
```

### 6.6 Using websocat (Manual Testing)

```bash
# Terminal 1: relay
node examples/github-viewer/ws-relay.mjs

# Terminal 2: CLI via websocat
websocat ws://localhost:8765

# Type:
grid.create hello.txt "Hello"

# Expected output:
# OK: connected as ctrl-0
# {"response":"OK: created grid 0 'hello.txt' (1 lines, 5 glyphs)","data":{"index":0,"filename":"hello.txt","lines":1,"glyphs":5,"position":{"x":0,"y":0,"z":0}}}
```

---

## 7. Context Bag Extensions Required

The `buildContext()` function in `websocket/index.js` needs these additions for grid CRUD:

```javascript
function buildContext(viewer) {
    return {
        // ... existing fields ...

        // NEW: Grid mutation methods
        addGrid(grid) {
            viewer.grids.push(grid);
            viewer.scene.add(grid);
        },

        removeGrid(index) {
            const grid = viewer.grids[index];
            if (!grid) return null;
            grid.dispose();
            viewer.scene.remove(grid);
            viewer.grids.splice(index, 1);
            return grid;
        },
    };
}
```

---

## 8. Protocol Summary Table

| Direction | Format | Example |
|---|---|---|
| Controller registration | First raw string (not "DISPLAY") | `"grid.list"` |
| Registration ack | Plain string | `"OK: connected as ctrl-0"` |
| Controller -> Relay | Raw string | `"grid.create foo.txt \"Hello\""` |
| Relay -> Display | JSON envelope | `{"from":"ctrl-0","cmd":"grid.create foo.txt \"Hello\""}` |
| Display -> Relay | JSON envelope | `{"to":"ctrl-0","response":"OK: ...","data":{...}}` |
| Relay -> Controller (with data) | JSON | `{"response":"OK: ...","data":{...}}` |
| Relay -> Controller (text only) | Plain string | `"OK: camera reset"` |
| Relay-level error | Plain string | `"ERR: no display connected..."` |
| App-level error | JSON (data=null) | `{"response":"ERR: ...","data":null}` |
| Relay event -> Display | JSON event | `{"event":"client_connected","clientId":"ctrl-0"}` |
| Relay-only: ping | Plain string | `"ping"` -> `"pong"` |
| Relay-only: whoami | Plain string | `"whoami"` -> `"You are ctrl-0..."` |
| Batch command | Raw string with JSON array | `"batch [\"cmd1\",\"cmd2\"]"` |
