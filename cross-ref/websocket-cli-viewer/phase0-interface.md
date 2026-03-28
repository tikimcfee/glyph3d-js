# Phase 0 — Interface-Perspective Analysis: WebSocket CLI for glyph3d-js Viewer

**Agent**: interface
**Focus**: CLI UX, command syntax, ergonomics, discoverability, developer experience
**Date**: 2026-03-27

---

## 1. CLI Invocation Patterns

### 1.1 Tool Name and Location

The CLI should be a standalone Node.js script invocable as `glyph-ctl` (or `g3d` for brevity). During development it lives at `./cli.js` in the project root; later it can be npm-linked or installed globally.

```bash
# Development — direct invocation
node cli.js <command> [args...]

# After npm link / bin registration
glyph-ctl <command> [args...]
g3d <command> [args...]
```

### 1.2 Three Operating Modes

**One-shot mode** — execute a single command and exit. This is the default when arguments follow the tool name.

```bash
$ g3d status
╔══ STATUS ══════════════════════════╗
║ grids:        12                   ║
║ glyphs:       8,421                ║
║ camera:       0, 50, 200           ║
║ websocket:    connected            ║
╚════════════════════════════════════╝
OK: status
```

**Interactive REPL mode** — enter with no arguments or with `--repl`. Maintains a persistent WebSocket connection. Prompt shows connection state.

```bash
$ g3d
glyph3d connecting to ws://localhost:8765... connected.
g3d> status
╔══ STATUS ══════════════════════════╗
║ grids:        12                   ║
║ ...                                ║
╚════════════════════════════════════╝
g3d> grid.list
#   filename                   glyphs  lines  position
──────────────────────────────────────────────────────
0   src/index.js               342     28     0,0,0
1   src/GlyphAtlas.js          1203    95     60,0,0
OK: 2 grids
g3d> .exit
```

**Pipe / stdin mode** — read commands from stdin, one per line. Activated when stdin is not a TTY, or with `--pipe`. Outputs one response per command, separated by a blank line. Ideal for scripting.

```bash
$ echo "grid.list" | g3d --json
{"grids":[{"index":0,"filename":"src/index.js",...}],"count":2}

$ cat commands.txt | g3d --pipe
```

### 1.3 Connection Options

```
  -h, --host <url>     WebSocket URL (default: ws://localhost:8765)
  -p, --port <port>    Port shorthand — equivalent to ws://localhost:<port>
  -t, --timeout <ms>   Command response timeout (default: 5000)
  -j, --json           Output raw JSON data instead of TUI text
  -q, --quiet          Suppress connection banners and OK confirmations
  --repl               Force REPL mode even with arguments
  --pipe               Force pipe mode (no readline, no prompt)
  --no-color           Disable ANSI color codes (for logging/CI)
  --version            Print version and exit
  --help               Print usage and exit
```

### 1.4 Connection Lifecycle

```
$ g3d --host ws://192.168.1.50:8765 camera.info
```

In one-shot mode: connect, send command, receive response, print, disconnect, exit. The entire round-trip must complete within `--timeout`. If the relay is unreachable, print an error to stderr and exit with code 1.

In REPL mode: connect once, keep alive, show reconnection messages inline. The prompt reflects state:

```
g3d>          # connected, ready
g3d [!]>      # disconnected, buffering
g3d [...]>    # reconnecting
```

---

## 2. Command Syntax Design

### 2.1 The Core Question: Dot-Namespaces vs CLI Subcommands

The browser-side CommandRouter uses dot-separated names: `camera.move`, `grid.list`, `grid.color`. The CLI could either:

**Option A: Mirror dot-namespace exactly (pass-through)**

```bash
g3d grid.list
g3d camera.move 0 50 100
g3d grid.color 0 1 0 0
```

**Option B: CLI-style subcommands with flags**

```bash
g3d grid list
g3d camera move --x 0 --y 50 --z 100
g3d grid color 0 --rgb 1 0 0
```

**Option C: Hybrid — dot-namespace as primary, with flag enrichment**

```bash
g3d grid.list
g3d camera.move 0 50 100
g3d grid.color 0 1 0 0
g3d grid.new "Hello, World" --color 1 0 0 --pos 0 10 0   # compound shortcut
```

### 2.2 Recommendation: Option C (Hybrid)

