# Phase 0 Analysis: GPU Memory, Draw Calls, and Texture Efficiency

**Agent**: GPU  
**Focus**: VRAM audit, texture sharing, instance attribute efficiency, draw call structure  
**Scope**: 555 CodeGrids, 6.1M total glyphs, Slug vector rendering pipeline

---

## 1. VRAM Audit: Concrete Numbers

### 1.1 Per-Renderer GPU Resources (Each of 555 CodeGrids)

Every CodeGrid creates one GlyphCollection, which creates one GlyphRendererV15. Each renderer allocates:

| Resource | Size formula | Typical size (11K glyphs/grid) |
|---|---|---|
| **Instance position** (Float32, 3/glyph) | count * 12 B | 132 KB |
| **Instance size** (Float32, 2/glyph) | count * 8 B | 88 KB |
| **Instance glyphId** (Float32, 1/glyph) | count * 4 B | 44 KB |
| **Instance color** (Float32, 3/glyph) | count * 12 B | 132 KB |
| **Instance groupId** (Float32, 1/glyph) | count * 4 B | 44 KB |
| **Highlight texture** (RGBA8, 1024-wide) | ceil(count/1024) * 1024 * 4 B | 48 KB |
| **Group texture** (RGBA Float, 4x64) | 64 * 4 * 16 B | 4 KB |
| **ShaderMaterial** (compiled program) | ~GPU driver overhead | ~50 KB est. |
| **Geometry + base quad** | fixed | ~1 KB |
| **Slug texture refs** (uniforms only) | 0 B (shared) | 0 B |

**Per-renderer total**: ~493 KB per grid at 11K glyphs.

**Instance attribute subtotal per glyph**: 5 attributes = 10 floats = **40 bytes/glyph** on the GPU side. This is correct and verified at `GlyphRenderer.js:280-293`.

### 1.2 Total Instance Buffer VRAM (555 Grids, 6.1M Glyphs)

```
6,100,000 glyphs * 40 bytes = 244 MB  (instance attributes alone)
```

### 1.3 Highlight Textures (555 Grids)

Each renderer owns its own RGBA8 highlight DataTexture (`GlyphRenderer.js:202-232`). Width is always 1024, height = ceil(instanceCount / 1024).

```
6,100,000 glyphs * 4 bytes = 24.4 MB  (all highlight textures combined)
```

### 1.4 Group Textures (555 Grids)

Each renderer creates a 4-wide, 64-tall RGBA Float DataTexture (`GlyphRenderer.js:181-194`). That is 4 * 64 * 16 = 4,096 bytes per renderer.

```
555 * 4 KB = 2.2 MB  (all group textures combined)
```

This is wasteful. Each CodeGrid uses at most 2-3 groups (filename + content + maybe one more). 64 rows of group data per grid is over-provisioned by 20x.

### 1.5 Slug Textures (Shared -- Single Copy)

The three Slug RGBA16UI DataTextures are created once by SlugEncoder and shared across all renderers via `options.slugData` (`GlyphRenderer.js:43`, `GlyphCollection.js:48`). The renderer correctly does NOT dispose them (`GlyphRenderer.js:1632`).

For a typical TrueType monospace font with ~400 encoded glyphs, approximate sizes from SlugEncoder stats logging:

| Texture | Width | Est. height | Bytes/texel | Est. size |
|---|---|---|---|---|
| curveTexture | 1024 | ~10-20 rows | 8 (RGBA16UI) | 80-160 KB |
| bandTexture | 1024 | ~5-15 rows | 8 | 40-120 KB |
| glyphMapTexture | 1024 | 1-2 rows | 8 | 8-16 KB |

**Slug texture total**: ~130-300 KB. This is negligible -- well designed. Single copy shared via uniform reference.

### 1.6 Atlas Canvas and Textures (WASTE)

The atlas canvas (`GlyphAtlas.js:137-139`) is always created at the configured size (default 2048x2048). It is used for:
1. Canvas 2D rendering of glyphs during `generate()` 
2. Metrics measurement (`getCharSize()`, `getMetrics()`)
3. The `getSerializableUVMap()` / `getSerializableGlyphWidths()` for workers

The atlas canvas is **not** uploaded as a GPU texture by GlyphRendererV15 -- the renderer has zero references to `atlasTexture`, `atlasCanvas`, `getSharedThreeTexture`, or `getAtlasMapTexture`. Verified by grep across all of `GlyphRenderer.js`.

