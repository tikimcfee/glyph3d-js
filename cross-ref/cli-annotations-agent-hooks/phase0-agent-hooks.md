# Phase 0: Agent Hooks — Implementation

Agent perspective: how Claude Code subagents can auto-send messages to the 3D viewer as pre/post action hooks, where each agent gets a visible 3D window that updates in real-time with its output.

---

## Architecture

```
Claude Code main process
  ├── AgentWindowManager (singleton, owns the CliConnection)
  │     ├── AgentWindow "protocol"   → grid #N in viewer
  │     ├── AgentWindow "transport"  → grid #N+1 in viewer
  │     └── AgentWindow "usability"  → grid #N+2 in viewer
  │
  │   (WebSocket via CliConnection → relay → browser)
  │
  └── agent-hook.mjs (CLI script, usable as Claude Code hook)
        reads stdin/args → creates or updates an AgentWindow
```

The key insight: each agent window is just a CodeGrid managed remotely via the existing WebSocket command protocol. No new server-side code is needed. The `AgentWindowManager` wraps `CliConnection` and assigns each agent a grid index.

### Design decisions

1. **Single CliConnection shared by all windows.** CliConnection has a single `_pendingResolve` slot (one in-flight command at a time), so the manager serializes all sends through a queue. This is fine for agent hooks -- they're not high-frequency.

2. **Grid index tracking by name.** The viewer assigns grid indices on creation. When a grid is removed, higher indices shift down. To avoid index corruption, each `AgentWindow` tracks its grid name and the manager maintains a name-to-index map. On removal, the map is rebuilt via `grid.list`.

3. **Auto-positioning.** New windows are placed in a horizontal row, spaced 100 units apart on the X axis. This is a sensible default for agent panels. The caller can override with `setPosition()`.

4. **Content truncation.** Agent output can be very long. The `write()` method accepts a `maxLines` option (default 80) to keep grids readable. Excess lines are truncated from the top (newest content at bottom, like a terminal).

---

## File 1: `AgentWindow.mjs`

Location: `examples/github-viewer/cli/AgentWindow.mjs`

