# GPU Techniques Analysis — Per-Glyph Memory Optimization
# Phase 0: GPU-Centric Proposals

Generated: 2026-03-30
Perspective: gpu-techniques (data indirection, shader-derived values, texture-based palettes)

---

## 1. Current GPU Data Flow

### What Gets Uploaded Per Frame

Seven `InstancedBufferAttribute` arrays back the geometry (GlyphRenderer.js, lines 218–231):

| Attribute | Floats | Bytes | Upload trigger |
|---|---|---|---|
| `instancePosition` | 3 | 12 | `updatePosition()` or rebuild |
| `instanceSize` | 2 | 8 | rebuild only |
| `instanceCodepoint` | 1 | 4 | rebuild only |
| `instanceColor` | 3 | 12 | `updateColor()` or rebuild |
| `instanceGroupId` | 1 | 4 | rebuild only |
| `instanceAddedColor` | 3 | 12 | `setGlyphHighlight()` |
| `instancePickingId` | 1 | 4 | rebuild only |
| **Total** | **14** | **56** | |

At the 10,000-instance cap that is **560 KB per mesh**, re-uploaded in full whenever any `needsUpdate` is set (each attribute is a separate `gl.bufferSubData` call — Three.js uploads the whole typed array, not a partial range).

### What Is Already Derived on GPU

- Atlas UV rect: vertex shader fetches from `atlasMapTexture` using `instanceCodepoint` (lines 306–313 of `_getVertexShader()`). The codepoint is the key; the 4-float UV rect comes back as a texture lookup. This is the existing GPU-codepoint path.
- Group offset, color, scale: fetched from `groupTexture` DataTexture using `instanceGroupId` (lines 286–289). This is the existing DataTexture indirection pattern.
- Fragment additive highlight: passed through as `vAddedColor` varying, added in fragment shader.

### What Is NOT Derived (but could be)

- `instanceSize`: uniform for a monospace mesh — every glyph in a mesh is the same size.
- `instancePickingId`: equals `basePickingId + gl_InstanceID` for a contiguously-allocated mesh.
- Per-glyph position in a regular grid: derivable from `gl_InstanceID` + line-break offset table.
- `instanceColor`: if syntax highlighting uses a small palette, an index byte suffices.

### Atlas Map Texture Size

`GlyphAtlas.getAtlasMapTexture()` (line 365) pre-allocates for full Unicode:
```
1024 × 1088 texels × 4 floats × 4 bytes = 17.8 MB
```
Only ~450 glyphs are ever populated. The texture is 99.96% zero-filled. This is a known optimization target (comment in CLAUDE.md performance notes).

---

## 2. Data Texture Approach (All Instance Data in One Texture)

### Concept

Instead of 7 separate `InstancedBufferAttribute` arrays, store all per-glyph state in a single RGBA Float32 DataTexture. The vertex shader fetches by row index = `gl_InstanceID`.

### Proposed Texel Layout (2 texels per glyph, width=1024)

```
Texel 0 (row = gl_InstanceID / 1024, col = gl_InstanceID % 1024):
  .r = position.x
  .g = position.y
  .b = position.z
  .a = codepoint (as float, cast to uint in shader)

Texel 1 (same row, col + 1, or second texture):
  .r = color.r
  .g = color.g
  .b = color.b
  .a = groupId (packed as float → uint)
```

`instanceSize`, `instancePickingId`, `instanceAddedColor` are handled by other techniques
described below and do not need texel storage.

### GLSL Fetch

```glsl
// WebGL2 — texelFetch for exact integer addressing (no filtering artifacts)
int idx = gl_InstanceID;
ivec2 coord0 = ivec2(idx % 1024, idx / 1024);
vec4 slot0 = texelFetch(instanceDataTex, coord0, 0);

vec3 instancePos = slot0.rgb;
int  codepoint   = int(slot0.a);

ivec2 coord1 = ivec2((idx + maxInstances) % 1024, (idx + maxInstances) / 1024);
vec4 slot1 = texelFetch(instanceDataTex, coord1, 0);

vec3 instanceCol = slot1.rgb;
int  groupId     = int(slot1.a);
```

`texelFetch` is WebGL2 core. Three.js r150+ requires WebGL2. No compatibility concern.

### CPU-Side Update Benefit

A partial position update for glyph N writes 1 texel (4 floats, 16 bytes) rather than
triggering a full 3-float attribute array re-upload (30,000 floats for a 10k-instance mesh).
The DataTexture can be partially updated via `gl.texSubImage2D` by setting a narrow
`DataTexture` `updateRange` — Three.js exposes this as `texture.image.data` + manual
`gl.texSubImage2D` call, or via a `THREE.DataTexture` with `unpackAlignment=1` and
re-upload of the affected row.

