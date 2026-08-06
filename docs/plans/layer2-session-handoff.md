# Layer 2 byte-in pipeline — session handoff (2026-08-06)

**Where main stands:** the byte-in GPU pipeline IS the layout engine for CodeGrid.
A load is `TextEncoder` → arena `stage()` → one coalesced flush (3 dispatches per
storm) → fields read the shared stride-11 slot buffer in the vertex shader
(`slotBase` per item). No worker shaping, no builder fold, no per-grid kernels.

## Committed, in order

- `0ad399f` one load path (sync load path deleted)
- `c374023`+ bounds as closed form (Layer 1; foldGeometry.js)
- `19dd817` M1: zWrapStep, scrollRows, totalRows/maxRowExtent lanes, live trie
- `9b2785c` M2: render bridge — fields read the pipeline's slot buffer (byteGlyph material kind, pick twin)
- `8026641` M3: CodeGrid byte-in end-to-end (ByteLayoutDescription: slot == byte offset)
- `7fbffc7` the arena: one pipeline per app, item table, 3 dispatches per storm
- `b116a26` load-path instrumentation (`core/loadStats.js` — every `[load]` line self-decomposes)
- `87ff8ac` bulk-bench lanes in layout-kernel-check

## Measured state

- Cold root restore (474 grids): total ~3.4–4.8s; seat ~2.0s (was ~9–11s with
  per-grid pipelines). kernels per storm: 24 (was 483×3). Still above Ivan's
  0.5ms/grid target — the remaining seat cost is grid/panel construction +
  commit bookkeeping, NOT GPU work (pure exec is ~1ms for 1.5M slots).
- Gates: glyph-pipeline 110, backtrack 43, byte-description 22, mirror 126,
  fuzz 200 seeds, node sweep, vite build — all green. glyph-pipeline-check:
  **31/31 lanes on hardware** (incl. multi-file item-isolation lanes).
- `layout.verify package.json` on a live grid: GPU == mirror, worst 0.0e+0.

## The one open bug

`tools/itests/byte-field.itest.mjs` fails: `RangeError: Invalid typed array
length: 2442` in `GlyphPipelineKernels.readSlots()`. Facts established:
`this.byteLength` is only set inside `setFiles()` (line ~638) and is undefined
before the first flush (→ NaN buffer size → createBuffer throws). 2442 = 222×11,
so in the itest the last flush covered 222 bytes (the test's 73 + ~149 of boot
labels) — verifyItem/readSlots assume a just-flushed, arena-wide byteLength.
Likely fix shape: initialize `byteLength = 0` at construction and make readSlots
take an explicit range (or read the whole allocated buffer); verifyItem should
read exactly the item's slice. Confirm against the multi-file lanes in
glyph-pipeline-check (they pass — they read back right after a controlled flush).

## Debug-loop laws learned (the expensive way)

1. **A WebGPU probe that never navigated to a served origin is not evidence.**
   `navigator.gpu` is secure-context-only; `about:blank` isn't one in Chromium 148.
   An entire "WebGPU is wedged machine-wide" investigation was an artifact of
   probing about:blank. (Recorded in dev-loop gotchas by the other agent too.)
2. **`1 << 31` is negative.** The arena's limits probe requested
   `maxBufferSize: -2147483648`; `requestDevice` rejected and three's
   WebGPURenderer fell back to WebGL2 *silently* (the rejection reason never
   prints). Fix: `2 ** 31`. When three says "WebGPU is not available," read its
   fallback path before theorizing about drivers.
3. The GPU never OOM'd — device creation died before any allocation.
4. Vivaldi headless: needs `--no-sandbox` (sandbox segfaults under CDP), rejects
   playwright's handshake entirely, and /json/new-created targets have dead ws
   endpoints (reuse the launch target). Raw CDP over bun's WebSocket works.

## Next

1. Fix the readSlots/verifyItem flush-state bug (above).
2. Finish the load-time hunt: seat is construction+bookkeeping now — profile
   `CodeGrid` construction + `attachBytePipeline` per grid; the 0.5ms/grid target
   needs those, not GPU work.
3. M4/M5 leftovers from `docs/plans/layer2-wiring-and-load-regression.md`:
   edit-path timing validation, arrangers byte-native (displacement re-index),
   Layer 1 retirement (GlyphLayoutKernel/Compute, evaluateFold, foldGeometry —
   currently dormant but gate-referenced), worker build path retirement for grids.
4. r185: safe to take whenever; nothing in it we need (research note in session).
