# Phase 0: Implementation Analysis -- WebSocket CLI Viewer

## 1. File Structure

```
examples/github-viewer/
  cli/
    glyph-cli.mjs              # Main CLI entry point (Node.js, ES module)
    CliConnection.mjs           # WebSocket client wrapper (controller role)
    CommandCompleter.mjs        # Tab-completion for REPL (optional, phase 2)

  websocket/
    commands/
      gridCommands.js           # EXTEND: add grid.create, grid.remove, grid.settext, grid.setposition
      index.js                  # No changes needed (gridCommands already registered)
```

The CLI lives inside `examples/github-viewer/cli/` because it is tightly coupled to the github-viewer's command vocabulary and context bag. It is NOT a library-level tool -- it controls a specific running viewer instance.

No new npm dependencies required. The `ws` package is already a devDependency (`"ws": "^8.19.0"` in package.json). Node.js >= 18 provides `readline/promises` natively.

A new npm script in `package.json`:

```json
"cli": "node examples/github-viewer/cli/glyph-cli.mjs"
```

## 2. Node.js Architecture

### 2.1 CliConnection.mjs -- WebSocket Client

The relay server (`ws-relay.mjs`) expects controllers to send raw text strings. The first message is the command itself (relay auto-registers as controller). Responses come back as either plain strings or JSON `{ response, data }`.

```javascript
// examples/github-viewer/cli/CliConnection.mjs
import WebSocket from 'ws';

export default class CliConnection {
    constructor(url = 'ws://localhost:8765') {
        this.url = url;
        this.ws = null;
        this.connected = false;
        this._pendingResolve = null;  // for request-response pairing
        this._registered = false;
    }

    /**
     * Connect to the relay server.
     * @returns {Promise<string>} Registration ack message
     */
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.on('open', () => {
                this.connected = true;
            });

            this.ws.on('message', (raw) => {
                const msg = raw.toString();

                // First message is registration ack: "OK: connected as ctrl-N"
                if (!this._registered && msg.startsWith('OK: connected as')) {
                    this._registered = true;
                    resolve(msg);
                    return;
                }

                // Subsequent messages are command responses
                if (this._pendingResolve) {
                    const fn = this._pendingResolve;
                    this._pendingResolve = null;

                    // Try to parse structured response
                    try {
                        const parsed = JSON.parse(msg);
                        fn({ text: parsed.response || msg, data: parsed.data || null });
                    } catch {
                        fn({ text: msg, data: null });
                    }
                }
            });

            this.ws.on('error', (err) => {
                if (!this._registered) reject(err);
            });

            this.ws.on('close', () => {
                this.connected = false;
            });
        });
    }

    /**
     * Send a command and wait for its response.
     * @param {string} cmd - Command string (e.g. "grid.list")
     * @param {number} [timeout=5000] - Timeout in ms
     * @returns {Promise<{text: string, data: any}>}
     */
    send(cmd, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected'));
                return;
            }

            const timer = setTimeout(() => {
                this._pendingResolve = null;
                reject(new Error(`Timeout waiting for response to: ${cmd}`));
            }, timeout);

            this._pendingResolve = (result) => {
                clearTimeout(timer);
                resolve(result);
            };

            this.ws.send(cmd);
        });
    }

    close() {
        if (this.ws) this.ws.close();
    }
}
```

Key protocol detail from `ws-relay.mjs` lines 86-98: The relay auto-registers the first message sender as a controller. The first raw text sent IS both the registration trigger AND a command. But the relay sends `OK: connected as ctrl-N` first, THEN forwards the command to the display. This means the first message from the CLI triggers two responses: the ack AND the command result. The implementation above handles this by treating the `OK:` prefix as registration and holding a pending resolve for the actual response.

**Correction on re-reading**: Actually looking at `ws-relay.mjs` lines 85-98 more carefully:

```javascript
} else {
    clientId = `ctrl-${nextId++}`;
    controllers.set(clientId, ws);
    role = 'controller';
    ws.send(`OK: connected as ${clientId}`);
    notifyDisplay('client_connected', { clientId });
    // Fall through to process first message as command
}
```