```javascript
/**
 * AgentWindow — a single agent's 3D text panel in the viewer.
 *
 * Wraps a remote CodeGrid managed via WebSocket commands.
 * Created by AgentWindowManager; do not instantiate directly.
 */

export default class AgentWindow {
    /**
     * @param {Object} options
     * @param {string} options.label - agent identifier (e.g. "protocol")
     * @param {number} options.gridIndex - assigned grid index in the viewer
     * @param {Function} options.sendCommand - async (cmd) => result, provided by manager
     * @param {Function} options.onClose - callback to notify manager of removal
     */
    constructor({ label, gridIndex, sendCommand, onClose }) {
        this.label = label;
        this.gridIndex = gridIndex;
        this._send = sendCommand;
        this._onClose = onClose;
        this._closed = false;
        this._lines = [];
        this._maxLines = 80;
    }

    /**
     * Replace the grid's entire text content.
     * @param {string} text - raw text (will be base64-encoded for transport)
     * @returns {Promise<{text: string, data: any}>}
     */
    async write(text) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        const b64 = Buffer.from(text).toString('base64');
        return this._send(`grid.text ${this.gridIndex} ${b64}`);
    }

    /**
     * Append text to the window, keeping only the last maxLines lines.
     * This is the primary method for streaming agent output.
     * @param {string} text - text to append (can be multi-line)
     * @param {Object} [options]
     * @param {number} [options.maxLines=80] - max lines to retain
     * @returns {Promise<{text: string, data: any}>}
     */
    async append(text, { maxLines } = {}) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        const limit = maxLines || this._maxLines;
        const newLines = text.split('\n');
        this._lines.push(...newLines);
        if (this._lines.length > limit) {
            this._lines = this._lines.slice(-limit);
        }
        return this.write(this._lines.join('\n'));
    }

    /**
     * Clear all content from the window.
     * @returns {Promise<{text: string, data: any}>}
     */
    async clear() {
        this._lines = [];
        return this.write('');
    }

    /**
     * Set the grid's display name (shown as filename label).
     * Implemented by removing and re-creating the grid with the new name,
     * since grid.create is the only way to set the filename label.
     *
     * Note: for simplicity, this just writes a header line. The grid name
     * is set at creation time via AgentWindowManager.createWindow().
     * @param {string} name
     * @returns {Promise<void>}
     */
    async setTitle(name) {
        // Prepend title as first line in content. The grid's actual filename
        // was set at creation time. This updates the visible header.
        if (this._lines.length > 0 && this._lines[0].startsWith('=== ')) {
            this._lines[0] = `=== ${name} ===`;
        } else {
            this._lines.unshift(`=== ${name} ===`);
        }
        return this.write(this._lines.join('\n'));
    }

    /**
     * Set the grid's text color.
     * @param {number} r - red (0-1)
     * @param {number} g - green (0-1)
     * @param {number} b - blue (0-1)
     * @returns {Promise<{text: string, data: any}>}
     */
    async setColor(r, g, b) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.color ${this.gridIndex} ${r} ${g} ${b}`);
    }

    /**
     * Set the grid's world position.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Promise<{text: string, data: any}>}
     */
    async setPosition(x, y, z) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.position ${this.gridIndex} ${x} ${y} ${z}`);
    }

    /**
     * Set the grid's uniform scale.
     * @param {number} factor
     * @returns {Promise<{text: string, data: any}>}
     */
    async setScale(factor) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.scale ${this.gridIndex} ${factor}`);
    }

    /**
     * Remove this grid from the viewer and mark the window as closed.
     * @returns {Promise<{text: string, data: any}>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        const result = await this._send(`grid.remove ${this.gridIndex}`);
        this._onClose(this.label);
        return result;
    }

    /** @returns {boolean} */
    get isClosed() {
        return this._closed;
    }
}
```

---

## File 2: `AgentWindowManager.mjs`

Location: `examples/github-viewer/cli/AgentWindowManager.mjs`

```javascript
/**
 * AgentWindowManager — manages multiple AgentWindows over a single CliConnection.
 *
 * Handles:
 * - Connection lifecycle (connect once, share across all windows)
 * - Command serialization (CliConnection supports one in-flight command)
 * - Grid index tracking (indices shift on removal)
 * - Auto-positioning of new windows in a horizontal row
 *
 * Usage:
 *   const mgr = new AgentWindowManager('ws://localhost:8765');
 *   await mgr.connect();
 *   const win = await mgr.createWindow('protocol');
 *   await win.write('Hello from protocol agent');
 *   await win.setColor(0.3, 1.0, 0.5);
 *   await win.close();
 *   await mgr.closeAll();
 */

import CliConnection from './CliConnection.mjs';
import AgentWindow from './AgentWindow.mjs';

export default class AgentWindowManager {
    /**
     * @param {string} [url='ws://localhost:8765'] - WebSocket relay URL
     * @param {Object} [options]
     * @param {number} [options.spacing=100] - X-axis spacing between windows
     * @param {number} [options.baseX=0] - starting X position for first window
     * @param {number} [options.baseY=0] - Y position for all windows
     * @param {number} [options.baseZ=0] - Z position for all windows
     */
    constructor(url = 'ws://localhost:8765', options = {}) {
        this._url = url;
        this._conn = new CliConnection(url);
        this._connected = false;

        /** @type {Map<string, AgentWindow>} label → AgentWindow */
        this._windows = new Map();

        /** @type {Map<string, number>} label → grid index */
        this._indexMap = new Map();

        // Layout config
        this._spacing = options.spacing || 100;
        this._baseX = options.baseX || 0;
        this._baseY = options.baseY || 0;
        this._baseZ = options.baseZ || 0;
        this._nextSlot = 0;

        // Command queue for serialization
        this._queue = [];
        this._processing = false;
    }

    /**
     * Connect to the relay server.
     * @returns {Promise<string>} registration ack
     */
    async connect() {
        if (this._connected) return 'already connected';
        const ack = await this._conn.connect();
        this._connected = true;
        return ack;
    }

