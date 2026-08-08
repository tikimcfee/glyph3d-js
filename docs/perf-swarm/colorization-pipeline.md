# Colorization pipeline — ideal design for static text at scale

Swarm topic: syntax highlighting / colorization data flow.
Repo state researched: 2026-08-07, `packages/glyph3d-core/src/` at the Layer-2 byte-pipeline baseline.

---

## 1. Problem framing

Colorization today is on the load critical path and scales with the wrong units:

- **Main-thread, synchronous, full-file tree-sitter parse per file per layout.**
  `CodeGrid._scheduleAnalyze()` (`collections/CodeGrid.js:1296`) fires
  `SyntaxColorizer.analyzeGrid()` (`parsing/SyntaxColorizer.js:103`) after every
  layout; `TreeSitterEngine.parseDocument()` (`parsing/TreeSitterEngine.js:130`)
  runs web-tree-sitter WASM synchronously, no worker, no incremental parse, no
  tree reuse, query cost ≈ parse cost (comment at `TreeSitterEngine.js:166`).
  A 450-file restore = 450 main-thread parses.
- **Two full writes of every colored glyph.** `analyzeGrid` first paints the whole
  file FOREGROUND (`SyntaxColorizer.js:131`), then overwrites per capture-row
  (`:135-153`) via `GlyphField.setGlyphColorRange` (`GlyphField.js:1258`): a JS
  loop per range plus one `addUpdateRange` + `needsUpdate` per call.
- **O(col) UTF-8 walks per capture boundary** — captures arrive in UTF-16
  row/col, converted through `byteOffsetOf` (`core/ByteLayoutDescription.js:65`).
- **12 B/glyph of color data**: `instanceColor` is vec3-f32
  (`GlyphField.js:918-948`), capacity-sized over the whole arena. Plus the
  separate 4 B/glyph RGBA8 `instanceHighlight` lane.

At the C10k target (10k files, ~200 MB source, ~30M glyphs, budget ≤ 8 s cold
per `docs/perf-swarm/benchmark-measurement.md:201-212`):

| Approach | Color bytes/glyph | 30M glyphs | Notes |
|---|---|---|---|
| Today: vec3-f32 `instanceColor` | 12 B | **360 MB** | +120 MB highlight lane = 480 MB total |
| This design: u8 palette index | 1 B | **30 MB** | 12× smaller; theme LUT is 1 KB |
| (fallback) u16 palette index | 2 B | 60 MB | only if >256 palette ids ever needed |

Upload bandwidth at a conservative 2 GB/s: 360 MB ≈ 180 ms of pure attribute
upload *per full repaint*, re-done after every relayout (attribute reset,
`GlyphField.js:1283-1284`). 30 MB ≈ 15 ms, uploaded once, surviving relayout.

**Key structural insight**: color depends only on (source bytes, language,
theme) — never on layout. In the byte pipeline, slot index == source byte
offset, so a byte-indexed color slab can be produced *before, during, or after*
GPU layout, in parallel workers, with zero dependency on the arena's layout
kernels. Colorization never needs to touch row/col at all: tree-sitter's
native output is byte ranges, which is exactly the slot space.

---

## 2. Design

### 2.1 Data flow

```
relay bytes (Uint8Array, no string decode)
 ├──→ GlyphPipelineArena.stage(bytes)  → GPU layout (existing, unchanged)
 └──→ ColorizePool.submit(bytes, slotBase, langId, contentHash)
        │
        │  N workers (N = hardwareConcurrency-2), each holding:
        │    web-tree-sitter WASM instance + lazily-loaded grammars
        │
        │  warm cache hit (IndexedDB, keyed by contentHash)?
        │    → span blob, inflate to per-byte indices (fast memcpy path)
        │  else:
        │    → tree-sitter parse → captures (byte offsets, native)
        │    → map scope → paletteId via theme table (in worker)
        │    → paint per-byte palette indices into a Uint8Array(file.byteLength)
        │      (single pass: memset default id, then write capture ranges
        │       back-to-front so innermost/last wins — same semantics as today)
        │    → persist span blob to IndexedDB (async, off critical path)
        │
        └→ transfer the per-file Uint8Array (Transferable, zero-copy)
             → main thread: colorSlab.set(fileColors, slotBase)   (memcpy ~ns/byte)
             → coalesced writeBuffer per flush batch (not per file)
```

