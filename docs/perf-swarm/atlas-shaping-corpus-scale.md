# Perf swarm: atlas & shaping strategy for corpus scale

**Topic:** the glyph atlas (Slug curve textures) and shaping path, designed for "load
`torvalds/linux` in seconds." Grounded in `packages/glyph3d-core/src/shaping/`,
`GlyphField.js`, `core/glyphVertex.js`, `compute/GlyphTrie.js`, and the regression notes in
`docs/plans/layer2-wiring-and-load-regression.md`.

---

## 1. Problem framing

### What the atlas actually is today

`GlyphAtlas.js` is an empty handle. The real atlas is two RGBA32Uint textures produced by
`SlugEncoder`/`SlugBuffer` (`shaping/slugData.js`):

- **curve texture** — 2 texels per quadratic bezier: `[P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,0,0]`,
  uint16-normalized coordinates in 32-bit channels.
- **glyph-map texture** — 1 texel per glyph slot: `[curveStart, curveCount, mode, emojiCell]`.

Glyph ids are **FontChain global slots** (`shaping/FontChain.js`): dense integers allocated
**append-on-first-sight** by `slotFor(fontIdx, gid)`. Slot 0 = blank. Bitmap (emoji) slots
index the Canvas2D `EmojiAtlas` instead.

Shaping is already effectively a table: `FontChain.shape()` routes each codepoint by cmap
(first covering font wins), forces the primary monospace advance, and never uses HarfBuzz
cluster/kerning machinery. `MonospaceShapeCache` memoizes codepoint → `{g, ax}`.

### Why it hurts at corpus scale

The atlas is treated as a **runtime-growable data structure** when the workload's glyph
universe is **a tiny, knowable constant**:

- A whole source tree exercises ~1–3k unique outline glyphs (LARGE_CORE_RANGES in
  `packages/glyph3d-r3f/src/coreRanges.js` spans ~10k codepoints; the font-chain-covered
  subset is what costs anything). That is *nothing*. The atlas should be fully known at
  boot — and it nearly is: `tools/bake-slug-core.mjs` + `slugCoreCache` already bake/hydrate
  the boot core.
- But **growth is still on the load path.** The regression log shows v1→v6 grows per cold
  reload; one grow added +402 glyphs of which ~378 encode as `.blank` (variation selectors
  and zero-outline glyphs — pure noise, see §3.4).
- Each grow: `SlugEncoder.appendGlyphs` → **two brand-new `THREE.DataTexture` objects** →
  `LiveSlugAtlas.ensureGlyphsEncoded` loops **every registered GlyphField** (200→606 after
  FieldLabel) calling `setSlugData`. And `glyphVertex.js:48-64` documents the kicker:
  three's WebGPU bind-group cache is keyed on texture id/version, so swapping textures
  invalidates bind groups — the hot-swap is not just a JS loop, it's **N fields × GPU
  bind-group rebuild**, several times per load, on a cold page. Plus the pre-dispose-fix
  version leaked a texture pair per grow (preceded the 2026-08-04 device OOM).

### The ideal in one sentence

**The atlas is a build artifact, not a runtime data structure: bake the entire glyph
universe once, upload fixed-capacity textures exactly once at boot, and reduce the runtime
load path to a GPU trie lookup with zero HarfBuzz, zero texture swaps, and zero per-field
broadcast — forever.**

---

## 2. Design

### 2.1 Deterministic slot assignment — decouple identity from discovery order

Today's root flaw is that a glyph's slot depends on the order it was first sighted. Any new
sighting changes the *meaning* of the glyph-map texture, forcing a rebuild + swap.

Instead, the bake assigns slots **deterministically**: enumerate every (fontIdx, gid)
reachable from the baked codepoint universe, sort by `(fontIdx, gid)` (or by codepoint of
first coverage), and assign slots `1..N` in that order. The bake output becomes:

