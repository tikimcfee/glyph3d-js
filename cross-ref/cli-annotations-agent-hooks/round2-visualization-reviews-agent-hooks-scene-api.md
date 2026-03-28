# Round 2: visualization reviews agent-hooks FIRST, then scene-api

Reviewer: **visualization** (inverse order)
Reviewing: **agent-hooks**, then **scene-api**

---

## Evolved Understanding

After two rounds, my position on three issues has shifted materially.

### 1. AgentLayoutHelper should NOT merge into AgentWindowManager -- it should dissolve

In Round 1, I recommended "merge AgentLayoutHelper into AgentWindowManager" (my R1). Scene-api's review correctly identified that this creates a dependency question: which class absorbs which? Agent-hooks' review proposed the opposite -- AgentLayoutHelper should drop its own grid map and accept a `getIndex(label)` callback.

Both are wrong. The real answer: **AgentLayoutHelper should not exist as a class at all.** Its layout methods (`arrangeAgents`, `focusAgent`, `correlateAgents`, `setPhaseLayout`) are thin wrappers around `conn.send('layout.agents ...')`. Those one-liners belong directly on AgentWindowManager. The grid-index tracking (my `agentGridMap`) is a redundant copy of AgentWindowManager's `_indexMap`. The `createAgentWindow()` / `removeAgentWindow()` / `updateAgentContent()` methods are duplicates of AgentWindow's `setContent()` / `setPosition()`. There is zero logic in AgentLayoutHelper that cannot live on AgentWindowManager as methods.

The browser-side `agentLayoutCommands.js` remains unchanged -- it operates on raw grids via `ctx.getGrids()` and needs no CLI-side helper class. The CLI side gets one class: `AgentWindowManager`, which gains layout methods.

### 2. Phase layout can and should stay CLI-only

My Phase 0 proposed `setPhaseLayout()` as a CLI-side method that computes positions from estimated window dimensions (W=120, H=80) and sends `grid.position` commands. Agent-hooks' review flagged that these estimates may not match actual grid sizes. Scene-api's review noted that the browser side has access to real `getBounds()` data.

I now think the CLI-only approach is correct, but for a different reason than I originally stated. The phase layout algorithm is **orchestration logic**, not rendering logic. It encodes cross-ref semantics (who reviews whom, which phase pairs which agents). The browser does not and should not know about cross-ref phases. The CLI computes approximate positions from estimated sizes, sends `grid.position` commands, then calls `camera.fitall` to let the browser handle framing. The estimates (W=120, H=80) are tuned for typical code review output and are good enough -- exact pixel precision is not needed for spatial layout.

However, the CLI should query actual grid dimensions when available. Adding a `grid.bounds <index>` command that returns `{width, height}` would let `setPhaseLayout` use real sizes instead of estimates, without pushing phase semantics to the browser.

### 3. Highlight/dim state must be unified but the mechanism is simpler than proposed

In Round 1, scene-api proposed `ctx.visualState` with four sub-maps (annotations, highlights, agentDimState, cameraAnimationId). I proposed a `highlightManager` with `save()`/`restore()`/`restoreAll()` methods. These are both over-engineered.

The actual requirement: any command that modifies a grid's position.z, scale, or groupColor should save the original values before first modification and restore them on clear. This is just a `Map<gridIndex, {originalZ, originalScale, originalColor}>` on `ctx`. Both `highlight.grid` and `layout.focus` write to it; both `highlight.clear` and `layout.undim` read from it.

---

## Convergence

All three perspectives now agree on these points:

1. **One CLI class, not two.** AgentWindowManager is the single CLI-side manager. No separate AgentLayoutHelper. The label-to-index map is singular. All three Round 1 reviews identified the dual-map problem as a correctness hazard.

2. **Browser owns positioning authority.** Agent-hooks should not auto-position at 100-unit spacing. Create at origin, then call `layout.agents row` or `setPhaseLayout()`. Scene-api's review (R1) and agent-hooks' review (recommendation 4) both converge on this.