The relay sends the ack, THEN falls through to process that same first message as a command. So the first message the CLI sends triggers BOTH the ack AND a forwarded command to the display. The CLI will receive the ack first, then the command response. The `_registered` flag in the code above handles this correctly -- the ack resolves the `connect()` promise, then the command response resolves the `send()` promise.

However, this means if you connect and immediately send a command, the FIRST message text you send becomes both the handshake trigger and a command. The simplest approach: send `ping` as the first message (the relay handles it directly at line 100, returning `pong` without forwarding to display), which cleanly separates registration from commands.

Revised connect():

```javascript
connect() {
    return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url);
        this.ws.on('open', () => {
            this.connected = true;
            // Send ping as first message to trigger registration
            // without sending a real command to display
            this.ws.send('ping');
        });
        this.ws.on('message', (raw) => {
            const msg = raw.toString();
            if (!this._registered) {
                // First response is "OK: connected as ctrl-N"
                if (msg.startsWith('OK:')) {
                    this._registered = true;
                    // Next message will be "pong" -- discard it
                    this._discardNext = true;
                    resolve(msg);
                    return;
                }
            }
            if (this._discardNext) {
                this._discardNext = false;
                return;
            }
            // ... handle command responses
        });
    });
}
```

Wait -- re-reading the relay more carefully. Line 96-98:

```javascript
if (role === 'controller') {
    const cmd = raw.trim();
    if (cmd.toLowerCase() === 'ping') { ws.send('pong'); return; }
```

The `ping` check happens AFTER the first-message role assignment. But the first message falls through to this block. So `ping` as first message means:
1. Relay assigns controller role, sends `OK: connected as ctrl-N`
2. Falls through to `if (role === 'controller')`, `cmd = 'ping'`, sends `pong`

So the CLI gets two messages: `OK: connected as ctrl-0` then `pong`. Clean separation.

### 2.2 glyph-cli.mjs -- REPL Loop

```javascript
#!/usr/bin/env node
// examples/github-viewer/cli/glyph-cli.mjs

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import CliConnection from './CliConnection.mjs';

const url = process.argv[2] || 'ws://localhost:8765';
const conn = new CliConnection(url);

try {
    const ack = await conn.connect();
    console.log(ack);
} catch (err) {
    console.error(`Failed to connect to ${url}: ${err.message}`);
    console.error('Is the relay running? (npm run ws)');
    console.error('Is the viewer open in a browser?');
    process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
rl.setPrompt('glyph> ');
rl.prompt();

rl.on('line', async (line) => {
    const cmd = line.trim();
    if (!cmd) { rl.prompt(); return; }

    // Local commands
    if (cmd === 'quit' || cmd === 'exit') {
        conn.close();
        rl.close();
        process.exit(0);
    }

    if (cmd === '.json') {
        // Toggle JSON output mode
        // (store as module-level flag)
    }

    try {
        const result = await conn.send(cmd);
        console.log(result.text);

        // Optionally print structured data
        if (result.data && process.env.GLYPH_CLI_JSON) {
            console.log(JSON.stringify(result.data, null, 2));
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
    }

    rl.prompt();
});

rl.on('close', () => {
    conn.close();
    process.exit(0);
});
```

This is intentionally minimal. The CLI is a thin transport layer -- all intelligence lives in the browser-side CommandRouter. The CLI just sends strings and prints responses.

### 2.3 One-shot mode (non-interactive)

For scripting, support piped input:

```javascript
// At the top of glyph-cli.mjs, detect non-TTY
if (!stdin.isTTY) {
    // Read all input, split into lines, execute sequentially
    let input = '';
    stdin.on('data', (chunk) => { input += chunk; });
    stdin.on('end', async () => {
        for (const line of input.split('\n')) {
            const cmd = line.trim();
            if (!cmd || cmd.startsWith('#')) continue;
            const result = await conn.send(cmd);
            console.log(result.text);
        }
        conn.close();
        process.exit(0);
    });
}
```