Output contract is **one byte per source byte**, byte-indexed 1:1 with arena
slots — not a span list on the hot path. A 200 MB tree produces 200 MB of
worker output, but it's memcpy all the way (workers write linearly, main
thread does one `.set()` per file, GPU gets one packed upload per batch).
Span lists (u32 start + u32 len|id = 8 B/span, ~6M spans ≈ 48 MB for 30M
glyphs) are the *cache/on-disk* format, where size matters; the slab is the
*runtime* format, where random access by `instanceIndex` matters.

Optimization where available (app is served by the Go relay — needs
COOP/COEP headers): make `colorSlab` a `SharedArrayBuffer` and let workers
paint **directly at `slotBase`**, eliminating both the transfer and the
main-thread `.set()`. Keep the Transferable path as fallback.

### 2.2 GPU-side layout

**Color slab** — byte-indexed, grows with the arena (same seam as
`MegaGlyphField._ensureCapacity`, `MegaGlyphField.js:184-199`; regrow ×2,
copy old — trivial for u8).

WGSL storage buffers have no u8 loads, so pack 4 indices per u32 — exactly
the precedent set by `byteWords` in `compute/glyphPipelineKernels.js:121-127`.
CPU side keeps a `Uint8Array` view over the same ArrayBuffer (no JS packing
loop — the mistake `packBytes` makes); GPU side:

```wgsl
// sketch — TSL equivalent slots into glyphVertex.js next to the slot reads
let word  = colorWords[slotIndex >> 2];
let pIdx  = (word >> ((slotIndex & 3u) * 8u)) & 0xFFu;
let color = paletteLoad(pIdx);           // textureLoad on 256×1 LUT
```

**Palette LUT** — one global 256×1 RGBA8 `DataTexture` (1 KB), sampled with
`textureLoad` (nearest, no filtering — same access pattern as the group
texture at `core/glyphVertex.js:193-201`). Palette ids are allocated at
runtime by a `PaletteRegistry`:

- ids 0–31: syntax theme scopes (`parsing/syntaxTheme.js` scopes, resolved
  once per theme instead of per capture),
- ids 32–63: semantic overlays (diff add/del — `DiffController` currently
  abuses `setGlyphColorRange` per line, `DiffController.js:286-295`),
- ids 64+: ephemeral registrations.

**Theme change = rewrite 1 KB and flip `needsUpdate`.** No glyph touched.
Compare with today: a theme change would re-run every parse and repaint every
glyph. sRGB handling moves into the LUT: upload palette texels pre-decoded
(linear), and drop the per-fragment `pow(2.2)` on the base color
(`GlyphField.js:419`).

**Per-file tinting stays multiplicative and free**: `CodeColorManager`'s
`setGroupColor`/`colorBlend` (`services/interaction/CodeColorManager.js:181`)
already lerps `instanceColor × groupColor` in the vertex stage
(`GlyphField.js:174-180`). LUT color simply replaces `instanceColor` in that
expression; group mechanics are untouched.

**Highlight lane** (`instanceHighlight`, RGBA8, 4 B/glyph) stays as-is —
it's transient interactive state (selection, hover, terminal ANSI), not
colorization. Orthogonal.

### 2.3 Vertex shader delta (TSL)

In `GlyphField._buildVertexNode` (`GlyphField.js:139-201`), for the
`byteGlyph` kind:

- remove: `attribute('instanceColor', 'vec3')` (line 143) — and its 12 B/glyph
  allocation at `:918-948`, its regrow in `MegaGlyphField._ensureCapacity`,
  and the entire `setGlyphColorRange` CPU path for the byte pipeline.
- add: u32 storage read of the packed color slab (registered like the slot
  buffer via `registerByteSlotsNode`, `glyphVertex.js:65-92`), shift/mask,
  `textureLoad` palette LUT → `baseColor`.