3. **`camera.fitall` must exist.** All three reviews flagged this gap. It should be a browser-side command in `cameraCommands.js` that computes a bounding box of all visible grids and animates the camera to frame them.

4. **Camera animation cancellation must be centralized.** Scene-api's `camera.animate` uses `ctx._cameraAnimationId`. Any command that moves the camera (`layout.focus`, `layout.correlate`, `camera.lookat.grid`, `camera.fitall`) must cancel in-flight animations first. All three reviews agree.

5. **`scene.reset` / `scene.clear_all` as a single cleanup command.** Scene-api proposed `scene.clear_annotations`, agent-hooks' review proposed `scene.clear_all`, my review proposed `scene.reset`. Same idea: one command that orchestrates all cleanup paths.

6. **`agent:` prefix naming convention is the stable contract.** No disputes across any review.

---

## Remaining Tensions

### 1. Color palette: identity white vs agent green vs phase-specific tints

Scene-api uses white `{1,1,1}` as identity. My layout commands use green `{0,1,0}` as the "normal" agent color. Phase 1 uses bright green `{0.2,1.0,0.4}` for reviewers. Phase 2 uses blue `{0.4,0.8,1.0}`. Phase 3 uses gold `{1.0,0.85,0.3}`. Scene-api's highlights use cyan `{0.2,1.0,1.0}`. Annotations use amber `{1.0,0.9,0.5}`.

The tension is not just "pick one default" -- it is semantic. Green means "agent window." Cyan means "highlighted." Gold means "convergence." These are different signals and should remain different. But the "reset" color must be agreed upon.

**Resolution:** The identity color for group 0 is white `{1,1,1}` -- this is the DataTexture default and the mathematically correct identity multiplier. Agent windows should NOT have a "default green." Instead, agent windows should use white as their base color, and the content text itself can be colored green via the per-instance color attribute (already supported). This separates grid-level tinting (group color, used for highlight/dim/phase) from content-level coloring (instance attribute, set at creation time). My `layout.undim` should restore to white, not green. My phase colors should be applied as temporary tints that `layout.undim` clears back to white.

### 2. Annotation visibility to layout commands

Agent-hooks' review (Gap 3) identified that scene-api annotations are added via `ctx.scene.add()` and stored in `ctx.annotations`, not in `ctx.getGrids()`. This means `layout.agents` cannot discover or reposition them. If an agent creates both a window and annotations, the annotations float in stale positions after layout.

This is not fully resolved. Agent-hooks proposed `ctx.getSceneObjects({ type: 'agent' | 'annotation' | 'all' })`. Scene-api's `ctx.annotations` Map could be queried. But no concrete API shape was agreed upon.

**My position:** Annotations should not be repositioned by layout commands. They are ephemeral labels attached to specific spatial locations. If a grid moves, annotations associated with it should either (a) be children of the grid's Object3D (so they move automatically via Three.js scene graph), or (b) be cleared and re-created at new positions. Option (a) is cleaner but requires `label.create` to accept a parent grid index. Option (b) requires the CLI to track annotation-to-grid associations and re-emit `scene.annotate` after layout changes.

### 3. Command queue serialization

Agent-hooks' `_enqueue` serializes commands through a single pending promise. My AgentLayoutHelper (now dissolved into AgentWindowManager) called `conn.send()` directly. Agent-hooks' review correctly identified this as a collision risk.

**Resolution:** With AgentLayoutHelper dissolved, this tension disappears. All commands flow through AgentWindowManager's `_enqueue`. The layout methods (`arrangeAgents`, `setPhaseLayout`, etc.) become `async` methods on AgentWindowManager that internally call `_enqueue` for each sub-command.

---

## Synthesis

### Merged AgentWindowManager with layout methods