This enables: `echo 'grid.create "Hello World"' | node examples/github-viewer/cli/glyph-cli.mjs`


## 3. Browser-Side Additions

### 3.1 New Commands in gridCommands.js

The existing `gridCommands.js` has `grid.list`, `grid.info`, `grid.color`, `grid.visibility`. We need to add:

| Command | Args | Description |
|---------|------|-------------|
| `grid.create` | `<text> [name]` | Create a new CodeGrid with text content |
| `grid.remove` | `<index>` | Remove and dispose a grid |
| `grid.settext` | `<index> <text>` | Replace grid text content |
| `grid.setposition` | `<index> <x> <y> <z>` | Move grid in world space |
| `grid.setscale` | `<index> <scale>` | Set uniform scale |

The critical integration point is the **context bag**. Looking at `websocket/index.js` line 21-52, the context provides:

```javascript
{
    scene: viewer.scene,        // THREE.Scene
    camera: viewer.camera,      // THREE.PerspectiveCamera
    renderer: viewer.renderer,  // THREE.WebGLRenderer
    atlas: viewer.atlas,        // GlyphAtlas
    getGrids: () => viewer.grids,  // Returns mutable array reference
    // ...
}
```

The `getGrids()` returns the actual `viewer.grids` array by reference. So `ctx.getGrids().push(grid)` mutates the viewer's grid list directly. And `ctx.scene.add(grid)` adds the Object3D to the Three.js scene. These are the same operations `GitHubRepoViewer.js` does at lines 855-857.

### 3.2 grid.create handler

