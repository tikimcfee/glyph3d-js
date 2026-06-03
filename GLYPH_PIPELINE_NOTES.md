# Glyph pipeline — convergence note (2026-06-03)

State of the live glyph rendering overhaul, written so the **major cleanup** has a
clean picture of what landed, what's deferred, and what this work made dead. Pairs
with agent memory `project_live_glyph_pipeline`.

## Landed + verified (screenshot loop)

The renderer now covers the full glyph range — specialty Unicode **and** color emoji —
auto-encoded on first sighting, columns aligned.

**New files (substrate, `packages/glyph3d-core/src/`):**
- `shaping/FontChain.js` — ordered fonts as ONE shaper; glyph IDs are dense global
  slots; per-codepoint routing (outline-first, except cp ≥ U+1F000 prefer color);
  bitmap-slot allocation for emoji; one shared HarfBuzz WASM across faces.
- `shaping/LiveSlugAtlas.js` — encoded-slot set + live GlyphField registry;
  `ensureGlyphsEncoded` re-encodes + hot-swaps curve/glyphMap textures into every field.
- `EmojiAtlas.js` — Canvas2D RGBA color-emoji atlas (browser-native NotoColorEmoji),
  fixed square cell grid, `ensure(cp)→cell`.
- `fonts/MesloLGS-NF-Mono.ttf` (~2.8 MB), `fonts/DejaVuSans.ttf` (~0.76 MB) — chain fallbacks.

**Modified:** `GlyphField.js` (slot-indexed glyphMap z=mode/w=emojiCell; TSL bitmap
branch; square emoji quad; field self-register), `shaping/slugData.js` (mode/cell
channels), `shaping/HarfBuzzShaper.js` (shared-hb init + `collectUnicodes`),
`collections/TerminalGrid.js` + `collections/CodeGrid.js` (live auto-encode via
`atlas._live`), `workers/WorkerBridge.js` (`resyncShapeCache`), `glyphEngine.js` (build
chain + emoji atlas), app entries (`apps/{ide,home}/main.jsx` pass FONT_CHAIN),
`app/commands/handlers/atlasCommands.js` (`atlas.info`/`atlas.encode`/`atlas.probe`).

## Deferred — persistence (do AFTER the cleanup)

The remaining half of the original ask: bake the slot table (cp→fontIdx/gid/slot/mode),
the Slug curve+glyphMap buffers, and the emoji atlas (PNG/cell-map) to `.glyph3d-atlas/`
via the Go fs/writeFile RPC; on boot, fs/readFile + reconstruct, skipping
HarfBuzz-shape / Slug-encode / emoji-draw when a font+emoji manifest matches. **Acceptance:**
a reload survives with no re-shape/re-encode/re-draw and glyphs+emoji still correct.
Not started — intentionally held so it lands on the post-cleanup architecture, not the
pre-cleanup one.

## Cleanup candidates this work created / exposed

(Candidates — verify reachability during the cleanup; flagged, not removed.)

1. **Canvas2D `GlyphAtlas` rasterization is dead for rendering.** The renderer draws from
   Slug curve/glyphMap + the emoji atlas; it never samples the GlyphAtlas canvas. GlyphAtlas
   now survives only as a **metrics provider** (`getCharSize()`, `getAtlasTexture().width`).
   Candidate: shrink it to that — drop the shelf-packing, `uvMap`, `_graphemeIds`,
   `ensureGraphemes`/`ensureCodepoints`, `generate()` rasterization, `exportAtlas` PNG, and
   likely `GlyphAtlasLoader` (prebuilt-PNG path). Verify no remaining readers of `uvMap`/metrics map.
2. **CodeGrid `if (!this.config.shaper)` legacy branch** (`_prepareAddsForBuild`, the
   `ensureGraphemes` path) — dead: the chain shaper is always present now. Remove.
3. **TerminalGrid** no longer calls `atlas.ensureCodepoints`/`uvMap`/`checkAndClearTextureUpdate`
   — confirm no stragglers reference the old Canvas2D upload flag.
4. `atlas.info`/`atlas.probe` reach into `FontChain._fonts` internals (diagnostic). Fine; tidy
   behind accessors if formalizing.

## Caveats / follow-ups (not blockers)

- **Double-width emoji.** Emoji use a square quad that overflows the monospace cell (centered),
  so dense emoji runs overlap. Terminal-correct fix = double-width advance (touches cell-counting);
  deferred.
- **Vite workspace-symlink watch.** Edits to `packages/glyph3d-core/**` are frequently served
  STALE (Vite serves the real path but watches the `node_modules/@glyph3d` symlink), forcing a
  `tools/dev.sh vite` clear+restart. A `vite.config` watch / `resolve.preserveSymlinks` fix would
  let core edits hot-reload — worth doing for the whole team's loop.
- **Full re-encode on growth** (LiveSlugAtlas re-encodes the whole set each time). Fine at current
  scale; could be append-only later.

## Convergence checklist (this surface)

- [x] All touched files parse (Vite `@fs` 200, no transform errors).
- [x] No temp `[PERF-PROBE]` / debug scaffolding left in the code.
- [x] Verified by screenshot: specialty glyphs, color emoji (upright, un-squished), auto-encode.
- [ ] Not committed (awaiting direction) — working tree is shared with parallel agents.
