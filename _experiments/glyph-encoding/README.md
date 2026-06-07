# Experiment: glyph-encoding

**Question:** how small can the *render representation* of text get, and is the
encoding reversible all the way to the rendered glyph? Validated three ways:
`bytes round-trip` → `glyph slots match the renderer` → `rasterized curves are
pixel-identical`.

Today each rendered glyph costs **40 bytes** of instance attributes
(`instancePosition` 12 + `instanceSize` 8 + `instanceColor` 12 + `instanceGlyphId`
4 + `instanceGroupId` 4). A few hundred source files is millions of glyphs →
hundreds of MB resident. Almost all of it is derivable. This measures how much.

## The model (matched to the real renderer)

The renderer (`FontChain` monospace path) draws **one global SLOT per CODEPOINT**:
advance is forced constant, offsets are zero, and the slot is a dense id into the
Slug glyph-map texture. So the map carries two linked layers:

- **render/source layer** — per codepoint: a dictionary of distinct codepoints
  (each → its FontChain slot) + a per-line stream of dictionary indices. One
  stream drives **both** drawing (`dict.slot`) and source reconstruction
  (`dict.cp`), because in the monospace model they're 1:1.
- **cluster layer** — per grapheme: `{codepointCount, byteLen}`, RLE-encoded
  (plain text is long runs of `{1,1}`). This is the editing/cursor oracle
  (grapheme ↔ codepoint ↔ byte), kept separate from the render stream — the
  `canonical-ruler` map.

We tap the **real** `FontChain` from `@glyph3d/core` (Bun, headless; a `file://`
fetch shim feeds it the on-disk fonts). The slot ids are the same ones the GPU
draws with — not a stand-in.

## Three validation layers (`run.js`)

1. **source round-trip** — `decodeSource(unpack(pack(encode(text)))) === text`,
   byte-exact, through the actual packed bytes. The falsifiable spine.
2. **glyph fidelity** — `expand(map)` slot sequence `===` a fresh `FontChain`
   shaping of the text. Catches wrong/dropped/misordered slots (the round-trip
   can't, since it rebuilds from stored source).
3. **curve image** — rasterize both renderings from the *same outlines the GPU
   uses* (`FontChain.glyphOutline(slot)`), pixel-diff must be 0. PNGs written to
   `out/` (reference / reconstructed / diff). The ground truth: identical glyph
   streams → identical pixels, so any encoding bug shows up as red.

Plus a structural check: render stream and cluster map agree on codepoint count.

## Results (current)

~**19×** smaller than the 40 B/glyph instance buffer (u16 stream), ~**44×** with
the stream bit-packed to the dictionary's real width (~7 bits for ~105 distinct
codepoints) — *including* the RLE'd cluster map. Ratio climbs with file size
because the dictionary is tiny and ~constant (a 64k-glyph file has ~105 distinct
codepoints). All three validation layers pass on every input incl. `torture.txt`.

Run: `bun _experiments/glyph-encoding/run.js`

## Picking / access patterns (validated — `validate_picking.js`)

Functionality before optimization: the map must support every interactive op the
IDE does on hover/click/highlight/edit. `IndexView` (`index_view.js`) derives —
from the map alone — the full coordinate web and its inverses:

| op | mapping |
|---|---|
| hover-a-glyph | `slot → {line, col, codepoint, char, byteRange, glyphId, grapheme}` |
| do-stuff-at-index | `lineCol↔slot`, `byte↔slot`, all round-trip exactly |
| highlight-a-range | `lines` / `byteRange` / `substring` → exact slot set |

`slot == codepoint index == column == GPU instance index` (the monospace
`canonical-ruler` invariant), and `lineStart` == the builder's `lineSlotOffsets`.
Every mapping is checked against independent ground truth (computed straight from
the raw text) for EVERY slot, on every corpus file. A highlight image
(`out/*.highlight.png`) confirms a substring query lands on exactly the right
glyphs. The GPU pixel→slot step is the existing picking ID pass — out of headless
scope; everything from `slot` outward is proven here.

