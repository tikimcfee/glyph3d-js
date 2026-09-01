# u32 slot-lane migration map — SUPERSEDED

This was a generated survey of every slot-lane access site, classified by lane KIND,
produced by `tools/lanemap.mjs` while the pipeline ran one `uint` slot buffer with the
measure lanes bitcast into it.

**Both the survey and its generator are gone, because the thing they described is gone.**
The slot record is two arrays now — an f32 array of measures beside a u32 array of exact
lanes — so a lane's kind is the array it lives in. There is no classification to survey:
the question "which treatment does this lane get" cannot be asked of a container that
holds exactly one kind.

Its opening line said *"The slot buffer IS `uint`"*, which is now false. That is the
reason this file was replaced rather than left in place — a stale doc that states a fact
is worse than no doc, because it reads as current.

What replaced it, and where the current facts live:

- `compute/glyphPipelineReference.js` — the two lane tables (`SLOT_MEASURE_STRIDE` /
  `SLOT_EXACT_STRIDE`), and the render-read prefix each array leads with.
- `tools/slot-type-discipline.test.mjs` — the shader-side guard, restated for two
  carriers. Its strongest tooth is now a property rather than a discipline: **no bitcast
  may appear in the vertex slot path at all.**
- `tools/contract-conformance.test.mjs` — this layer's mapping against the shared KIND
  declarations, including that the render-read prefix equals the contract's `VERTEX_READ`.
- `docs/plans/carrier-split-and-decast.md` — the plan this work executed, with the census
  and the ordering correction.
