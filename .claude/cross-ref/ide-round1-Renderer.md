# IDE Feature Analysis — Renderer Specialist Round 1

Analysis of five IDE-like visual features for glyph3d-js, examining each through the lens of the existing GPU pipeline.

---

## 1. Selection Highlighting

### Goal
Visually distinguish one or more selected files (CodeGrids) from the rest.

### Approach A: Group color tint via DataTexture (recommended primary)

Each CodeGrid's GlyphCollection can assign all its glyphs to one groupId. On selection, call `setGroupColor(groupId, { r, g, b, a })` with a highlight color. The vertex shader multiplies `instanceColor * gColor.rgb`, so a tint like `{ r: 1.5, g: 1.5, b: 0.5 }` brightens selected glyphs warm-yellow. Setting the group color back to `{ r: 1, g: 1, b: 1 }` (identity) deselects instantly.

Cost: 1 DataTexture texel write + `needsUpdate = true` per selection event. The DataTexture is 4KB; the re-upload is negligible. No geometry changes, no draw-call additions. Works today — `setGroupColor` and `setGroupColorBlend` are already live.

For a "replace" highlight (override per-glyph colors entirely, e.g. render everything in bright cyan): set `setGroupColorBlend(groupId, 1.0)`. This drives the `colorBlend` path in the vertex shader: `vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend)`. At 1.0, the group color fully replaces per-glyph colors, making the entire file a solid hue. Restore with `setGroupColorBlend(groupId, 0.0)`.

No shader changes needed.

### Approach B: Z-offset pop-forward via group offset

Call `setGroupOffset(groupId, { x: 0, y: 0, z: 5 })` to push selected file forward in Z. Combines well with the tint: glyphs pop out of the plane visually. Same cost as approach A.

Caution: Z-pop interacts poorly with BackdropManager planes at fixed Z values. If backdrops are at `z = depth * -depthZ`, a selected grid's glyphs will penetrate backdrops of neighboring directories.

### Approach C: Per-file backdrop color change

BackdropManager already creates a `THREE.PlaneGeometry` + `MeshBasicMaterial` per directory. For file-level selection, there is no per-file backdrop today (only per-directory). Adding one would mean: create a new MeshBasicMaterial for each file's background panel with a highlight color. This is O(1) material property change (`material.color.set(...)`) but adds another draw call per file background visible. For 100+ files on screen, that's 100+ extra draw calls.

**Verdict**: Not recommended as primary mechanism. Better to use it as a secondary visual (border glow), or defer to the group tint above.

### Approach D: Outline via edge detection shader

This would require a two-pass render: first render to a render target, then a full-screen post-processing pass detecting edges. Three.js `EffectComposer` + `OutlinePass` can do this. Cost is a full-resolution framebuffer + additional render pass every frame. For 60fps at 4K that is expensive; for 1080p it's workable.

The existing renderer has `frustumCulled = false` and renders as a single draw call. An outline pass would add at minimum one extra draw call for the outline geometry, plus the framebuffer overhead.

**Verdict**: Visually the richest option, but complexity and cost are high. Good for a "selected file detail view" panel, not for highlighting many files simultaneously.

### Recommended combination

Selection: group tint (approach A) + Z-offset of +3 (approach B). Costs two DataTexture writes. Deselection resets both to identity. Instant, zero-allocation, no shader changes.

---

## 2. Minimap Rendering

### Goal
A second small viewport showing the full treemap layout from above, giving navigation context.

### Option A: Orthographic camera to a WebGLRenderTarget

Create a `THREE.OrthographicCamera` looking down at the scene (negative Z axis, or Y axis depending on layout orientation). Each frame, render to a `WebGLRenderTarget` (e.g. 512x512), then display as a `THREE.Sprite` or HTML `<img>` in the corner of the screen.

Cost: a second render pass of the full scene every frame. With 100k+ glyphs in one draw call, the single instanced draw is cheap, but Three.js still traverses the scene graph, computes frustum culling (even though all meshes have `frustumCulled = false`), and uploads the framebuffer to a render target. Typical overhead: 1–4ms for the secondary pass.

The minimap camera can use a much lower resolution render target (256x256 or even 128x128 given the zoomed-out view), reducing fill-rate cost. The atlas texture will show at very low resolution but is still readable as color shapes.

Shader implication: none. The same instanced mesh renders into both cameras.

### Option B: HTML canvas overlay (CPU-side minimap)

Maintain a 2D `<canvas>` overlay. When layout changes, draw colored rectangles representing each file's bounding box (using `getDirectoryBounds()` from TreemapLayoutManager). No GPU second pass. Mouse click on the minimap canvas converts from minimap 2D coordinates to world coordinates and moves the main camera.

Cost: zero GPU cost. Canvas 2D draw on layout change only (not per frame). Limitation: does not show actual glyph content, only colored blocks. For a code visualization tool this is usually sufficient for navigation.

### Option C: Scissor-test viewport within main canvas

