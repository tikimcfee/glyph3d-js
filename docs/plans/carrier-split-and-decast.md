# Split by carrier, delete the casts

Plan of record, written 2026-08-30 by the render/JS session, immediately after the
item-table migration. Ivan's framing, and it is the right one: *casts back and forth
usually mean something is being made compatible or patched into place, which isn't
always the right path.*

## THE FINDING

The pipeline binds **21 storage buffers**. Nine of them carry **two kinds in one
container** — exact integers and real measures — and every access to a measure lane
goes through a `bitcast`. There are **33 bitcast sites** in `glyphPipelineKernels.js`
alone, plus the vertex path's `fl()` helper (one definition, six reads) and ~29
`fbits`/`fval` calls on the CPU mirror.

The casts are not the problem. They are the *symptom* of the mixed container, and the
mixed container is the single cause behind every defect this session:

| defect | shape |
|---|---|
| slot ordinals past 2^24 | exact value on a float carrier |
| pick ids (3 carriers) | exact value on a float carrier |
| `foldScalars` `totalRows` | exact value on a float carrier (ordered key) |
| `GLYPH_ID` | exact value on a float carrier, inherited from the trie |
| trie `glyphId` + `flags` | exact values on a float carrier |
| `I_BYTE_COUNT` | exact value on a float carrier |

Six instances, one cause. **We fixed the instances and preserved the cause.** The
containers are correct now; they are still mixed, so the next lane added to any of them
is one discipline lapse away from number seven.

## WHY THE ORIGINAL JUSTIFICATION IS DEAD

The stated reason, in `GlyphTrie.js`'s own comment: *"a single array keeps the GPU
binding to one buffer instead of two."*

That was a real trade once. It is not one now — **21 buffers are already bound.**
Splitting the nine mixed ones adds at most nine more, and no shader stage binds all of
them. The saving was never large and is now noise against the count.

## THE DECISIVE ARGUMENT — where the error is allowed to live

    one mixed buffer + bitcast   a wrong-kind read is a CORRECT-LOOKING access that
                                 returns a denormal. Silent. Wrong only in a range
                                 nobody tests. Kind lives in a side table (LANE_KIND)
                                 consulted by DISCIPLINE.

    split by carrier             a wrong-kind read is reading the WRONG VARIABLE. The
                                 storage node's declared type IS the kind. Enforced by
                                 the type system, not by a convention someone must
                                 remember.

This is the difference between a convention and a constraint. We have paid for the
convention six times.

## THE EVIDENCE IT WORKS — the engine already did it

mojo-rising split their realizations by carrier (`blocks_m` f32 / `blocks_c` u32, with
accessors on the struct) and reports **zero bitcasts**. Same kinds, same shared
contract, both layers conformant — the tier split explicitly permits different
containers per layer. So this is not a hypothesis: one of the two implementations of
this pipeline already runs without casts, and it is the faster one.

## INVENTORY — what is mixed, what is not

MIXED (the work):

| buffer | stride | exact lanes | measure lanes |
|---|---|---|---|
| `slots` | 12 | `GLYPH_ID` `ROW` `COL` `FLAGS` `ORD` (5) | `ADVANCE` `HEIGHT` `X` `Y` `Z` `BASE_X` `LINE_ADV` (7) |
| `itemTable` | 15 | `PAGE_ROWS` `PAGE_COLS` `PAGES_WIDE` `SCROLL_ROWS` `WRAP_WIDTH` `BYTE_COUNT` (6) | origins, gaps, depths, `Z_STEP`, `LINE_HEIGHT` (9) |
| `trieBlocks` | 4 | `GLYPH_ID` `FLAGS` (2) | `ADVANCE` `HEIGHT` (2) |
| `partials` / `partialPrefix` / `supers` / `superPrefix` | 8 | 7 counts | `TAILADV` (1) |
| `foldScalars` | 2 | `totalRows` (1) | widest-row extent (1) |
| `farItems` | 5 | slab coords, dirty flag | rows/cols-per-texel |

NOT MIXED — leave alone, and do not migrate for symmetry:

- `itemStrides`, `farInk` — all-measure, `'float'` is *correct*.
- `byteWords`, `trieIndex`, `ordToByte`, `itemStarts`, `misses`, `missCount`,
  `farDirtyList`, `farAccum`, `farPacked` — all-exact, `'uint'` is correct.
