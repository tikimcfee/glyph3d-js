# Round 2: agent-hooks reviews visualization, then scene-api

Reviewer: **agent-hooks**
Review order: **visualization** first, **scene-api** second (inverse)

---

## Evolved Understanding

After reading all three Round 1 reviews, my understanding has shifted on several points:

**1. Auto-positioning must go.** In my Phase 0 I defended 100-unit spacing as "a sensible default for agent panels." All three reviewers -- including myself -- identified this as a conflict with visualization's layout authority. The Round 1 consensus is unanimous: AgentWindowManager should create grids at origin and let layout commands handle arrangement. I now agree fully. The `_nextSlot`, `_spacing`, `_baseX/Y/Z` fields should be removed from AgentWindowManager entirely. If a caller wants immediate positioning before a layout pass, they call `window.setPosition()` explicitly.

**2. AgentWindowManager should absorb layout methods, not the reverse.** My Round 1 suggested this, scene-api's Round 1 (R1) agreed, and visualization's Round 1 explicitly concurred ("These should be one class"). The debate about dependency direction is settled: AgentWindowManager is the higher-level abstraction that owns the connection, the command queue, and the label-to-index map. Layout algorithms from AgentLayoutHelper become methods on it. The browser-side `agentLayoutCommands.js` remains a separate file (it operates on raw grids via `ctx`, not the CLI abstraction).

**3. The context bag needs a shared visual-state contract.** Scene-api's Round 1 proposed `ctx.visualState` with sub-objects for annotations, highlights, agentDimState, and cameraAnimationId. Visualization's Round 1 proposed a `highlightManager` with `save()`/`restore()`/`restoreAll()`. These are the same idea with different shapes. The evolved understanding: we need both a state store and an API over it, because raw Map access leads to the exact stale-state bugs all three reviews identified.

**4. The `agent:` naming convention is safe but insufficient for discovery.** My Round 1 confirmed that annotation IDs (`label-*`, `annot-*`) never collide with `agent:*` prefixes. But all three reviews flag that `ctx.getGrids()` only returns agent windows, not annotations. There is no unified "all non-content objects" query. The fix is not to merge registries but to add a `ctx.getSceneObjects()` discovery API as I proposed in Round 1.

---

## Convergence

The following points have full three-way agreement across all Round 1 reviews:

**C1. One CLI class, not two.** AgentWindowManager absorbs AgentLayoutHelper. One label-to-index map. One command queue. One connection wrapper. All three reviews agree.

**C2. Browser side owns positioning authority.** Agent-hooks should not auto-position. Layout commands (`layout.agents row`, `layout.agents grid`, `setPhaseLayout`) are the positioning authority. All three reviews agree.

**C3. Shared highlight/dim state on ctx.** Whether called `ctx.visualState` (scene-api), `highlightManager` (visualization), or "shared annotation/visual-state tracker" (scene-api R1), all three reviews agree that `highlight.grid` and `layout.focus` must save/restore through one state object so they do not clobber each other.

**C4. Camera animation cancellation must be centralized.** `ctx._cancelCameraAnimation` (or equivalent) must be called by any command that moves the camera -- `camera.animate`, `layout.focus`, `layout.correlate`, `camera.lookat.grid`. Scene-api established the `cancelAnimationFrame` pattern; visualization's `layout.correlate` must adopt it.

**C5. `camera.fitall` must exist.** Visualization depends on it for every phase transition. Neither scene-api nor the existing codebase implements it. All three reviews flag this gap.

**C6. A unified reset command.** Whether called `scene.reset` (scene-api R1) or `scene.clear_all` (my R1), the need for a single "clean slate" command that clears annotations, agent windows, highlights, and dim state is agreed.

**C7. Shared color palette.** All three reviews identify the green-vs-white-vs-cyan color semantics conflict. A shared constants file with semantic color assignments is needed.

---

## Remaining Tensions

**T1. Command queue: shared vs per-window.**

AgentWindowManager serializes all commands through a single `_enqueue` queue because CliConnection has one `_pendingResolve` slot. When layout methods are absorbed into the manager, layout commands (which may send 5-10 rapid `grid.position` calls) go through the same queue as content updates (`grid.text`). This is correct for serialization but introduces latency: a layout pass for 6 windows sends 6+ sequential commands, each waiting for a response.

The tension: should the queue remain a single FIFO, or should we batch layout commands? CliConnection's single-pending-resolve constraint means true parallelism is impossible without modifying the connection. The pragmatic answer: keep the single queue. The commands are not high-frequency (sub-second total for a layout pass). But this means any future optimization requires changing CliConnection to support pipelining, which is out of scope here.

**T2. How does `agent:` naming work with scene-api's annotation tracking?**

