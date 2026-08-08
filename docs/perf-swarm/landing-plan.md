# Landing plan — rows, not actors (greenlit 2026-08-08)

The measurement that sets the direction, from live 1489-file traces (relay log store):
fetch 150ms · GPU layout pipeline ~200ms encode · self-bake 212ms · tree-sitter 1.4s —
**the exact-layout machine costs ~0.5s for 1500 files. The 5–48s lives in the object
system around it.** The load unit is still the file-as-actor: every file constructs a
CodeGrid Object3D, panel mesh, background, caret, filename item, pick registration,
registry record, workspace sheet, React rows, per-grid promises, per-grid analyze —
and pour beats re-lay the whole tree and fan out to every listener. The mega-field
killed per-file *glyph* construction; everything around the glyphs still constructs
per file. Patterns fine per component; quadratic-ish in aggregate.

**The shape:** the load unit becomes the BATCH; actors materialize on interaction
(the mirror-oracle law, generalized — the ECS direction). Target budget for 1000
files: ~100ms transport + ~200ms flush + ~100ms relayout + worker-side color =
**cold loads in the half-second class, warm loads in milliseconds off the bake index.**
Every step independently measurable with the loadStats/loadTrace counters in place.

## The five moves, with owners

1. **Files become ROWS, not actors** *(CF — Claude session)*. A load writes arena
   items + mega-field view records + registry DATA rows; the CodeGrid object
   materializes on first interaction (focus/edit/caret), same law as the lazy
   oracle. Data-driven layout: the content tree lays out row records (measure from
   the bake index — rows/widest exact before bytes), not Object3D trees.
2. **One panel draw** *(CF, with move 1)*. A thousand panel meshes become instanced
   quads posed by the same group texels that pose the glyphs (backplate machinery
   half-exists in the glyph-fill lane). Pick IDs are 32-bit now — a panel-instance
   channel fits.
3. **Worker-pool colorization → palette bytes** *(CF-k — colorization-pipeline lane)*.
   Tree-sitter in the worker pool emitting 1B/glyph palette indices; ONE typed-array
   write per file lands them (no per-capture main-thread range calls). The bake
   index is the natural cache home (content-hash keyed — see the delta review);
   spans as index lanes when the format next revs. **This consolidation is a big
   deal on its own** — it removes the largest uncounted main-thread block.
4. **One binary stream in** *(CF-k — disk-to-gpu lane)*. fs/streamTree frames land
   bytes in the arena with no JSON, no strings; the index.bin one-container pattern
   is the template.
5. **One transaction out** *(CF — with move 1)*. One relayout, one registry/React
   flush per load; pour beats stop fanning per-beat over thousands of rows.

## Standing constraints (all proven, keep them)

- Slot == source byte offset (sourceBase is the ONE translation). 32-bit pick space.
- The arena free-list (byteStart never moves) + pre-sizing from the bake index.
- The edit fast path (in-place rewrite, 0x80 slack) — rows must not regress typing.
- The bake index: record always exists (self-bake fallback), window always exists.
- Fold gates: bake.test (879), scan-layout, glyph-pipeline, layout-fuzz,
  arena-compaction-check, loadstorm (needs the :8099 scratch relay up).
- MEASURES.md v3 (docs/measures-refactor/) is the bounds contract move 1 builds on:
  leaves declare intrinsic measure (the bake record), containers aggregate.

## Coordination

Two agents, one tree: commits are the channel (both sides demonstrably read them).
Overlap-scan before commit; the compaction-requirements memory tracks open items
(pick-generation stamp vs recycled ranges, instance-count shrink, index-on-ctx).