- **`itemBoxes` is a special case: read it before touching it.** Its six lanes are all
  measures, stored as f32 ORDERED KEYS in a uint buffer. That encoding exists because
  `atomicMin`/`atomicMax` need integers — it is an atomics requirement, *not* kind
  mixing. Removing it would break the reduce. `foldScalars` lane 1 is the same
  technique for the same reason.

## ORDER OF WORK — CORRECTED 2026-08-30, and the original was wrong

The first ordering was written on "smallest first," which is not the same question as
**which split actually deletes casts**. Counting the real call sites (comments excluded,
classified by the buffer each touches) gives 31, not the 33 estimated above:

| buffer | bitcast sites |
|---|---|
| `slots` | 14 |
| `itemTable` | 13 |
| scan buffers (`P_TAILADV`) | 2 |
| ordered-key helpers (atomics — legitimate, keep) | 2 |
| **`trieBlocks`** | **0** |

**Standing at 16 of 31**: the 14 on `slots` and the 2 legitimate atomics helpers. Every
cast left in the kernels is now either on the one buffer that still mixes kinds, or is an
ordered key that has to be an integer for `atomicMin`/`atomicMax` to work at all.

`trieBlocks` has **zero**. Both the trie and the slot buffer are u32-with-bitcast-measures
today, so a measure copies from one to the other VERBATIM — the verbatim copy is the
reward of both containers sharing the same wrong convention. Splitting the trie alone
would have *added* two casts at the trie→slots seam. Step 1 as originally written made
the number go up.

The rule the census produces: **a cast dies only when BOTH ends of the copy are
single-kind.** So order by casts-deleted-with-nothing-added:

1. ✅ **`itemTable` — DONE.** 13 sites, and the decisive property is that it is
   GPU-READ-ONLY (packed on the CPU, never written by a kernel), so its measures land in
   float arithmetic and nothing needs a cast back. 31 → 18 sites, none added. Split into
   `itemMeasures` (f32 × 9) + `itemExact` (u32 × 6).
2. ✅ **The scan buffers — DONE.** 2 sites, and the shape is the point: one float lane
   (`TAILADV`) was setting the container type for seven counts it had nothing to do with.
   Each rung is now a `{c, a}` pair — counts u32 beside one advance f32 — paired in plain
   JS at construction, so all nine call sites still name a rung and nothing changed at
   dispatch. `P_STRIDE` 8 → 7. **18 → 16 sites.**
3. **`slots` + `trieBlocks` TOGETHER** — 14 deleted, 0 added, and only together. This is
   the step that wants the far-LOD gate first (below), and the step the record/compaction
   work may subsume rather than repeat.
4. **`farItems` — DEFERRED, deliberately, and it corrects the census above.**

## THE CENSUS COUNTED SYMPTOMS OF ONLY ONE FAILURE

Ordering the work by bitcast count was better than "smallest first," and still not right,
because **a bitcast is the symptom of only ONE of the two ways a container can be wrong.**

    mixed uint container    measures bitcast in and out. Symptom: casts. Countable.
    uniform float container exact values ride float lanes. Symptom: NOTHING. Zero casts.

`farItems` scored 0 in the census and is not clean — it is a `'float'` buffer holding two
genuine measures (`ROWS_PER_TEXEL`, `COLS_PER_TEXEL`) and **three exact values**:
`FI_SLAB_X` and `FI_SLAB_Y` are texel coordinates converted with `int(...)` at every read,
and `FI_DIRTY` is a flag tested as `.lessThan(float(0.5))` — the float proxy for a bit
test, the *same* line that was deleted from the trie's flags lane hours earlier
(`tflags.greaterThan(float(0.5))`). It is exactly how `GLYPH_ID` and `I_BYTE_COUNT` looked
before they were caught: small values, no casts, no symptom, correct until the range grows.

So the count is a *lower* bound on the work, never the measure of it. A buffer with no
casts has either one kind or a hidden float carrier, and only reading the lanes tells you
which.

Deferred rather than done, for reasons that are about risk and not about effort:

- It deletes **zero** casts. Its whole value is removing a latent exact-on-float instance.
- `FI_SLAB_X` uses **−1 as a sentinel** for "no slab", so a u32 container needs a real
  re-encoding (a `HAS_SLAB` bit beside `DIRTY`), not a lane move. That is a semantic
  change to the far subsystem, not a carrier change.
