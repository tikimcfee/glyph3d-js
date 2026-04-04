# Round 3: data-source-abstraction convergence

## Settled

All points are now fully resolved. The five Round 1 reviews achieved convergence on every substantive question. No Round 2 was needed.

1. **Per-glyph cost is 10 floats = 40 bytes instance data + 4 bytes RGBA8 highlight = 44 bytes effective.** All five agents confirmed the "11 floats" claim in universal-text-pipeline was wrong. The buffer contract is 10 floats across 5 typed arrays. The highlight texture is a separate resource, not an 11th float. Settled unanimously.

2. **`GlyphBufferSet` is the portability seam, not a GPU abstraction layer.** rendering-backend-portability's 13-function `GlyphGPU` interface is a requirements spec, not a runtime implementation target. prior-art-lessons' Zed/Blade warning was decisive. Three.js for browser, wgpu for native. The typed-array handoff between `buildBatchBuffers()` and `applyPrebuiltBuffers()` is the right boundary. Settled: rendering-backend-portability, universal-text-pipeline, prior-art-lessons all agree.

3. **`TextSource` is the input portability seam.** The system needs two explicit seams: `TextSource` (where content enters) and `GlyphBufferSet` (where typed arrays exit toward the GPU). universal-text-pipeline confirmed these are complementary, not competing. The full pipeline is `TextSource -> buildBatchBuffers() -> GlyphBufferSet -> GPU backend`. Settled: my analysis + universal-text-pipeline.

4. **GridVirtualizer culls draw calls, not VRAM.** device-tier-scaling's finding was the single most impactful discovery across all five analyses. Every other agent acknowledged this gap. Buffer eviction for off-screen grids is mandatory on Tier 1-2 devices. Settled unanimously.

5. **Bitmap atlas now, MSDF later, pre-baked atlas as the bridge.** prior-art-lessons showed every shipping project chose bitmap. universal-text-pipeline's pre-baked atlas strategy (`loadAtlas(imageUrl, descriptorUrl)`) decouples generation from rendering, making MSDF a build-time swap. device-tier-scaling's multi-resolution pre-baked atlases (512/1024/2048) solve tier scaling simultaneously. Settled: prior-art-lessons + universal-text-pipeline + device-tier-scaling.

6. **WebGL context loss handling is a production requirement.** device-tier-scaling identified it; no other agent had addressed it. On mobile, backgrounding a tab destroys all WebGL state. `SourceBoundGrid` needs `onContextRestored()` to re-flush from latest source state. Settled: device-tier-scaling, endorsed by all.

7. **Async-first picking readback.** rendering-backend-portability proposed `readPixel -> Promise`. device-tier-scaling proposed per-frame throttling on mobile. Both are correct and complementary. The API should be async even on WebGL2 (`Promise.resolve(pixel)`) to prevent sync assumptions from spreading before WebGPU. Settled: rendering-backend-portability + device-tier-scaling.

8. **Merge throttling into `SourceBoundGrid`, do not ship separate `ThrottledSourceBridge` and `SourceUpdateScheduler`.** prior-art-lessons' xi-editor warning and device-tier-scaling's over-modularization flag were both correct. The coalescing logic is ~15 lines. `TextSource` and `SourceBoundGrid` are the only two new classes needed at launch. The scheduler/throttle layers are deferred until a concrete multi-stream use case demands them. Settled: prior-art-lessons + device-tier-scaling.

9. **Mali-400 supports `ANGLE_instanced_arrays` but lacks `gl_InstanceID`.** device-tier-scaling's original "lacks instancing entirely" was imprecise. The failure mode is: instanced draw calls work, but picking and highlighting silently break because the shader cannot address individual instances. The ES 3.0 hard floor stands -- the degradation path below it is a separate text output system (Canvas 2D or HTML), not a degraded version of the instanced pipeline. Settled: my correction, confirmed by rendering-backend-portability.

10. **LOD via GridVirtualizer's existing `entry.distance` is the highest-impact rendering optimization.** Near/mid/far bands with solid-color quads at mid-range and single rectangles at far-range cut active glyph count by 80-90%. The data already exists in the virtualizer update loop. Settled: device-tier-scaling, endorsed by universal-text-pipeline and prior-art-lessons.