Use `renderer.setViewport()` and `renderer.setScissor()` per frame to render a corner of the main canvas with the orthographic camera, then restore viewport for the main view. Two render passes but no render target allocation. Works but requires careful cleanup of viewport state between passes.

### Recommendation

Option B (HTML canvas overlay) for initial implementation — zero GPU overhead, interactive, simple to implement. Option A (RenderTarget) for a polished second pass if glyph-level detail in the minimap is needed. Do not implement Option C — it complicates the render loop.

Performance note: if Option A is implemented, render at 128x128 and throttle to 10fps (update every 6 frames). The minimap only needs to update when camera or layout changes, not every frame.

---

## 3. File/Directory Labels in Treemap Mode

### Goal
Show filename and directory labels positioned at the actual packed treemap locations.

### Current state
NameplateManager builds labels using the HierarchicalLayoutManager's tree node positions (`node.position.x`, `node.position.y`). TreemapLayoutManager uses `grid.position.set(x, y, z)` on the CodeGrid Object3D. The two systems do not share position data — NameplateManager reads from tree nodes, not from CodeGrid world positions.

### Option A: Extend NameplateManager to accept CodeGrid positions (recommended)

Add a `createNameplatesFromGrids(grids)` method to NameplateManager (or a new `TreemapNameplateManager`). For each grid, read `grid.position` and `grid.getBounds()` after layout, compute the label position as:

```
x = grid.position.x + bounds.width / 2  // centered above file
y = grid.position.y + bounds.height / 2 + yOffset
z = grid.position.z + zOffset
```

Then create a CodeGrid per label exactly as the existing `_createNameplateForNode` does. The CodeGrid/GlyphCollection pipeline handles the text rendering. A short filename (say 20 chars) costs ~20 glyph instances per label. For 200 files that is 4000 instances — well inside the 10k cap.

The labels can share the scene's main GlyphRenderer if the shared-renderer architecture (future work) is in place. For now each label creates its own CodeGrid/GlyphCollection, which means a separate draw call per label. 200 labels = 200 draw calls beyond the file content renderers. This is the real cost.

### Option B: HTML `<div>` labels (overlay approach)

After layout, project each grid's world position through the camera to screen space (`vector.project(camera)`) and position a `<div>` at those screen coordinates. No GPU cost. Downside: HTML labels do not participate in 3D depth, do not scale with zoom as naturally, and require a CSS overlay system.

### Option C: Batch all label text into one GlyphCollection

Instead of one CodeGrid per label, maintain a single GlyphCollection for all treemap labels. Call `addText(filename, { x, y, z })` per file, then `flush()` once. All labels render in one draw call. On relayout, call `updatePosition(id, newPos)` per label — direct buffer write, no rebuild. This is the most GPU-efficient approach.

### Recommendation

Option C is cleanest from a rendering perspective. Create a `TreemapLabelCollection` that wraps one GlyphCollection, maps grid → text ID, and calls `updatePosition` on relayout. This keeps all label text in a single draw call and fits the zero-rebuild update pattern.

For directory labels (larger, brighter), use a second GlyphCollection with a larger worldScale.

---

## 4. Search Highlighting

### Goal
Highlight glyphs that match a search query across visible files.

### The granularity problem

The group DataTexture operates at the CodeGrid (file) granularity — one groupId per file. Highlighting individual characters requires sub-file granularity. The existing `updateColor(id, newColor)` on GlyphRenderer writes directly to the `instanceColor` Float32Array, which is per-glyph.

But today there is no mapping from "character at row R, column C in file F" to an instance buffer index. The `renderedTexts` map in GlyphRenderer stores `{ bufferStartIndex, glyphs[] }` per text string. A full line of a file is typically one text entry. To reach a specific character, the caller must know the character's offset within that line's entry.

### Option A: Per-glyph color update (requires index tracking)

Add a `charToInstanceIndex(fileId, line, col)` lookup to CodeGrid or GlyphCollection that returns the buffer slot index. Then call `updateColor` at that slot directly (bypassing the text-entry-level API). This is a direct write into `instanceColor.array[slotIndex * 3]`, sets `needsUpdate = true`.

For a search producing N matches across M files: N direct writes to the `instanceColor` array + one `needsUpdate = true` per renderer. If all matches are in one renderer, that is 1 GPU re-upload of the full color attribute (typically 10k * 3 * 4 = ~120KB).

Cost for 100 matches across 5 files: 5 x 120KB re-uploads = 600KB GPU transfers. Feasible at 60fps if search runs at user keystroke rate (debounced, not per frame).

### Option B: Search overlay mesh

Add a second instanced mesh of flat colored quads (no atlas texture needed — just solid color) at search match positions. This is a separate draw call but avoids touching the main renderer's color buffer. The overlay quads sit slightly in front of the text (Z+0.5) and use a transparent blended material (additive or alpha blend).

Pros: does not dirty the main color attribute. Cons: a second instanced mesh with its own buffer (N quads for N matches). Need to rebuild the overlay buffer on each new search.