```
baked-core.bin
├── header: format version, font-chain key (= existing slugCoreKey), counts
├── slotTable:    sorted [(fontIdx, gid)] pairs, N entries      (Uint32 ×2)
├── codepointMap: the trie payload (§2.3) — codepoint → slot+advance
├── curve array:  all curves, uint16-packed, 1 texel/curve (§2.4)
└── glyphMap:     N entries [curveStart, curveCount, mode, emojiCell]
```

At boot, `FontChain` enters a **frozen mode**: `_slotByKey`/`_slotMeta` are pre-seeded from
`slotTable` so `slotFor()` reproduces the baked numbering exactly. Runtime sightings of
glyphs outside the universe allocate from a **reserved overflow region** (`N+1 … N+K`,
K = 512) that the baked textures already have capacity for (§2.2). Deterministic slots mean
the bake, the runtime, the worker transfer tables, and the GPU trie all agree on glyph
identity with no negotiation.

This subsumes the existing `slugCoreKey` content addressing: any font-chain change produces
a new key, the ladder recomputes once, done.

### 2.2 Fixed-capacity textures, in-place growth — the hot-swap dies structurally

The biggest single change. Upload the atlas textures **once**, at their **final capacity**,
and never create another texture object:

| texture | capacity | size | notes |
|---|---|---|---|
| curve | 65,536 curves × 16 B | **1 MB** (with §2.4 packing; 2 MB unpacked) | ~2–4× the baked need |
| glyph-map | 16,384 slots × 16 B | **256 KB** | covers N + overflow K with 8× headroom |
| codepoint trie | ~40 KB | (already the design in `compute/GlyphTrie.js`) | boot upload, per §2.3 |
| emoji | existing Canvas2D atlas, pre-sized | ~4 MB RGBA | partial-upload on sighting |

Total atlas VRAM: **~5–6 MB, allocated once.** Compare: today every grow allocates a fresh
pair (and until recently leaked the old pair).

**Boot path:** hydrate baked arrays → `new DataTexture(fullCapacityArray)` → upload once.
No encode, no growth possible during boot. Boot atlas cost: fetch + gunzip + one upload ≈
**10–20 ms**, once per device (IndexedDB hit) — the `slugCoreCache` ladder already does the
fetch/gunzip/validate part.

**Growth path (rare, overflow-only):** encode the new glyph's curves into the CPU-side
backing arrays at the cursor, then **write the new texels into the existing GPUTexture**
without touching texture identity:

- Preferred: a tiny compute/copy path — stage the new texels in a storage buffer and
  `copyBufferToTexture` (or an equivalent three-WebGPU upload) into the tail region. Texture
  object never changes → bind groups never invalidate → **zero per-field work**. The
  `LiveSlugAtlas._fields` registry and its broadcast loop are deleted outright.
- Acceptable fallback: three's partial-update mechanism (`texture.addUpdateRange`, WebGPU
  backend r160+) with `needsUpdate`. Caveat: `glyphVertex.js:48-64` says the bind-group
  cache key accumulates texture *version*, and `needsUpdate` bumps version — so verify on
  hardware whether a version bump on the same texture id rebuilds bind groups. If it does,
  this fallback is no better than today and the copy path is mandatory.

