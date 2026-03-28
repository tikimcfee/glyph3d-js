# Phase 0 -- Display Agent: TUIWindow System (Modernized)

Agent perspective: buffer model, streaming, scroll, rendering in CodeGrid, API alignment.

## Key Findings from Source Review

1. **CodeGrid constructor**: `new CodeGrid(scene, atlas, options)` -- unchanged from original TUIWindow usage. The original code is compatible.
2. **Rendering call**: Original uses `grid.loadFile(title, content)` which calls `loadText()` internally. This is correct -- `loadFile` sets the filename label, `loadText` just renders text. For TUIWindow, `loadFile` is right because we want the title bar.
3. **Base64 pattern**: `gridCommands.js` uses `atob(args[N])` for content decoding. Window commands must follow the same pattern.
4. **Context bag**: `ctx.windowManager` slot exists but is null. We populate it during command registration.
5. **AgentWindow (CLI-side)** rebuilds full text via `grid.text` on every append. The browser-side TUIWindow should be smarter -- dirty flag avoids redundant `loadFile` calls when nothing changed.

## File 1: `TUIWindow.js`

Location: `examples/github-viewer/websocket/TUIWindow.js`

```javascript
/**
 * TUIWindow -- browser-side terminal pane backed by a CodeGrid.
 *
 * Buffer model: fixed cols x rows grid. Supports write (replace all),
 * appendLine (scroll), clear, resize, cursor tracking, scroll offset,
 * and dirty-flag rendering to avoid redundant GPU uploads.
 */

import CodeGrid from '../../../src/collections/CodeGrid.js';

export default class TUIWindow {
    /**
     * @param {string} id - unique window identifier
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} [options]
     * @param {number} [options.cols=80]
     * @param {number} [options.rows=24]
     * @param {Object} [options.position]
     * @param {Object} [options.color]
     * @param {string} [options.title]
     */
    constructor(id, scene, atlas, options = {}) {
        this.id = id;
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this.scene = scene;
        this.atlas = atlas;
        this.title = options.title || id;

        // -- Line buffer (visible window is buffer.slice(scrollOffset, scrollOffset + rows))
        /** @type {string[]} full history buffer */
        this._history = [];
        /** @type {number} lines scrolled back from bottom (0 = latest) */
        this.scrollOffset = 0;

        // -- Cursor (row/col relative to visible window, for future input)
        this.cursorRow = 0;
        this.cursorCol = 0;

        // -- Dirty tracking
        this._dirty = true;
        this._lastRenderedContent = '';

        // -- CodeGrid
        this.grid = new CodeGrid(scene, atlas, {
            name: `tui-${id}`,
            showFilename: true,
            filenameColor: { r: 0.8, g: 0.8, b: 0.2 },
            textColor: options.color || { r: 0, g: 1, b: 0 },
            backgroundColor: 0x0a0a1e,
            backgroundOpacity: 0.92,
        });

        if (options.position) {
            this.grid.position.set(
                options.position.x || 0,
                options.position.y || 0,
                options.position.z || 0,
            );
        }

        scene.add(this.grid);
        this._pushBlankLines(this.rows);
        this._render();
    }

    // ============ Buffer Writes ============

    /**
     * Replace full content. Long lines are wrapped to cols.
     * @param {string} text
     */
    write(text) {
        this._history = [];
        const rawLines = text.split('\n');
        for (const line of rawLines) {
            this._pushWrapped(line);
        }
        this._padToRows();
        this.scrollOffset = 0;
        this.cursorRow = Math.min(this._history.length, this.rows) - 1;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    /**
     * Append a line (or multi-line text), scrolling if buffer exceeds rows.
     * @param {string} text
     */
    appendLine(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            this._pushWrapped(line);
        }
        // Auto-scroll to bottom when appending
        this.scrollOffset = 0;
        this.cursorRow = this.rows - 1;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    /** Clear all content. */
    clear() {
        this._history = [];
        this._pushBlankLines(this.rows);
        this.scrollOffset = 0;
        this.cursorRow = 0;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    // ============ Geometry ============

    /**
     * Resize the visible window.
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        // Re-wrap entire history at new col width
        const oldText = this._history.join('\n');
        this._history = [];
        for (const line of oldText.split('\n')) {
            this._pushWrapped(line);
        }
        this._padToRows();
        this.scrollOffset = 0;
        this._dirty = true;
        this._render();
    }

    /**
     * Set 3D position.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setPosition(x, y, z) {
        this.grid.position.set(x, y, z);
    }

    /** @returns {{x:number, y:number, z:number}} */
    getPosition() {
        const p = this.grid.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Set title (re-renders). */
    setTitle(title) {
        this.title = title;
        this._dirty = true;
        this._render();
    }

    // ============ Scroll ============

    /** Scroll up by n lines (into history). */
    scrollUp(n = 1) {
        const maxOffset = Math.max(0, this._history.length - this.rows);
        this.scrollOffset = Math.min(this.scrollOffset + n, maxOffset);
        this._dirty = true;
        this._render();
    }

    /** Scroll down by n lines (toward latest). */
    scrollDown(n = 1) {
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
        this._dirty = true;
        this._render();
    }

    /** Scroll to bottom (latest output). */
    scrollToBottom() {
        this.scrollOffset = 0;
        this._dirty = true;
        this._render();
    }

    // ============ Queries ============

    /** @returns {number} total history lines */
    get historyLength() { return this._history.length; }

    /** @returns {string[]} currently visible lines */
    getVisibleLines() {
        const end = this._history.length - this.scrollOffset;
        const start = Math.max(0, end - this.rows);
        return this._history.slice(start, end);
    }

    // ============ Private ============

    /** Wrap a single line to cols and push to history. */
    _pushWrapped(line) {
        if (line.length <= this.cols) {
            this._history.push(line);
        } else {
            for (let i = 0; i < line.length; i += this.cols) {
                this._history.push(line.slice(i, i + this.cols));
            }
        }
    }

    /** Pad history so it has at least this.rows entries. */
    _padToRows() {
        while (this._history.length < this.rows) {
            this._history.push('');
        }
    }

    /** Push n blank lines. */
    _pushBlankLines(n) {
        for (let i = 0; i < n; i++) this._history.push('');
    }

    /** Render visible slice to CodeGrid (skips if not dirty). */
    _render() {
        if (!this._dirty) return;
        const content = this.getVisibleLines().join('\n');
        if (content === this._lastRenderedContent) {
            this._dirty = false;
            return;
        }
        this.grid.loadFile(`[${this.title}]`, content);
        this._lastRenderedContent = content;
        this._dirty = false;
    }

    /** Dispose grid and remove from scene. */
    dispose() {
        this.scene.remove(this.grid);
        this.grid.dispose();
        this.grid = null;
    }
}
```