Scene-api tracks annotations in `ctx.annotations` (keyed by generated IDs like `label-1234-abcd`). Agent-hooks creates windows that appear in `ctx.getGrids()` with names like `agent:protocol`. These are two disjoint registries. The tension surfaces in three scenarios:

- **Agent attaches a label to its window.** The agent calls `label.create` through scene-api, manually computing coordinates relative to its grid. The label goes into `ctx.annotations`. If the agent window moves (via `layout.agents`), the label stays behind. There is no `label.attach` command to parent an annotation to a grid.

- **`scene.clear_annotations` vs window cleanup.** Clearing annotations does not touch agent windows. Closing all windows does not touch annotations an agent created. If an agent created both windows and labels, a clean teardown requires calling both `closeAll()` and `scene.clear_annotations`.

- **Discovery across registries.** `layout.agents` finds agent grids via `findAgentGrids()`. `label.list` finds annotations via `ctx.annotations`. No single command lists "everything agent X created."

Resolution sketch: annotations should support an optional `parentGrid` index. When the parent grid moves, the annotation moves with it (relative offset). When the parent is removed, its child annotations are removed. This keeps the registries separate but adds a structural relationship.

**T3. `layout.correlate` camera sync.**

Scene-api's Round 1 flagged that visualization's `layout.correlate` directly sets `cam.position.set()` and `cam.lookAt()` without syncing `cameraController.pitch/yaw`. Visualization's Round 1 acknowledged that scene-api's `camera.lookat.grid` carefully extracts Euler angles and writes them back. But visualization did not commit to fixing this. The tension remains: `layout.correlate` will fight the physics-based camera controller on the next frame unless it adopts the pitch/yaw sync pattern.

This is not a design disagreement -- it is an implementation gap that visualization must close by calling the same Euler-extraction logic scene-api uses.

---

## Synthesis

### Merged AgentWindowManager with Layout Methods

```javascript
// examples/github-viewer/cli/AgentWindowManager.mjs

import CliConnection from './CliConnection.mjs';
import AgentWindow from './AgentWindow.mjs';

export default class AgentWindowManager {
    constructor(url = 'ws://localhost:8765') {
        this._url = url;
        this._conn = new CliConnection(url);
        this._connected = false;

        /** @type {Map<string, AgentWindow>} */
        this._windows = new Map();
        /** @type {Map<string, number>} label -> grid index */
        this._indexMap = new Map();

        // Command queue (single-pending-resolve serialization)
        this._queue = [];
        this._processing = false;

        // No auto-positioning fields. Layout is explicit.
    }

    async connect() { /* unchanged */ }

    /**
     * Create a new agent window at origin. No auto-positioning.
     * Call arrangeAgents() or setPosition() after creation.
     */
    async createWindow(label, options = {}) {
        if (this._windows.has(label)) return this._windows.get(label);

        const initialText = options.initialText || `[${label}] ready`;
        const b64 = Buffer.from(initialText).toString('base64');
        const result = await this._enqueue(`grid.create ${b64} agent:${label}`);
        const match = result.text.match(/grid #(\d+)/);
        if (!match) throw new Error(`Failed to create grid "${label}": ${result.text}`);

        const gridIndex = parseInt(match[1]);
        this._indexMap.set(label, gridIndex);

        const window = new AgentWindow({
            label, gridIndex,
            sendCommand: (cmd) => this._enqueue(cmd),
            onClose: (lbl) => this._handleWindowClose(lbl),
        });
        this._windows.set(label, window);

        if (options.color) {
            await window.setColor(options.color.r, options.color.g, options.color.b);
        }
        return window;
    }

    // ---- Layout methods (absorbed from AgentLayoutHelper) ----

    /**
     * Arrange all agent windows using a named layout style.
     * Delegates to browser-side layout.agents command.
     * @param {'row'|'column'|'grid'|'radial'} style
     */
    async arrangeAgents(style = 'row') {
        return this._enqueue(`layout.agents ${style}`);
    }

    /**
     * Focus camera on a specific agent window.
     * Dims other windows and animates camera to the target.
     * @param {string} label - agent label to focus
     */
    async focusAgent(label) {
        return this._enqueue(`layout.focus ${label}`);
    }

    /**
     * Arrange agents in correlated pairs for side-by-side comparison.
     * @param {string[]} pairs - flat array of labels: [a, b, c, d] -> pairs (a,b), (c,d)
     */
    async correlateAgents(pairs) {
        return this._enqueue(`layout.correlate ${pairs.join(' ')}`);
    }

    /**
     * Apply a cross-ref phase layout.
     * @param {number} phase - 0, 1, 2, or 3
     * @param {Object} [options] - phase-specific options
     */
    async setPhaseLayout(phase, options = {}) {
        const args = [`phase=${phase}`];
        if (options.focus) args.push(`focus=${options.focus}`);
        if (options.pairs) args.push(`pairs=${options.pairs.join(',')}`);
        return this._enqueue(`layout.phase ${args.join(' ')}`);
    }

    /**
     * Reset dim/focus state on all agent windows.
     */
    async undimAll() {
        return this._enqueue('layout.undim');
    }

    /**
     * Fit camera to show all visible agent windows.
     */
    async fitAll() {
        return this._enqueue('camera.fitall');
    }

    // ---- Index management (single source of truth) ----

    /**
     * Get the current grid index for a label.
     * Used by external code that needs index-based commands.
     * @param {string} label
     * @returns {number|undefined}
     */
    getIndex(label) {
        return this._indexMap.get(label);
    }

    async _refreshIndices() {
        const result = await this._enqueue('grid.list');
        if (!result.data || !result.data.grids) return;

        this._indexMap.clear();
        for (const grid of result.data.grids) {
            const name = grid.filename || grid.name || '';
            if (name.startsWith('agent:')) {
                const label = name.slice(6);
                this._indexMap.set(label, grid.index);
                const win = this._windows.get(label);
                if (win) win.gridIndex = grid.index;
            }
        }
    }

    // ---- Queue, close, disconnect: unchanged from Phase 0 ----

    _enqueue(cmd) { /* unchanged */ }
    async _processQueue() { /* unchanged */ }
    _handleWindowClose(label) { /* unchanged */ }
    async closeAll() { /* unchanged but without _nextSlot reset */ }
    async disconnect(opts) { /* unchanged */ }
}
```

