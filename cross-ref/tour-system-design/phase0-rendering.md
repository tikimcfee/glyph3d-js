# Tour System — Phase 0: Rendering Layer Design

Rendering agent perspective. Covers GPU primitives, ConnectionRenderer, annotation
composition, frustum interaction, and performance.

---

## 1. Line/Arrow Primitives

### Geometry choice

`THREE.LineSegments` with a pre-allocated `BufferGeometry` is the right primitive.
Each connection is two vertices (start, end). Arrowheads are two additional line
segments forming a V at the tip — four vertices total per arrowhead. All connections
share one geometry and one draw call.

`THREE.Line` (line strip) is the wrong choice here: disconnected connections would
require separate objects. `LineMaterial` (from Three.js examples) adds a full-screen
quad pass for caps/joins — too heavy for what amounts to pointer lines.

`THREE.LineSegments` costs ~12 bytes per vertex (x, y, z Float32 × 2 verts = 24 bytes
per segment). A tour with 32 connection lines + arrowheads sits well under 2 KB of
vertex data.

### Material

```js
const material = new THREE.LineBasicMaterial({
    vertexColors: true,   // per-segment color via BufferAttribute
    depthTest: true,
    depthWrite: false,    // lines don't write depth — prevents z-fighting with grids
    transparent: true,
    opacity: 1.0,
    linewidth: 1,         // WebGL spec: only 1px honored cross-browser
});
```

`linewidth > 1` is a no-op on most WebGL implementations. If thick lines are needed
later, use `THREE.MeshLine` (a third-party quad-expanded line) or add a custom instanced
cylinder shader. For v1 keep `linewidth: 1` — a bright color reads fine at 1px in 3D.

### Buffer layout

Pre-allocate for a cap of `MAX_CONNECTIONS = 256` connections (configurable).
Each connection uses 3 segments: shaft + 2 arrowhead sides = 6 vertices = 18 floats
for position, 18 floats for color.

```
position buffer: MAX_CONNECTIONS * 6 verts * 3 floats = MAX_CONNECTIONS * 18 floats
color buffer:    MAX_CONNECTIONS * 6 verts * 3 floats = MAX_CONNECTIONS * 18 floats
```

At MAX_CONNECTIONS=256: 256 × 36 × 4 bytes = ~36 KB. Negligible.

`geometry.setDrawRange(0, activeSegments * 2)` controls how many vertices Three.js
submits — inactive slots are never seen by the GPU.

---

## 2. ConnectionRenderer class

File: `src/annotations/ConnectionRenderer.js`