### Changes from original

| Area | Original (Mar 9) | Modernized |
|------|------------------|------------|
| Buffer | `this.buffer` (fixed array, length === rows) | `this._history` (unbounded) + `scrollOffset` viewport |
| Scroll | None -- buffer was truncated | `scrollUp/Down/ToBottom`, history preserved |
| Cursor | None | `cursorRow`, `cursorCol` for future input |
| Dirty flag | None -- always re-rendered | Skip `loadFile` when content unchanged |
| Rendering | `loadFile()` | Same -- confirmed correct API |
| Constructor | Same signature | Same -- `new CodeGrid(scene, atlas, opts)` is current |

---

## File 2: `TUIWindowManager.js`

Location: `examples/github-viewer/websocket/TUIWindowManager.js`

```javascript
/**
 * TUIWindowManager -- lifecycle manager for TUI windows.
 * Creates, tracks, auto-positions, and exposes window operations
 * for the command system.
 */

import TUIWindow from './TUIWindow.js';

export default class TUIWindowManager {
    /**
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     */
    constructor(scene, atlas) {
        this.scene = scene;
        this.atlas = atlas;

        /** @type {Map<string, TUIWindow>} */
        this.windows = new Map();

        // Auto-position: stack vertically, wrap to next column
        this._nextY = 50;
        this._nextX = -100;
        this._stackSpacing = 30;
    }

    /**
     * Create a new window.
     * @param {string} id
     * @param {Object} [options]
     * @returns {TUIWindow}
     */
    create(id, options = {}) {
        if (this.windows.has(id)) {
            throw new Error(`window '${id}' already exists`);
        }

        if (!options.position) {
            options.position = { x: this._nextX, y: this._nextY, z: 0 };
            this._nextY -= this._stackSpacing;
            if (this._nextY < -150) {
                this._nextY = 50;
                this._nextX += 80;
            }
        }

        const win = new TUIWindow(id, this.scene, this.atlas, options);
        this.windows.set(id, win);
        return win;
    }

    /** @returns {TUIWindow|undefined} */
    get(id) { return this.windows.get(id); }

    /**
     * Remove and dispose a window.
     * @param {string} id
     * @returns {boolean}
     */
    remove(id) {
        const win = this.windows.get(id);
        if (!win) return false;
        win.dispose();
        this.windows.delete(id);
        return true;
    }

    /**
     * List all windows with metadata.
     * @returns {Array<Object>}
     */
    list() {
        return [...this.windows.entries()].map(([id, win]) => ({
            id,
            cols: win.cols,
            rows: win.rows,
            position: win.getPosition(),
            title: win.title,
            historyLines: win.historyLength,
            visibleNonEmpty: win.getVisibleLines().filter(l => l.length > 0).length,
        }));
    }

    /** Remove all windows. */
    clearAll() {
        for (const [id] of this.windows) this.remove(id);
    }

    /** @returns {number} */
    get count() { return this.windows.size; }
}
```