    /**
     * Create a new agent window in the viewer.
     * @param {string} label - unique agent identifier
     * @param {Object} [options]
     * @param {string} [options.initialText=''] - text to show on creation
     * @param {{r: number, g: number, b: number}} [options.color] - initial color
     * @param {{x: number, y: number, z: number}} [options.position] - override auto-position
     * @returns {Promise<AgentWindow>}
     */
    async createWindow(label, options = {}) {
        if (this._windows.has(label)) {
            return this._windows.get(label);
        }

        const initialText = options.initialText || `[${label}] ready`;
        const b64 = Buffer.from(initialText).toString('base64');
        const gridName = `agent:${label}`;

        // Create the grid in the viewer
        const result = await this._enqueue(`grid.create ${b64} ${gridName}`);
        const match = result.text.match(/grid #(\d+)/);
        if (!match) {
            throw new Error(`Failed to create grid for "${label}": ${result.text}`);
        }
        const gridIndex = parseInt(match[1]);

        this._indexMap.set(label, gridIndex);

        const window = new AgentWindow({
            label,
            gridIndex,
            sendCommand: (cmd) => this._enqueue(cmd),
            onClose: (lbl) => this._handleWindowClose(lbl),
        });
        this._windows.set(label, window);

        // Auto-position unless overridden
        const pos = options.position || {
            x: this._baseX + (this._nextSlot * this._spacing),
            y: this._baseY,
            z: this._baseZ,
        };
        this._nextSlot++;
        await window.setPosition(pos.x, pos.y, pos.z);

        // Set initial color if provided
        if (options.color) {
            await window.setColor(options.color.r, options.color.g, options.color.b);
        }

        return window;
    }

    /**
     * Get an existing window by label.
     * @param {string} label
     * @returns {AgentWindow|null}
     */
    getWindow(label) {
        return this._windows.get(label) || null;
    }

    /**
     * Get or create a window. Idempotent.
     * @param {string} label
     * @param {Object} [options] - same as createWindow options
     * @returns {Promise<AgentWindow>}
     */
    async ensureWindow(label, options = {}) {
        if (this._windows.has(label)) {
            return this._windows.get(label);
        }
        return this.createWindow(label, options);
    }

    /**
     * Close and remove all agent windows from the viewer.
     * Removes in reverse order to avoid index shifting issues.
     */
    async closeAll() {
        // Collect labels and their current indices
        const entries = [...this._indexMap.entries()]
            .sort((a, b) => b[1] - a[1]); // highest index first

        for (const [label, _idx] of entries) {
            const win = this._windows.get(label);
            if (win && !win.isClosed) {
                // Re-resolve current index before removal (indices may have shifted)
                await this._refreshIndices();
                const currentIdx = this._indexMap.get(label);
                if (currentIdx !== undefined) {
                    win.gridIndex = currentIdx;
                    await win.close();
                }
            }
        }

        this._windows.clear();
        this._indexMap.clear();
        this._nextSlot = 0;
    }

    /**
     * Disconnect from the relay. Optionally close all windows first.
     * @param {Object} [options]
     * @param {boolean} [options.cleanup=true] - remove grids before disconnecting
     */
    async disconnect({ cleanup = true } = {}) {
        if (cleanup && this._windows.size > 0) {
            await this.closeAll();
        }
        this._conn.close();
        this._connected = false;
    }

    /** @returns {number} number of active windows */
    get count() {
        return this._windows.size;
    }

    /** @returns {string[]} labels of all active windows */
    get labels() {
        return [...this._windows.keys()];
    }

    // ============ Internal ============

    /**
     * Enqueue a command for serialized sending.
     * CliConnection supports only one pending response at a time,
     * so we queue commands and process them sequentially.
     * @param {string} cmd
     * @returns {Promise<{text: string, data: any}>}
     * @private
     */
    _enqueue(cmd) {
        return new Promise((resolve, reject) => {
            this._queue.push({ cmd, resolve, reject });
            this._processQueue();
        });
    }

    /** @private */
    async _processQueue() {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            const { cmd, resolve, reject } = this._queue.shift();
            try {
                const result = await this._conn.send(cmd);
                resolve(result);
            } catch (err) {
                reject(err);
            }
        }

        this._processing = false;
    }