```javascript
// cli/AgentWindowManager.mjs
// Single CLI-side class: window lifecycle + layout + phase management

import CliConnection from './CliConnection.mjs';

// Shared color constants
const COLORS = {
    IDENTITY:     { r: 1.0, g: 1.0, b: 1.0 },  // white, group color identity
    HIGHLIGHT:    { r: 0.2, g: 1.0, b: 1.0 },  // cyan, focused/highlighted
    DIMMED:       { r: 0.3, g: 0.3, b: 0.3 },  // gray, dimmed background
    PHASE_0:      { r: 0.3, g: 1.0, b: 0.5 },  // green, independent work
    PHASE_1:      { r: 0.2, g: 1.0, b: 0.4 },  // bright green, forward review
    PHASE_1_DIM:  { r: 0.0, g: 0.6, b: 0.2 },  // dim green, review target
    PHASE_2:      { r: 0.4, g: 0.8, b: 1.0 },  // blue, inverse review
    PHASE_2_DIM:  { r: 0.1, g: 0.4, b: 0.6 },  // dim blue, inverse target
    PHASE_3:      { r: 1.0, g: 0.85, b: 0.3 }, // gold, convergence
};

export { COLORS as AGENT_COLORS };

export default class AgentWindowManager {
    constructor(conn) {
        this.conn = conn;
        this._windows = new Map();   // label -> AgentWindow
        this._indexMap = new Map();   // label -> grid index
        this._queue = Promise.resolve();
    }

    // -- Command serialization --

    _enqueue(cmd) {
        const p = this._queue.then(() => this.conn.send(cmd));
        this._queue = p.catch(() => {});  // prevent unhandled rejection chain
        return p;
    }

    // -- Window lifecycle (from agent-hooks) --

    async createWindow(label, content, options = {}) {
        const b64 = Buffer.from(content).toString('base64');
        const name = `agent:${label}`;
        const result = await this._enqueue(`grid.create ${b64} ${name}`);
        const index = result.data?.index ?? this._parseIndex(result.text);
        if (index != null) this._indexMap.set(label, index);
        return { index, label };
    }

    async updateContent(label, content) {
        const index = this._requireIndex(label);
        const b64 = Buffer.from(content).toString('base64');
        return this._enqueue(`grid.text ${index} ${b64}`);
    }

    async removeWindow(label) {
        const index = this._requireIndex(label);
        const result = await this._enqueue(`grid.remove ${index}`);
        this._indexMap.delete(label);
        await this._refreshIndices();
        return result;
    }

    async closeAll() {
        const labels = [...this._indexMap.keys()];
        // Remove in reverse index order to avoid shifting issues
        const sorted = labels
            .map(l => ({ label: l, index: this._indexMap.get(l) }))
            .sort((a, b) => b.index - a.index);
        for (const { label } of sorted) {
            await this._enqueue(`grid.remove ${this._indexMap.get(label)}`);
            this._indexMap.delete(label);
        }
    }

    // -- Layout commands (absorbed from AgentLayoutHelper) --

    async arrangeAgents(style = 'row') {
        return this._enqueue(`layout.agents ${style}`);
    }

    async focusAgent(label) {
        return this._enqueue(`layout.focus ${label}`);
    }

    async correlateAgents(label1, label2) {
        return this._enqueue(`layout.correlate ${label1} ${label2}`);
    }

    async undimAll() {
        return this._enqueue('layout.undim');
    }

    // -- Phase layout (absorbed from AgentLayoutHelper) --

    async setPhaseLayout(phase, agentLabels, options = {}) {
        const W = options.windowWidth || 120;
        const H = options.windowHeight || 80;
        const gap = options.gap || 15;

        switch (phase) {
            case 0: return this._layoutPhase0(agentLabels, W, gap);
            case 1: return this._layoutPhase1(agentLabels, W, H, gap);
            case 2: return this._layoutPhase2(agentLabels, W, H, gap);
            case 3: return this._layoutPhase3(agentLabels, W, H);
            default: throw new Error(`Unknown phase: ${phase}`);
        }
    }

    async _layoutPhase0(labels, W, gap) {
        for (let i = 0; i < labels.length; i++) {
            const x = i * (W + gap);
            await this._positionByLabel(labels[i], x, 0, 0);
            await this._colorByLabel(labels[i], COLORS.PHASE_0);
        }
        await this._enqueue('camera.fitall');
        return { text: `OK: phase 0 -- ${labels.length} agents in row` };
    }

    async _layoutPhase1(labels, W, H, gap) {
        const pairs = this._computeForwardPairs(labels);
        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));
            await this._positionByLabel(reviewer, 0, y, 0);
            await this._colorByLabel(reviewer, COLORS.PHASE_1);
            await this._positionByLabel(target, W + gap, y, 0);
            await this._colorByLabel(target, COLORS.PHASE_1_DIM);
        }
        await this._enqueue('camera.fitall');
        return { text: `OK: phase 1 -- ${pairs.length} forward pairs` };
    }

    async _layoutPhase2(labels, W, H, gap) {
        const pairs = this._computeInversePairs(labels);
        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));
            await this._positionByLabel(reviewer, W + gap, y, 0);
            await this._colorByLabel(reviewer, COLORS.PHASE_2);
            await this._positionByLabel(target, 0, y, 0);
            await this._colorByLabel(target, COLORS.PHASE_2_DIM);
        }
        await this._enqueue('camera.fitall');
        return { text: `OK: phase 2 -- ${pairs.length} inverse pairs` };
    }

    async _layoutPhase3(labels, W, H) {
        const n = labels.length;
        const radius = Math.max(W, H) * 0.8;
        for (let i = 0; i < n; i++) {
            const angle = (Math.PI / 2) + (2 * Math.PI * i / n);
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            await this._positionByLabel(labels[i], x, y, 0);
            await this._colorByLabel(labels[i], COLORS.PHASE_3);
        }
        await this._enqueue('camera.fitall');
        return { text: `OK: phase 3 -- ${n} agents in convergence cluster` };
    }

    _computeForwardPairs(labels) {
        return labels.map((l, i) => {
            const others = labels.filter((_, j) => j !== i);
            return { reviewer: l, target: others[0] };
        });
    }

    _computeInversePairs(labels) {
        return labels.map((l, i) => {
            const others = labels.filter((_, j) => j !== i).reverse();
            return { reviewer: l, target: others[0] };
        });
    }

    // -- Internal helpers --

    async _positionByLabel(label, x, y, z) {
        const index = this._requireIndex(label);
        return this._enqueue(`grid.position ${index} ${x} ${y} ${z}`);
    }

    async _colorByLabel(label, { r, g, b }) {
        const index = this._requireIndex(label);
        return this._enqueue(`grid.color ${index} ${r} ${g} ${b}`);
    }

    _requireIndex(label) {
        const index = this._indexMap.get(label);
        if (index === undefined) throw new Error(`No agent window: '${label}'`);
        return index;
    }

    _parseIndex(text) {
        const match = text?.match(/grid #(\d+)/);
        return match ? parseInt(match[1]) : null;
    }

    async _refreshIndices() {
        const result = await this._enqueue('grid.list');
        this._indexMap.clear();
        if (result.data?.grids) {
            for (const g of result.data.grids) {
                const name = g.filename || g.name || '';
                if (name.startsWith('agent:')) {
                    this._indexMap.set(name.slice(6), g.index);
                }
            }
        }
    }
}
```