However:
- The `_sharedThreeTexture` (CanvasTexture) is only created on-demand via `getSharedThreeTexture(THREE)`. If nothing calls it, no GPU upload.
- The `_atlasMapTexture` (Float DataTexture) is only created on-demand via `getAtlasMapTexture(THREE)`. Same.
- The 2048x2048 Canvas2D still occupies **16 MB of system RAM** (RGBA8, not VRAM), and is kept alive for `ensureGraphemes()` dynamic additions.

**Finding**: The atlas canvas costs 16 MB RAM but 0 VRAM under the Slug pipeline. The canvas is still needed for metrics and dynamic glyph addition. No GPU waste here.

### 1.7 Background Planes (555 Grids)

Each CodeGrid creates a PlaneGeometry + MeshBasicMaterial for the background panel (`CodeGrid.js:511-519`). This is a separate draw call and material per grid.

```
555 grids * ~1 KB geometry + material overhead = ~0.5 MB
```

Modest, but 555 additional draw calls.

### 1.8 VRAM Summary

| Category | VRAM |
|---|---|
| Instance attribute buffers (6.1M glyphs) | **244 MB** |
| Highlight textures (555 grids) | **24.4 MB** |
| Group textures (555 grids) | **2.2 MB** |
| Slug textures (shared, 1 copy) | **~0.2 MB** |
| Shader programs (555 compilations) | **~28 MB** (est. 50KB/program) |
| Background meshes | **~0.5 MB** |
| **Total estimated VRAM** | **~300 MB** |

---

## 2. Material/Texture Sharing Analysis

### 2.1 What IS Shared (Good)

- **Slug textures** are created once by SlugEncoder and passed by reference through `atlas._slugData` to every CodeGrid -> GlyphCollection -> GlyphRendererV15. `GlyphRenderer.js:43` reads `options.slugData || (atlas && atlas._slugData)`. The dispose method at line 1632 explicitly skips them: `// Don't dispose Slug textures -- they're shared across all renderers`.

### 2.2 What is NOT Shared (Problem)

Each of the 555 renderers creates its own:

1. **ShaderMaterial** (`GlyphRenderer.js:259-276`) -- identical GLSL source, identical uniforms structure. 555 independent compilations of the same vertex + fragment shader. The GPU driver may cache compiled programs, but Three.js still creates 555 material objects and 555 uniform sets.

2. **Group DataTexture** (`GlyphRenderer.js:250-251`) -- a 4x64 RGBA Float texture. Most grids use only group 0 (identity transform). The 64-row default is set by `PERF_THRESHOLDS.defaultMaxGroups` in `constants.js:37`.

3. **Highlight DataTexture** -- necessarily per-renderer since highlight state is per-glyph. Cannot be shared.

### 2.3 Impact of 555 Separate Draw Calls

Each CodeGrid = 1 instanced draw call (the glyph mesh) + 1 draw call (background plane) = **1,110 draw calls** at full visibility. GridVirtualizer reduces this to ~10-50 visible grids (~20-100 draw calls), but all 555 grids' GPU buffers persist in VRAM whether visible or not.

The eviction system (`GridVirtualizer.js:267-303`) can call `unloadContent()` on far-away grids, which calls `GlyphCollection.dispose()`, which calls `GlyphRendererV15.dispose()` -- this correctly frees instance buffers, highlight texture, and group texture. But eviction is off by default (`enableEviction=false` at `GridVirtualizer.js:44`).

---

## 3. Instance Attribute Efficiency

### 3.1 Current Layout: 10 Floats = 40 Bytes/Glyph

| Attribute | Components | Bytes | Can it be derived? |
|---|---|---|---|
| instancePosition | vec3 | 12 | No -- per-glyph world position |
| instanceSize | vec2 | 8 | **YES** -- derivable from glyphId |
| instanceGlyphId | float | 4 | No -- needed for Slug lookup |
| instanceColor | vec3 | 12 | **PARTIALLY** -- most glyphs in a line share the same color (syntax token spans) |
| instanceGroupId | float | 4 | **YES** -- almost always 0 |

### 3.2 Deriving instanceSize from glyphId (Saves 8 bytes/glyph)

The vertex shader already does a `texelFetch` on `glyphMapTexture` using `instanceGlyphId` (`GlyphRenderer.js:371-378`). Glyph advance widths are deterministic per glyphId. If the glyphMapTexture stored normalized advance width in an unused channel (both `glyphInfo.z` and `.w` are used for band data, but we could add a second row or a separate tiny 1D lookup), the shader could compute `instanceSize` from `instanceGlyphId` + a uniform `worldScale`.