    /**
     * Refresh grid index map by querying the viewer.
     * Necessary after removals since indices shift.
     * @private
     */
    async _refreshIndices() {
        const result = await this._enqueue('grid.list');
        if (!result.data || !result.data.grids) return;

        this._indexMap.clear();
        for (const grid of result.data.grids) {
            const name = grid.filename || grid.name || '';
            // Match our naming convention: "agent:<label>"
            if (name.startsWith('agent:')) {
                const label = name.slice(6);
                this._indexMap.set(label, grid.index);
                // Update the AgentWindow's gridIndex too
                const win = this._windows.get(label);
                if (win) win.gridIndex = grid.index;
            }
        }
    }

    /**
     * Handle a window closing: remove from maps.
     * @param {string} label
     * @private
     */
    _handleWindowClose(label) {
        this._windows.delete(label);
        this._indexMap.delete(label);
    }
}
```

---

## File 3: `agent-hook.mjs`

Location: `examples/github-viewer/cli/agent-hook.mjs`

This is a standalone CLI script designed to be called as a Claude Code hook or from any shell process. It connects, sends a single update, and disconnects.

```javascript
#!/usr/bin/env node
/**
 * agent-hook.mjs — CLI hook for pushing agent output to the 3D viewer.
 *
 * Usage:
 *   # One-shot text update
 *   node agent-hook.mjs --agent "protocol" --text "Phase 0 complete"
 *
 *   # Pipe stdin as content
 *   echo "analysis results here" | node agent-hook.mjs --agent "protocol"
 *
 *   # Set color alongside text
 *   node agent-hook.mjs --agent "protocol" --text "DONE" --color "0.3,1.0,0.5"
 *
 *   # Read from file
 *   node agent-hook.mjs --agent "transport" --file ./analysis.md
 *
 *   # Close a window
 *   node agent-hook.mjs --agent "protocol" --close
 *
 *   # Close all agent windows
 *   node agent-hook.mjs --close-all
 *
 * Flags:
 *   --agent <label>    Agent identifier (required unless --close-all)
 *   --text <string>    Text content to display
 *   --file <path>      Read content from file
 *   --color <r,g,b>    Set text color (0-1 floats, comma-separated)
 *   --position <x,y,z> Set grid position
 *   --append           Append to existing content instead of replacing
 *   --close            Close this agent's window
 *   --close-all        Close all agent windows
 *   --host <url>       WebSocket relay URL (default ws://localhost:8765)
 *   --port <n>         Shorthand for ws://localhost:<n>
 *   --max-lines <n>    Max lines to retain when appending (default 80)
 *
 * Environment:
 *   GLYPH_WS_URL       Default WebSocket URL (overridden by --host/--port)
 */

import { readFileSync } from 'fs';
import { stdin } from 'process';
import AgentWindowManager from './AgentWindowManager.mjs';

// ---- Parse arguments ----
const argv = process.argv.slice(2);
const opts = {
    agent: null,
    text: null,
    file: null,
    color: null,
    position: null,
    append: false,
    close: false,
    closeAll: false,
    host: process.env.GLYPH_WS_URL || 'ws://localhost:8765',
    maxLines: 80,
};

for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
        case '--agent': opts.agent = argv[++i]; break;
        case '--text': opts.text = argv[++i]; break;
        case '--file': opts.file = argv[++i]; break;
        case '--color': opts.color = argv[++i]; break;
        case '--position': opts.position = argv[++i]; break;
        case '--append': opts.append = true; break;
        case '--close': opts.close = true; break;
        case '--close-all': opts.closeAll = true; break;
        case '--host': opts.host = argv[++i]; break;
        case '--port': opts.host = `ws://localhost:${argv[++i]}`; break;
        case '--max-lines': opts.maxLines = parseInt(argv[++i]); break;
        case '--help':
            console.log(`agent-hook.mjs — push agent output to 3D viewer

  --agent <label>      Agent identifier (required)
  --text <string>      Text content to display
  --file <path>        Read content from file
  --color <r,g,b>      Set text color (0-1 floats)
  --position <x,y,z>   Set grid position
  --append             Append instead of replace
  --close              Close this agent's window
  --close-all          Close all agent windows
  --host <url>         WebSocket URL (default ws://localhost:8765)
  --port <n>           Shorthand for ws://localhost:<n>
  --max-lines <n>      Max lines when appending (default 80)`);
            process.exit(0);
    }
}

// ---- Validate ----
if (!opts.closeAll && !opts.agent) {
    console.error('Error: --agent <label> is required (or use --close-all)');
    process.exit(1);
}