### Changes from original

- `list()` exposes `historyLines` (total) and `visibleNonEmpty` instead of just `bufferLines`.
- Otherwise structurally identical -- the original design is clean.

---

## File 3: `windowCommands.js`

Location: `examples/github-viewer/websocket/commands/windowCommands.js`

```javascript
/**
 * Window commands: window.create, window.write, window.append,
 * window.clear, window.close, window.list, window.resize, window.move
 *
 * Content args use base64 encoding (atob) matching the grid.* pattern.
 */

import TUIWindowManager from '../TUIWindowManager.js';

/**
 * Ensure ctx.windowManager exists, lazily creating it.
 * @param {Object} ctx
 * @returns {TUIWindowManager}
 */
function getOrCreateManager(ctx) {
    if (!ctx.windowManager) {
        ctx.windowManager = new TUIWindowManager(ctx.scene, ctx.atlas);
    }
    return ctx.windowManager;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerWindowCommands(router) {

    router.register('window.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.create <id> [cols] [rows] [title]', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const id = args[0];
        const cols = args[1] ? parseInt(args[1]) : 80;
        const rows = args[2] ? parseInt(args[2]) : 24;
        const title = args[3] || id;

        if (mgr.windows.has(id)) {
            return { text: `ERR: window '${id}' already exists`, data: null };
        }

        try {
            const win = mgr.create(id, { cols, rows, title });
            const pos = win.getPosition();
            return {
                text: `OK: window '${id}' created (${cols}x${rows}) at (${pos.x},${pos.y},${pos.z})`,
                data: { id, cols, rows, title, position: pos },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Create a TUI window', usage: '<id> [cols] [rows] [title]' });

    router.register('window.write', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.write <id> <base64-text>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = atob(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        win.write(text);
        return {
            text: `OK: window '${args[0]}' written (${win.historyLength} lines)`,
            data: { id: args[0], historyLines: win.historyLength },
        };
    }, { description: 'Replace window content', usage: '<id> <base64-text>' });

    router.register('window.append', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.append <id> <base64-text>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = atob(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        win.appendLine(text);
        return {
            text: `OK: window '${args[0]}' appended (${win.historyLength} lines)`,
            data: { id: args[0], historyLines: win.historyLength },
        };
    }, { description: 'Append text to window', usage: '<id> <base64-text>' });

    router.register('window.clear', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.clear <id>', data: null };
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        win.clear();
        return { text: `OK: window '${args[0]}' cleared`, data: { id: args[0] } };
    }, { description: 'Clear window content', usage: '<id>' });

    router.register('window.close', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.close <id>', data: null };
        const mgr = getOrCreateManager(ctx);
        const removed = mgr.remove(args[0]);
        if (!removed) return { text: `ERR: no window '${args[0]}'`, data: null };
        return { text: `OK: window '${args[0]}' closed`, data: { id: args[0] } };
    }, { description: 'Close and dispose a window', usage: '<id>' });

    router.register('window.list', (args, ctx) => {
        const mgr = getOrCreateManager(ctx);
        const list = mgr.list();
        if (list.length === 0) {
            return { text: 'OK: 0 windows', data: { windows: [], count: 0 } };
        }
        const lines = list.map(w =>
            `  ${w.id}: ${w.cols}x${w.rows} "${w.title}" (${w.historyLines} lines)`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} windows`,
            data: { windows: list, count: list.length },
        };
    }, { description: 'List all TUI windows' });

    router.register('window.resize', (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: window.resize <id> <cols> <rows>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        const cols = parseInt(args[1]);
        const rows = parseInt(args[2]);
        if (isNaN(cols) || isNaN(rows)) return { text: 'ERR: cols/rows must be numbers', data: null };
        win.resize(cols, rows);
        return {
            text: `OK: window '${args[0]}' resized to ${cols}x${rows}`,
            data: { id: args[0], cols, rows },
        };
    }, { description: 'Resize a window', usage: '<id> <cols> <rows>' });

    router.register('window.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: window.move <id> <x> <y> <z>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x,y,z must be numbers', data: null };
        win.setPosition(x, y, z);
        return {
            text: `OK: window '${args[0]}' moved to (${x},${y},${z})`,
            data: { id: args[0], position: { x, y, z } },
        };
    }, { description: 'Move window in 3D space', usage: '<id> <x> <y> <z>' });
}
```

---

## Wiring: changes to `commands/index.js`

Add one import and one call:

```javascript
import registerWindowCommands from './windowCommands.js';
// ... inside registerAllCommands():
registerWindowCommands(router);
```

No changes needed to `websocket/index.js` -- the `ctx.windowManager` slot already exists and `getOrCreateManager()` lazily populates it on first `window.*` command.

---

## Design Decisions & Rationale

### Why `loadFile()` not `loadText()`
`loadFile(title, content)` sets `grid.filename` and calls `loadText` internally. This gives us the yellow filename bar for free -- the title shows as `[agent-output]` etc. The original code had this right.

### Why unbounded history + scroll offset
The original truncated the buffer to `rows` lines, losing history. Terminal users expect scrollback. The new model keeps all lines in `_history` and computes a visible slice via `scrollOffset`. Cost: memory for history strings (negligible for text).

### Why dirty flag with content comparison
`_render()` does a string equality check against `_lastRenderedContent`. If an `appendLine` call adds content but the visible window hasn't changed (e.g., user scrolled up), we skip the `loadFile` call entirely. This avoids:
- Redundant `_clearContent()` + `_layoutContent()` + `flush()` cycles inside CodeGrid
- Unnecessary GPU buffer rebuilds

### Why lazy manager creation
The context bag has `windowManager: null`. Rather than requiring the viewer to construct a TUIWindowManager at startup (which imports CodeGrid etc.), `getOrCreateManager(ctx)` creates it on first `window.*` command. Zero cost if windows are never used.

### Why no `loadTextAsync` / worker path
Terminal panes are small (80x24 = 1920 chars max). The sync `loadFile` path is fine. Workers add latency for small payloads. If a pane grows to 200x50 in the future, switching to `loadFileAsync` is a one-line change in `_render()`.

### Base64 encoding
`window.write` and `window.append` accept base64-encoded content via `atob()`, exactly matching the pattern in `gridCommands.js` (`grid.create`, `grid.text`). This handles newlines, special characters, and binary-safe transport over WebSocket.

### Cursor tracking
`cursorRow` and `cursorCol` are set but not yet consumed by rendering. They exist as hooks for a future input mode where the TUI window accepts keystrokes (shell input, REPL). No rendering cost until activated.