- The far path is **the least covered code in the pipeline** — `far-texels-check` proves
  the scatter and normalize kernels, and the `vRowCol` → far-texel UV derivation has no
  GPU gate at all (`tools/CHECKS.md`). Doing the riskiest re-encoding in the thinnest
  evidence is the trade this plan already refused once for `slots`.

Right order for it: build the far-LOD UV gate, then re-encode `farItems` and split `slots`
behind the same instrument — which is the same prerequisite step 3 already has.

Each step: mutation-test that a wrong-kind access now FAILS TO COMPILE or reads a
different variable, rather than returning a denormal. That property is the deliverable;
the deleted casts are a side effect.

## THE PREREQUISITE NOBODY SHOULD SKIP

**The far-LOD `vRowCol` -> far-texel UV path has no GPU gate** (`tools/CHECKS.md`,
"What is NOT covered"). It is the one path whose failure is silent — near text renders
correctly while every far glyph collapses to texel (0,0) — and step 2 touches exactly
it. Build that gate before splitting `slots`, or the step with the worst failure mode
is the step with no evidence.

## WHAT STEP 1 TURNED UP — a defect in the SHARED tier

Splitting the item table made a question askable that could not be asked while every lane
sat in one mixed container: **does each parameter ride the carrier its declared KIND
requires?** Asked for the first time, it failed immediately, and not on this layer:

`PAGE_ROWS`, `PAGE_COLS`, `PAGES_WIDE`, `SCROLL_ROWS`, `WRAP_WIDTH` are declared
`'measure'` in `schema/glyph-identity.json`. They are integer page geometry. The paginate
kernel reads every one of them through `int()` and explains why in its own comment —
keying a page decision off a float put 119 glyphs on the wrong page, because f32 addition
is not associative and a boundary row wobbles by a ULP.

They are declared measures because the *other* layer's item table is a single f32 array
literally named `measures`, so every lane in it was classified as one. **The container
defined the kind** — which is the exact inversion the tier split exists to prevent. It is
the same family as `GLYPH_ID` and `I_BYTE_COUNT`: exact-in-practice on a float carrier,
unbitten so far only because page counts are small.

This layer has always stored them exact, so nothing here is broken; the split is what made
the disagreement VISIBLE, not what caused it. Fixing `KIND` edits the shared schema and
puts the native backend's f32 item table in violation of its own contract, so it is a
cross-layer decision for mojo-rising and Ivan, not a unilateral edit. It is declared in
`tools/contract-conformance.test.mjs` as `KIND_DISPUTED`, **armed**: each entry asserts
the contract still says `'measure'`, so the day the schema is corrected the entry goes
stale and the gate fails until it is deleted. A dispute cannot outlive its resolution.

## AND THE BIGGER THING THIS IS ADJACENT TO

Ivan's actual target is not the casts and was not the `2^24` constant (which is gone —
no live `2 ** 24` remains in `packages/glyph3d-core`). It is the **architecture**:

> **48 bytes of GPU state per SOURCE BYTE, held for every byte loaded whether or not it
> is ever drawn.**

`ARENA_MAX_BYTES` = 2GB binding / 48 = ~44MB of text, and that division *is* the
ceiling. Four of the twelve slot lanes are fold SCRATCH — job-scale intermediates held
at corpus lifetime, per byte, including every space and newline.

A bigger number moves that; it does not fix it. The fix is in
`docs/perf-swarm/vram-memory-architecture.md` and half-built on the engine side: slots
become a per-job scratch pool, a compact kernel emits ~32B records for glyphs that
actually exist, and `maxBytes` stops being a corpus limit at all. **Pay per rendered
glyph, not per loaded byte.**

These are the same work, which is the part worth noticing: defining the record forces
you to say what a rendered glyph IS, and that definition is exactly the schema that
makes the containers single-kind. **The split is not a competing refactor — the record
work subsumes it.** Do the split first only where it de-risks the record work (the
trie, the scan buffers); let `slots` fall out of compaction rather than being migrated
twice.

## MEASURED, 2026-08-30 — and it tempers the record case