Rationale:

1. **Consistency with the browser**. The dot-namespace is already the command vocabulary. Users who learn commands in the browser console (`viewer.run('grid.list')`) should type exactly the same string in the CLI. Zero translation overhead.

2. **The relay is a string pipe**. Commands cross the wire as flat strings — `"grid.list"`, `"camera.move 0 50 100"`. The CLI's primary job is to send these strings through. Adding a subcommand parser that reassembles them into dot-strings adds complexity for no protocol benefit.

3. **Flags for CLI-only enrichment**. Where the CLI adds value over raw strings, use optional long flags: `--json`, `--color`, `--pos`. These are parsed client-side and never cross the wire — they either modify output formatting or compose multiple wire commands.

4. **Tab completion works naturally**. `grid.<TAB>` completes to `grid.list`, `grid.info`, `grid.color`, `grid.visibility`. The dot acts as a visual and completion separator without needing subcommand trees.

### 2.3 Syntax Rules

- First token is always the command name (dot-namespaced)
- Remaining tokens are positional arguments, matching CommandRouter's `args[]` array
- Quoted strings are supported: `grid.new "Hello World"`
- Long flags (`--json`, `--timeout 3000`) are stripped before sending to the wire
- The raw command string sent to the relay is exactly what the user typed, minus CLI-local flags

```
g3d grid.color 0 1 0.5 0 --json
     └─ command ─┘ └ args ┘  └ CLI-local flag (not sent)

Wire message: {"from":"cli-1","cmd":"grid.color 0 1 0.5 0"}
```

---

## 3. Common Action Workflows

### 3.1 Create a Grid

The browser currently has no `grid.create` command registered. This needs to be added server-side. The CLI syntax for the new command:

```bash
# Minimal: create a grid with text content
g3d> grid.new "Hello, World"
OK: created grid 3 (13 glyphs, 1 lines)

# With positioning
g3d> grid.new "Hello, World" 0 20 0
OK: created grid 3 at 0, 20, 0

# Full options via compound CLI shortcut
g3d> grid.new "function add(a, b) {\n  return a + b;\n}" --pos 0 20 0 --color 0.5 1 0.5
OK: created grid 3 at 0, 20, 0 (color: 0.5, 1, 0.5)
```

The compound shortcut (`--pos`, `--color`) decomposes into sequential wire commands:
1. `grid.new "function add(a, b) {\n  return a + b;\n}" 0 20 0`
2. `grid.color 3 0.5 1 0.5`

The CLI waits for each step and reports a combined result.

### 3.2 Edit Grid Text

```bash
# Replace all text in a grid
g3d> grid.text 3 "Updated content here"
OK: grid 3 text updated (21 glyphs, 1 lines)

# Multi-line content using shell heredoc (pipe mode)
$ g3d grid.text 3 "$(cat myfile.js)"
OK: grid 3 text updated (1482 glyphs, 87 lines)

# Load from file (CLI-side convenience)
g3d> grid.load 3 ./src/index.js
OK: grid 3 loaded from ./src/index.js (342 glyphs, 28 lines)
```

`grid.load` is a CLI-only command: it reads the local file, then sends `grid.text <index> "<contents>"` over the wire. It never touches the relay.

### 3.3 Change Grid Color

```bash
g3d> grid.color 3 1 0 0
OK: grid 3 color set to (1, 0, 0)

# Verify
g3d> grid.info 3
╔══ GRID #3 ═════════════════════════╗
║ filename:     (none)               ║
║ glyphs:       13                   ║
║ lines:        1                    ║
║ position:     0.0, 20.0, 0.0      ║
║ visible:      true                 ║
╚════════════════════════════════════╝
OK: grid info
```

### 3.4 Change Grid Visibility

```bash
g3d> grid.visibility 3 false
OK: grid 3 visibility = false

g3d> grid.visibility 3 true
OK: grid 3 visibility = true
```

### 3.5 Remove a Grid

```bash
g3d> grid.remove 3
OK: grid 3 removed

# Verify
g3d> grid.list
#   filename                   glyphs  lines  position
──────────────────────────────────────────────────────
0   src/index.js               342     28     0,0,0
1   src/GlyphAtlas.js          1203    95     60,0,0
2   src/GlyphRenderer.js       2100    178    120,0,0
OK: 3 grids
```