### Shared HighlightManager on ctx

This resolves the stale-state problem identified by all three reviews. Both `annotationCommands.js` and `agentLayoutCommands.js` use this instead of maintaining independent state.

```javascript
// examples/github-viewer/websocket/commands/HighlightManager.js

/**
 * Shared highlight/dim state tracker for the browser-side context bag.
 * Both annotation commands and layout commands use this to avoid
 * clobbering each other's saved state.
 */
export default class HighlightManager {
    constructor() {
        /** @type {Map<number, {originalZ: number, originalScale: number, originalColor: {r,g,b}, source: string}>} */
        this._saved = new Map();
        /** @type {number|null} */
        this.cameraAnimationId = null;
    }

    /**
     * Save a grid's current visual state before modifying it.
     * Only saves once per grid -- first writer wins.
     * @param {number} gridIndex
     * @param {Object} state - { z, scale, color: {r,g,b} }
     * @param {string} source - 'highlight' | 'layout' | 'annotation'
     */
    save(gridIndex, state, source) {
        if (this._saved.has(gridIndex)) return; // don't overwrite original
        this._saved.set(gridIndex, {
            originalZ: state.z,
            originalScale: state.scale,
            originalColor: { ...state.color },
            source,
        });
    }

    /**
     * Restore a grid to its saved state.
     * @param {number} gridIndex
     * @returns {{originalZ: number, originalScale: number, originalColor: {r,g,b}}|null}
     */
    restore(gridIndex) {
        const saved = this._saved.get(gridIndex);
        if (!saved) return null;
        this._saved.delete(gridIndex);
        return saved;
    }

    /**
     * Restore all saved grids.
     * @returns {Map<number, {originalZ, originalScale, originalColor}>}
     */
    restoreAll() {
        const all = new Map(this._saved);
        this._saved.clear();
        return all;
    }

    /**
     * Cancel any in-flight camera animation.
     */
    cancelCameraAnimation() {
        if (this.cameraAnimationId != null) {
            cancelAnimationFrame(this.cameraAnimationId);
            this.cameraAnimationId = null;
        }
    }

    /** @returns {boolean} */
    has(gridIndex) {
        return this._saved.has(gridIndex);
    }
}
```

Integrated into context bag setup:

```javascript
// In websocket/index.js buildContext():
import HighlightManager from './commands/HighlightManager.js';

function buildContext(scene, camera, cameraController, getGrids) {
    return {
        scene, camera, cameraController, getGrids,
        annotations: new Map(),       // scene-api label/annotation registry
        highlights: new HighlightManager(), // shared visual state
        // ... existing fields
    };
}
```

### Annotation Parenting (resolving T2)

To allow annotations to follow agent windows when layout commands reposition them:

```javascript
// Addition to annotationCommands.js

// label.attach <annotation-id> <grid-index> [offsetX offsetY offsetZ]
router.register('label.attach', (args, ctx) => {
    if (args.length < 2) {
        return { text: 'ERR: usage: label.attach <id> <grid-index> [ox oy oz]', data: null };
    }

    const [id, indexStr] = args;
    const gridIndex = parseInt(indexStr);
    const annotation = ctx.annotations.get(id);
    if (!annotation) return { text: `ERR: annotation "${id}" not found`, data: null };

    const grids = ctx.getGrids();
    if (gridIndex < 0 || gridIndex >= grids.length) {
        return { text: `ERR: grid index ${gridIndex} out of range`, data: null };
    }

    const parentGrid = grids[gridIndex];
    const ox = parseFloat(args[2]) || 0;
    const oy = parseFloat(args[3]) || 0;
    const oz = parseFloat(args[4]) || 0;

    // Re-parent: remove from scene root, add as child of grid
    ctx.scene.remove(annotation);
    parentGrid.add(annotation);
    annotation.position.set(ox, oy, oz);

    // Tag for cleanup tracking
    annotation.userData.parentGridIndex = gridIndex;

    return {
        text: box(`Attached ${id} to grid #${gridIndex} at offset (${ox}, ${oy}, ${oz})`),
        data: { id, parentGridIndex: gridIndex, offset: { x: ox, y: oy, z: oz } },
    };
});
```

### Shared Color Palette

```javascript
// examples/github-viewer/websocket/commands/agentColors.js

/**
 * Semantic color palette for agent windows and annotations.
 * Imported by both annotationCommands.js and agentLayoutCommands.js.
 */
export const AGENT_COLORS = {
    /** Identity / reset color (white multiplier, no tint) */
    identity:    { r: 1.0,  g: 1.0,  b: 1.0  },
    /** Normal agent window color */
    normal:      { r: 0.3,  g: 1.0,  b: 0.5  },
    /** Focused / highlighted window */
    focus:       { r: 0.2,  g: 1.0,  b: 1.0  },
    /** Dimmed / background window */
    dimmed:      { r: 0.3,  g: 0.3,  b: 0.3  },
    /** Annotation / label text */
    annotation:  { r: 1.0,  g: 0.85, b: 0.3  },
    /** Error / critical */
    error:       { r: 1.0,  g: 0.3,  b: 0.3  },
    /** Phase 0-1 (independent work) */
    phase01:     { r: 0.3,  g: 1.0,  b: 0.5  },
    /** Phase 2 (cross-review) */
    phase2:      { r: 0.4,  g: 0.8,  b: 1.0  },
    /** Phase 3 (convergence) */
    phase3:      { r: 1.0,  g: 0.85, b: 0.3  },
};
```

---

## Dissent

**D1. I dissent from visualization's suggestion that `highlight.grid` should accept label strings.**

Visualization's Round 1 recommendation 6 proposes that `highlight.grid` accept either a numeric index or an `agent:<label>` string. I disagree. Scene-api's annotation commands are intentionally index-based -- they operate on any grid, not just agent windows. Adding label resolution to `highlight.grid` mixes two abstraction levels. The correct bridge is a `grid.resolve` command that translates a label to an index, usable by any command:

```
grid.resolve agent:protocol  ->  { text: "grid #3", data: { index: 3 } }
```

Then users compose: `highlight.grid $(grid.resolve agent:protocol)`. This keeps scene-api's commands generic and avoids teaching every grid command about the `agent:` naming convention.

**D2. I dissent from the idea that `scene.reset` should remove agent windows.**

Scene-api's Round 1 (R6) proposes `scene.reset` that calls `scene.clear_annotations` + `layout.undim` + optionally `scene.clear_windows`. My Round 1 similarly proposed `scene.clear_all`. On reflection, this is wrong for agent windows. Agent windows have CLI-side state (the `AgentWindowManager._windows` map, line buffers in `AgentWindow._lines`, the `_closed` flag). If the browser side silently removes agent grids via `scene.reset`, the CLI-side `AgentWindowManager` is left holding dead references -- `_indexMap` entries pointing to removed grids, `AgentWindow` instances whose `gridIndex` no longer exists. Subsequent `window.write()` calls would fail or write to the wrong grid.

Agent window cleanup must always go through `AgentWindowManager.closeAll()` on the CLI side, which removes grids in reverse order and properly cleans up its own state. `scene.reset` should clear annotations + highlights + dim state + camera, but NOT touch agent grids. If a user wants a full reset, they call `manager.closeAll()` from the CLI followed by `scene.reset` in the viewer.

**D3. The `ctx.getSceneObjects({ type })` discovery API I proposed in Round 1 may be over-engineering.**

On reflection, the `findAgentGrids()` scan-by-prefix pattern is simple and correct. Annotations live in `ctx.annotations`, agent windows live in `ctx.getGrids()` with `agent:` prefix. Adding a unified query API creates a third abstraction over two simple data structures. The real need is not discovery but relationship (T2 above: parenting annotations to grids). `label.attach` solves the actual problem without a new registry.