**Savings**: 8 bytes/glyph * 6.1M = **48.8 MB** VRAM saved.

**Implementation**: Add per-glyph normalized advance width to glyphMapTexture (e.g., pack into the unused `.zw` of a second texel row for each glyph, or create a small 1D Float texture of glyph widths keyed by glyphId). The vertex shader would compute:

```glsl
float glyphAdvance = texelFetch(glyphSizeTexture, ivec2(gid, 0), 0).x;
vec2 computedSize = vec2(glyphAdvance * worldScale, lineHeight);
```

Height is uniform across all glyphs (same font size), so it is just a uniform.

### 3.3 Compressing instanceGroupId (Saves 4 bytes/glyph)

Nearly all CodeGrid glyphs use groupId 0. The groupId is a float but only ever holds small integers. Two options:

- **Remove it entirely** if CodeGrid never uses groups: pass groupId=0 as a uniform default, add it back only for renderers that actually need multi-group. Saves 4 bytes/glyph.
- **Pack it into an existing attribute**: e.g., into the W component of instancePosition (currently vec3, could become vec4 with groupId in .w).

**Savings**: 4 bytes/glyph * 6.1M = **24.4 MB** VRAM saved.

### 3.4 Color Compression

instanceColor is vec3 float (12 bytes). Most source code lines have 2-4 distinct colors (keyword, string, comment, default). Options:

- **Palette index**: Store a uint8 color index per glyph, look up in a small palette texture. Reduces 12 bytes to 1 byte per glyph. Savings: 11 bytes * 6.1M = **67.1 MB**. This is the highest single-attribute saving.
- **RGB565 or RGB8 packed**: Pack into a single float or uint. Less flexible but still large savings.

### 3.5 Maximum Theoretical Savings

If all three optimizations are applied:

| Optimization | Savings |
|---|---|
| Derive instanceSize from glyphId | 48.8 MB |
| Remove/pack instanceGroupId | 24.4 MB |
| Palette-compress instanceColor | 67.1 MB |
| **Total** | **140.3 MB** (57% reduction) |

Reduced per-glyph cost: 40 -> ~17 bytes (position vec3 12B + glyphId 4B + colorIndex 1B).

---

## 4. Buffer Upload Strategy

### 4.1 Worker Path (Primary Path)

`applyPrebuiltBuffers()` at `GlyphRenderer.js:1426-1533` swaps in worker-built Float32Arrays as new `InstancedBufferAttribute` instances. This is a full buffer swap, not a partial upload -- but it happens once per grid at load time, which is correct.

### 4.2 Incremental Updates

`updatePosition()` (`GlyphRenderer.js:646-680`) and `updateColor()` (`GlyphRenderer.js:687-711`) correctly use `addUpdateRange()` for partial GPU uploads. Only the modified byte range is uploaded.

`updateAddedColor()` at line 719 sets `highlightTexture.needsUpdate = true` without `addUpdateRange`, causing a **full texture re-upload** of the entire highlight DataTexture. For a 11K-glyph grid this is 44 KB -- acceptable. For bulk highlight operations across many grids, this could be optimized.

### 4.3 Sync Path (Fallback)

`_rebuildAllInstances()` at line 1325 does a full CPU-side collection of all glyph data followed by `_updateInstanceMesh()` which writes every attribute and sets `needsUpdate = true` on all five attributes. This is a full re-upload. However, this path is rarely used -- the worker path dominates.

---

## 5. Shader Program Duplication

### 5.1 The Problem

Each GlyphRendererV15 constructor creates a new `THREE.ShaderMaterial` with inline GLSL (`GlyphRenderer.js:259-276`). Three.js identifies shader programs by source string reference and uniform structure. Since every renderer constructs its material independently with `new THREE.ShaderMaterial(...)`, Three.js may or may not deduplicate the compiled GPU program depending on internal caching behavior.

Even if the GL program is cached by the driver, each material still holds its own uniform state (an object with `.value` references). At 555 materials, the JS-side overhead is non-trivial: 555 uniform objects, 555 material instances in Three.js's internal tracking.

### 5.2 Solution: Shared Material with Per-Instance Uniforms