### Trade-off

One `texelFetch` per vertex vs. 7 attribute fetches. On modern GPU hardware attribute
fetches and texture fetches have similar throughput in a vertex shader. The main win is
on the CPU-to-GPU upload side, not raw GPU throughput.

---

## 3. Computed Position Scheme

### Observation

In a `CodeGrid` (monospace source file), every glyph position follows:
```
x = col * charWidth
y = -line * lineHeight
z = 0
```
The grid is regular. `instancePosition` is redundant if the shader knows `(line, col)`.

### Proposed Encoding

Replace `instancePosition` vec3 (12 bytes) with `instanceGridCoord` vec2 (8 bytes):
```
.x = column  (float, 0–N)
.y = line    (float, 0–M)
```
The vertex shader reconstructs world position:

```glsl
uniform vec2 gridCellSize;   // (charWidth, lineHeight) — same for all glyphs in mesh
uniform vec3 gridOrigin;     // base position of this CodeGrid

vec3 worldPos = vec3(
    gridOrigin.x + instanceGridCoord.x * gridCellSize.x,
    gridOrigin.y - instanceGridCoord.y * gridCellSize.y,
    gridOrigin.z
);
```

Saving: 12 bytes → 8 bytes per glyph (4 bytes saved). More importantly, the position is
never stale — moving the entire grid is a uniform change (`gridOrigin`), not a buffer
rebuild. This is a 100% overlap with what the group DataTexture already does for group
offset, so for CodeGrid the gridOrigin IS the group offset and no new storage is needed.

### Full Derivation via gl_InstanceID

For text that fills a rectangle with known width W:
```glsl
int col  = gl_InstanceID % int(gridWidth);
int line = gl_InstanceID / int(gridWidth);
```
This requires a `gridWidth` uniform (integer) and eliminates `instanceGridCoord` entirely.
The constraint is that the text must have uniform wrap width — which is true for CodeGrid
but not for general `GlyphCollection` use (word-wrap boundaries vary).

A hybrid: store only the line-break offset table (one uint16 per line, ~80 bytes for a
40-line terminal) in a small texture or UBO, then:
```glsl
int line = binarySearch(lineBreakTex, gl_InstanceID);  // O(log M) texture fetches
int col  = gl_InstanceID - lineBreakTex[line];
```
This is shader-expensive. Stick with `instanceGridCoord` vec2 for practical use.

---

## 4. Color Palette System

### Observation

Syntax highlighting for a source file uses a small, bounded color set. Common themes:
- 8–16 colors for token types (keyword, string, comment, operator, etc.)
- The additive highlight `instanceAddedColor` (12 bytes) is used for interactive hover/range
  highlights but is zero for the vast majority of glyphs at rest.

### Palette Texture

A 1D RGBA8 texture of width 256 stores up to 256 distinct colors at 4 bytes each = 1 KB:
```
palette[0] = (r, g, b, a)   // index 0 → default white
palette[1] = (0.3, 0.8, 1.0, 1.0)  // index 1 → keyword blue
...
```

Replace `instanceColor` vec3 (12 bytes) with `instanceColorIndex` float (4 bytes, actually
a uint8 packed as float). The shader:
```glsl
uniform sampler2D paletteTexture;  // 256 × 1, RGBA8

float palU = (instanceColorIndex + 0.5) / 256.0;
vec4 palColor = texture2D(paletteTexture, vec2(palU, 0.5));
vec3 instanceColor = palColor.rgb;
```

Saving: 12 bytes → 4 bytes (8 bytes saved per glyph).

### Additive Highlight Sparse Encoding

`instanceAddedColor` is 12 bytes and zero for most glyphs. Two options:

**Option A — keep as-is but use a highlight DataTexture:**
A separate 1D Float DataTexture of width=maxInstances, storing (r,g,b,0) per glyph.
Only the highlighted glyphs have non-zero values. No per-attribute array needed;
the vertex shader does `texelFetch(highlightTex, gl_InstanceID, 0)`. Update cost:
write 1 texel per highlighted glyph.

**Option B — additive color in fragment shader only for picked glyph:**
Pass `hoveredInstanceId` as a uniform. Fragment shader:
```glsl
float isHovered = float(int(vPickingId) == hoveredInstanceId);
gl_FragColor.rgb += highlightColor * isHovered;
```
Zero per-glyph storage. Works only for single-glyph hover, not range highlights.

For range highlights the DataTexture approach (Option A) is correct.
Encoding: the highlight DataTexture is 10,000 × 1 × RGBA32F = 160 KB per mesh — the same
size as the `instanceAddedColor` attribute. No memory win, but the update is a
`texSubImage2D` on one texel instead of flagging the entire attribute array.