**Two structural findings the picking requirement forced** (not the byte layout):
- The cluster map had to become **per-line**, not whole-text — graphemes are
  line-local (a cluster never spans `\n`), and whole-text clustering mishandles
  CRLF and line boundaries. The access pattern revealed the right data shape.
- Grapheme `byteLen` is **redundant** — byte offsets derive from each codepoint's
  UTF-8 length via the dict. Dropped it; the cluster map now stores only
  codepoint-grouping.

## What the curve images reveal (honest ground truth)

The rasterized output is faithful to the map (reconstructed == reference, 0 px
diff) — and it also surfaces the **renderer's own** coverage limits, which are
orthogonal to the encoding:

- **CJK is blank** — no CJK font in this chain (Cousine/Meslo/DejaVu).
- **Emoji / ZWJ / flags / skin-tones are blank** — the color `EmojiAtlas` isn't
  loaded headlessly; those slots need the bitmap path.
- **Arabic/Hebrew render in logical order, isolated forms** — the FontChain
  monospace path does no bidi and no contextual joining (one slot per codepoint).

The map round-trips the *source bytes* of all of these perfectly; it just can't
render coverage the renderer itself lacks. The headless harness therefore can't
fully exercise emoji/CJK — that needs the `EmojiAtlas` + a CJK font.

## Caveats / not yet done

- **Slot-table persistence.** Slots are allocated by the live `FontChain` this
  process. A persisted/shipped cache must also serialize `slotMeta`
  (slot → fontIdx,gid) or re-derive slots — otherwise slots are meaningless
  across sessions/font-versions. Currently same-process only.
- **Stream bit-packing** is measured (the `map(bits)` column) but not emitted;
  the packed file still uses u16 indices.
- **Color/group** aren't in the map: today `color = item.color || defaultColor`
  is constant per file, so the 12 B `instanceColor` + 4 B `instanceGroupId` are
  pure redundancy. Real syntax color would be a future per-span layer.
- The rasterizer is a deterministic *proxy* for the Slug analytic-coverage shader
  (nonzero-winding scanline + supersample), not the exact GPU coverage. It's for
  discrimination (does the map reproduce the glyph stream?), not pixel-matching
  the GPU.

## Files

- `shaper.js` — loads the real `FontChain` headlessly (file:// fetch shim).
- `codec.js` — `encode`/`pack`/`unpack`/`decodeSource`/`expandRender`/
  `referenceRender`/`sizes`.
- `index_view.js` — `IndexView`: the access-pattern layer (slot ↔ line/col/byte/
  grapheme, range queries) + `cpByte`.
- `raster.js` — outline flatten + scanline fill + `renderHighlighted` + image diff.
- `png.js` — minimal PNG writer (node:zlib).
- `run.js` — encoding/fidelity/curve driver + metrics table.
- `validate_picking.js` — access-pattern validation vs ground truth + highlight image.
- `corpus/torture.txt` — adversarial Unicode (no zalgo). `corpus/sample.js` — code.
- `out/` — generated reference/reconstructed/diff/highlight PNGs.

## Where it slots into the system

- **Encode** (text→map) runs where shaping runs — at the `shapeText()` seam in
  `WorkerBridge`, in a worker or a Bun process. `MonospaceShapeCache` is already
  a per-codepoint dictionary; the map generalizes + persists it + adds the
  per-document index stream.
- **Decode/expand** (map→builder input) runs client-side, feeding
  `buildBatchBuffers`. `instanceGlyphId` already = FontChain slot, so the id
  space matches; position is the builder's advance scan (derived, not stored).
- **Cache** as `.glyph3d-shapes-<fontHash>.bin` beside `.glyph3d-session.json`,
  keyed by font version. Removes the current re-shape-on-every-open/reload cruft.

## Next

- Emit the bit-packed stream + ASCII fast-lane / exception split (realize 44×).
- Serialize the slot table; key the cache by font-version hash.
- GPU compute-expand: keep the map resident, scan to instances on demand
  (trade memory bandwidth for compute — the streaming-load direction).