```js
import * as THREE from 'three';

const MAX_CONNECTIONS = 256;
const VERTS_PER_CONNECTION = 6; // shaft(2) + arrowL(2) + arrowR(2)
const ARROW_HALF_ANGLE = Math.PI / 7;  // ~25 degrees
const ARROW_LENGTH_RATIO = 0.12;       // arrowhead = 12% of connection length

export default class ConnectionRenderer {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [options]
     * @param {number} [options.maxConnections=256]
     * @param {number} [options.arrowLengthRatio=0.12]
     */
    constructor(scene, options = {}) {
        this._scene = scene;
        this._max = options.maxConnections ?? MAX_CONNECTIONS;
        this._arrowRatio = options.arrowLengthRatio ?? ARROW_LENGTH_RATIO;

        /** @type {Map<string, ConnectionEntry>} id → entry */
        this._connections = new Map();

        this._posArr  = new Float32Array(this._max * VERTS_PER_CONNECTION * 3);
        this._colArr  = new Float32Array(this._max * VERTS_PER_CONNECTION * 3);
        this._slotFree = Array.from({ length: this._max }, (_, i) => i).reverse();

        this._geo = new THREE.BufferGeometry();
        this._posBuf = new THREE.BufferAttribute(this._posArr, 3);
        this._colBuf = new THREE.BufferAttribute(this._colArr, 3);
        this._posBuf.setUsage(THREE.DynamicDrawUsage);
        this._colBuf.setUsage(THREE.DynamicDrawUsage);
        this._geo.setAttribute('position', this._posBuf);
        this._geo.setAttribute('color',    this._colBuf);
        this._geo.setDrawRange(0, 0);

        this._mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 1.0,
        });

        this._mesh = new THREE.LineSegments(this._geo, this._mat);
        this._mesh.frustumCulled = false; // connections span arbitrary world space
        this._mesh.renderOrder = 1;       // draw on top of grid quads
        scene.add(this._mesh);

        this._activeSlots = 0; // highest active slot + 1, for setDrawRange
    }

    /**
     * Add or replace a connection. Idempotent: same id → same visual result.
     * @param {string} id - stable identifier (e.g. 'call:foo->bar')
     * @param {{ x, y, z }} from - world-space start point
     * @param {{ x, y, z }} to   - world-space end point
     * @param {{ r, g, b }} color
     * @returns {string} id
     */
    set(id, from, to, color) {
        let entry = this._connections.get(id);
        if (!entry) {
            const slot = this._slotFree.pop();
            if (slot === undefined) {
                console.warn('[ConnectionRenderer] MAX_CONNECTIONS reached, dropping:', id);
                return id;
            }
            entry = { slot };
            this._connections.set(id, entry);
        }
        this._writeSlot(entry.slot, from, to, color);
        this._refreshDrawRange();
        return id;
    }

    /**
     * Remove a connection by id. Zeroes its vertices (degenerate — GPU discards).
     * @param {string} id
     */
    remove(id) {
        const entry = this._connections.get(id);
        if (!entry) return;
        this._zeroSlot(entry.slot);
        this._slotFree.push(entry.slot);
        this._connections.delete(id);
        this._refreshDrawRange();
    }

    /**
     * Remove all connections.
     */
    clear() {
        for (const id of this._connections.keys()) this.remove(id);
    }

    /**
     * Update only the position of an existing connection.
     * Use when a grid moves (e.g. group offset change) without changing color.
     * @param {string} id
     * @param {{ x, y, z }} from
     * @param {{ x, y, z }} to
     */
    updatePosition(id, from, to) {
        const entry = this._connections.get(id);
        if (!entry) return;
        // Read color from buffer to preserve it
        const base = entry.slot * VERTS_PER_CONNECTION * 3;
        const color = { r: this._colArr[base], g: this._colArr[base + 1], b: this._colArr[base + 2] };
        this._writeSlot(entry.slot, from, to, color);
    }

    /**
     * Show or hide all connections. O(1) — just toggles mesh visibility.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._mesh.visible = visible;
    }

    /**
     * Free GPU resources.
     */
    dispose() {
        this._scene.remove(this._mesh);
        this._geo.dispose();
        this._mat.dispose();
    }

    // ── private ──────────────────────────────────────────────────────

    /**
     * Write shaft + arrowhead vertices for a slot.
     * @private
     */
    _writeSlot(slot, from, to, color) {
        const base = slot * VERTS_PER_CONNECTION * 3;
        const p = this._posArr;
        const c = this._colArr;

        // Direction vector
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) { this._zeroSlot(slot); return; }

        // Shaft: from → to
        p[base]     = from.x; p[base + 1] = from.y; p[base + 2] = from.z;
        p[base + 3] = to.x;   p[base + 4] = to.y;   p[base + 5] = to.z;

        // Arrowhead: two lines from `to` backward along shaft direction, spread by angle
        const arrowLen = len * this._arrowRatio;
        const ux = dx / len, uy = dy / len, uz = dz / len;

        // Build a perpendicular vector. Pick axis least aligned with direction.
        let px, py, pz;
        if (Math.abs(ux) < 0.9) { px = 0; py = -uz; pz = uy; }
        else                     { px = uz; py = 0;  pz = -ux; }
        const plen = Math.sqrt(px * px + py * py + pz * pz);
        px /= plen; py /= plen; pz /= plen;

        const sinA = Math.sin(ARROW_HALF_ANGLE);
        const cosA = Math.cos(ARROW_HALF_ANGLE);

        // Arrow left: to + arrowLen * (-u * cosA + p * sinA)
        const al = base + 6;
        p[al]     = to.x; p[al + 1] = to.y; p[al + 2] = to.z;
        p[al + 3] = to.x + arrowLen * (-ux * cosA + px * sinA);
        p[al + 4] = to.y + arrowLen * (-uy * cosA + py * sinA);
        p[al + 5] = to.z + arrowLen * (-uz * cosA + pz * sinA);

        // Arrow right: to + arrowLen * (-u * cosA - p * sinA)
        const ar = base + 12;
        p[ar]     = to.x; p[ar + 1] = to.y; p[ar + 2] = to.z;
        p[ar + 3] = to.x + arrowLen * (-ux * cosA - px * sinA);
        p[ar + 4] = to.y + arrowLen * (-uy * cosA - py * sinA);
        p[ar + 5] = to.z + arrowLen * (-uz * cosA - pz * sinA);

        // Colors: all 6 vertices same color
        const { r, g, b } = color;
        for (let v = 0; v < VERTS_PER_CONNECTION; v++) {
            c[base + v * 3]     = r;
            c[base + v * 3 + 1] = g;
            c[base + v * 3 + 2] = b;
        }

        // Partial GPU upload — only this slot's range
        const vertBase = slot * VERTS_PER_CONNECTION;
        this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._colBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._posBuf.needsUpdate = true;
        this._colBuf.needsUpdate = true;
    }

    /** @private */
    _zeroSlot(slot) {
        const base = slot * VERTS_PER_CONNECTION * 3;
        this._posArr.fill(0, base, base + VERTS_PER_CONNECTION * 3);
        const vertBase = slot * VERTS_PER_CONNECTION;
        this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3);
        this._posBuf.needsUpdate = true;
    }

    /** Recompute setDrawRange to cover all occupied slots. @private */
    _refreshDrawRange() {
        if (this._connections.size === 0) {
            this._geo.setDrawRange(0, 0);
            return;
        }
        let maxSlot = 0;
        for (const { slot } of this._connections.values()) {
            if (slot > maxSlot) maxSlot = slot;
        }
        // setDrawRange takes vertex count, not segment count
        this._geo.setDrawRange(0, (maxSlot + 1) * VERTS_PER_CONNECTION);
    }
}
```