```javascript
// Addition to examples/github-viewer/websocket/commands/gridCommands.js
import CodeGrid from '../../collections/CodeGrid.js';  // ADD this import at top

router.register('grid.create', (args, ctx) => {
    if (args.length < 1) {
        return { text: 'ERR: usage: grid.create <text> [name]', data: null };
    }

    const text = args[0];
    const name = args[1] || `cli-grid-${Date.now()}`;

    // Create CodeGrid exactly how GitHubRepoViewer does (line 959)
    const grid = new CodeGrid(ctx.scene, ctx.atlas, {
        name,
        showBackground: true,
        showFilename: !!args[1],
    });

    // Load text synchronously (fine for CLI-created content)
    grid.loadText(text);
    if (args[1]) {
        grid.setFilenameLabel(args[1]);
    }

    // Add to scene and tracking array
    ctx.scene.add(grid);
    const grids = ctx.getGrids();
    grids.push(grid);

    const idx = grids.length - 1;

    return {
        text: `OK: created grid #${idx} "${name}" (${grid.getGlyphCount()} glyphs)`,
        data: {
            index: idx,
            name,
            glyphs: grid.getGlyphCount(),
            lines: grid.getLineCount(),
        }
    };
}, {
    description: 'Create a new grid with text content',
    usage: '<text> [name]',
    returns: 'index, name, glyphs, lines'
});
```

**Important implementation note**: `CodeGrid` constructor signature is:

```javascript
constructor(scene, atlas, options = {})
```

It internally creates a `GlyphCollection`, which creates a `GlyphRendererV15`. The `scene` param is used by `GlyphCollection` to add its internal `THREE.Group` to the scene. Then `CodeGrid` also calls `this.add(this._collection.group)` to reparent the collection group as a child of the CodeGrid Object3D.

However, there is a subtlety: `GlyphCollection` constructor does `this.scene.add(this.group)` at line 58. Then `CodeGrid` constructor does `this.add(this._collection.group)` at line 87, which reparents the group from the scene root into the CodeGrid. This means the CodeGrid must ALSO be added to the scene for the collection's group to be visible. The `ctx.scene.add(grid)` call handles this.

### 3.3 grid.remove handler

```javascript
router.register('grid.remove', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 1) return { text: 'ERR: usage: grid.remove <index>', data: null };

    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
    }

    const grid = grids[idx];
    const name = grid.getFilename() || grid.name || '(unnamed)';

    // Dispose GPU resources and remove from scene
    grid.dispose();
    ctx.scene.remove(grid);

    // Remove from tracking array
    grids.splice(idx, 1);

    return {
        text: `OK: removed grid #${idx} "${name}"`,
        data: { removedIndex: idx, name }
    };
}, { description: 'Remove a grid from the scene', usage: '<index>' });
```

Note: `grids.splice(idx, 1)` changes the indices of all subsequent grids. The `grid.dispose()` call (CodeGrid line 358) disposes the collection, which disposes the renderer, which frees GPU buffers.

### 3.4 grid.settext handler

```javascript
router.register('grid.settext', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 2) return { text: 'ERR: usage: grid.settext <index> <text>', data: null };

    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid grid index ${args[0]}`, data: null };
    }

    const text = args.slice(1).join(' ');
    const grid = grids[idx];

    // CodeGrid.loadText() clears previous content and re-layouts
    grid.loadText(text);

    return {
        text: `OK: grid #${idx} text updated (${grid.getGlyphCount()} glyphs, ${grid.getLineCount()} lines)`,
        data: { index: idx, glyphs: grid.getGlyphCount(), lines: grid.getLineCount() }
    };
}, { description: 'Replace grid text content', usage: '<index> <text>' });
```

`CodeGrid.loadText()` (line 103) calls `_clearContent()` then `_layoutContent()` then `_updateBackground()`. The `_clearContent()` removes all existing text entries from the collection and flushes. Then `_layoutContent()` re-adds lines and flushes again. This is the clean path for text replacement.

### 3.5 grid.setposition handler

```javascript
router.register('grid.setposition', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 4) return { text: 'ERR: usage: grid.setposition <index> <x> <y> <z>', data: null };

    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid grid index ${args[0]}`, data: null };
    }
    const [x, y, z] = args.slice(1, 4).map(Number);
    if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };

    // CodeGrid extends Object3D, so .position is a THREE.Vector3
    grids[idx].position.set(x, y, z);

    return {
        text: `OK: grid #${idx} position = (${x}, ${y}, ${z})`,
        data: { index: idx, position: { x, y, z } }
    };
}, { description: 'Set grid world position', usage: '<index> <x> <y> <z>' });
```

Because `CodeGrid extends THREE.Object3D`, `.position` is the standard Three.js `Vector3`. Setting it moves the entire grid (background + text) in world space.

### 3.6 grid.setscale handler

```javascript
router.register('grid.setscale', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 2) return { text: 'ERR: usage: grid.setscale <index> <scale>', data: null };

    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid grid index ${args[0]}`, data: null };
    }
    const scale = parseFloat(args[1]);
    if (isNaN(scale)) return { text: 'ERR: scale must be a number', data: null };

    grids[idx].scale.setScalar(scale);

    return {
        text: `OK: grid #${idx} scale = ${scale}`,
        data: { index: idx, scale }
    };
}, { description: 'Set grid uniform scale', usage: '<index> <scale>' });
```


## 4. Shared Code

There is very little to share between CLI and browser. The design intentionally keeps them decoupled:

- **CLI side**: Sends raw command strings over WebSocket. No parsing, no command knowledge.
- **Browser side**: CommandRouter parses and dispatches. All command logic lives here.

The only shared concept is the command string format: `namespace.verb arg1 arg2 "quoted arg"`. This is documented implicitly by the `CommandRouter.parse()` method (line 70-101) and does not need a shared module.

If we wanted tab-completion in the CLI, we would fetch the command list via `help` and cache it. No shared code needed -- just a one-time `help` call on connect:

```javascript
// In glyph-cli.mjs, after connect:
const helpResult = await conn.send('help');
const commandNames = helpResult.data?.commands?.map(c => c.name) || [];