### Unified highlight state on ctx (browser side)

```javascript
// In websocket/index.js buildContext(), add:
ctx.gridVisualState = new Map();
// Map<gridIndex, { originalZ: number, originalScale: number, originalColor: {r,g,b} }>

// Shared helper used by BOTH annotationCommands.js and agentLayoutCommands.js:

/**
 * Save grid's original visual state before modifying it.
 * No-op if already saved (first writer wins).
 */
function saveGridState(ctx, gridIndex) {
    if (ctx.gridVisualState.has(gridIndex)) return;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return;
    ctx.gridVisualState.set(gridIndex, {
        originalZ: grid.position.z,
        originalScale: grid.scale.x,
        originalColor: { r: 1, g: 1, b: 1 },  // identity white
    });
}

/**
 * Restore grid to its original visual state.
 */
function restoreGridState(ctx, gridIndex) {
    const saved = ctx.gridVisualState.get(gridIndex);
    if (!saved) return;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return;
    grid.position.z = saved.originalZ;
    grid.scale.setScalar(saved.originalScale);
    const coll = grid.collection || grid.glyphCollection;
    if (coll) coll.setGroupColor(0, saved.originalColor);
    ctx.gridVisualState.delete(gridIndex);
}

/**
 * Restore all modified grids.
 */
function restoreAllGridStates(ctx) {
    for (const idx of ctx.gridVisualState.keys()) {
        restoreGridState(ctx, idx);
    }
}
```