### Option C: Group-level file highlighting

Mark entire files that contain matches with `setGroupColor(groupId, { r:1.2, g:1.2, b:0.5 })`. This does not highlight specific characters but shows "this file has matches." Zero buffer cost, only DataTexture writes.

### Recommendation

Start with Option C for the first pass — highlight matching files via group color. For character-level highlighting, add Option B (overlay mesh) as a separate feature. Option A is viable but requires adding character-index tracking to the collection layer, which is a non-trivial refactor of how text entries are stored.

For the overlay mesh approach, the buffer builder can be a simple loop: for each match, store its world position (from the glyph's known atlas coordinates + grid offset). Build a Float32Array of positions, create an InstancedBufferGeometry with just `instancePosition` (vec3) and `instanceSize` (vec2). The fragment shader outputs a flat highlight color with 50% alpha. This mesh is completely separate from the atlas-based text rendering.

---

## 5. Hover/Focus Effects

### Goal
Instant visual feedback when the mouse hovers over a file grid.

### Raycast strategy

Raycasting against individual glyph instances is prohibitively expensive — the CPU would need to test all 10k+ instance quads. The correct level is the file's bounding box.

CodeGrid has a `getBounds()` method returning a `THREE.Box3`. For hover detection, build an array of `{ box3, groupId, grid }` once after layout. Each frame on mouse move, convert the mouse to a ray and test `box3.intersectsRay(ray)`. For 200 files this is 200 AABB tests — O(200) per mousemove, negligible.

On hover enter: `setGroupColor(groupId, { r: 1.3, g: 1.3, b: 1.3 })` — a subtle brightening. Cost: 1 DataTexture write.
On hover exit: restore identity color `{ r: 1, g: 1, b: 1 }`. Cost: 1 DataTexture write.

No shader changes needed.

### Mouse-to-ray conversion

```javascript
// In the mousemove handler:
const rect = renderer.domElement.getBoundingClientRect();
const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
);
raycaster.setFromCamera(mouse, camera);
```

Then iterate the bounding-box array. Cache the previous hovered groupId to avoid redundant DataTexture writes when the mouse stays over the same file.

### Focus (click) effects

On click of the hovered grid, set a stronger highlight: `setGroupColorBlend(groupId, 0.5)` with a distinct color. Or combine with a Z-offset for a "selected" appearance (see section 1).

### Cursor fade

For a more refined UX: a radial "spotlight" effect where glyphs near the cursor are brighter. This would require a `vec2 cursorScreenPos` uniform and a distance calculation in the vertex or fragment shader. Cost: one uniform update per frame (trivial). The distance calculation in the fragment shader would be `length(gl_FragCoord.xy - cursorPos)` and apply a falloff. This adds ~3 ALU instructions per fragment — negligible for typical fill rates.

---

## Summary Table

| Feature | Mechanism | Shader changes | Per-frame cost | New code |
|---------|-----------|----------------|----------------|----------|
| Selection highlight | group color tint + Z-offset | None | 0 (event-driven) | None — existing API |
| Minimap (nav) | HTML canvas overlay | None | 0 (layout-driven) | ~100 LOC canvas |
| Minimap (glyph detail) | WebGLRenderTarget + ortho camera | None | 1–4ms extra render pass | ~50 LOC |
| Treemap labels (efficient) | Single GlyphCollection for all labels | None | 0 | ~150 LOC new collection |
| Search (file-level) | group color | None | 0 (event-driven) | None |
| Search (char-level) | overlay instanced mesh | New minimal shader | Rebuild overlay buffer on search | ~200 LOC |
| Hover | AABB raycast + group color | None | O(N) AABB tests in mousemove | ~50 LOC |
| Cursor spotlight | cursorPos uniform + frag shader falloff | Fragment (3 ALU) | 1 uniform write/frame | ~20 LOC shader |

---

## Key architectural observations

**Group DataTexture is the workhorse for interactive effects.** All five features can use it as the primary mechanism for visual state changes. The texture is tiny (4KB at 64 groups), re-uploads are negligible, and the update is O(1) regardless of glyph count. Features 1 and 5 use it exclusively with zero shader changes.

**`setGroupColorBlend` is underused.** It exists in the renderer but no example uses it. For selection highlighting (replace per-glyph syntax colors with a uniform selection color) this is exactly the right primitive.

**Per-glyph color updates trigger a full attribute re-upload.** The `instanceColor` buffer is 10k entries even if only 100 change. For search highlighting at character level, the overlay mesh pattern avoids touching the main buffer entirely.

**Treemap labels need a shared GlyphCollection, not one CodeGrid per label.** One CodeGrid per label means one draw call per label, breaking the single-draw-call architecture. A shared collection for all labels keeps this to 1–2 draw calls regardless of file count.

**Minimap is free if HTML-based.** The 3D render target option is only justified if users need to see actual glyph characters in the minimap (e.g., to navigate by code content). For pure navigation, 2D colored rectangles in a canvas overlay are sufficient and have zero GPU overhead.