rl.completer = (line) => {
    const hits = commandNames.filter(c => c.startsWith(line));
    return [hits.length ? hits : commandNames, line];
};
```

## 5. The Grid Lifecycle

### 5.1 Creation (programmatic, no GitHub fetch)

From `GitHubRepoViewer.createGridForFileAsync()` (line 957-963):

```javascript
async createGridForFileAsync(path, content) {
    const filename = path.split('/').pop();
    const grid = new CodeGrid(this.scene, this.atlas);
    await grid.loadFileAsync(filename, content);
    grid.userData.sourcePath = path;
    return grid;
}
```

For CLI-created grids, the simpler sync path works:

```javascript
const grid = new CodeGrid(scene, atlas, { showBackground: true });
grid.loadText("Hello, World!");     // Sync: splits lines, adds to collection, flushes to GPU
scene.add(grid);                    // Add Object3D to scene graph
grids.push(grid);                   // Track in viewer's grid array
```

### 5.2 What happens inside loadText()

1. `CodeGrid.loadText(text)` (line 103):
   - Sets `this.content = text`, `this.lines = text.split('\n')`
   - Calls `_clearContent()`: removes previous text IDs from collection, flushes
   - Calls `_layoutContent()`:
     - Optionally renders filename label via `this._collection.addText(filename, pos, {color})`
     - For each line: `this._collection.addText(line, {x:0, y:currentY, z:0}, {color})`
     - Calls `this._collection.flush()` which triggers lazy renderer creation + GPU upload
   - Calls `_updateBackground()`: sizes the background plane to match content bounds

2. Inside `GlyphCollection.flush()` (line 410):
   - If no renderer exists, creates one sized to pending glyph count
   - Calls `this._renderer.renderBatch(items)` which:
     - Converts text to codepoints
     - Builds per-instance attribute arrays (position, size, codepoint, color, groupId)
     - Uploads to GPU via `InstancedBufferGeometry`

### 5.3 Positioning after creation

CodeGrid extends Object3D. Two positioning strategies:

**A. Object3D position (standard Three.js)**:
```javascript
grid.position.set(100, 50, 0);  // Moves entire grid in world space
```

**B. Collection-level group offset (GPU-side)**:
```javascript
grid.getCollection().setGroupOffset(0, {x: 100, y: 50, z: 0});  // DataTexture-based, O(1)
```

For CLI control, option A is simpler and more intuitive. Option B is for shared-renderer architectures.

### 5.4 Removal

```javascript
grid.dispose();         // Frees GlyphCollection -> GlyphRenderer -> GPU buffers
scene.remove(grid);     // Remove from scene graph
grids.splice(idx, 1);   // Remove from tracking array
```

`CodeGrid.dispose()` (line 358) handles:
- `this._collection.dispose()` -> removes renderer mesh from group, disposes geometry/material/textures
- Disposes background plane geometry + material
- Nulls content arrays


## 6. Hello Demo -- Actual Runnable Code

### 6.1 Prerequisites

Three processes must be running:
1. HTTP server: `npm run serve` (port 8000)
2. WebSocket relay: `npm run ws` (port 8765)
3. Browser: open `http://localhost:8000/examples/github-viewer/`
4. Enable WebSocket in viewer settings (toggle in UI, or call `viewer.connect()` in devtools)

### 6.2 File: examples/github-viewer/cli/glyph-cli.mjs

```javascript
#!/usr/bin/env node
/**
 * glyph-cli -- WebSocket CLI controller for glyph3d-js viewer.
 *
 * Usage:
 *   node examples/github-viewer/cli/glyph-cli.mjs [ws://host:port]
 *   echo 'grid.create "Hello"' | node examples/github-viewer/cli/glyph-cli.mjs
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import CliConnection from './CliConnection.mjs';

const url = process.argv[2] || 'ws://localhost:8765';

console.log(`Connecting to ${url}...`);
const conn = new CliConnection(url);

try {
    const ack = await conn.connect();
    console.log(ack);
    console.log('Type commands (help for list, quit to exit)\n');
} catch (err) {
    console.error(`Failed: ${err.message}`);
    console.error('Ensure relay is running (npm run ws) and viewer is open in browser.');
    process.exit(1);
}

// Non-interactive (piped) mode
if (!stdin.isTTY) {
    let input = '';
    stdin.on('data', (chunk) => { input += chunk; });
    stdin.on('end', async () => {
        for (const line of input.split('\n')) {
            const cmd = line.trim();
            if (!cmd || cmd.startsWith('#')) continue;
            try {
                const result = await conn.send(cmd);
                console.log(result.text);
            } catch (err) {
                console.error(`Error: ${err.message}`);
            }
        }
        conn.close();
    });
} else {
    // Interactive REPL
    const rl = createInterface({ input: stdin, output: stdout, prompt: 'glyph> ' });
    rl.prompt();

    rl.on('line', async (line) => {
        const cmd = line.trim();
        if (!cmd) { rl.prompt(); return; }
        if (cmd === 'quit' || cmd === 'exit') {
            conn.close();
            rl.close();
            return;
        }

        try {
            const result = await conn.send(cmd);
            console.log(result.text);
        } catch (err) {
            console.error(`Error: ${err.message}`);
        }
        rl.prompt();
    });

    rl.on('close', () => { conn.close(); process.exit(0); });
}
```

