# Visual Consistency Analysis — glyph3d-js Examples

Analyzed: 2026-03-25

## Examples Covered

1. **github-viewer** — GitHub repository 3D explorer (most feature-complete)
2. **word-wall** — Semantic dictionary word cloud / grid
3. **code-spectrometer** — Periodic table of code concepts
4. **hand-tracking** — AR hand pose with gesture detection
5. **mod-layer-visualizer** — Number sequence modular arithmetic viewer
6. **render-test** — Renderer stress test / parameter tuner

---

## 1. Color Schemes

### Palette Breakdown

| Example | Background | Primary Accent | Secondary | Text Body |
|---|---|---|---|---|
| github-viewer | `#0a0a0a` | `#00ff88` (green) | `#ffaa00` (amber) | `#e0e0e0` |
| word-wall | `#0a0a0a` | `#33ff88` (green) | `#ffdd00` (yellow) | `#e0e0e0` |
| code-spectrometer | `#0a0a0f` | `#88ccff` (steel blue) | block-specific hues | `#e0e0e0` |
| hand-tracking | `#0a0a0a` | `#00ff88` (green) | `#4488ff` (blue) | `#ccc` |
| mod-layer-visualizer | `#0a0a0f` | `#7af` (sky blue) | — | `#ccc` |
| render-test | `#0a0a0a` | `#00ff88` (green) | — | `#e0e0e0` |

### Observations

- Every example uses a near-black background (`#0a0a0a` or `#0a0a0f`). The deviation is only 5 hex points in the blue channel — close enough to be imperceptible in practice. **This is the de-facto base color for the dark theme.**
- Monospace font families are consistent across all examples: `Monaco`, `Menlo`, `Consolas` (or `SF Mono`, `Fira Code` variants in hand-tracking).
- The dominant UI accent is `#00ff88` / `#33ff88` — neon green. It appears in 4 of 6 examples as the primary interactive color (borders, buttons, highlights, FPS badge). The exceptions are code-spectrometer (`#88ccff`, steel blue) and mod-layer-visualizer (`#7af`).
- **Code-spectrometer and mod-layer-visualizer diverge** from the green accent. This is contextually appropriate: spectrometer uses block-specific hues to encode semantic meaning; mod-layer uses blue to suggest mathematical/analytical tone. However, the UI chrome (drawer, buttons) should align with the shared green when possible.
- The amber `#ffaa00` appears only in github-viewer's Settings slider thumbs and setting values. This secondary accent has no representation in other examples and could be unified under a single secondary token.

### Recommended Shared Palette Tokens

```
--bg-base:       #0a0a0a        // scene background, drawer background
--bg-surface:    #111118        // panels, cards, info boxes
--bg-elevated:   #1a1a22        // input fields, hover states
--border-subtle: #222           // dividers, panel borders
--border-ui:     #333 / #444   // control borders
--accent-primary: #00ff88       // CTA buttons, active tabs, key labels
--accent-secondary: #88ccff     // secondary highlights, link color (spectrometer)
--accent-amber:   #ffaa00       // slider values (github-viewer), could retire
--text-primary:   #e0e0e0       // body text
--text-secondary: #aaa          // labels, file names
--text-muted:     #666 / #888  // counters, placeholders
--text-dim:       #555          // separator text, inactive controls
--error:          #f44 / #da3633
--success:        #4f8 / #238636
--warning:        #ff0 / #d29922
```

---

## 2. Selection Visuals

### Current State

- **github-viewer**: Selection in the file tree panel uses `background: #1a3a1a` + `border-left: 3px solid #00ff88`. In 3D, the `SelectionManager` is referenced but not fully visible from files read; the diff system highlights added/removed/modified with green/red badges.
- **word-wall**: Highlights words in-scene by calling `renderer.updateColor()` with `highlightColor: { r:0.2, g:1.0, b:0.5 }` (the green family) and `renderer.updatePosition()` with a Z-pop of `2.0` world units forward. Definition words get `definitionColor: { r:1.0, g:0.7, b:0.2 }` (amber) with half the Z-pop (`1.0`). Chain lines use per-meaning color palettes.
- **code-spectrometer**: Selected/matched elements use intensity-driven color brightening (`getElementColor(el, 0.3 + intensity * 0.7)`) and a Z-pop of `0.1 + intensity * glowStrength` (max 2.1). No distinct "selected" vs "active" distinction — active is just fully bright.
- **hand-tracking**: Gesture state changes a text element color from `#555` to `#ff4488` (pink). No 3D glyph selection present.
- **mod-layer-visualizer / render-test**: No selection concept; these are observational viewers.