Because glyph-map entries for unencoded slots are all-zero (`curveCount=0` → the fragment
shader's existing `Discard(vCurveCount.equal(int(0)))` path), the spare capacity is
self-consistent: an unencoded glyph renders as nothing, no placeholder dance.

**What dies:** the hot-swap multiplier (regression suspect #1) is not batched or deferred —
it is *removed from the architecture*. `GlyphField.setSlugData`, `_ensureSlugTextures`
placeholder resolution, `registerField`/`unregisterField` for atlas purposes: all gone.
Fields reference the one global texture pair at material build.

### 2.3 Shaping: HarfBuzz is a boot-time glyph factory, never a text shaper

For monospace source rendering, "shaping" is `codepoint → (slot, advance)` where advance is
the forced cell width (or 2 cells for emoji). That is a **pure lookup**, and the repo
already built its GPU form: `compute/GlyphTrie.js` — a two-level UTrie, ~37 KB, two
dependent texture loads, content-deduped blocks.

The ideal pipeline:

```
BAKE TIME (offline / first boot, cached):
  for each codepoint in universe:   FontChain route → shape → slot, outline → curves
  emit: slotTable, curve/glyphMap arrays, trie payload
  HarfBuzz runs here and ONLY here (plus rare overflow sightings).

RUNTIME BOOT:
  hydrate arrays, upload 3 textures once (~15 ms). No HarfBuzz shaping of text. No priming.

LOAD PATH (per file, per glyph): NOTHING on CPU.
  kernel 1 (decodeAndResolve, compute/glyphPipelineKernels.js):
      byte → codepoint (UTF-8 decode, already in the pipeline)
      codepoint → {slot, advance, flags} via 2 trie texel loads
  Zero JS, zero WASM, zero shape cache, zero worker round-trip.
```

Concretely retired from the hot path:

- `MonospaceShapeCache.lookup/prime/shapeLine` — becomes a **bake-time-only** helper and the
  overflow-resolution fallback. Its worker transfer (`toTransferArray`) is unnecessary: the
  trie replaces it.
- `shapeCache.prime(codepointsFromRanges(...))` in `glyphEngine.js:107` — gone (subsumed by
  the bake).
- The **miss flow** from the Layer-2 plan (`layer2-wiring` M1.5: `readMisses → cache.lookup
  → ensureGlyphsEncoded → trie patch → re-run`): for the baked universe every codepoint has
  a trie *value*, not a miss. Uncovered codepoints resolve at bake time to an explicit
  entry `{slot: 0, advance: cell, flags: UNCOVERED}` — the layout stays right (occupies its
  cell), renders blank, and **never re-enters any flow** (regression suspect #2, the blank
  storm, dies here too). A thin miss list survives only for overflow glyphs worth encoding
  (a genuinely new outline glyph — e.g. a Nerd-Font icon outside the bake), and its
  resolution is: encode into overflow capacity (§2.2), patch the trie blocks for those
  codepoints, done. No re-run of dispatches needed if kernel 1 treats "slot pending" as
  blank-but-correct-advance; the next frame picks up the patched trie naturally.

**Is HarfBuzz shaping ever needed at runtime?** Only for text where clusters matter:
combining sequences, ZWJ emoji, RTL. Source code in a monospace grid is one-cell-per-
codepoint by design (FontChain already forces this). The corpus-computed tail in
`coreRanges.js` confirms the real universe. Combining marks render as individual cells —
the same behavior terminals ship. So: **no, shaping is not on the hot path, and the design
should stop paying for it there.** (If a future "rich text" view wants real shaping, it's an
opt-in per-view CPU pass, not a load-path tax.)

### 2.4 Slug bezier vs SDF vs cached coverage — keep Slug, pack it tighter

**Verdict: keep Slug.** The reasoning is quantitative:

- *Magnified/readable zoom* — Slug's single-sample analytic coverage is exact and already
  tuned (dilate/soften ramps). An SDF atlas would need a second texture set (2048² R8+mips
  ≈ 5.6 MB), bilinear sampling artifacts on thin strokes, and buys nothing here.
- *Minified masses* (the corpus-scale case: thousands of files on screen) — the per-curve
  loop is **already bypassed**: `GlyphField.js:364` impostor (curveCount × density, no loop)
  past LOD_HI, and `:443` the opaque occluder path (no discard → early-Z) for depth-stacked
  scenes. The expensive fragment path only runs where text is actually readable, where the
  number of visible glyphs is screen-bounded (~10–20k quads), not corpus-bounded.
- *The known Slug weakness* — foreshortened minification breakup (`GlyphField.js:209-212`) —
  is an LOD-tuning matter, not a format matter.

So the format is right; the **encoding is wasteful**. Two concrete wins:

1. **One texel per curve.** A quadratic needs 6 uint16 coordinates = 12 bytes ≤ one
   RGBA32Uint texel (16 B). Pack channels as 2×uint16 each: `t.x = p0x | p0y<<16`, etc.
   Effects: fragment loop does **1 texture load per curve instead of 2**
   (`GlyphField.js:373-374`), curve texture halves (2 MB → 1 MB at 65k capacity), texture
   cache locality doubles. At a readable full screen (~2M fragments × ~12 curves) that's
   ~48M → 24M texel loads/frame. Cost: an extra unpack shift/and per coordinate — ALU is
   free relative to texture traffic here.
2. **Drop MAX_CURVES from 256 to a realistic bound** (e.g. 64; the loop already breaks at
   `vCurveCount`). `Loop(MAX_CURVES)` with a `Break` generates the same code either way in
   WGSL-unrolled terms, but the bound feeds register allocation and the worst-case trip
   count the compiler must assume. Measure before/after on the readable-zoom stress scene.

Cached coverage (per-glyph bitmap impostors) is a *third* option that isn't needed: the
curveCount-density impostor already collapses minified glyphs to zero texture loads, and a
coverage cache would reintroduce an atlas-growth problem (per-glyph bitmap cells) we just
eliminated.

### 2.5 Binding model: one immutable set, not bindless

The game-engine reflex (bindless/descriptor-indexed atlases, array textures) solves a
problem this workload doesn't have: many atlas textures. We have **one** working set. The
right model:

- **One curve texture + one glyph-map texture + one trie texture, fixed identity for the
  session's lifetime**, bound in the single shared glyph program. No per-field binding at
  all — the field count (606 and rising) is then *irrelevant* to the atlas.
- All per-glyph variation stays where it already is: `instanceGlyphId` → glyph-map texel.
- Emoji stays a separate filterable RGBA texture (bitmap branch), also fixed-identity with
  partial canvas→texture uploads on sighting (`EmojiAtlas` already repacks; make it
  pre-sized so repacks stop).
- Array texture / bindless: **explicitly rejected** — added binding complexity to serve a
  multi-atlas scenario the corpus working set will never create.

### 2.6 Data flow summary

```
offline bake (tools/bake-slug-core.mjs, extended)
    fonts + universe ──HarfBuzz──► deterministic slots, curves, glyphMap, trie payload
        └──► baked-core.bin (~1–2 MB raw, ~300–600 KB gz) ──► shipped asset + IndexedDB

boot (glyphEngine.js)
    load baked-core ──► FontChain.frozenSlots(slotTable)
                     ──► 3 fixed-capacity DataTextures, upload once   [~15 ms]
                     ──► atlas done for the session

load 30k files (byte-in pipeline, Layer 2)
    per file: TextEncoder → setFile(bytes) → 3 dispatches
    kernel 1: bytes → codepoints → trie loads → {slot, advance}   [GPU, no CPU]
    atlas cost on load path: 0 ms, 0 texture objects created, 0 bind-group rebuilds

runtime overflow sighting (rare; genuinely new outline glyph)
    FontChain allocates slot in reserved region
    encode curves → write texels into existing textures (copy path)
    patch trie blocks → next frame renders it
    fields notified: none. there is nothing to notify.
```

### 2.7 ms budgets (per cold load of a repo-scale corpus)

| stage | today (regression doc) | ideal |
|---|---|---|
| boot atlas (per page load) | hydrate ~15 ms **or** live encode + re-grows | ~15 ms hydrate, once |
| atlas during corpus load | v1→v6 grows × (encode + swap × 200–606 fields + bind-group rebuilds), est. 0.5–2 s + OOM risk | **0 ms** |
| shaping during corpus load | per-codepoint JS lookups through shape cache / worker tables | **0 ms CPU** (trie in kernel 1, ~2 texel loads/glyph on GPU) |
| blank-glyph handling | encode-as-.blank + full grow + re-swap per batch | bake-time zero entries; trie value; never re-enters |
| atlas VRAM | grows per grow; leaked pairs pre-fix | ~5–6 MB fixed |

For scale: kernel 1 over 100M bytes ≈ 100M threads × (UTF-8 decode + 2 texel loads) — a
few ms of GPU time total across the corpus, fully overlapped with upload. The atlas is no
longer a load-path line item at all.

---

## 3. Mapping onto existing seams

| existing seam | change |
|---|---|
| `tools/bake-slug-core.mjs` + `shaping/slugCoreCache.js` | Already 80% of the design (ladder: IndexedDB → served asset → live encode). Extend the bake to emit `slotTable` + trie payload + deterministic ordering. The served-asset rung already exists; ship the asset. |
| `shaping/FontChain.js` | Add frozen mode: `freezeSlots(slotTable)` pre-seeds `_slotByKey`/`_slotMeta`; `slotFor` after freeze only allocates ≥ overflowBase. Slot 0 and BITMAP_KEY_BASE semantics unchanged. |
| `shaping/slugData.js` (`SlugBuffer`) | Doubling arrays → fixed-capacity arrays sized at boot; `serialize`/`deserialize` survive as the bake format (extend with slotTable). The `.blank`/empty-outline entries are written at bake time; `addGlyphs` becomes the overflow-only append at reserved offsets. |
| `shaping/SlugEncoder.js` | `_buildTextures` builds full-capacity textures once. `appendGlyphs` → writes into backing arrays + triggers the in-place GPU write (copy path), returns no new texture objects. |
| `shaping/LiveSlugAtlas.js` | Slashed: no `_fields` registry, no broadcast, no `setSlugData` hot-swap. Keeps only: overflow ensure + provenance logging + `loadStats` counters (which should then read ~0 on loads). The emoji `_refreshEmojiTextures` path survives but targets a pre-sized emoji texture (partial upload instead of `needsUpdate` full re-upload). |
| `GlyphField.js` (`setSlugData`, `_ensureSlugTextures`, placeholder 1×1) | Deleted. The shared material binds the module-global texture pair built once in `bootGlyphEngine`. Material never rebuilds for atlas reasons. |
| `core/glyphVertex.js` bind-group-cache note (lines 48–64) | The workaround stays for byte-slots arena realloc (different problem), but the atlas stops being a texture-swap trigger entirely. |
| `compute/GlyphTrie.js` + `glyphPipelineKernels.js` kernel 1 | Trie payload ships inside the bake (single artifact, one key). Kernel 1 unchanged in shape — it already does the trie lookup; the difference is the trie is complete at boot and misses are values. |
| Layer-2 plan M1.4/M1.5 (real-atlas trie builder, miss flow) | M1.4 simplifies to "hydrate trie from bake"; M1.5 shrinks to the overflow path. `known-uncoverable codepoints map blank-resolved` is already the plan — the bake just makes it universal and offline. |
| `MonospaceShapeCache` / `shapeText.js` / worker transfer tables | Bake-time factory + overflow fallback only. Deleted from the load path (worker `toTransferArray` need dies with the trie). |
| `packages/glyph3d-r3f/src/glyphEngine.js` boot | Replace prime/encode/cache-ladder with: fetch bake → freeze FontChain → build 3 textures. Keep `cache:false` live-encode fallback for dev (it re-derives the same deterministic slots, so behavior is identical, just slower once). |

### The `.blank` storm, explained and closed

The 378-of-402 grow: variation selectors (U+FE00–FE0F, zero-width, ride every emoji) plus
codepoints whose routed font glyph has an empty outline (glyph literally named `.blank` —
see `FontChain.describeSlot` note at `FontChain.js:309-314`). `encodeGlyph` returns
`curves: []` for them, so the grow *encoded nothing visible* yet paid the full price:
texture rebuild + all-field swap. In the ideal design these codepoints are resolved **at
bake time** to zero-curve entries (or, for zero-width format chars, to a
`{advance: 0, slot: blank}` trie value), so they never appear as a runtime event. The
`loadStats.atlasBlanks` counter should stay at 0 during loads; make it trip a warning if it
isn't.

---

## 4. Risks / open questions

1. **three.js partial texture update semantics (the load-bearing unknown).** Does the
   WebGPU backend support sub-region uploads on a persistent `DataTexture`, and does
   `needsUpdate`/version bump rebuild the texture-keyed bind groups even when texture
   identity is unchanged? `glyphVertex.js:48-64` implies version is in the cache key. If
   any JS-side flag rebuilds bind groups, the only clean path is a GPU-side
   copy/compute write into the GPUTexture — needs a small spike against the three version
   in `node_modules` (re-check `WebGPUBindingUtils.createBindings` as the comment says).
   **Mitigation:** growth is overflow-only and rare, so even a clumsy path is survivable —
   but the *boot* immutability (the 99.9% case) doesn't depend on this at all.
2. **Universe completeness.** If the corpus contains codepoints outside the bake (CJK in
   comments — the linux kernel has some), they resolve blank-with-advance: correct layout,
   invisible glyph. Options: accept (tofu), extend ranges and re-bake (key change → one
   recompute), or let overflow encode handle it (works, but CJK would blow the 512-slot
   overflow — size overflow by corpus audit: `coreRanges.js` shows the audit methodology
   already exists; re-run it on the target corpus). Recommend: corpus-audit tool runs in
   CI, bake covers everything audited.
3. **Deterministic slots across environments.** Bake and runtime must derive identical
   slots from identical fonts; the `slugCoreKey` mechanism already gates this (miss →
   recompute). Keep slot *re-derivation* (frozen seeding) implemented via the same sorted
   enumeration the bake uses, so a cache miss and a hydrate produce the same numbering.
4. **1-texel curve packing is a shader + encoder + bake-format change in one move.** Needs
   new harness lanes (the `glyph-pipeline-check` / slug validate suites) and a
   SLUG_BUFFER_FORMAT bump. Low risk, mechanical, but touches the hottest shader.
5. **Emoji atlas growth** is the remaining runtime texture mutation. Pre-size it (fixed
   grid, partial uploads) or accept the current cheap refresh — emoji are bitmap slots and
   never trigger curve growth anymore, so this is already second-order.
6. **Interaction with the mega-field / one-draw proposals** (other agents): fixed-identity
   atlas textures are a *prerequisite-shaped gift* for merging draws — one less per-field
   binding difference. No conflict expected; the byte-slots rebind seam
   (`rebindByteSlots`) is orthogonal.

## 5. Effort estimate

| piece | effort |
|---|---|
| Deterministic bake: slotTable + frozen FontChain + corpus-audit ranges | 2–3 days |
| Fixed-capacity textures + boot-once upload; delete hot-swap/registry machinery | 1–2 days |
| In-place overflow growth (partial-update spike → copy path) | 1–3 days (spike-dependent) |
| Trie payload in bake; retire load-path shaping + miss flow | 1–2 days (assumes Layer-2 kernels land separately) |
| 1-texel curve packing + MAX_CURVES retune + harness lanes | 1 day |
| Emoji pre-sizing (optional) | 0.5 day |
| **Total** | **~1.5–2 weeks**, gates: slug validate suites, glyph-pipeline-check, itests, three consecutive cold-load profiler runs (`tools/load-profile.mjs`) showing `atlasGrows == 0` during loads |

**Expected payoff:** the atlas line item on the load path goes from ~0.5–2 s (plus OOM risk
and reload-storm amplification) to literally zero; boot loses the live-encode path; the
fragment shader's texture traffic halves; and the field count — the multiplier that made
every atlas event expensive — stops mattering to the atlas at all.