### 6.3 File: examples/github-viewer/cli/CliConnection.mjs

```javascript
/**
 * CliConnection -- Node.js WebSocket client for the glyph3d-js relay.
 * Connects as a "controller" role. Sends string commands, receives responses.
 */

import WebSocket from 'ws';

export default class CliConnection {
    constructor(url = 'ws://localhost:8765') {
        this.url = url;
        this.ws = null;
        this.connected = false;
        this._registered = false;
        this._pendingResolve = null;
    }

    /**
     * Connect to relay. Sends 'ping' to trigger clean registration.
     * @returns {Promise<string>} Registration ack
     */
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            let gotAck = false;

            this.ws.on('open', () => {
                this.connected = true;
                this.ws.send('ping');
            });

            this.ws.on('message', (raw) => {
                const msg = raw.toString();

                // Phase 1: registration ack
                if (!gotAck && msg.startsWith('OK: connected as')) {
                    gotAck = true;
                    this._registered = true;
                    resolve(msg);
                    return;
                }

                // Phase 2: discard the 'pong' response to our initial ping
                if (gotAck && !this._registered) {
                    // This shouldn't happen since we set _registered above
                    return;
                }

                // Discard 'pong' from initial ping
                if (msg === 'pong' && !this._pendingResolve) {
                    return;
                }

                // Phase 3: command responses
                if (this._pendingResolve) {
                    const fn = this._pendingResolve;
                    this._pendingResolve = null;

                    try {
                        const parsed = JSON.parse(msg);
                        fn({ text: parsed.response || msg, data: parsed.data || null });
                    } catch {
                        fn({ text: msg, data: null });
                    }
                }
            });

            this.ws.on('error', (err) => {
                if (!this._registered) reject(err);
                else console.error(`[ws] error: ${err.message}`);
            });

            this.ws.on('close', () => {
                this.connected = false;
                if (!this._registered) reject(new Error('Connection closed before registration'));
            });
        });
    }

    /**
     * Send command, wait for response.
     * @param {string} cmd
     * @param {number} [timeout=5000]
     * @returns {Promise<{text: string, data: any}>}
     */
    send(cmd, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected'));
                return;
            }

            const timer = setTimeout(() => {
                this._pendingResolve = null;
                reject(new Error(`Timeout: ${cmd}`));
            }, timeout);

            this._pendingResolve = (result) => {
                clearTimeout(timer);
                resolve(result);
            };

            this.ws.send(cmd);
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
```

### 6.4 Browser-side: additions to gridCommands.js

At the top of `examples/github-viewer/websocket/commands/gridCommands.js`, add the import:

```javascript
import CodeGrid from '../../CodeGrid.js';
```

Wait -- need the actual import path. Looking at `GitHubRepoViewer.js`:

```javascript
// GitHubRepoViewer.js imports CodeGrid from the library
import CodeGrid from '../../src/collections/CodeGrid.js';
```

But `gridCommands.js` is at `examples/github-viewer/websocket/commands/gridCommands.js`. So the relative path to CodeGrid would be:

```javascript
import CodeGrid from '../../../../src/collections/CodeGrid.js';
```