// ---- Read content from sources ----
async function getContent() {
    // Explicit --text flag
    if (opts.text) return opts.text;

    // File
    if (opts.file) {
        try {
            return readFileSync(opts.file, 'utf-8');
        } catch (err) {
            console.error(`Error reading file: ${err.message}`);
            process.exit(1);
        }
    }

    // Stdin (only if piped, not TTY)
    if (!stdin.isTTY) {
        return new Promise((resolve) => {
            let data = '';
            stdin.on('data', (chunk) => { data += chunk; });
            stdin.on('end', () => resolve(data));
        });
    }

    return null;
}

// ---- Main ----
async function main() {
    const mgr = new AgentWindowManager(opts.host);

    try {
        process.stderr.write(`Connecting to ${opts.host}...\n`);
        await mgr.connect();
        process.stderr.write('Connected.\n');
    } catch (err) {
        console.error(`Failed to connect: ${err.message}`);
        console.error('Ensure relay is running (npm run ws) and viewer is open.');
        process.exit(2);
    }

    try {
        // Close all windows
        if (opts.closeAll) {
            await mgr.closeAll();
            process.stderr.write('All agent windows closed.\n');
            await mgr.disconnect({ cleanup: false });
            process.exit(0);
        }

        // Get or create the window
        const win = await mgr.ensureWindow(opts.agent);

        // Close single window
        if (opts.close) {
            await win.close();
            process.stderr.write(`Window "${opts.agent}" closed.\n`);
            await mgr.disconnect({ cleanup: false });
            process.exit(0);
        }

        // Get content
        const content = await getContent();
        if (content !== null) {
            if (opts.append) {
                await win.append(content, { maxLines: opts.maxLines });
            } else {
                await win.write(content);
            }
            process.stderr.write(`Content sent to "${opts.agent}" (${content.length} chars).\n`);
        }

        // Set color
        if (opts.color) {
            const [r, g, b] = opts.color.split(',').map(Number);
            await win.setColor(r, g, b);
        }

        // Set position
        if (opts.position) {
            const [x, y, z] = opts.position.split(',').map(Number);
            await win.setPosition(x, y, z);
        }

        // Disconnect without cleanup (leave grids in the viewer)
        await mgr.disconnect({ cleanup: false });
        process.exit(0);

    } catch (err) {
        console.error(`Error: ${err.message}`);
        await mgr.disconnect({ cleanup: false });
        process.exit(1);
    }
}

main();
```

---

## Critical Implementation Detail: Stateless Reconnection

The `agent-hook.mjs` script is **stateless** — it connects, sends, disconnects. Each invocation is independent. This means:

1. **First call** with `--agent "protocol"` creates a new grid (`grid.create`).
2. **Second call** with `--agent "protocol"` needs to find the existing grid.

The `ensureWindow()` method calls `createWindow()`, which calls `grid.create`. But if the grid already exists from a prior hook invocation, we get a duplicate.

The fix: `ensureWindow()` first queries `grid.list` to check if a grid named `agent:<label>` already exists. Here's the refined version of `ensureWindow`:

```javascript
    /**
     * Get or create a window. Queries the viewer first to find existing grids
     * from prior hook invocations (handles stateless reconnection).
     * @param {string} label
     * @param {Object} [options] - same as createWindow options
     * @returns {Promise<AgentWindow>}
     */
    async ensureWindow(label, options = {}) {
        // Check in-memory cache first
        if (this._windows.has(label)) {
            return this._windows.get(label);
        }

        // Query the viewer for an existing grid with this agent label
        const gridName = `agent:${label}`;
        const listResult = await this._enqueue('grid.list');
        if (listResult.data && listResult.data.grids) {
            for (const grid of listResult.data.grids) {
                const name = grid.filename || grid.sourcePath || '';
                if (name === gridName) {
                    // Found existing grid — wrap it in an AgentWindow
                    const window = new AgentWindow({
                        label,
                        gridIndex: grid.index,
                        sendCommand: (cmd) => this._enqueue(cmd),
                        onClose: (lbl) => this._handleWindowClose(lbl),
                    });
                    this._windows.set(label, window);
                    this._indexMap.set(label, grid.index);
                    return window;
                }
            }
        }

        // No existing grid — create a new one
        return this.createWindow(label, options);
    }