### 3.6 Camera Workflow

```bash
g3d> camera.info
╔══ CAMERA ══════════════════════════╗
║ position:     0.0, 50.0, 200.0    ║
║ rotation:     -0.24, 0.00, 0.00   ║
║ fov:          60                   ║
║ speed:        2                    ║
╚════════════════════════════════════╝

g3d> camera.move 0 20 50
OK: camera moved to 0, 20, 50

g3d> camera.focus 3
OK: focusing on grid 3

g3d> camera.fitall
OK: fitting all grids in view
```

---

## 4. Output Modes

### 4.1 Human-Readable (Default)

The browser's TUIFormatter already produces box-drawing characters and aligned tables. The CLI should pass this through directly. The response `text` field from the relay is already formatted.

```bash
$ g3d grid.list
#   filename                   glyphs  lines  position
──────────────────────────────────────────────────────
0   src/index.js               342     28     0,0,0
1   src/GlyphAtlas.js          1203    95     60,0,0
OK: 2 grids
```

The only CLI-side post-processing: optionally strip the `OK:` / `ERR:` status line when `--quiet` is active.

### 4.2 JSON Mode

Activated by `--json` flag (one-shot) or `.json on` in REPL. Prints the `data` field from the response as JSON to stdout.

```bash
$ g3d grid.list --json
{"grids":[{"index":0,"filename":"src/index.js","glyphs":342,"lines":28},{"index":1,"filename":"src/GlyphAtlas.js","glyphs":1203,"lines":95}],"count":2}
```

When `data` is null (no structured response), fall back to wrapping the text:

```bash
$ g3d camera.reset --json
{"text":"OK: camera reset","data":null}
```

### 4.3 JSON in REPL

```
g3d> .json on
Output mode: JSON
g3d> grid.list
{"grids":[...],"count":2}
g3d> .json off
Output mode: text
```

### 4.4 Exit Codes (One-Shot Mode)

| Code | Meaning |
|------|---------|
| 0 | Command succeeded (response text starts with `OK:` or does not start with `ERR:`) |
| 1 | Command failed (response starts with `ERR:`) |
| 2 | Connection failed (relay unreachable or timeout) |
| 3 | Usage error (bad arguments, unknown local flag) |

This enables scripting:

```bash
g3d grid.info 0 --json && echo "Grid exists" || echo "Grid not found"
```

### 4.5 Stderr vs Stdout Separation

- **stdout**: Command response (text or JSON). Nothing else.
- **stderr**: Connection messages, warnings, progress indicators, REPL prompt.

This means piping works cleanly:

```bash
g3d grid.list --json | jq '.grids[].filename'
```

---

## 5. Discoverability

### 5.1 Built-in Help

```bash
$ g3d help
╔══ COMMANDS ════════════════════════════════════════════════════════╗
║ help [namespace]                    List all commands             ║
║ status                              Show scene status             ║
║ camera.move <x> <y> <z>            Set camera position           ║
║ camera.lookat <x> <y> <z>          Point camera at position      ║
║ camera.focus <index|name>           Focus camera on grid          ║
║ camera.reset                        Reset camera to default       ║
║ camera.speed <value>                Set camera movement speed     ║
║ camera.info                         Show camera details           ║
║ camera.fitall                       Fit all grids in camera view  ║
║ grid.list                           List all loaded grids         ║
║ grid.info <index>                   Show grid details             ║
║ grid.color <index> <r> <g> <b>     Set grid text color           ║
║ grid.visibility <index> <true|false> Show/hide a grid             ║
║ ...                                                               ║
╚════════════════════════════════════════════════════════════════════╝
OK: 18 commands available
```

This is the exact output of the browser-side `help` command — the CLI passes it through. The `help` command is sent to the relay and the formatted response is returned.

### 5.2 Namespace Browsing

```bash
$ g3d help camera
╔══ COMMANDS: camera* ═══════════════════════════════════════════════╗
║ camera.move <x> <y> <z>            Set camera position            ║
║ camera.lookat <x> <y> <z>          Point camera at position       ║
║ camera.focus <index|name>           Focus camera on grid           ║
║ camera.reset                        Reset camera to default        ║
║ camera.speed <value>                Set camera movement speed      ║
║ camera.info                         Show camera details            ║
║ camera.fitall                       Fit all grids in camera view   ║
╚═══════════════════════════════════════════════════════════════════╝
```