Let me verify. From `examples/github-viewer/websocket/commands/gridCommands.js`:
- `../` -> `examples/github-viewer/websocket/`
- `../../` -> `examples/github-viewer/`
- `../../../` -> `examples/`
- `../../../../` -> project root
- `../../../../src/collections/CodeGrid.js` -- correct.

The new registrations to add after the existing `grid.visibility` handler:

```javascript
router.register('grid.create', (args, ctx) => {
    if (args.length < 1) {
        return { text: 'ERR: usage: grid.create <text> [name]', data: null };
    }

    const text = args[0];
    const name = args[1] || null;

    const grid = new CodeGrid(ctx.scene, ctx.atlas, {
        name: name || `cli-${Date.now()}`,
        showBackground: true,
        showFilename: !!name,
    });

    if (name) grid.setFilenameLabel(name);
    grid.loadText(text);

    ctx.scene.add(grid);
    const grids = ctx.getGrids();
    grids.push(grid);

    const idx = grids.length - 1;
    return {
        text: `OK: created grid #${idx} (${grid.getGlyphCount()} glyphs)`,
        data: { index: idx, name: name || grid.name, glyphs: grid.getGlyphCount() }
    };
}, { description: 'Create a grid with text content', usage: '<text> [name]' });

router.register('grid.remove', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 1) return { text: 'ERR: usage: grid.remove <index>', data: null };
    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid index ${args[0]} (0-${grids.length - 1})`, data: null };
    }

    const grid = grids[idx];
    grid.dispose();
    ctx.scene.remove(grid);
    grids.splice(idx, 1);

    return {
        text: `OK: removed grid #${idx}`,
        data: { removedIndex: idx }
    };
}, { description: 'Remove a grid', usage: '<index>' });

router.register('grid.settext', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 2) return { text: 'ERR: usage: grid.settext <index> <text>', data: null };
    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid index ${args[0]}`, data: null };
    }
    // All remaining args are the text (joined with spaces for unquoted input)
    const text = args.slice(1).join(' ');
    grids[idx].loadText(text);
    return {
        text: `OK: grid #${idx} updated (${grids[idx].getGlyphCount()} glyphs)`,
        data: { index: idx, glyphs: grids[idx].getGlyphCount() }
    };
}, { description: 'Replace grid text', usage: '<index> <text>' });

router.register('grid.setposition', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 4) return { text: 'ERR: usage: grid.setposition <index> <x> <y> <z>', data: null };
    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid index ${args[0]}`, data: null };
    }
    const [x, y, z] = args.slice(1, 4).map(Number);
    if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
    grids[idx].position.set(x, y, z);
    return {
        text: `OK: grid #${idx} position = (${x}, ${y}, ${z})`,
        data: { index: idx, position: { x, y, z } }
    };
}, { description: 'Set grid position', usage: '<index> <x> <y> <z>' });

router.register('grid.setscale', (args, ctx) => {
    const grids = ctx.getGrids();
    if (args.length < 2) return { text: 'ERR: usage: grid.setscale <index> <scale>', data: null };
    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { text: `ERR: invalid index ${args[0]}`, data: null };
    }
    const scale = parseFloat(args[1]);
    if (isNaN(scale)) return { text: 'ERR: scale must be a number', data: null };
    grids[idx].scale.setScalar(scale);
    return {
        text: `OK: grid #${idx} scale = ${scale}`,
        data: { index: idx, scale }
    };
}, { description: 'Set grid scale', usage: '<index> <scale>' });
```

### 6.5 What Happens When You Type `grid.create "Hello"`

End-to-end flow:

1. **CLI** (`glyph-cli.mjs`): User types `grid.create "Hello"` at the `glyph>` prompt
2. **CLI** -> **Relay**: WebSocket sends raw string `grid.create "Hello"` to `ws://localhost:8765`
3. **Relay** (`ws-relay.mjs` line 111): Wraps as `{ from: "ctrl-0", cmd: "grid.create \"Hello\"" }`, sends to display WebSocket
4. **Browser** (`WebSocketBridge._handleMessage` line 339-340): Receives envelope, calls `this.router.execute('grid.create "Hello"')`
5. **CommandRouter.execute** (line 108): Parses tokens: `["grid.create", "Hello"]` (quotes stripped by parser, line 88)
6. **CommandRouter._run** -> calls `grid.create` handler with `args = ["Hello"]`, `ctx = {scene, atlas, getGrids, ...}`
7. **Handler**: Creates `new CodeGrid(ctx.scene, ctx.atlas, {...})`, calls `grid.loadText("Hello")`
   - Inside `loadText`: splits "Hello" into `["Hello"]` (1 line)
   - `_layoutContent`: calls `this._collection.addText("Hello", {x:0, y:0, z:0}, {color})` then `flush()`
   - `flush()` creates GlyphRenderer, builds 5 glyph instances (H, e, l, l, o), uploads to GPU
   - `_updateBackground`: creates background plane sized to "Hello" text bounds
   - `ctx.scene.add(grid)` makes it visible, `ctx.getGrids().push(grid)` adds to tracking