Both `highlight.grid` (scene-api) and `layout.focus` (visualization) call `saveGridState(ctx, index)` before modifying Z/scale/color. Both `highlight.clear` and `layout.undim` call `restoreGridState` or `restoreAllGridStates`. This eliminates the stale-state corruption described in all three Round 1 reviews.

### camera.fitall implementation

```javascript
// In cameraCommands.js, add:

router.register('camera.fitall', (args, ctx) => {
    ctx._cancelCameraAnimation?.();  // cancel any in-flight animation

    const grids = ctx.getGrids();
    if (grids.length === 0) return { text: 'WARN: no grids to fit' };

    // Compute bounding box of all visible grids
    const box = new THREE.Box3();
    for (const g of grids) {
        if (!g.visible) continue;
        const b = g.getBounds();
        const pos = g.position;
        box.expandByPoint(new THREE.Vector3(
            pos.x + b.min.x, pos.y + b.min.y, pos.z
        ));
        box.expandByPoint(new THREE.Vector3(
            pos.x + b.max.x, pos.y + b.max.y, pos.z
        ));
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Position camera to see the whole bounding box
    const maxDim = Math.max(size.x, size.y);
    const fov = ctx.camera.fov * (Math.PI / 180);
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.2;  // 20% margin

    // Use camera.animate if available, else snap
    const target = { x: center.x, y: center.y, z: center.z + dist };

    // Sync camera controller
    ctx.camera.position.set(target.x, target.y, target.z);
    ctx.camera.lookAt(center);
    if (ctx.cameraController) {
        ctx.cameraController.pitch = 0;
        ctx.cameraController.yaw = 0;
    }

    return { text: `OK: camera fit ${grids.length} grids` };
});
```

---

## Dissent

### I disagree with agent-hooks' recommendation to make annotations children of grid Object3Ds

Agent-hooks proposed that annotations should be parented to grids so they move automatically. This couples two independent systems and makes cleanup harder -- removing a grid would also remove its annotations, and `scene.clear_annotations` would need to traverse the scene graph rather than iterate a flat Map. Annotations should remain in `ctx.annotations` as top-level scene objects. If a grid moves, the CLI is responsible for clearing and re-creating associated annotations. This keeps both systems simple and independently testable.

### Phase layout belongs on the CLI, not the browser

Scene-api's review suggested that the browser side could compute better layouts because it has access to `getBounds()`. While true, this would mean the browser needs to understand cross-ref semantics (phases, reviewer/target pairs, forward vs. inverse order). That is orchestration logic, not rendering logic. The browser should remain a dumb spatial renderer that responds to `grid.position` and `grid.color` commands. If the CLI needs actual grid dimensions, add a `grid.bounds` query command -- do not push cross-ref knowledge into the browser.

### `ctx.getSceneObjects({ type })` is premature abstraction

Agent-hooks' review proposed a typed discovery API. With only two object types today (agent windows in `ctx.getGrids()`, annotations in `ctx.annotations`), this creates an abstraction layer for a problem that does not yet exist at scale. The `agent:` prefix convention and the `ctx.annotations` Map are sufficient. If a third object type appears, then revisit. Premature unification often calcifies the wrong boundaries.