---

## 3. Annotation composition per tour step

A tour step over a grid applies a layered stack of visuals. Each layer is independent
and idempotent:

```
Layer 1 — glyph highlight  : highlightRange(startLine, endLine, color) on the CodeGrid
Layer 2 — grid highlight   : setGroupColor() + z-pop via gridVisualState (already exists)
Layer 3 — connection lines : connectionRenderer.set(id, from, to, color)
Layer 4 — text label       : existing label.create command (CodeGrid at position)
```

Applying the same step twice produces the same result because:
- `setGlyphHighlight` is a direct write (last-write wins).
- `setGroupColor` is a direct write.
- `connectionRenderer.set(id, ...)` is idempotent by id.
- `label.create` with a stable id (tour step id) replaces via `remove` + `create` if needed,
  or the caller avoids duplicates by keying on step id.

Step lifecycle:

```js
function applyStep(connectionRenderer, ctx, step) {
    const { id, sourceGrid, sourceAnchor, targetGrid, targetAnchor, color, label } = step;

    // 1. highlight source grid
    saveGridState(ctx, sourceIdx);
    sourceGrid.collection.setGroupColor(0, color);

    // 2. highlight target grid (dimmer)
    saveGridState(ctx, targetIdx);
    targetGrid.collection.setGroupColor(0, dimColor(color, 0.5));

    // 3. draw connection
    const from = resolveAnchor(getWorldBounds(sourceGrid), sourceAnchor ?? 'trailing');
    const to   = resolveAnchor(getWorldBounds(targetGrid), targetAnchor ?? 'leading');
    connectionRenderer.set(id, from, to, color);

    // 4. optional label at midpoint
    if (label) {
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 1, z: (from.z + to.z) / 2 };
        // use existing label.create path
    }
}

function clearStep(connectionRenderer, ctx, step) {
    connectionRenderer.remove(step.id);
    restoreGridState(ctx, sourceIdx);
    restoreGridState(ctx, targetIdx);
}
```