### Selection Color Analysis

The teal highlight `{r:0.2, g:1.0, b:0.5}` in word-wall and the green `#00ff88` CSS accent are the same hue family. However:

- The `definitionColor` amber `{r:1.0, g:0.7, b:0.2}` in word-wall matches github-viewer's amber `#ffaa00`. This suggests a natural secondary-selection semantic already emerging: **primary = green, secondary/related = amber**.
- Code-spectrometer uses block-specific hues at full brightness for selected elements — these cannot be homogenized without losing the semantic encoding, which is the point of the visualization.

### Z-Pop Convention

Z-pop (translating selected glyphs forward along the camera axis) is used in:
- word-wall: `+2.0` for primary, `+1.0` for definition words
- code-spectrometer: `+0.1` to `+2.1` based on match intensity

These are in different world-unit scales since the renderer `worldScale` differs per example. The pattern is consistent conceptually but the absolute values are not shared constants. For cross-example consistency, Z-pop values should be expressed as multiples of `charHeight` (e.g., `2 * renderer.metrics.charHeight`).

### Proposed Unified Selection Visual

```
Primary selected:   color = {r:0.2, g:1.0, b:0.5}  (neon green family), Z-pop = 2 * charHeight
Secondary/related:  color = {r:1.0, g:0.7, b:0.2}  (amber), Z-pop = 1 * charHeight
Active/hovered:     color = {r:0.8, g:0.9, b:1.0}  (white-blue), no Z-pop
Dim/inactive:       color = {r:0.3, g:0.3, b:0.35} (github-viewer default body color)
```

---

## 3. Label Rendering

### Current Usage

| Example | Labels? | Font Scale | Color | Position |
|---|---|---|---|---|
| github-viewer / hierarchical mode | Directory nameplates (CodeGrid) | `scale: 1.5` | `{r:0, g:1, b:0.53}` (accent green) | Above dir bounding box + Z-forward |
| github-viewer / treemap mode | TreemapLabelManager | Dir: `1.8`, File: `0.9` | Dir: green accent, File: `{0.8, 0.8, 0.8}` | Above bounding box edges |
| word-wall | None (words ARE the labels) | n/a | — | — |
| code-spectrometer | Symbol (1.8x), Name (0.7x), Count (0.5x) per cell | Fixed per renderer | Element block color | Inside cells |
| hand-tracking | Status text (DOM), gesture name (DOM) | 13px / 18px DOM | `#888` / active: `#ff4488` | Fixed top-left HUD |
| mod-layer-visualizer | DOM only (drawer panel) | DOM | `#7af` | DOM sidebar |
| render-test | DOM only (stats panel) | DOM | `#00ff88` | DOM panel |

### Label Observations

- Labels using the glyph rendering pipeline (`CodeGrid`-based) appear only in github-viewer. These are consistent with each other: green accent color, billboard-facing camera.
- The two-tier LOD system in `TreemapLabelManager` (dir labels at Z > 100, file labels at Z < 600) is a well-designed pattern. It should be documented as the canonical approach for LOD labels in any spatially dense layout.
- Label Z-offsets are hardcoded per-manager (dir: `+2`, file: `+1`). These are independent of actual glyph height. They should be expressed relative to `atlas.getCharSize().height * worldScale`.
- No example has LOD-responsive text sizing — labels maintain a fixed scale regardless of camera distance. For very large datasets (10k+ glyphs), label scale could benefit from distance-based scaling to improve readability at mid-range zoom.

### Font Scale Reference

Using the default `worldScale: 0.1` with a 48px atlas glyph:
- `charHeight` ≈ 0.48 world units, `charWidth` ≈ 0.29 world units
- Scale 1.8 (directory) → ~0.86 WU tall
- Scale 0.9 (file) → ~0.43 WU tall
- Scale 0.5 (count) → ~0.24 WU tall