```

This is essential for the hook script pattern where each invocation is a fresh process.

---

## Example Usage: 3 Agents Creating Windows

### Scenario: Cross-ref analysis with 3 perspective agents

```javascript
#!/usr/bin/env node
/**
 * example-three-agents.mjs — demonstrates 3 agents with live 3D windows.
 */
import AgentWindowManager from './AgentWindowManager.mjs';

const AGENT_COLORS = {
    protocol:  { r: 0.3, g: 0.8, b: 1.0 },  // cyan
    transport: { r: 1.0, g: 0.6, b: 0.2 },  // orange
    usability: { r: 0.5, g: 1.0, b: 0.4 },  // green
};

async function main() {
    const mgr = new AgentWindowManager('ws://localhost:8765', {
        spacing: 120,  // 120 units apart
        baseX: -120,   // center the 3 windows around origin
        baseY: 50,     // above existing grids
    });

    await mgr.connect();
    console.log('Connected to viewer.');

    // Phase 0: Create windows for all 3 agents
    const protocol = await mgr.createWindow('protocol', {
        initialText: '[protocol] Analyzing wire format...',
        color: AGENT_COLORS.protocol,
    });

    const transport = await mgr.createWindow('transport', {
        initialText: '[transport] Analyzing connection layer...',
        color: AGENT_COLORS.transport,
    });

    const usability = await mgr.createWindow('usability', {
        initialText: '[usability] Analyzing developer ergonomics...',
        color: AGENT_COLORS.usability,
    });

    console.log('3 agent windows created.');

    // Simulate Phase 0 work: each agent appends output progressively
    await protocol.append('Examining command structure...');
    await protocol.append('Found: dot-separated namespaces (grid.create, camera.move)');
    await protocol.append('Base64 encoding for text content — prevents injection');
    await protocol.append('Single pending-resolve slot limits throughput');
    await protocol.append('');
    await protocol.append('VERDICT: Protocol is clean but needs batch optimization');

    await transport.append('WebSocket via ws:// — no TLS in dev');
    await transport.append('Relay architecture: controller → relay → display');
    await transport.append('Auto-reconnect with exponential backoff (browser side)');
    await transport.append('CLI side: no reconnect, fire-and-forget');
    await transport.append('');
    await transport.append('VERDICT: Transport is solid, CLI needs retry logic');

    await usability.append('CLI modes: one-shot, REPL, pipe — good coverage');
    await usability.append('Error messages include "Ensure relay is running" — helpful');
    await usability.append('No --quiet flag for scripting use cases');
    await usability.append('Base64 encoding is invisible to user — nice');
    await usability.append('');
    await usability.append('VERDICT: Good DX, needs --quiet and --timeout flags');

    console.log('Phase 0 complete. Windows updated with analysis.');

    // Phase 1: Cross-reference — update windows with review status
    await protocol.setTitle('protocol — reviewing transport, usability');
    await protocol.setColor(0.8, 0.8, 0.3); // yellow during review

    await transport.setTitle('transport — reviewing protocol, usability');
    await transport.setColor(0.8, 0.8, 0.3);

    await usability.setTitle('usability — reviewing protocol, transport');
    await usability.setColor(0.8, 0.8, 0.3);

    // ... review output would be appended here ...

    // After review completes, restore colors
    await protocol.setColor(AGENT_COLORS.protocol.r, AGENT_COLORS.protocol.g, AGENT_COLORS.protocol.b);
    await transport.setColor(AGENT_COLORS.transport.r, AGENT_COLORS.transport.g, AGENT_COLORS.transport.b);
    await usability.setColor(AGENT_COLORS.usability.r, AGENT_COLORS.usability.g, AGENT_COLORS.usability.b);

    console.log('Phase 1 cross-reference complete.');

    // Leave windows in viewer for inspection (don't clean up)
    await mgr.disconnect({ cleanup: false });
    console.log('Disconnected. Windows remain in viewer.');
}

main().catch(console.error);
```

### Using the hook script from shell (e.g., Claude Code hooks)

```bash
# Create/update windows from separate processes (stateless)
node agent-hook.mjs --agent "protocol" --text "Phase 0: Analyzing wire format..."
node agent-hook.mjs --agent "transport" --text "Phase 0: Analyzing connection layer..."
node agent-hook.mjs --agent "usability" --text "Phase 0: Analyzing ergonomics..."