Three.js supports material sharing across meshes. The Slug textures and group texture are already per-renderer uniforms, but the Slug textures are shared objects and the group texture could be too (if we unified groups across grids).

A practical approach: create ONE ShaderMaterial prototype, then `.clone()` it for each renderer. Three.js clones share the compiled program and only diverge in uniform values. This eliminates 554 redundant shader compilations.

---

## 6. Prioritized Recommendations

### Tier 1: Highest Impact, Lowest Risk

**A. Enable eviction by default** (`GridVirtualizer.js:44`). Change `enableEviction` default to `true`. This is already implemented and tested -- it calls `unloadContent()` which properly disposes all GPU resources. At 555 grids with ~50 visible, this would reduce active VRAM from ~300 MB to ~27 MB (50/555 ratio). The reload-on-re-enter path via `reloadContent()` is also already implemented.

**B. Reduce defaultMaxGroups from 64 to 4** (`constants.js:37`). Each CodeGrid uses 1-2 groups. Changing to 4 saves: `555 * (64-4) * 4 * 16 = 2.1 MB` and reduces per-renderer texture overhead. The group texture auto-grows when `createGroup()` is called, so no functionality is lost.

### Tier 2: Significant Savings, Moderate Effort

**C. Derive instanceSize from glyphId in the shader**. Add a small glyph-width lookup texture (one float per glyphId, ~400 entries = 1.6 KB). Remove the `instanceSize` attribute. Saves 48.8 MB across 6.1M glyphs. Requires changes to: SlugEncoder (embed advance width in glyphMapTexture or new texture), vertex shader (compute size from lookup), buffer builders (stop emitting sizes array), applyPrebuiltBuffers (stop expecting sizes).

**D. Pack instanceGroupId into instancePosition.w**. Change instancePosition from vec3 to vec4, put groupId in the .w component. Removes one attribute. Saves 24.4 MB. Straightforward shader + buffer builder change.

### Tier 3: Large Savings, Higher Complexity

**E. Color palette compression**. Replace instanceColor vec3 (12 bytes) with a uint8 palette index (1 byte). Each grid maintains a palette of ~8-16 colors (syntax highlighting has limited cardinality). Saves 67 MB. Requires: a per-renderer palette texture, a new uint8 instance attribute, shader modification, and changes to the color update API.

**F. Shader material sharing**. Create one prototype material, clone per renderer. Reduces shader compilation time and JS object overhead. Three.js `Material.clone()` shares the compiled program.

### Tier 4: Architectural (Future)

**G. Multi-grid merged draw calls**. Multiple CodeGrids could share a single GlyphRendererV15 by using group transforms to position them. This would reduce 555 draw calls to ~1-5 merged calls. Major architectural change -- requires rethinking the CodeGrid-owns-its-renderer model. The group transform system already supports this conceptually, but the current 64-group limit would need to become 555+.

---

## 7. Key Code References

| Finding | File | Lines |
|---|---|---|
| Per-renderer material creation | `src/GlyphRenderer.js` | 259-276 |
| Instance attribute allocation (skipPrealloc=false) | `src/GlyphRenderer.js` | 279-294 |
| Group texture 64-row default | `src/core/constants.js` | 37 |
| Group texture creation | `src/GlyphRenderer.js` | 181-194 |
| Highlight texture creation/resize | `src/GlyphRenderer.js` | 202-232 |
| Slug texture sharing via options | `src/GlyphRenderer.js` | 43 |
| Slug textures not disposed (shared) | `src/GlyphRenderer.js` | 1632 |
| Buffer swap (worker path) | `src/GlyphRenderer.js` | 1433-1444 |
| Partial upload (addUpdateRange) | `src/GlyphRenderer.js` | 678 |
| CodeGrid creates GlyphCollection | `src/collections/CodeGrid.js` | 56-62 |
| GlyphCollection creates renderer | `src/collections/GlyphCollection.js` | 1073-1083 |
| Eviction disabled by default | `src/collections/GridVirtualizer.js` | 44 |
| Eviction implementation | `src/collections/GridVirtualizer.js` | 267-303 |
| Atlas canvas size (system RAM, not VRAM) | `src/GlyphAtlas.js` | 137-139 |
| Atlas texture NOT used by renderer | `src/GlyphRenderer.js` | (no references) |
| SlugEncoder texture creation | `src/shaping/SlugEncoder.js` | 199-201 |
| Slug texture width constant | `src/shaping/slug-constants.js` | 18 |