These work at typical camera Z = 50–200. Below Z = 10 they become overly large; above Z = 500 they become unreadable. LOD thresholds in TreemapLabelManager (`DIR_VISIBLE_MIN_Z = 100`, `FILE_VISIBLE_MAX_Z = 600`) address this for visibility, but not for scale.

---

## 4. Background / Backdrop Patterns

### BackdropManager (github-viewer)

`BackdropManager` creates semi-transparent `THREE.MeshBasicMaterial` planes per directory using a depth-coded dark palette:

```
depth 1: 0x1a2a3a (dark blue)
depth 2: 0x2a1a3a (dark purple)
depth 3: 0x1a3a2a (dark green)
depth 4: 0x3a2a1a (dark amber)
depth 5: 0x2a3a1a (dark olive)
depth 6: 0x1a2a2a (dark teal)
```

Base opacity `0.12`, decaying by `0.7x` per depth, minimum `0.03`. Optional wireframe edges at `0.25` opacity using 2x brightened colors.

### Other Examples

- **code-spectrometer**: Per-element cell backgrounds using block colors at `0.08` intensity, opacity `0.6`. Animated to `0.08 + intensity * 0.4` as analysis matches occur. This is the richest background-as-data-encoding pattern in the codebase.
- **mod-layer-visualizer**: Canvas 2D textures on Three.js planes — entirely different rendering path (no glyph pipeline). Background cells are pixel-painted using configurable color schemes (rainbow, neon, warm, cool, grayscale).
- **word-wall / hand-tracking / render-test**: No 3D background meshes. Scene background is a solid `THREE.Color(0x0a0a0a)`.

### Unification Opportunity

The BackdropManager pattern (transparent planes behind content groups) is the most transferable:
- **word-wall**: A subtle group plane behind the entire word cloud would help orient the viewer. Currently there is no spatial boundary.
- **code-spectrometer**: Already has per-element planes; a larger block-level background plane would group elements visually at macro scale.
- Both examples could use a variant of `BackdropManager` with `depthWrite: false` and low-opacity block colors rather than depth-coded colors.

---

## 5. Animation Patterns

### Code-Spectrometer: Lerp Animation

The definitive animation pattern in the codebase:

```javascript
// Per-frame in update(deltaTime):
const diff = target - current;
if (Math.abs(diff) > 0.001) {
    const newIntensity = current + diff * Math.min(fadeSpeed * deltaTime, 1);
    // Apply to color, position (Z-pop), material opacity
}
```

`fadeSpeed: 3.0` means 95% convergence in ~1 second. The pattern is framerate-independent (uses `deltaTime`) and terminates cleanly (epsilon threshold). This is the correct implementation for smooth state transitions.

### Word-Wall: Instant Transitions

Word-wall uses immediate `updateColor()` / `updatePosition()` calls with no interpolation. The chain lines have their own animated dash shader (`time` uniform, `smoothstep` dash edges). There is no lerp between highlight states.

**Missed opportunity**: Lerp-based highlight transitions in word-wall would feel significantly more polished. The primary word appearing to "zoom forward" from Z=0 to Z=2 in a single frame is jarring at 60fps.

### Hand-Tracking: CSS Transitions

Selection state uses CSS `transition: color 0.15s` on DOM elements. No 3D animation.

### Minimap (github-viewer): No Animation

The minimap viewport rectangle jumps instantly to new camera positions. A one-frame lag is acceptable and expected.

### Animation Pattern Recommendation

Any example doing highlight/selection state changes should adopt the code-spectrometer lerp pattern:

```javascript
// Reusable lerp tick (per frame):
const lerpTo = (current, target, speed, dt) => {
    const diff = target - current;
    return Math.abs(diff) < 0.001 ? target : current + diff * Math.min(speed * dt, 1);
};
```

This pattern is appropriate for: color transitions, Z-pop transitions, panel opacity, backdrop opacity changes.

---

## 6. Minimap Applicability

### Current State

The `MinimapOverlay` in github-viewer provides:
- 2D Canvas (`180 × 120px`) bottom-left, zero GPU cost
- Colored rectangles per CodeGrid (hue by file index)
- White viewport rectangle showing camera frustum footprint
- Click/drag to navigate
- `M` key toggle