### 5.3 Tab Completion (REPL Mode)

The CLI fetches the command list from the relay on connect (via `help --json` or a dedicated introspection command) and populates readline's completer.

```
g3d> gr<TAB>
grid.color       grid.info        grid.list        grid.new
grid.remove      grid.text        grid.visibility

g3d> grid.<TAB>
grid.color       grid.info        grid.list        grid.new
grid.remove      grid.text        grid.visibility

g3d> grid.c<TAB>
grid.color

g3d> grid.color <TAB>
(hint: <index> <r> <g> <b>)
```

Implementation: on REPL start, send `help` to the relay, parse the `data.commands` array, and register each `name` + `usage` as completions.

### 5.4 REPL Meta-Commands

Dot-prefixed commands are REPL-local (never sent to relay):

| Command | Action |
|---------|--------|
| `.help` | Show REPL meta-commands |
| `.exit` / `.quit` / Ctrl-D | Exit REPL |
| `.json on/off` | Toggle JSON output mode |
| `.connect [url]` | Reconnect to a different relay |
| `.disconnect` | Close WebSocket |
| `.status` | Show CLI connection state (not viewer status) |
| `.history` | Show command history |
| `.clear` | Clear terminal |
| `.batch <file>` | Execute commands from a file |

The dot prefix prevents collision with relay commands (`status` vs `.status`).

---

## 6. Ergonomic Shortcuts

### 6.1 Compound Grid Creation

The most common multi-step operation is creating a grid with properties. The CLI should offer a compound shortcut that decomposes into wire commands:

```bash
g3d grid.new "Hello" --color 1 0 0 --pos 0 10 0
```

Internally this sends three commands sequentially:
1. `grid.new "Hello"` -- creates grid, returns index N
2. `grid.color N 1 0 0` -- sets color (using returned index)
3. (position is part of `grid.new` args, so already handled)

The CLI prints the final composite result:

```
OK: created grid 3 "Hello" at (0, 10, 0) color (1, 0, 0)
```

### 6.2 File Loading

```bash
g3d grid.load 0 ./myfile.js
```

CLI-side: reads `./myfile.js`, sends `grid.text 0 "<escaped content>"`. This is a local-only command that composes into a wire command.

### 6.3 Batch Execution

```bash
# From file
g3d --batch setup.g3d

# Inline semicolons (shell one-liner)
g3d "grid.new hello ; camera.fitall"
```

Where `setup.g3d` contains:
```
grid.new "function hello() {"
grid.new "  return 'world';"
grid.new "}"
camera.fitall
```

### 6.4 Watch Mode

```bash
g3d grid.load 0 ./src/index.js --watch
```

CLI-side: uses `fs.watch` on the file path; on change, re-sends `grid.text 0 "<new content>"`. Prints a one-line update each time:

```
[14:32:01] updated grid 0 (342 glyphs)
[14:32:15] updated grid 0 (348 glyphs)
^C
```

### 6.5 Aliasing in REPL

```
g3d> .alias ls grid.list
OK: alias 'ls' -> 'grid.list'
g3d> ls
#   filename    glyphs  lines  position
...
```

---

## 7. Hello Demo

### 7.1 Prerequisites

1. The viewer is running in a browser at `localhost:8000/examples/github-viewer/`
2. The relay is running: `node relay.js` (port 8765)
3. The browser has connected to the relay: either via settings toggle or `viewer.connect()` in devtools
4. The `grid.new` command has been registered in the browser-side CommandRouter

### 7.2 The Session

```bash
$ node cli.js
glyph3d connecting to ws://localhost:8765... connected.

g3d> status
╔══ STATUS ══════════════════════════╗
║ grids:        0                    ║
║ glyphs:       0                    ║
║ windows:      0                    ║
║ camera:       0, 50, 200           ║
║ websocket:    connected            ║
╚════════════════════════════════════╝
OK: status

g3d> grid.new "Hello"
OK: created grid 0 (5 glyphs, 1 line)

g3d> grid.list
#   filename    glyphs  lines  position
──────────────────────────────────────
0   (unnamed)   5       1      0,0,0
OK: 1 grid

g3d> camera.fitall
OK: fitting all grids in view

g3d> grid.color 0 0 1 0.5
OK: grid 0 color set to (0, 1, 0.5)

g3d> .exit
```