11. **Deferred updates for frustum-culled grids with staleness flag.** When a grid is off-screen, queue the latest source event. When it re-enters the frustum, check the staleness flag and apply before the next render frame. Combined with buffer eviction (point 4), this means off-screen grids hold neither GPU buffers nor pending update processing. Settled: my analysis, endorsed by device-tier-scaling.

12. **Backpressure parameterized by device tier.** My `ThrottledSourceBridge` maxFps and device-tier-scaling's frame budget are the same system viewed from different ends. On Tier 1-2 devices, coalescing interval drops to 200ms (5 FPS). On Tier 4, it can run at 33ms (30 FPS). The device tier parameterizes source update rate. Settled: my analysis + device-tier-scaling.

13. **`buildBatchBuffers()` is the correct function name, not `buildBuffers()`.** My Phase 0 call chain had a stale name. universal-text-pipeline and prior-art-lessons both flagged this. Settled.

14. **Float precision ceiling on picking IDs at 2^23.** rendering-backend-portability identified that `vPickingId` as a float varying loses precision above 8,388,608. The fix is `flat out int vPickingId` (supported in GLSL ES 3.00). Not urgent at 10K glyphs per mesh, but should be documented as a scalability ceiling. Settled: rendering-backend-portability.

## Implementation Plan

This plan focuses on the data-source layer: the `TextSource` contract, `SourceBoundGrid` lifecycle, and the integration points where data flow meets rendering, memory management, and device adaptation.

### Phase 1: TextSource contract and core implementations

**File: `src/sources/TextSource.js`** (new)

The base class / interface. Minimal, no framework dependencies, importable from workers.

```javascript
/**
 * @typedef {'ready'|'loading'|'streaming'|'error'|'closed'} SourceState
 * @typedef {{type: 'content'|'append'|'patch'|'reset'|'error'|'closed', text?: string, edits?: Array, error?: Error}} SourceEvent
 */
export default class TextSource {
    get uri() { throw new Error('Not implemented'); }
    get state() { throw new Error('Not implemented'); }
    async read() { throw new Error('Not implemented'); }
    onChange(callback) { throw new Error('Not implemented'); }
    async open() { /* no-op default */ }
    async close() { /* no-op default */ }
}
```

**File: `src/sources/FileTextSource.js`** (new)

Wraps `FileSystemProvider.readFile()` and its `onDidChange` notifications. Produces `{ text, meta: { uri } }` from `read()`. Fires `{ type: 'content', text }` on external file change.

**File: `src/sources/SyntheticSource.js`** (new)

For REPL output, diff views, generated content. Exposes `set(text)` and `patch(edits)` for external callers. This replaces the ad-hoc pattern in `AgentGrid.write()` / `appendLine()`.

**File: `src/sources/StreamSource.js`** (new)

WebSocket-backed. Accumulates lines in a ring buffer with configurable `maxLines` (default 10,000). Fires `append` events normally, switches to `content` (full replacement) when lines are evicted from the ring buffer head. State transitions: `streaming` -> `closed` on WebSocket close.

**File: `src/sources/GitHubFileSource.js`** (new)

Wraps GitHub API file fetch. `onChange` is a no-op (GitHub has no push notifications). Static after initial `read()`.

**File: `src/sources/index.js`** (new)

Barrel export for all source types.

### Phase 2: SourceBoundGrid lifecycle manager

**File: `src/sources/SourceBoundGrid.js`** (new)

This is the central piece. It pairs a `TextSource` with a `CodeGrid` and manages the full lifecycle: initial load, incremental updates, frustum-culled deferral, backpressure coalescing, context loss recovery, and disposal.