# Pipe file analysis output
cat analysis-results.md | node agent-hook.mjs --agent "protocol" --append

# Color change to indicate phase transition
node agent-hook.mjs --agent "protocol" --color "0.8,0.8,0.3" --text "Phase 1: Cross-referencing..."

# Read a file into the window
node agent-hook.mjs --agent "transport" --file ./round1-transport.md

# Clean up
node agent-hook.mjs --close-all
```

---

## Wiring into the Cross-Ref Skill

The cross-ref skill (`.claude/skills/cross-ref/SKILL.md`) launches parallel subagents for Phase 0/1/2. Each agent can get a 3D window by using agent-hook.mjs as a pre/post hook.

### Option A: Hooks in settings.json

Claude Code supports hooks that run before/after agent actions. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent",
        "command": "node /path/to/agent-hook.mjs --agent \"$AGENT_LABEL\" --text \"Starting: $TOOL_NAME\" --color \"0.8,0.8,0.3\" --append"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Agent",
        "command": "node /path/to/agent-hook.mjs --agent \"$AGENT_LABEL\" --text \"Done: $TOOL_NAME\" --color \"0.3,1.0,0.5\" --append"
      }
    ]
  }
}
```

### Option B: Direct integration in the cross-ref skill orchestrator

The more practical approach: the orchestrating agent (which launches subagents) creates windows and updates them directly. Since the orchestrator runs in Node.js, it can import AgentWindowManager:

```javascript
// In the cross-ref orchestrator (the agent running the skill)
import AgentWindowManager from './examples/github-viewer/cli/AgentWindowManager.mjs';

// At the start of cross-ref
const viewer = new AgentWindowManager('ws://localhost:8765', {
    spacing: 120,
    baseX: -120,
    baseY: 80,  // above existing code grids
});
await viewer.connect();

// Phase 0: create a window per agent
const agentLabels = ['protocol', 'transport', 'usability'];
const PHASE_COLORS = {
    working: { r: 0.8, g: 0.8, b: 0.3 },   // yellow
    done:    { r: 0.3, g: 1.0, b: 0.5 },    // green
    review:  { r: 0.6, g: 0.4, b: 1.0 },    // purple
};

for (const label of agentLabels) {
    await viewer.createWindow(label, {
        initialText: `[${label}] Phase 0: analyzing...`,
        color: PHASE_COLORS.working,
    });
}

// After each subagent completes Phase 0, update its window:
async function onPhase0Complete(label, outputFilePath) {
    const win = viewer.getWindow(label);
    const content = readFileSync(outputFilePath, 'utf-8');
    // Show a summary (first 60 lines) in the 3D window
    const summary = content.split('\n').slice(0, 60).join('\n');
    await win.write(`=== ${label}: Phase 0 Complete ===\n\n${summary}`);
    await win.setColor(PHASE_COLORS.done.r, PHASE_COLORS.done.g, PHASE_COLORS.done.b);
}

// Phase 1: change windows to "review" color
async function onPhase1Start(label, reviewTargets) {
    const win = viewer.getWindow(label);
    await win.setColor(PHASE_COLORS.review.r, PHASE_COLORS.review.g, PHASE_COLORS.review.b);
    await win.write(`=== ${label}: Phase 1 ===\nReviewing: ${reviewTargets.join(', ')}\n\nWorking...`);
}

// Phase 1 complete: show cross-ref findings
async function onPhase1Complete(label, outputFilePath) {
    const win = viewer.getWindow(label);
    const content = readFileSync(outputFilePath, 'utf-8');
    const summary = content.split('\n').slice(0, 60).join('\n');
    await win.write(`=== ${label}: Phase 1 Done ===\n\n${summary}`);
    await win.setColor(PHASE_COLORS.done.r, PHASE_COLORS.done.g, PHASE_COLORS.done.b);
}

// Phase 2: inverse cross-reference
async function onPhase2Start(label, reviewTargets) {
    const win = viewer.getWindow(label);
    await win.setColor(PHASE_COLORS.review.r, PHASE_COLORS.review.g, PHASE_COLORS.review.b);
    await win.write(`=== ${label}: Phase 2 (inverse) ===\nReviewing: ${reviewTargets.join(', ')}\n\nWorking...`);
}
```