8. **Handler returns**: `{ text: "OK: created grid #0 (5 glyphs)", data: { index: 0, ... } }`
9. **WebSocketBridge** (line 343-352): Sends `{ to: "ctrl-0", response: "OK: created grid #0 (5 glyphs)", data: {...} }` back to relay
10. **Relay** (line 118-125): Forwards to controller `ctrl-0`
11. **CLI** (`CliConnection.send`): Resolves promise, prints `OK: created grid #0 (5 glyphs)`

The "Hello" text now appears as a 3D grid in the viewer at position (0, 0, 0) with green text on a dark background.

### 6.6 Follow-up commands to demonstrate full lifecycle

```
glyph> grid.create "Hello" greeting
OK: created grid #0 (5 glyphs)

glyph> grid.list
#  filename   glyphs  lines  position
-- --------   ------  -----  --------
0  greeting   5       1      0,0,0
OK: 1 grids

glyph> grid.setposition 0 50 20 0
OK: grid #0 position = (50, 20, 0)

glyph> grid.settext 0 "Hello\nWorld"
OK: grid #0 updated (10 glyphs)

glyph> grid.color 0 1 0.5 0
OK: grid 0 color set to (1, 0.5, 0)

glyph> grid.setscale 0 2
OK: grid #0 scale = 2

glyph> grid.remove 0
OK: removed grid #0

glyph> quit
```

### 6.7 Multiline text caveat

The CommandRouter parser handles quoted strings but does NOT handle `\n` escape sequences. The string `"Hello\nWorld"` arrives as the literal characters `H e l l o \ n W o r l d`, not with a real newline.

Two options:
- **Option A**: Add `\n` unescaping in the `grid.create` / `grid.settext` handlers:
  ```javascript
  const text = args[0].replace(/\\n/g, '\n');
  ```
- **Option B**: Add a `grid.loadfile` command that reads content from a URL or the grid.create handler accepts content via the structured data channel.

Option A is simpler and sufficient for the hello demo. Option B can come later for loading real files.


## 7. Summary of Files to Create/Modify

### New files (3):
| File | Purpose |
|------|---------|
| `examples/github-viewer/cli/glyph-cli.mjs` | CLI entry point, REPL loop |
| `examples/github-viewer/cli/CliConnection.mjs` | WebSocket client for relay |
| `package.json` | Add `"cli"` script |

### Modified files (1):
| File | Changes |
|------|---------|
| `examples/github-viewer/websocket/commands/gridCommands.js` | Add import for CodeGrid, register 5 new commands: grid.create, grid.remove, grid.settext, grid.setposition, grid.setscale |

### No changes needed:
- `ws-relay.mjs` -- protocol already supports this use case
- `CommandRouter.js` -- parser handles quoted strings correctly
- `WebSocketBridge.js` -- already routes commands and returns structured responses
- `commands/index.js` -- gridCommands already registered, new commands auto-included
- `CodeGrid.js`, `GlyphCollection.js` -- APIs already sufficient