### Applicability to Other Examples

| Example | Minimap Useful? | Rationale |
|---|---|---|
| github-viewer | Yes (implemented) | Repository with 100s of files benefits greatly |
| word-wall | Yes, high value | 40k-word cloud spans large spatial extent; current navigation is by mouse/keyboard only |
| code-spectrometer | Low value | Layout is a fixed single-screen periodic table; camera never zooms far enough to lose orientation |
| hand-tracking | No | Content is small (hand wireframe near camera); spatial navigation is not the interaction model |
| mod-layer-visualizer | Medium value | Stacked planes could benefit from a side-view minimap showing layer depth, but this requires a non-XY projection |
| render-test | No | Stress test; no meaningful spatial navigation |

### Word-Wall Minimap Design

For word-wall with embedding-based layout, the minimap would show:
- Each word as a 1px dot (or small cluster marker) in embedding-space XY projection
- Highlighted words in green, definition words in amber
- The color-coded schema (currently hue-by-index) would degrade gracefully since 40k dots at 1px are illegible individually anyway

The existing `MinimapOverlay` class is architected to accept any `getGrids()` function. Word-wall's equivalent would need a `getWordRects()` function returning world-space XY extents per word. Since each word is a single text item (not a CodeGrid), the minimap would need a lighter data representation — one point per word center rather than one rect per grid.

---

## 7. Performance Analysis

### GPU Budget by Example

| Example | Glyph Count | Draw Calls | GPU Cost | Status |
|---|---|---|---|---|
| github-viewer | 50k–500k (repo-dependent) | 1 per renderer (auto-splits at 10k) | High | Manages well at 60fps; async worker path used |
| word-wall | ~400k (40k words × ~10 chars avg) | Multiple (10k cap per renderer) | High | Single GlyphRenderer, renderBatch path |
| code-spectrometer | ~3k (symbols + names + counts) | 3 (3 separate GlyphRenderers) | Low | Minimal GPU load; most cost is lerp animation logic |
| hand-tracking | 0 glyphs (hand uses Three.js LineSegments) | 0 glyph draw calls | Negligible | Performance dominated by MediaPipe inference |
| mod-layer-visualizer | 0 glyphs (uses Canvas 2D textures on planes) | 0 glyph draw calls | Low-Medium | Canvas texture generation is CPU-heavy on rebuild |
| render-test | Configurable (stress test) | Variable | User-controlled | Purpose-built for GPU benchmarking |

### Bottleneck Assessment

**Word-wall** is the most at-risk for added features:
- 400k+ glyph instances mean the instance buffer is ~6.4MB per attribute
- Any `needsUpdate = true` on an attribute triggers a full 6.4MB GPU re-upload
- The current `highlightWord()` calls `updateColor()` and `updatePosition()` per highlighted word — each call sets `needsUpdate` once, but if N words are highlighted in a loop without batching, N upload triggers fire per frame
- Adding lerp animation would require either: (a) a batch-lerp approach that sets `needsUpdate` once after all lerp steps, or (b) switching to group-based color/position transforms via DataTexture

**GitHub-viewer** handles large repos gracefully through:
- Async worker path (`flushAsync()`) for parallel buffer computation
- GlyphCollection group DataTexture for O(1) group-level transforms (directory visibility toggling)
- TreemapLabelManager uses one GlyphCollection for all labels (1 draw call)

**Code-spectrometer** has 3 separate GlyphRenderers (symbol, name, count) where one would suffice if groups were used. This is a minor inefficiency — 3 draw calls instead of 1. At the current scale (118 elements) the impact is immeasurable.

### Added Feature Performance Impact

| Feature | Impact on Word-Wall | Impact on GitHub-Viewer |
|---|---|---|
| Lerp highlight animation | High: per-frame buffer writes for all animated words. Must batch into single needsUpdate. | Low: group DataTexture lerp is 4 bytes per group per frame |
| Minimap | Zero GPU: pure 2D Canvas | Zero GPU (already implemented) |
| Backdrop planes | Medium: ~50–200 additional Three.js meshes. No glyph rendering cost. | Already implemented |
| Selection Z-pop lerp | Same as highlight animation above | Same as highlight |

---

## 8. Unified Visual Language Recommendations

