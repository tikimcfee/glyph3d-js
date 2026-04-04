# Phase 0: Prior Art Lessons for Universal GPU Text Rendering

**Agent**: prior-art-lessons
**Focus**: What can we learn from projects that already tackled cross-platform GPU text rendering? What survived, what failed, and what does it mean for glyph3d-js?

---

## 1. Project-by-Project Analysis

### 1.1 Alacritty (GPU-Accelerated Terminal Emulator)

**Rendering approach**: Traditional instanced quads. Each glyph is a separate instanced quad textured from a pre-rasterized atlas. Two draw calls per frame (one for background cells, one for glyph quads). This is structurally identical to glyph3d-js's approach -- a single `InstancedBufferGeometry` with per-glyph attributes (position, size, UV/codepoint, color), rendered from a bitmap font atlas.

**Atlas strategy**: Shelf-packing into a single texture, glyphs rasterized on-demand and cached. glyph3d-js does the same via `GlyphAtlas.generate()` with `packingState` tracking shelf rows. Alacritty's grid-atlas variant (256x256 cells, fixed-size) is interesting for monospace terminals but wouldn't work for glyph3d-js's proportional grapheme cluster support.

**Cross-platform font handling**: Alacritty created `crossfont`, a dedicated crate that wraps three completely different platform APIs: FreeType on Linux/BSD, CoreText on macOS, DirectWrite on Windows. The unified interface exposes `rasterize(glyph) -> RasterizedGlyph { buffer, width, height, bearing }`. This is the most important lesson: font rasterization is the one place where "write once" absolutely does not work. Every platform's native rasterizer produces subtly different results (hinting, subpixel AA, stem darkening), and users notice.

**What survived**: The instanced-quad-from-atlas pattern. The platform-specific font rasterization behind a common interface. The single-atlas texture approach.