---

## 5. Atlas Map Optimization

### Current Cost

`GlyphAtlas.getAtlasMapTexture()` line 365:
```js
const ATLAS_MAP_WIDTH  = 1024;
const ATLAS_MAP_HEIGHT = Math.ceil(0x110000 / 1024); // 1088
// 1024 × 1088 × 4 floats × 4 bytes = 17,825,792 bytes ≈ 17 MB
```
~450 glyphs are ever populated. GPU has 17 MB of zeros uploaded once on atlas init.

### Option A — Sparse Codepoint Redirect Texture

Two textures:
1. `codepointRedirectTex` — width=1024, height=ceil(maxCodepoint/1024), R32UI
   Each texel contains an atlas slot index (uint16 packed in R channel). Zero = absent.
   Only the occupied codepoint range needs to be non-zero. Most rows are zero and
   can be omitted if the texture height is bounded to the actual max codepoint used.
   For printable ASCII + box-drawing + Latin-1 the max codepoint is U+257F = 9599.
   `ceil(9600 / 1024) = 10` rows. Texture size: 1024 × 10 × 4 bytes = 40 KB.
   A 400× reduction in atlas map size for the common-case charset.

2. `atlasSlotTex` — width=512, height=1, RGBA32F. One texel per slot, stores
   `(u0, v0_webgl, u1, v1_webgl)`. 512 slots × 16 bytes = 8 KB.

Shader lookup:
```glsl
// Step 1: redirect codepoint → slot index
float cp = instanceCodepoint;
float mapCol = mod(cp, 1024.0);
float mapRow = floor(cp / 1024.0);
float tx = (mapCol + 0.5) / 1024.0;
float ty = (mapRow + 0.5) / redirectTexHeight;
float slotIdx = texture2D(codepointRedirectTex, vec2(tx, ty)).r;

// Step 2: fetch UV rect from compact slot table
float su = (slotIdx + 0.5) / 512.0;
vec4 uvRect = texture2D(atlasSlotTex, vec2(su, 0.5));
vUV = mix(uvRect.xy, uvRect.zw, uv);
```
Two texture fetches instead of one — slight shader cost, ~400× memory reduction.

### Option B — Direct Compact Map (Simplest)

If the application only ever uses ASCII + box-drawing (max codepoint U+257F = 9599),
size the atlas map texture to cover only that range:
```js
const MAX_CP = 0x2600;  // covers full charset in GlyphAtlas._buildCharset()
const ATLAS_MAP_WIDTH  = 256;
const ATLAS_MAP_HEIGHT = Math.ceil(MAX_CP / 256); // 38 rows
// 256 × 38 × 4 floats × 4 bytes = 155,648 bytes ≈ 152 KB
```
The existing single-lookup shader works unchanged. 114× smaller than current 17 MB.
Codepoints outside the map return (0,0,0,0) — rendered as the origin texel of the atlas,
which can be a blank glyph. A bounds-check guard can be added in the shader.

**Option B is the highest-value, lowest-risk change.**

---

## 6. Picking ID Derivation

### Current State

`instancePickingId` is a float attribute (4 bytes per glyph). It stores a globally unique
24-bit picking ID so the GPU can encode it as RGB in the picking render pass.

### Derivation from gl_InstanceID

For a contiguously allocated mesh, the picking ID for instance I is:
```
pickingId(I) = meshBasePickingId + I
```
where `meshBasePickingId` is assigned once when the mesh is created and stored as a uniform.

Shader:
```glsl
uniform float basePickingId;

// In vertex shader — pass through to fragment
float vPickingIdF = basePickingId + float(gl_InstanceID);

// In picking fragment shader
float pid = vPickingIdF;
float b = floor(pid / (256.0 * 256.0));
float g = floor(mod(pid, 256.0 * 256.0) / 256.0);
float r = mod(pid, 256.0);
gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
```

Saving: eliminates `instancePickingId` entirely — 4 bytes per glyph, zero GPU attribute.
The `resolveGlyph()` path in PickingSystem reads back the RGB value, reconstructs the
picking ID, then does `pickingId - meshBasePickingId` to get the slot index.

Constraint: glyph slots must remain contiguous (no holes from deletion). Current
`renderedTexts` map does not guarantee this. A compacting allocator or a free-list with
`gl_InstanceID` remapping is required before this can be enabled.

---

## 7. Combined Proposal

### Per-Glyph Layout After Optimizations