```javascript
import TextSource from './TextSource.js';

export default class SourceBoundGrid {
    /**
     * @param {TextSource} source
     * @param {CodeGrid} grid
     * @param {Object} [options]
     * @param {number} [options.coalesceMs=100] - Min interval between renders
     */
    constructor(source, grid, { coalesceMs = 100 } = {}) {
        this.source = source;
        this.grid = grid;
        this._coalesceMs = coalesceMs;
        this._unsub = null;
        this._stale = false;
        this._pendingEvent = null;
        this._frustumCulled = false;
        this._coalesceTimer = null;
        this._pendingText = null;
    }

    async bind() {
        const content = await this.source.read();
        await this.grid.loadTextAsync(content.text);

        this._unsub = this.source.onChange((event) => {
            this._onSourceEvent(event);
        });
    }

    _onSourceEvent(event) {
        // Frustum-culled: defer
        if (this._frustumCulled) {
            this._pendingEvent = event;
            this._stale = true;
            return;
        }

        // Coalesce rapid updates
        if (event.type === 'append' || event.type === 'content') {
            this._pendingText = event.type === 'append'
                ? (this._pendingText ?? this.grid.content) + '\n' + event.text
                : event.text;

            if (!this._coalesceTimer) {
                this._coalesceTimer = setTimeout(
                    () => this._flushCoalesced(),
                    this._coalesceMs
                );
            }
            return;
        }

        // Patch and reset: apply immediately
        this._applyEvent(event);
    }

    _flushCoalesced() {
        this._coalesceTimer = null;
        if (this._pendingText !== null) {
            this.grid.loadText(this._pendingText);
            this._pendingText = null;
        }
    }

    async _applyEvent(event) {
        switch (event.type) {
            case 'content':
            case 'reset':
                await this.grid.loadTextAsync(event.text);
                break;
            case 'append':
                // Full replacement until Tier 2 append is implemented
                this.grid.loadText(this.grid.content + '\n' + event.text);
                break;
            case 'patch':
                // Full replacement until Tier 3 patch is implemented
                await this.grid.loadTextAsync(
                    applyTextEdits(this.grid.content, event.edits)
                );
                break;
            case 'error':
                console.warn(`Source error [${this.source.uri}]:`, event.error);
                break;
            case 'closed':
                // Grid stays visible as last-known state
                break;
        }
    }

    /** Called by GridVirtualizer when grid leaves frustum */
    onBecameInvisible() {
        this._frustumCulled = true;
    }

    /** Called by GridVirtualizer when grid enters frustum */
    onBecameVisible() {
        this._frustumCulled = false;
        if (this._stale) {
            this._applyEvent(this._pendingEvent);
            this._stale = false;
            this._pendingEvent = null;
        }
    }

    /** Called on WebGL context restore */
    async onContextRestored() {
        const content = await this.source.read();
        await this.grid.loadTextAsync(content.text);
    }

    async unbind() {
        this._unsub?.();
        this._unsub = null;
        if (this._coalesceTimer) {
            clearTimeout(this._coalesceTimer);
            this._coalesceTimer = null;
        }
    }

    dispose() {
        this.unbind();
        this.source.close();
        this.grid.dispose();
    }
}
```