### What Already Works

The dark theme is effectively unified — all six examples share `#0a0a0a` as the scene background and monospace font in UI. The drawer/bottom-sheet UI pattern used in github-viewer and mod-layer-visualizer is identical in structure and could be extracted as a shared component.

### Priority Gaps

**Gap 1: Selection highlight missing from 4 of 6 examples**
- word-wall has it, code-spectrometer has an analog, but hand-tracking, mod-layer-visualizer, and render-test do not have selectable 3D content
- The word-wall teal+amber scheme should be adopted as the shared selection convention wherever selection exists

**Gap 2: Animation smoothness inconsistency**
- word-wall uses instant transitions; code-spectrometer uses lerp
- A shared `LerpAnimator` utility class (or even just a documented single-function pattern) would normalize this across examples

**Gap 3: Label positioning is unmaintained across examples**
- Directory nameplates use hardcoded Y/Z offsets independent of glyph size
- These should be multiples of `renderer.metrics.charHeight` for scale-correctness

**Gap 4: Treemap + spiral features have no existing analogs for comparison**
- The treemap mode in github-viewer uses BackdropManager for rectangles and TreemapLabelManager for LOD labels — this is the right pattern
- Any spiral layout would benefit from a minimap with a circular projection to show the spiral structure; this is not directly supported by the current `MinimapOverlay` XY-rect approach

### Shared Constants to Extract

From the analysis, these should live in a `src/core/theme.js` or be added to `src/core/constants.js`:

```javascript
// Selection colors
export const SELECTION_COLORS = {
    primary:   { r: 0.2,  g: 1.0,  b: 0.5  },  // neon green (word-wall highlight, github tab)
    secondary: { r: 1.0,  g: 0.7,  b: 0.2  },  // amber (definition words, setting values)
    dim:       { r: 0.3,  g: 0.3,  b: 0.35 },  // body text dim state
    inactive:  { r: 0.15, g: 0.15, b: 0.18 },  // unmatched, background elements
};

// Label scale tiers (multiplier on worldScale)
export const LABEL_SCALES = {
    directory: 1.8,   // TreemapLabelManager DIR_LABEL_SCALE
    file:      0.9,   // TreemapLabelManager FILE_LABEL_SCALE
    nameplate: 1.5,   // NameplateManager default
    detail:    0.5,   // Count/detail text
};

// Z-pop depth (in charHeight multiples)
export const Z_POP_FACTORS = {
    primary:   2.0,
    secondary: 1.0,
};

// Backdrop opacity
export const BACKDROP_OPACITY = {
    base:  0.12,
    decay: 0.70,
    min:   0.03,
};
```

### Minimap Adoption Order

1. **Word-wall** — highest ROI. 40k words with embedding coordinates means camera can easily get lost in the cloud. Implementation: provide `getWordRects()` returning `{x, y, w:charWidth, h:charHeight}` per word, pass to a modified MinimapOverlay that accepts point data in addition to rect data.
2. **Mod-layer-visualizer** — medium ROI. A top-down minimap showing all layers as horizontal strips (layer = Y offset) would help navigate the stacked planes.
3. **Code-spectrometer** — lowest ROI. The periodic table fits in a single view; no navigation loss possible.

---

## Summary Table

| Dimension | Shared | github-viewer | word-wall | code-spectrometer | hand-tracking | mod-layer | render-test |
|---|---|---|---|---|---|---|---|
| Background | #0a0a0a | same | same | #0a0a0f | same | #0a0a0f | same |
| Primary accent | — | #00ff88 | #33ff88 | #88ccff | #00ff88 | #7af | #00ff88 |
| Backdrop planes | — | depth-coded | none | per-cell | none | canvas textures | none |
| Selection 3D | — | yes (tree+diff) | yes (teal+Z) | yes (intensity) | gesture only | none | none |
| Animation | — | none in 3D | instant | lerp | CSS only | none | none |
| Labels 3D | — | CodeGrid billboard + LOD | none (words are labels) | per-cell | none | none | none |
| Minimap | — | yes (MinimapOverlay) | no | no | no | no | no |
| Workers | — | yes (flushAsync) | no (direct render) | no | no | no | no |
| GPU pressure | — | high | high | low | negligible | low | variable |