**What failed / evolved**: The original per-quad instancing approach was challenged by a WIP PR (#4373) exploring a full-screen shader that draws all glyphs in a single pass using terminal grid coordinates. This works for terminals (fixed grid) but not for the arbitrary 3D positioning glyph3d-js needs. The instanced-quad approach survived because it's the right abstraction for non-grid text.

**Relevance to glyph3d-js**: Very high. glyph3d-js's core rendering is essentially Alacritty's glyph renderer lifted into 3D with per-glyph world positions. The key delta is that glyph3d-js does GPU-side codepoint-to-UV lookup via `atlasMapTexture` + `texelFetch`, while Alacritty bakes UVs into vertex data CPU-side. glyph3d-js's approach is more flexible (atlas can change without re-uploading instance buffers) but requires vertex texture sampling, which is WebGL2+/GLES3+.

### 1.2 Zed (GPU-Accelerated Code Editor)

**GPUI framework**: Zed built GPUI, a full UI framework that renders everything through the GPU at 120 FPS. It uses a hybrid immediate/retained mode: layout is computed immediately each frame (like React reconciliation), but paint output is retained as a scene graph of GPU primitives. Three phases: Prepaint (layout), Paint (scene building), Present (GPU submission).

**Text rendering**: Zed delegates text shaping and glyph rasterization entirely to OS APIs (CoreText on macOS, platform equivalents on Linux/Windows). Shaped glyphs are cached per (text, font) pair, and rasterized bitmaps are cached in a glyph atlas. This is deliberate: Zed wants text to look native, matching system rendering exactly.

**The Blade-to-wgpu migration**: This is a major data point. Zed originally built on Blade (a custom thin GPU wrapper). In 2025 they replaced it with wgpu. Reasons: wgpu compiles WGSL shaders to SPIR-V/MSL/HLSL/GLSL automatically via Naga; it abstracts Vulkan/Metal/DX12/OpenGL under one API; it opens the door to WebGPU in the browser. The migration reused a single global buffer for per-frame data, cutting CPU time ~20%. The takeaway: even a well-funded team with a working custom GPU layer concluded that wgpu was better than maintaining their own.

**Performance**: Handles large files (10K+ lines) at 60+ FPS during editing. The key insight: Zed doesn't try to render all text at once. Only visible lines are processed. This is analogous to glyph3d-js's `GridVirtualizer` frustum culling, which eliminates ~97% of draw calls at 1500-file scale.

**Relevance to glyph3d-js**: The GPUI architecture confirms that the "atlas + instanced quads + GPU submission" pattern is production-proven at scale. The Blade-to-wgpu migration is a warning against building on custom GPU abstraction layers. The OS-native text shaping decision is the opposite of glyph3d-js's Canvas 2D approach -- Zed gets native-quality text but loses portability (each platform needs a shaping backend). glyph3d-js's Canvas 2D atlas generation is more portable but less typographically correct.

### 1.3 Xi-Editor (Rope + CRDT + GPU Rendering)

**Why it stalled**: Raph Levien's retrospective identifies several causes:
1. **Complexity multiplication**: The multi-process architecture (frontend, core, plugins each in separate processes) created enormous coordination overhead. JSON serialization between processes was slow (especially in Swift) and bloated the binary (9.3 MB release builds from serde alone).
2. **CRDT was overkill**: The CRDT for text synchronization was designed for collaborative editing but made simple features (like indent/dedent) disproportionately complex. The abstraction didn't match the actual use case.
3. **Modularity tax**: Levien concluded that modular architecture's benefits are mostly organizational (smaller teams own modules), not technical. For a small team, the coordination overhead exceeds the benefit.

**What would they do differently**: Build a monolithic core, avoid multi-process architecture for single-user editing, use simpler synchronization primitives, and accept that modularity has a real complexity cost.

**Relevance to glyph3d-js**: Strong cautionary lessons. glyph3d-js's `WorkerBridge` worker pool is much lighter than xi's multi-process model (shared memory via transferables, not JSON serialization). The buffer contract (`GlyphBufferSet` of typed arrays) is the right seam -- it's a data boundary, not a process boundary. The xi lesson is: don't over-abstract the internals. Keep the atlas-to-GPU pipeline monolithic and fast; modularize only at clean data boundaries.

### 1.4 wgpu (Cross-Platform GPU Abstraction)

**Abstraction approach**: wgpu exposes a WebGPU-inspired API that maps natively to Vulkan, Metal, DX12, OpenGL/GLES, and WebGPU/WebGL2. Shader translation is handled by Naga (WGSL -> SPIR-V/MSL/HLSL/GLSL). The HAL (Hardware Abstraction Layer) is clean: `Device`, `Queue`, `BindGroup`, `RenderPipeline` -- concepts that map 1:1 to every modern GPU API.

**Text rendering ecosystem on wgpu**:
- **glyphon**: Fast 2D text renderer. Uses cosmic-text for shaping + layout, etagere for atlas packing. Renders into existing render passes (no extra pass). This is the closest Rust equivalent to glyph3d-js's pattern.
- **wgpu_glyph**: Older, built on glyph_brush. Still functional but less maintained.
- **wgpu_text**: Wrapper over glyph_brush with simpler API.

All three use the same fundamental approach: rasterize glyphs to atlas, pack with shelf/etagere allocator, render as textured quads. The convergence is telling.

**Is wgpu the right level for glyph3d-js?**: For native targets, yes. wgpu is exactly what glyph3d-js's GPU contract needs -- instanced draw calls, texture sampling, offscreen render targets, pixel readback. For the browser, glyph3d-js already has WebGL2 via Three.js. The question is whether to replace Three.js with wgpu-in-WASM for the browser path. Answer: not yet. Three.js provides scene graph, camera, and renderer infrastructure that wgpu doesn't. But for a native Rust/Swift/Kotlin port, wgpu is the obvious backend.

### 1.5 Bevy (Game Engine Text Rendering)

**How Bevy handles text**: Bevy 0.14+ uses cosmic-text for shaping and layout. `TextPipeline` is the central coordinator. Glyphs are rasterized on-demand into `FontAtlas` textures (one per font-size combination). A `FontAtlasSet` manages multiple atlases. The pipeline supports both UI text and 2D world-space text.

**SDF vs bitmap atlas**: Bevy uses bitmap atlases, not SDF. The reason: bitmap atlases are simpler, give pixel-perfect results at the rasterized size, and don't require the SDF generation pass. SDF's advantage (scale-independence) matters less when you can re-rasterize at the needed size. Bevy's subpixel offset binning (glyphs re-rasterized at different fractional pixel positions) gives high quality without SDF complexity.

**Relevance to glyph3d-js**: glyph3d-js uses bitmap atlases at 48px with mipmaps, which is the same fundamental approach. The per-size atlas strategy (Bevy) vs single-size-with-worldScale (glyph3d-js) is a trade-off: glyph3d-js's approach is simpler (one atlas) but loses quality at extreme zoom. Bevy's multi-size approach is heavier but more correct. For a code visualization tool where text is viewed at various distances in 3D, glyph3d-js's mipmap approach is actually well-suited -- it's a 3D use case, not a 2D UI.

### 1.6 egui/epaint (Immediate-Mode GUI)

**Portability secret**: egui achieves extreme portability through a clean rendering abstraction. The core (`egui`) produces `ClippedPrimitive` lists (textured triangles + scissor rects). These are purely data -- no GPU calls. Then backend renderers (`egui_wgpu`, `egui_glow`) consume these primitives and translate them to GPU API calls. This is the same pattern as Dear ImGui's draw lists.

**Atlas management**: Dynamic growth. `TextureAtlas` starts small and grows as glyphs are encountered. Subpixel binning: up to 4 cached versions of each glyph at different subpixel offsets. CJK characters use only the zero bin to save space. Uses `ab_glyph` for rasterization (pure Rust, no system dependencies, but no hinting).

**Backend diversity**: egui_wgpu (Vulkan/Metal/DX12/WebGPU), egui_glow (OpenGL/WebGL). The community is converging on wgpu as default, with glow becoming opt-in. This mirrors the broader ecosystem trend.

**Relevance to glyph3d-js**: The `ClippedPrimitive` abstraction is a proven model for the render contract. glyph3d-js's equivalent is the `GlyphBufferSet` (typed arrays + metadata). The key difference: egui outputs triangles (mesh data), glyph3d-js outputs instance attributes (one entry per glyph). glyph3d-js's approach is more efficient for text (40 bytes/glyph vs 6 vertices * N bytes/vertex for quads) but less general. This is the right trade-off for a text-specific renderer.

### 1.7 Dear ImGui (The Portability Benchmark)

**The secret to portability**: ImGui outputs `ImDrawList` -- vertex buffers (position, UV, color) + index buffers + command lists (texture ID, scissor rect, vertex count). The application is responsible for submitting these to the GPU. This means ImGui has zero GPU dependencies. There are 20+ renderer backends (OpenGL 2/3, Vulkan, Metal, DX9/10/11/12, WebGPU, SDL_Renderer, etc.) because the contract is trivial to implement.

**stb_truetype approach**: Single-header C library for font rasterization. No system dependencies. Produces grayscale bitmaps. Quality is adequate for UI but not publication-grade (no hinting, limited subpixel AA). The v1.92 redesign (June 2025) made fonts dynamic -- glyphs are rasterized on demand at any size, cached in `ImFontBaked` structures. Atlas textures are managed through `ImTextureData` with a status protocol that backends implement.

**Atlas management**: All loaded font glyphs rendered into a single shared texture. The modular architecture separates loading, rasterization, atlas building, and rendering. Multiple rasterization backends (stb_truetype default, FreeType optional).

**Relevance to glyph3d-js**: ImGui's draw-list abstraction is the gold standard for portability. glyph3d-js can't adopt it directly because ImGui outputs per-vertex mesh data while glyph3d-js outputs per-instance attributes for GPU instancing. But the principle is transferable: define a minimal data contract that any GPU backend can consume. glyph3d-js's `GlyphBufferSet` (5 typed arrays + count + metadata) is already close to this ideal.

### 1.8 cosmic-text (The Emerging Standard for Rust Text)

**What it abstracts**: Font discovery (fontdb), text shaping (HarfRust -- pure Rust HarfBuzz port), layout (custom, supports bidirectional text), rasterization (swash -- supports ligatures and color emoji), font fallback (static lists from Chromium/Firefox). All pure Rust, no C dependencies.

**Why everyone uses it**: It solves the entire text pipeline in one library. Before cosmic-text, Rust projects needed to glue together harfbuzz-sys + fontconfig + freetype + icu4c for proper text support. cosmic-text replaces all of them with pure Rust. Bevy, Iced, Lapce, COSMIC Desktop, and now effectively Zed (via the broader ecosystem) all converged on it.

**Relevance to glyph3d-js**: cosmic-text solves a problem glyph3d-js doesn't have yet -- complex text shaping. glyph3d-js uses Canvas 2D `fillText()` for rasterization, which delegates to the browser's text stack (HarfBuzz, CoreText, etc.). For a native port, cosmic-text would replace Canvas 2D as the rasterization backend. The shaping/layout output (glyph IDs + positions) maps cleanly to glyph3d-js's buffer contract.

---

## 2. Patterns That Survived (Proven Across Multiple Projects)

### 2.1 Bitmap Atlas + Textured Quads
Every project uses this. Alacritty, Zed, Bevy, egui, ImGui, glyphon -- all rasterize glyphs once into an atlas and render textured quads. SDF was considered by several (Bevy discussions, various game engines) but bitmap won for code/UI text because pixel-perfect quality at target size matters more than scale-independence. glyph3d-js is on the right path.

### 2.2 Platform-Native Font Rasterization Behind a Common Interface
Alacritty (crossfont), Zed (OS APIs), cosmic-text (swash/HarfRust) -- they all converged on platform-specific rasterization with a unified output format. The output is always `{ bitmap, width, height, bearing/metrics }`. glyph3d-js's `Canvas 2D fillText()` is actually a good version of this for the browser -- the browser already abstracts platform fonts.

### 2.3 Draw-List / Buffer-Contract Abstraction
ImGui (ImDrawList), egui (ClippedPrimitive), glyph3d-js (GlyphBufferSet) -- the pattern is: produce GPU-submission-ready data without touching the GPU. Let a thin backend translate to the actual API. This is the key to portability.

### 2.4 Frustum/Visibility Culling
Zed (only visible lines), glyph3d-js (GridVirtualizer), Bevy (ECS visibility) -- nobody renders everything. The specific mechanism varies but the principle is universal: determine what's visible before building GPU data.

### 2.5 Single Atlas Texture (or Very Few)
Most projects use one atlas. Bevy uses one per font-size. ImGui uses one shared across all fonts. Multiple atlases mean multiple draw calls, which defeats the purpose of instancing. glyph3d-js's single 2048x2048 atlas is aligned with best practice.

---

## 3. Patterns That Failed

### 3.1 Multi-Process Architecture for Text Editing (Xi)
Process boundaries between text processing and rendering created serialization overhead, complexity, and debugging difficulty. Data boundaries (typed arrays, buffer contracts) work. Process boundaries don't -- for this use case.

### 3.2 Custom GPU Abstraction Layers (Zed's Blade)
Zed built Blade, then replaced it with wgpu. The maintenance burden of a custom GPU layer was not justified when wgpu exists. Lesson: use the community's GPU abstraction, don't build your own. For glyph3d-js, this means Three.js for WebGL and wgpu for native -- not a custom abstraction.

### 3.3 Over-Abstracting Synchronization (Xi's CRDT)
CRDTs for text buffer synchronization were technically elegant but made simple features disproportionately complex. The abstraction didn't match the actual editing use case. Lesson: match abstraction granularity to actual usage patterns.

### 3.4 Fixed-Grid Rendering Assumptions (Alacritty's Full-Screen Shader)
The full-screen shader approach (one pass, no instancing) works for terminals with fixed cell grids but fails for arbitrary text positioning. It's a dead end for 3D text visualization. glyph3d-js's instanced approach is correct for its use case.

---

## 4. The Font Problem: A Cross-Cutting Concern

Every project solves this differently, and none are fully satisfied:

| Project | Rasterizer | Shaper | Font Discovery | Quality |
|---|---|---|---|---|
| Alacritty | crossfont (FT/CT/DW) | platform | platform | Native-quality |
| Zed | OS APIs | OS APIs | OS APIs | Native-quality |
| Bevy | cosmic-text (swash) | HarfRust | fontdb | Good, not native |
| egui | ab_glyph | none (basic) | embedded | Adequate, no hinting |
| ImGui | stb_truetype / FreeType | none | embedded | stb: blurry; FT: good |
| glyph3d-js | Canvas 2D fillText | browser engine | browser engine | Native-quality (browser) |

**The insight**: glyph3d-js has the best font story of any of these for its current platform (browser). Canvas 2D delegates everything to the browser's native text stack. The problem only arises when leaving the browser. For native ports, the choice is between cosmic-text (pure Rust, good quality, no system deps) and platform-specific APIs (native quality, per-platform work).

**Recommendation**: Keep Canvas 2D for browser. For native, use cosmic-text. Its output (shaped glyph IDs + positions + rasterized bitmaps) maps directly to glyph3d-js's buffer contract. The atlas packing (`GlyphAtlas._packGrapheme`) and buffer building (`buildBatchBuffers`) don't care where the bitmaps came from.

---

## 5. The Abstraction Level Question

| Level | Example | Pros | Cons |
|---|---|---|---|
| Raw GPU API | Direct WebGL2/Metal/Vulkan | Maximum control | Maximum per-platform work |
| Thin wrapper | Three.js, wgpu | 90% of control, 10% of work | Still need text pipeline |
| Full framework | GPUI, Bevy | Batteries included | Locked to framework's decisions |

**Where glyph3d-js sits**: Three.js (thin wrapper) for browser, nothing for native.

**Where it should sit**: Three.js for browser (keep it), wgpu for native (adopt it). Do not build a custom abstraction layer. Do not adopt a full framework. The rendering contract (5 typed arrays -> GPU instanced draw) is simple enough that a thin wrapper is the right level.

---

## 6. Specific Recommendations for glyph3d-js

### 6.1 Keep the Instanced-Quad-From-Atlas Architecture
Every prior art project confirms this is the right pattern for GPU text. The 40-byte-per-glyph instance layout, the GPU-side codepoint-to-UV lookup, the single draw call -- all of this is validated by Alacritty (2D), Zed (2D UI), and Bevy (2D/3D game engine). glyph3d-js adds the 3D positioning dimension, which is unique and correct.

### 6.2 Formalize the Buffer Contract as the Portability Seam
The `GlyphBufferSet` (positions, sizes, glyphIds, colors, groupIds, count, metadata) should be the formal interface between text processing and rendering. This is already nearly true. Making it explicit and documented means any backend (Three.js/WebGL, wgpu/Vulkan, Metal, WebGPU) can consume it. ImGui and egui prove this pattern works.

### 6.3 Extract Font Rasterization Behind a Provider Interface
Following Alacritty's crossfont model: define `rasterize(grapheme, fontSize) -> { bitmap, width, height, bearing }` as an interface. Browser implementation: Canvas 2D `fillText()` (already works). Native implementation: cosmic-text/swash. The atlas packing (`_packGrapheme`) doesn't change -- it receives bitmaps regardless of source.

### 6.4 Don't Build a Custom GPU Abstraction
Zed's Blade-to-wgpu migration is the definitive lesson. For native, use wgpu. For browser, keep Three.js (or eventually wgpu-in-WASM when WebGPU is universally available). The rendering contract is simple enough that a thin adapter per backend is manageable.

### 6.5 Resist Over-Modularization
Xi-editor's failure mode was architectural complexity from too many abstraction layers and process boundaries. glyph3d-js's worker pool (typed array transfer, not JSON serialization) and the `GlyphBufferSet` data contract are the right level of separation. Don't add more layers.

### 6.6 Consider Multi-Size Atlas Strategy for Extreme Zoom
Bevy's per-font-size atlas strategy would improve quality when users zoom far into or out of code in 3D. Currently glyph3d-js uses a single 48px atlas with mipmaps. For deep zoom, a LOD system (multiple atlas sizes, swap based on projected pixel size) would be better. This is a future optimization, not a blocking requirement.

---

## 7. Summary: The Convergent Architecture

Every successful GPU text project has independently arrived at the same core architecture:

```
[Font Rasterization]  ->  [Atlas Packing]  ->  [Buffer Building]  ->  [GPU Instanced Draw]
 (platform-specific)      (shelf/etagere)      (typed arrays)        (backend-specific)
         ^                      ^                     ^                       ^
    The hard part          Solved problem        The portability        Thin adapter
    (crossfont,            (shelf packing         seam (ImDrawList,     (Three.js, wgpu,
     cosmic-text,           is universal)          GlyphBufferSet)       egui backends)
     Canvas 2D)
```

glyph3d-js already has this architecture. The path to universality is not a redesign -- it's formalizing the seams that already exist and implementing the platform-specific pieces (font rasterization, GPU backend) that the browser currently provides for free.

---

Sources:
- [Announcing Alacritty](https://jwilm.io/blog/announcing-alacritty/)
- [Alacritty new renderer PR #4373](https://github.com/alacritty/alacritty/pull/4373)
- [Alacritty crossfont](https://github.com/alacritty/crossfont)
- [Alacritty DeepWiki](https://deepwiki.com/alacritty/alacritty)
- [Zed: Leveraging Rust and the GPU for 120 FPS](https://zed.dev/blog/videogame)
- [Zed GPUI Framework DeepWiki](https://deepwiki.com/zed-industries/zed/2.2-ui-framework-(gpui))
- [Zed Blade-to-wgpu migration PR](https://github.com/zed-industries/zed/pull/46758)
- [Zed switches to wgpu](https://ubos.tech/news/zed-editor-switches-graphics-library-from-blade-to-wgpu-for-better-performance/)
- [Xi-editor retrospective by Raph Levien](https://raphlinus.github.io/xi/2020/06/27/xi-retrospective.html)
- [Xi-editor modularization commentary](https://www.ehfeng.com/xi-retrospective-comments/)
- [wgpu GitHub](https://github.com/gfx-rs/wgpu)
- [Cross-Platform Rust Graphics with wgpu](https://www.blog.brightcoding.dev/2025/09/30/cross-platform-rust-graphics-with-wgpu-one-api-to-rule-vulkan-metal-d3d12-opengl-webgpu/)
- [glyphon: Fast 2D text renderer for wgpu](https://github.com/grovesNL/glyphon)
- [Bevy text rendering pipeline DeepWiki](https://deepwiki.com/bevyengine/bevy/7.3-input-handling)
- [Bevy cosmic-text migration issue #7616](https://github.com/bevyengine/bevy/issues/7616)
- [egui DeepWiki](https://deepwiki.com/emilk/egui/1-overview)
- [egui text rendering and fonts](https://deepwiki.com/emilk/egui/4.4-layout-system)
- [Dear ImGui font system DeepWiki](https://deepwiki.com/ocornut/imgui/4-font-system)
- [Dear ImGui font atlas management](https://deepwiki.com/ocornut/imgui/4.1-font-atlas-and-management)
- [cosmic-text GitHub](https://github.com/pop-os/cosmic-text)
- [cosmic-text DeepWiki](https://deepwiki.com/pop-os/cosmic-text)
- [Etagere atlas allocator](https://nical.github.io/posts/etagere.html)