---

## 4. Frustum interaction

GridVirtualizer removes grids from the scene when off-screen. A connection from an
off-screen grid has an endpoint that may not reflect the grid's actual position (the
grid's matrixWorld is still valid even when not in scene — `scene.remove` doesn't reset
transforms).

**Chosen behavior: hide the connection when either endpoint grid is off-screen.**

Rationale: a line ending at an invisible grid misleads more than it informs. Directional
indicators (small arrow at viewport edge) are a phase-2 feature.

Implementation — ConnectionRenderer gains a per-frame visibility refresh hook:

```js
/**
 * Called each frame (or each virtualizer update). Hides connections whose grids are
 * off-screen. Does not modify the buffer — just toggles visibility per connection via
 * zero-area degenerate vertices when needed. Simpler: just set mesh.visible globally
 * for a tour pass, or track per-connection with a visible flag.
 *
 * Lightest approach: track {fromGrid, toGrid} per connection, zero the slot when
 * either grid is not in the scene (grid.parent === null).
 */
refreshVisibility() {
    let changed = false;
    for (const [id, entry] of this._connections) {
        const shouldShow = (!entry.fromGrid || entry.fromGrid.parent !== null)
                        && (!entry.toGrid   || entry.toGrid.parent   !== null);
        if (shouldShow !== entry.visible) {
            entry.visible = shouldShow;
            if (shouldShow) {
                this._writeSlot(entry.slot, entry.from, entry.to, entry.color);
            } else {
                this._zeroSlot(entry.slot);
            }
            changed = true;
        }
    }
}
```

Store `fromGrid` / `toGrid` references in the entry. Check `grid.parent !== null` as the
off-screen test — GridVirtualizer uses `scene.remove` which sets `parent` to null.

Call `refreshVisibility()` from the application animate loop, after
`virtualizer.update()`.

---

## 5. Performance

| Item | GPU cost |
|---|---|
| ConnectionRenderer geometry | ~36 KB VRAM (MAX_CONNECTIONS=256), 1 draw call |
| Per `set()` call | 2× `addUpdateRange` partial buffer upload |
| Per `refreshVisibility()` | At most N slot writes (N active connections), degenerate-zero |
| Per frame (no changes) | Zero uploads, 1 draw call for all lines |

Key points:

- `addUpdateRange` is used on every `_writeSlot`. Three.js uploads only the flagged range.
  Multiple ranges per frame accumulate and are cleared by Three.js after render.
- The shaft + arrowhead shares one geometry object. One `gl.drawArrays` for all connections.
- `frustumCulled = false` on the LineSegments mesh is correct: connections span arbitrary
  world space and the geometry bounding box would need per-frame recomputation to be useful.
- `depthWrite: false` on the line material prevents lines from occluding grid glyph quads
  at the same z-depth. Grid quads write depth; lines read it.
- `renderOrder = 1` ensures lines render after the default opaque pass (renderOrder 0).

---

## 6. File placement

```
src/
└── annotations/
    ├── ConnectionRenderer.js    ← new, per this document
    └── index.js                 ← barrel: export { default as ConnectionRenderer }
```

The `src/annotations/` directory is new. It is a peer of `src/collections/`, not nested
inside it — connections are not collection items; they are scene-level overlay objects.

`ConnectionRenderer` is registered in `src/index.js` main exports and optionally as a
named export in `package.json` exports map at `glyph3d-js/annotations`.

The tour command handlers that drive connections live in `app/commands/handlers/tourCommands.js`
(new file, app layer). They import `ConnectionRenderer` from `src/annotations/`, instantiate
it once in the command context (`ctx.connectionRenderer`), and drive it via `set`/`remove`/`clear`.