### Option C: Shell-level hooks (simplest, works today)

Each subagent's prompt includes a preamble that runs the hook script:

```
You are agent "protocol". Before writing your analysis file, run:
  node examples/github-viewer/cli/agent-hook.mjs --agent "protocol" --text "Phase 0: Working on analysis..." --color "0.8,0.8,0.3"

After writing your analysis file, run:
  cat cross-ref/websocket-cli/phase0-protocol.md | node examples/github-viewer/cli/agent-hook.mjs --agent "protocol" --append --max-lines 60
  node examples/github-viewer/cli/agent-hook.mjs --agent "protocol" --color "0.3,1.0,0.5"
```

This works with zero code changes to the skill. The subagent executes the hook via Bash tool calls as part of its normal flow.

---

## Sequence Diagram: Hook Script Lifecycle

```
agent-hook.mjs                AgentWindowManager        CliConnection        Relay        Browser
      |                              |                       |                  |            |
      |-- new AgentWindowManager --->|                       |                  |            |
      |                              |-- new CliConnection ->|                  |            |
      |-- connect() --------------->|-- connect() --------->|== ws open ==>    |            |
      |                              |                       |-- "ping" ------->|            |
      |                              |                       |<-- ack+pong -----|            |
      |<-- "connected" -------------|                       |                  |            |
      |                              |                       |                  |            |
      |-- ensureWindow("proto") --->|                       |                  |            |
      |                              |-- grid.list -------->|-- send --------->|-- fwd ---->|
      |                              |                       |<-- response -----|<-- resp ---|
      |                              | (no match found)      |                  |            |
      |                              |-- grid.create b64 -->|-- send --------->|-- fwd ---->|
      |                              |                       |                  |            |-- creates
      |                              |                       |<-- "OK: #3" -----|<-- resp ---|   CodeGrid
      |                              |-- grid.position ---->|-- send --------->|-- fwd ---->|-- sets pos
      |<-- AgentWindow -------------|                       |                  |            |
      |                              |                       |                  |            |
      |-- win.write("hello") ------>|                       |                  |            |
      |                              |-- grid.text 3 b64 -->|-- send --------->|-- fwd ---->|-- updates
      |<-- OK ----------------------|                       |                  |            |   text
      |                              |                       |                  |            |
      |-- disconnect(cleanup:false) |                       |                  |            |
      |                              |-- close() ---------->|== ws close ==    |            |
      |                              |                       |                  |            |
      | (grid #3 remains in viewer — next invocation finds it via grid.list)   |            |
```

---

## Error Handling

The implementation handles these failure modes:

1. **Relay not running**: `connect()` throws, script exits with code 2 and a helpful message.
2. **Viewer not open**: `grid.create` returns an error response (relay has no display client). The script exits with code 1.
3. **Grid index shifted**: `ensureWindow()` queries `grid.list` each time, so it finds the current index.
4. **Concurrent hook invocations**: The command queue serializes sends. Two hooks running simultaneously would each have their own CliConnection and command queue, so they won't corrupt each other's in-flight state. However, they may both try to create the same grid. The second `grid.create` would create a duplicate. To prevent this, `ensureWindow()` always checks `grid.list` first. There's still a race window, but for the agent hook use case (sequential phase transitions), this is acceptable.
5. **Large content**: The base64 encoding inflates content by ~33%. WebSocket frame size limits vary by relay implementation, but the Python relay used here has no explicit limit. For safety, `append()` caps at `maxLines` (default 80).

---

## Files to Create

| File | Path | Purpose |
|------|------|---------|
| `AgentWindow.mjs` | `examples/github-viewer/cli/AgentWindow.mjs` | Single agent's 3D panel |
| `AgentWindowManager.mjs` | `examples/github-viewer/cli/AgentWindowManager.mjs` | Multi-window manager with command queue |
| `agent-hook.mjs` | `examples/github-viewer/cli/agent-hook.mjs` | CLI hook script for shell/hook use |

All three files import from the existing `cli/` directory (`CliConnection.mjs`). No modifications to existing files are needed.