Key design decisions in this class:
- Coalescing is built-in, not a separate wrapper (per prior-art-lessons' modularity warning).
- `coalesceMs` is constructor-configurable so device-tier-scaling can set it (100ms for Tier 3-4, 200ms for Tier 1-2).
- Frustum-culled deferral stores only the latest event (not a queue). For streams, this means some intermediate lines are lost while off-screen -- acceptable because the full content is always available via `source.read()`.
- Context loss recovery re-reads from the source, not from cached grid state.

### Phase 3: Integration with existing systems

**File: `src/collections/GridVirtualizer.js`** (modify)

Add hooks for `SourceBoundGrid` visibility callbacks. The virtualizer already tracks which grids enter/leave the frustum. Add:

```javascript
// In _updateVisibility(), after adding grid to scene:
if (entry.sourceBound) {
    entry.sourceBound.onBecameVisible();
}

// After removing grid from scene:
if (entry.sourceBound) {
    entry.sourceBound.onBecameInvisible();
}
```

Add a second distance threshold for buffer eviction (device-tier-scaling's finding):

```javascript
// New constant: eviction distance = 3x visibility distance
const EVICTION_DISTANCE_FACTOR = 3.0;

// In _updateVisibility(), after frustum check:
if (entry.distance > entry.visibilityRadius * EVICTION_DISTANCE_FACTOR) {
    if (!entry.evicted) {
        entry.grid.unloadContent();  // new method on CodeGrid
        entry.evicted = true;
    }
} else if (entry.evicted && entry.visible) {
    // Re-entering: reload from source
    entry.sourceBound?.onBecameVisible();
    entry.evicted = false;
}
```

**File: `src/collections/CodeGrid.js`** (modify)

Add `unloadContent()` method that disposes GPU buffers but preserves the grid's position, metadata, and source binding:

```javascript
unloadContent() {
    this.collection?.dispose();
    this._contentLoaded = false;
}
```

Add a `content` getter that returns the last-loaded text string (needed by `SourceBoundGrid` for append coalescing).

**File: `src/GlyphRenderer.js`** (modify)

Add `webglcontextlost` and `webglcontextrestored` event listeners. On context restore, re-create shader programs, re-upload atlas texture, and trigger re-flush of all bound sources. The renderer should emit an event that `SourceBoundGrid` instances can listen to.

**File: `app/GitHubRepoViewer.js`** (modify)

Refactor `createGridForFileAsync()` to create a `SourceBoundGrid` wrapping a `GitHubFileSource` instead of directly calling `grid.loadFileAsync()`. This is the adoption point where the existing app transitions to the source abstraction.

**File: `app/IDEShell.js`** (modify)

When loading local files via the WebSocket relay, create `FileTextSource` instances wrapping the `RemoteFileSystemProvider`. Wire `onDidChange` notifications through so file saves propagate as `content` events to the bound grid.

### Phase 4: Package export

**File: `src/index.js`** (modify)

Add exports for all source types:

```javascript
export { default as TextSource } from './sources/TextSource.js';
export { default as FileTextSource } from './sources/FileTextSource.js';
export { default as StreamSource } from './sources/StreamSource.js';
export { default as SyntheticSource } from './sources/SyntheticSource.js';
export { default as SourceBoundGrid } from './sources/SourceBoundGrid.js';
```

### What is explicitly NOT in this plan

- **`ThrottledSourceBridge`**: Merged into `SourceBoundGrid._onSourceEvent()`. No separate class.
- **`SourceUpdateScheduler`**: Deferred. The per-grid coalescing in `SourceBoundGrid` is sufficient until a use case with 50+ simultaneously-streaming sources emerges.
- **Tier 2 append (extending GPU buffer without full rebuild)**: Future work. Requires `GlyphCollection.appendText()` with `addUpdateRange()`. The current plan falls back to full replacement for append events.
- **Tier 3 patch (line-granular buffer edits)**: Future work. Requires gap-buffer or segmented-buffer in `GlyphCollection` plus `_lineSlotBase` rebuild. The current plan falls back to full replacement for patch events.
- **MSDF atlas**: Separate concern, addressed by the pre-baked atlas path from universal-text-pipeline.
- **LOD system**: Belongs to device-tier-scaling's implementation plan, not the data-source layer. `SourceBoundGrid` is LOD-agnostic.

### File summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/sources/TextSource.js` | New | ~30 |
| `src/sources/FileTextSource.js` | New | ~60 |
| `src/sources/SyntheticSource.js` | New | ~45 |
| `src/sources/StreamSource.js` | New | ~70 |
| `src/sources/GitHubFileSource.js` | New | ~35 |
| `src/sources/SourceBoundGrid.js` | New | ~120 |
| `src/sources/index.js` | New | ~10 |
| `src/collections/GridVirtualizer.js` | Modify | ~30 added |
| `src/collections/CodeGrid.js` | Modify | ~15 added |
| `src/GlyphRenderer.js` | Modify | ~25 added |
| `app/GitHubRepoViewer.js` | Modify | ~40 changed |
| `app/IDEShell.js` | Modify | ~30 changed |
| `src/index.js` | Modify | ~6 added |
| **Total** | | **~516** |

## Implementer Vote

**device-tier-scaling** should implement.

Reasoning: The data-source abstraction layer is fundamentally a lifecycle and resource management system. The most critical integration points are not the source types themselves (those are straightforward adapters) but the interactions with memory budgets, frustum-culled buffer eviction, context loss recovery, and tier-parameterized coalescing intervals. device-tier-scaling produced the single most impactful finding in the entire cross-ref (GridVirtualizer culls draw calls but not VRAM) and understands the memory/performance constraints that `SourceBoundGrid` must respect. The buffer eviction threshold, the coalescing interval scaling by device tier, and the context-loss recovery path all live at the intersection of data-source lifecycle and device capability -- exactly where device-tier-scaling has demonstrated the deepest understanding.

rendering-backend-portability would be the second choice (it understands the GPU resource lifecycle and the `addUpdateRange` partial upload pattern), but its focus is the GPU contract, not the data-flow-to-rendering bridge. universal-text-pipeline is too focused on the buffer builder internals. prior-art-lessons is an analytical perspective, not an implementation one.