The claim "pay per rendered glyph, not per loaded byte" was never measured. Measured now,
over this repo (595 source files, 6.68 MB):

    leaders (codepoints)   99.07% of bytes      <- source code is ASCII
    newlines                2.01%               <- slot held, nothing drawn
    spaces/tabs            19.86%               <- slot held, blank quad
    drawable glyphs        97.07% of bytes

    slot state @48B/source byte     306.0 MB
    records    @32B/drawable glyph  198.0 MB    1.55x
      eliding blanks too            157.5 MB    1.94x

**A byte IS a glyph in source code.** The multi-byte saving is 0.93%. So compaction to a
32-byte record buys **1.55x** — real, worth having, and NOT the fix. The ceiling moves
42.7 MB → ~66 MB of source. That is a bigger number, which is the thing this plan already
said was not the goal.

The saving that IS structural is **lifetime, not size**: 4 of the 12 slot lanes
(`BASE_X`, `LINE_ADV`, `FLAGS`, `ORD` — the complement of the contract's 8 `VERTEX_READ`
fields) are fold SCRATCH. They are needed while a job lays out and never again, yet they
are held per byte for the life of the corpus. Scratch as a per-JOB pool sized to the
largest single load, rather than to the corpus, drops resident cost to 32B/glyph *and*
makes the remaining 16B/byte independent of how much is loaded.

## THE THING ALREADY BUILT THAT ACTUALLY BREAKS THE CEILING

Residency is keyed to LOADING. It should be keyed to VISIBILITY — and the mechanism for
that is already in the tree.

The far-LOD path renders a file as one 64×64 slab of a shared 1024×1024 RGBA8 atlas
(`FAR_SLAB`, `FAR_TEX`): **16 KB per file, regardless of the file's size**, 256 slabs in
4 MB total. At this corpus's average file (11 KB), those same 256 files cost ~2.9 MB of
source — which at 48B/byte is ~137 MB of slot state. The far path is already ~34x cheaper
per file and it is not a proposal; it ships.

So the question the arena work should answer is not "how small can the record get." It is:
**why is every loaded byte resident at full layout fidelity when the renderer already owns
a representation that costs per FILE?** Full records for what is near enough to read, far
slabs for the rest, and the byte ceiling stops being a corpus limit at all — not because
the number grew, but because the corpus stopped having to be resident.

That reframes `slots` too. Splitting it by carrier is worth doing when it is the resident
NEAR-text buffer sized to the working set. Splitting it while it is still "every byte ever
loaded" is migrating the wrong thing carefully.

## PROVENANCE CORRECTION — commit 2363801 is mis-scoped

Recorded because the git record is now wrong in a way that misleads an auditor, and it
cannot be rewritten: it is published and the engine session has committed on top of it.

**`2363801` ("layout: the last live 'exactly representable as f32'") also contains 114
lines of `schema/glyph-identity.json`** — the shared-tier correction that moves PAGE_ROWS,
PAGE_COLS, PAGES_WIDE, SCROLL_ROWS and WRAP_WIDTH off the float carrier and restructures
`itemTable` into `measures` + `exact`. That work is **mojo-rising's**, not this session's,
and the commit message describes only the layout kernel.

Cause: `git add -A` in a working tree that a peer session was editing live. I knew we
shared the tree — I had already staged a single file by name in `a44a489` for exactly that
reason — and then used the sweeping form four commits earlier without thinking about it.

Consequences, so nobody has to rediscover them:

- Anyone asking "when did the shared contract change?" lands on a commit about the layout
  kernel. That is a real navigational defect in the history.
- The engine session's own record says the kind correction landed in `a44a489`. It landed
  in `2363801`, and not deliberately — their sequencing argument ("the ordering hazard
  couldn't bite, the correction was already committed") happens to hold, but it held by
  accident rather than by staging discipline. Nobody should lean on that.

Practice, adopted: **in a shared tree, stage by name.** `git add -A` is a statement that
every change in the tree is yours, and in a shared tree that statement is false by default.

## A BIAS TO DECLARE

This plan is written by the session that spent a day making the mixed-container
discipline *work* — `LANE_KIND`, the totality guards, the contract conformance teeth.
That is a real incentive to preserve the thing rather than delete it. Ivan flagged it
directly and he was right to. Discount accordingly: the guards were worth building
because they made a live system safe, AND they are scaffolding around a design that
should stop needing them.