- `vColor = lerp(baseColor * groupColor.rgb, groupColor.rgb, colorBlend)` —
  unchanged shape.

The legacy Path-A fields (TerminalGrid, FrameGrid, labels) keep
`instanceColor`; this change is scoped to the byte path where the scale is.

### 2.4 Tokenization: where and what

**CPU worker pool, tree-sitter WASM, incremental.** Rationale:

- Grammar-correct highlighting for 6+ languages (registry at
  `parsing/languageRegistry.js:104`) is a solved problem in tree-sitter;
  porting it to GPU is a research project with no correctness win.
- Tree-sitter's native coordinates are **byte offsets** — zero conversion into
  the byte-pipeline slot space. The entire UTF-16 col → codepoint col →
  `byteOffsetOf` O(col) dance (`SyntaxColorizer.js:57-74`,
  `ByteLayoutDescription.js:65-77`) and the CRLF drift TODO
  (`SyntaxColorizer.js:87-89`) simply disappear on the 3D path.
- Throughput is sufficient (see budget below), and it's off the main thread.

Each worker: one `web-tree-sitter` instance, grammars lazy-loaded per
language (same `.scm` queries), plus a retained `Tree` per open file
(keyed by contentHash / fileId) for **incremental edits**.

**Edit path**: edit arrives as byte-range edits (the byte pipeline already
thinks in bytes) → `tree.edit()` → re-parse (typically sub-ms for localized
edits) → diff captures against the file's previous span set → repaint only
the damaged byte ranges in the slab → one small `writeBuffer`. Theme change:
re-resolve ids at the registry, rewrite LUT — no re-parse at all.

**2D editor reuse**: today `grid._highlights` shares the 3D parse with the
CodeMirror panel (`CodeGrid.js:619-640`). The worker returns the capture
list (UTF-16 coords included, as today) alongside the painted slab; the grid
stashes it the same way. Editor decorations unchanged.

**Unknown/unsupported language**: worker paints id 0 (default foreground)
with a memset — O(bytes), microseconds.

### 2.5 Disk cache

`services/state/BlobStore.js` (IndexedDB, namespaced) already exists and its
header names a "future persistent RepositoryContent cache" as intended — this
is it. Namespace `syntax-colors`:

```
key:   contentHash (xxh64 of file bytes, computed in worker, ~GB/s)
value: [paletteId:u8, byteLen:u32]* span blob, delta-free, memcpy-inflatable
```

Warm load of an unchanged tree = **zero parses**: fetch bytes → hash →
inflate spans into slab. Hash + inflate of 200 MB ≈ 100–200 ms across workers.
Cache invalidation is content-addressed, so it's trivially correct. A
secondary LRU cap (e.g. 500 MB) mirrors `slugCoreCache` hygiene.

### 2.6 Budget at C10k (200 MB source, 30M glyphs)

| Stage | Cost | Overlapped with |
|---|---|---|
| xxh64 hash, 200 MB, 8 workers | ~50 ms | fetch |
| Cache-miss parse: tree-sitter ≈ 20–60 MB/s/thread × 8 workers | **~0.4–1.2 s cold** | fetch (0.7 s) + GPU layout (1.5 s) |
| Cache-hit inflate | ~100 ms | everything |
| Slab assembly (memcpy 200 MB, main thread, batched) | ~20 ms | — |
| GPU upload 30 MB @ 2 GB/s, one writeBuffer per batch | ~15 ms | — |
| LUT upload | negligible | — |

Worst case (cold cache): colorization finishes under the GPU layout shadow —
**it is not the bottleneck**. Warm case: ~150 ms total. Today's equivalent
work (450 main-thread parses + double paints + per-range uploads) is a major
chunk of the ~3.4–4.8 s seat time for 474 grids
(`docs/plans/layer2-session-handoff.md:19-28`); at 10k files it would be
minutes.

---

## 3. Mapping onto existing seams