| Attribute | Current bytes | Proposed | Bytes saved | Technique |
|---|---|---|---|---|
| `instancePosition` | 12 | 8 (vec2 grid coord) | 4 | §3 computed pos |
| `instanceSize` | 8 | 0 (uniform) | 8 | size is mesh-uniform |
| `instanceCodepoint` | 4 | 4 (keep) | 0 | already GPU-derived |
| `instanceColor` | 12 | 4 (uint8 index) | 8 | §4 palette |
| `instanceGroupId` | 4 | 4 (keep) | 0 | DataTexture already |
| `instanceAddedColor` | 12 | 0 (DataTexture) | 12 | §4 highlight tex |
| `instancePickingId` | 4 | 0 (gl_InstanceID) | 4 | §6 derivation |
| **Total** | **56** | **20** | **36** | |

Target: **20 bytes per glyph** (vec2 coord + float codepoint + uint8 color + float groupId).
A 64% reduction. At 10,000 instances: 200 KB per mesh vs. 560 KB current.

### Atlas Map Win (Independent of Per-Glyph Layout)

Switch to Option B compact atlas map: 152 KB vs. 17 MB. This is a 17.7 MB one-time
GPU allocation saved, paid in a 1-line change to `GlyphAtlas.getAtlasMapTexture()`.

### Recommended Rollout Order

1. **Atlas map compact size** — isolated change, no shader impact, immediate 17 MB save.
2. **`instanceSize` → uniform** — add `charWidth`/`charHeight` uniforms, remove attribute.
   Requires all glyphs in a mesh to share size, which is already true for GlyphRenderer
   (it derives size from `atlasCharSize * worldScale` — see constructor lines 50–65).
3. **`instancePickingId` → `basePickingId` uniform + `gl_InstanceID`** — requires compact
   slot allocation; audit `_rebuildAllInstances()` to confirm no sparse slots.
4. **Color palette** — add `paletteTexture` uniform, change buffer builder to emit 1-float
   color index. Requires palette registration API on GlyphCollection.
5. **`instanceAddedColor` → highlight DataTexture** — add sparse highlight texture,
   update `setGlyphHighlight()` to write texels rather than attribute floats.

---

## 8. WebGL2 Constraints and Three.js Compatibility

### gl_InstanceID

Available in WebGL2 core (GLSL ES 3.00). Three.js r150+ targets WebGL2.
`THREE.WebGLRenderer` defaults to WebGL2. Safe to use.

When using `THREE.ShaderMaterial` with custom GLSL, the `#version 300 es` pragma must be
declared **or** `glsl_version: THREE.GLSL3` must be set on the material. The current
renderer uses `THREE.ShaderMaterial` with GLSL1-compatible syntax (no `#version`). Adding
`gl_InstanceID` requires upgrading to GLSL ES 3.00.

```js
const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,   // enables #version 300 es + gl_InstanceID
    ...
});
```

Output variables change: `gl_FragColor` → `out vec4 fragColor;` with `layout(location=0)`.
`texture2D()` → `texture()`. This is a mechanical translation of both shaders.

### texelFetch

GLSL ES 3.00 only. Available with `THREE.GLSL3`. Signature:
```glsl
vec4 texelFetch(sampler2D tex, ivec2 coord, int lod);
```
More reliable than `texture2D` for data textures since it bypasses filtering and mip
selection. The existing group DataTexture and atlas map DataTexture use `NearestFilter`
which approximates `texelFetch` behavior, but `texelFetch` is exact and has no
half-texel offset arithmetic.

### R32UI / Integer Textures

The redirect texture in Option A (§5) uses a single-channel unsigned integer format.
In WebGL2 this is `THREE.RedIntegerFormat` + `THREE.UnsignedIntType`. Requires:
- `texelFetch` (integer samplers use `usampler2D`)
- `THREE.NearestFilter` (mandatory for integer textures)
- Manual `WebGLRenderer.getContext().texImage2D(...)` if Three.js does not expose the
  format via DataTexture constructor — check Three.js r160+ for full integer texture
  support via `THREE.DataTexture`.

For Option B compact atlas map (§5) the existing `FloatType` + `RGBAFormat` is unchanged.

### InstancedBufferAttribute `updateRange`

Three.js exposes `attribute.updateRange = { offset, count }` for partial re-uploads.
This is relevant if keeping InstancedBufferAttribute but wanting sub-array updates.
The DataTexture approach is cleaner and does not require this Three.js-specific API.

### Picking Pass Compatibility

`PickingSystem.js` swaps shader materials, renders an offscreen pass, and reads pixels.
If picking ID is derived from `gl_InstanceID + basePickingId`, the picking fragment
shader must also run in GLSL3 and receive `basePickingId` as a uniform. The material
swap must preserve or re-set this uniform. PickingSystem's material swap mechanism
(material-swap second render pass described in CLAUDE.md) must be audited to ensure
custom uniforms survive the swap.