### 7.3 One-Shot Equivalent

```bash
$ node cli.js grid.new "Hello"
OK: created grid 0 (5 glyphs, 1 line)

$ node cli.js camera.fitall
OK: fitting all grids in view
```

### 7.4 What the User Sees

In the browser, a 3D text rendering of "Hello" appears at the origin. Five GPU-instanced glyph quads — H, e, l, l, o — each sampling from the GlyphAtlas texture. The camera auto-fits to frame it after `camera.fitall`. When `grid.color 0 0 1 0.5` runs, the text shifts to a teal color via the group DataTexture color multiplier.

### 7.5 Wire Protocol Trace

For `grid.new "Hello"`, the exact messages on the wire:

```
CLI  -> Relay:  CONTROLLER
Relay -> CLI:   {"ok":true}

CLI  -> Relay:  {"from":"cli-1","cmd":"grid.new \"Hello\""}
Relay -> Display: {"from":"cli-1","cmd":"grid.new \"Hello\""}
Display -> Relay: {"to":"cli-1","response":"OK: created grid 0 (5 glyphs, 1 line)","data":{"index":0,"glyphs":5,"lines":1}}
Relay -> CLI:   {"to":"cli-1","response":"OK: created grid 0 (5 glyphs, 1 line)","data":{"index":0,"glyphs":5,"lines":1}}
```

Note: The current relay.js is a broadcast relay that does not understand `from`/`to` routing. It broadcasts all messages to all other clients. This means:
- The CLI receives its own response because the display sends it, and the relay broadcasts to all non-sender clients
- If multiple controllers connect, they each see all responses (the CLI filters by `to` matching its own ID)
- The relay does NOT need modification for basic single-controller use — broadcast works fine when there is one display and one controller

---

## 8. Commands That Need to Be Added (Browser-Side)

The existing CommandRouter registers read-only grid commands. For the Hello demo and full CRUD, these new commands must be registered:

| Command | Wire syntax | Purpose |
|---------|------------|---------|
| `grid.new` | `grid.new <text> [x y z]` | Create a new CodeGrid with text content |
| `grid.remove` | `grid.remove <index>` | Remove a grid from the scene |
| `grid.text` | `grid.text <index> <text>` | Replace text content of an existing grid |
| `grid.move` | `grid.move <index> <x> <y> <z>` | Set grid position |

These are all implemented in the browser's `gridCommands.js` registration file and require access to the context bag's scene, GlyphAtlas, and grid management methods.

---

## 9. Controller Registration Protocol

The current relay.js does a simple broadcast. The WebSocketBridge registers by sending the bare string `DISPLAY`. For the CLI to be recognized as a controller, one of two approaches:

**Option A: CLI sends `CONTROLLER` as first message.** The relay (or the WebSocketBridge) can use this to differentiate client types. The current relay does not care — it broadcasts everything — so this is purely for future routing.

**Option B: CLI just connects and starts sending `{from, cmd}` JSON.** The WebSocketBridge already handles this format. No registration needed with the current broadcast relay.

Recommendation: Use Option A for clarity. Send `CONTROLLER` on connect. The relay can optionally log it. The WebSocketBridge can track connected controllers. The CLI assigns itself a unique `from` ID like `cli-<pid>` for response correlation.

---

## 10. Implementation Priority for Hello Demo

To achieve the "send hello from CLI and see it render" goal, the minimum work is:

1. **Browser-side**: Register `grid.new` command handler in `gridCommands.js` (creates a CodeGrid, adds text, adds to scene)
2. **CLI**: A ~100-line Node.js script using the `ws` npm package:
   - Parse args to determine one-shot vs REPL
   - Connect to relay WebSocket
   - Send `CONTROLLER` registration
   - Send `{from: "cli-1", cmd: "<user input>"}`
   - Listen for `{to: "cli-1", response: "..."}` and print `response`
   - For REPL: use `readline` with tab completion seeded from `help` response

The CLI itself is thin by design. The intelligence lives in the CommandRouter and command handlers on the browser side. The CLI is a formatted pipe with readline.