| Existing seam | Change |
|---|---|
| `parsing/TreeSitterEngine.js` | Move into a worker (`parsing/workers/colorizeWorker.js`); keep engine class as the worker-side core. Capture production contract unchanged. |
| `parsing/SyntaxColorizer.js` `analyzeGrid` | Replaced by `ColorizePool.submit(grid)`; the whole paint loop (`:128-153`) deleted on the byte path. |
| `collections/CodeGrid.js:1296` `_scheduleAnalyze` | Submits to pool keyed by `contentHash`; gen-token abort logic carries over. Edit path calls `pool.edit(fileId, edits)`. |
| `parsing/syntaxTheme.js` `resolveScopeColor` | Becomes `PaletteRegistry.idForScope(scope)`; colors resolve once per theme into the LUT, not per capture. |
| `GlyphField.js:918-948` `_createInstanceMesh` | Drop `instanceColor` for byte kind; add packed-u32 color slab storage node + palette LUT texture. |
| `GlyphField.js:143,174-180` vertex | Read slab + LUT instead of `instanceColor`; blend math unchanged. |
| `GlyphField.js:1258-1272` `setGlyphColorRange` | Byte-path callers deleted (colorizer, `MegaGlyphField.js:155,263`); kept for legacy Path-A fields. |
| `MegaGlyphField.js:184-199` `_ensureCapacity` | Regrow color slab alongside (u8, cheap). |
| `DiffController.js:286-295` | Registers diff colors as palette ids; writes per-line id ranges into the slab (same byte-range API). |
| `services/state/BlobStore.js` | New `syntax-colors` namespace, modeled on `shaping/slugCoreCache.js`. |
| `cli/` relay | Optional: add COOP/COEP headers for SharedArrayBuffer fast path. |
| `CodeGrid.js:619-640` highlight stash | Worker returns captures too; editor path untouched. |

No conflicts with the GPU layout kernels: the color slab is additive — one
new storage buffer, no new dispatches, no changes to the 9-dispatch flush.

---

## 4. Risks / open questions

- **Parse throughput variance.** 20–60 MB/s is a planning number; minified JS
  and giant JSON files parse slower. Mitigation: per-file time budget with
  graceful degradation (fall back to default id for files over a parse-time
  cap, recolor lazily when idle). Needs one measurement pass on a linux-tree
  corpus.
- **SharedArrayBuffer** requires cross-origin isolation; the relay must send
  COOP/COEP. The Transferable fallback costs ~20 ms at C10k — acceptable, but
  SAB is the clean version.
- **256-id ceiling.** A single global palette is plenty for one theme +
  overlays (<64 ids). If per-file divergent themes ever appear, either go u16
  (2 B/glyph, still 6× win) or add a per-group `paletteBase` column to the
  group texture (`GROUP_COLS` is already a lockstep hazard with the WebGL pick
  GLSL — touch carefully).
- **Realloc ordering**: arena growth moves `slotBase`s; the slab must be
  regrown/copied in the same transaction (`MegaGlyphField._ensureCapacity`)
  or colors smear across files. Same hazard class as today's color repaint on
  realloc — but with the slab, a plain `copyWithin`/memcpy fixes it, no
  re-parse.
- **Edit-path byte vs UTF-16**: tree-sitter `tree.edit()` wants both point and
  byte coordinates; the editor speaks UTF-16. Conversion is per-edit (small),
  not per-capture — fine, but needs one careful adapter.
- **Depends on**: ingest going byte-native end-to-end (relay bytes → arena
  without the `TextDecoder`/`split`/re-encode round-trip,
  `RemoteFileSystemProvider.js:25-30`, `CodeGrid.js:277-288`) so workers get
  bytes, not strings. That's the at-scale ingest proposal; colorization can
  land before it but shines with it.

## 5. Effort estimate

| Piece | Effort |
|---|---|
| Worker pool + worker-side TreeSitterEngine + span/slab format | ~1 wk |
| Palette LUT + shader read path + drop byte-path `instanceColor` | ~3 d |
| Edit path (incremental parse, damaged-range repaint) | ~1 wk |
| BlobStore cache + content hashing | ~3 d |
| SAB fast path + relay headers | ~1–2 d |
| **Total** | **~3–4 wks** (one engineer, includes bench instrumentation in `loadStats`) |
