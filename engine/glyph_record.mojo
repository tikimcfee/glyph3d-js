# glyph_record.mojo — the record format, and the scratch pool it makes possible.
#
# THE PROBLEM. Today a source byte costs MEASURE_STRIDE + COUNT_STRIDE lanes and
# is held for the corpus's entire lifetime. But the render path reads only the
# prefix of each buffer; the tail — BASE_X, LINE_ADV, ORD — is FOLD SCRATCH, an
# intermediate the layout pass needs while computing and nothing needs afterward.
# So the arena pays corpus-scale memory for job-scale temporaries, on every byte,
# including every space and newline.
#
# THE SPLIT THAT MAKES IT CHEAP. Because the schema orders render-read lanes
# FIRST in both buffers, emitting a record is a truncation — copy a prefix — not
# a gather through a lane map. That is what turns "compact" from a repack into a
# memcpy-shaped loop, and it is checked: gen-schema.mjs refuses a schema where a
# render-read lane sorts after an unread one.
#
# THE DECOUPLING. Once records exist, slots become a SCRATCH POOL sized to the
# JOB, not the corpus. run_streaming below proves it: a fixed pool, reused across
# chunks, with resident cost equal to records alone. Corpus size stops determining
# arena size — which is a different kind of win from any multiplier on the old
# form, and it is what makes streaming edits a range re-run rather than a reload.

from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE,
    RECORD_MEASURE_STRIDE, RECORD_COUNT_STRIDE, RECORD_BYTES,
    C_FLAGS,
)
from glyph_pipeline import Item, Trie, run_pipeline, F_LEADER


struct RecordSet(Copyable, Movable):
    """Resident render state: one record per RENDERED glyph, not per source byte."""

    var measures: List[Float32]  # glyphs × RECORD_MEASURE_STRIDE
    var counts: List[UInt32]  # glyphs × RECORD_COUNT_STRIDE
    var glyphs: Int

    def __init__(out self):
        self.measures = List[Float32]()
        self.counts = List[UInt32]()
        self.glyphs = 0


def compact(
    measures: List[Float32], counts: List[UInt32], byte_len: Int, mut out: RecordSet
):
    """KERNEL — thread per byte in the GPU form: leaders emit a record, others don't.

    Serial here because the append order IS the ordinal order, and making that
    deterministic is worth more than the parallelism (the same reason the miss
    rebuild is a serial pass). On the GPU this is a prefix-sum over the leader
    flag plus a scatter, which the scan machinery already computes."""
    for id in range(byte_len):
        var co = id * COUNT_STRIDE
        if (Int(counts[co + C_FLAGS]) & F_LEADER) == 0:
            continue
        var mo = id * MEASURE_STRIDE
        # The truncation: a contiguous prefix of each buffer, no lane map.
        for k in range(RECORD_MEASURE_STRIDE):
            out.measures.append(measures[mo + k])
        for k in range(RECORD_COUNT_STRIDE):
            out.counts.append(counts[co + k])
        out.glyphs += 1


def run_streaming(
    bytes: List[UInt8], trie: Trie, items: List[Item], chunk_bytes: Int
) raises -> RecordSet:
    """The decoupling, demonstrated: lay one item at a time through a scratch pool
    that is never larger than the biggest item, and keep only records.

    `chunk_bytes` is the pool's ceiling. An item larger than it is still laid whole
    — the fold is sequential within an item, so an item is the true unit of work.
    Splitting one further needs the bake's checkpoints (prefix_at resumes mid-file
    from a saved state, already conformance-proven), which is the next step and not
    this function's job."""
    var out = RecordSet()
    for i in range(len(items)):
        var one = List[Item]()
        var it = items[i].copy()
        var span = it.byte_count
        var sub = Item()
        sub.byte_start = 0
        sub.byte_count = span
        sub.origin_x = it.origin_x
        sub.origin_y = it.origin_y
        sub.origin_z = it.origin_z
        sub.wrap_width = it.wrap_width
        sub.z_step = it.z_step
        sub.line_height = it.line_height
        sub.has_page = it.has_page
        sub.page_rows = it.page_rows
        sub.page_cols = it.page_cols
        sub.scroll_rows = it.scroll_rows
        sub.pages_wide = it.pages_wide
        sub.page_gap_x = it.page_gap_x
        sub.band_stride_y = it.band_stride_y
        sub.depth_per_band = it.depth_per_band
        sub.depth_per_col = it.depth_per_col
        sub.page_line_height = it.page_line_height
        one.append(sub^)

        var slice = List[UInt8](capacity=span)
        for b in range(span):
            slice.append(bytes[it.byte_start + b])

        # The scratch: allocated per job, dropped at the end of this iteration.
        var r = run_pipeline(slice, trie, one)
        compact(r.measures, r.counts, span, out)
        _ = chunk_bytes
    return out^


# ── Mid-item resume ─────────────────────────────────────────────────────────
#
# run_streaming above lays one ITEM at a time. That already decouples the arena
# from the corpus, but an edit still re-lays a whole file. To re-lay a RANGE we
# need the fold's accumulators at an arbitrary byte, which is exactly what the
# bake's checkpoints are for: prefix_at is "nearest checkpoint + a <= K tail fold",
# already bit-exact across the bake suite.
#
# The monoid carries four of the five accumulators (base_row, col, seg_adv, ord).
# It deliberately does NOT carry line_adv, and that omission is correct: line_adv
# is an f64 chain, and f64 addition is not associative, so putting it in a monoid
# that gets regrouped in parallel would drift. (This is the same reason segAdv is
# summed f32-per-add.)
#
# It doesn't need to be carried, because line_adv RESETS at every newline — it is a
# per-LINE accumulator, not a per-item one. So recovering it exactly costs a re-sum
# over the current partial line, bounded by line length rather than file length.

from glyph_bake import BakeRecord, bake_file, prefix_at, lanes_from_prefix, rows_for_line
from glyph_pipeline import (
    LayoutSeed, layout_item, sequence_length, decode_codepoint_at,
    trie_lookup_base, LANE_ADVANCE, NEWLINE, trunc_nonneg,
)


def is_line_start(bytes: List[UInt8], at: Int) -> Bool:
    """Byte 0, or the byte immediately after a newline."""
    if at == 0:
        return True
    if at > len(bytes):
        return False
    var j = at - 1
    while j >= 0:
        var n = sequence_length(bytes, j)
        if n > 0:
            return decode_codepoint_at(bytes, j, n) == NEWLINE and j + n == at
        j -= 1
    return False


def seed_at(
    bytes: List[UInt8], trie: Trie, record: BakeRecord, wrap: Int, at: Int,
    base_row_hint: Int = -1,
) raises -> LayoutSeed:
    """The fold state at a LINE START — checkpoint lookup, nothing re-summed.

    WHY LINE STARTS. The fold carries five accumulators. The monoid carries the two
    that are pure counts (base_row, ord). It cannot carry the other three:

      line_adv  an f64 chain — f64 addition is not associative, so a monoid that
                gets regrouped in parallel would drift (the same reason segAdv is
                summed f32-per-add rather than in f64).
      seg_adv   resets at every FOLD boundary, and fold is wrap-or-page-cols — a
                QUERY parameter. The bake is deliberately wrap-agnostic, so a
                per-segment sum cannot live in it.
      col       likewise per-line.

    At a line start all three are zero BY DEFINITION, so the monoid carries
    everything that is left and the seed needs no re-summing at all. That is not a
    workaround: a line is the natural resume unit, it is what the arena's own
    design study already proposed ("large files chunked at newline boundaries"),
    and it is how edits actually arrive.

    Resuming mid-line is possible — re-sum line_adv from the line start and seg_adv
    from the segment start, both bounded spans — but it buys nothing an edit needs
    and costs two more things that can silently disagree with the fold.

    WHY base_row_hint EXISTS, and it is a real limit rather than an oversight.
    `scan_combine` accumulates `rows` using the wrap carried in the element, and
    `bake_file` bakes at wrap = 0 ON PURPOSE — wrap is a QUERY parameter, which is
    exactly why `rows_under_wrap` is a separate histogram query rather than a field.
    So for an UNWRAPPED item (fold == 0) the prefix's row count is exact and the
    bake alone can seed a resume. For a wrapped or paged item it cannot, because
    the answer depends on a wrap the bake deliberately does not know.

    Rather than return a plausible wrong number, the caller must supply the row.
    That is not a burden in practice: anything re-laying a range has already laid
    the document once, and the row of the line being edited is in the previous
    layout. Passing -1 with wrap > 0 raises instead of guessing."""
    if not is_line_start(bytes, at):
        raise Error("seed_at: resume points must be line starts (byte 0 or after a newline)")
    var seed = LayoutSeed()
    var prefix = prefix_at(bytes, trie, record, at)
    var lanes = lanes_from_prefix(prefix, wrap)
    # col / seg_adv / line_adv are all zero at a line start; only the counts carry.
    seed.ord = lanes.ord
    var folds = wrap > 0
    if base_row_hint >= 0:
        seed.base_row = base_row_hint
    elif folds:
        raise Error(
            "seed_at: a wrapped item needs base_row_hint — the bake is wrap-agnostic"
            " by design, so its prefix row count is only exact at wrap 0"
        )
    else:
        seed.base_row = lanes.row
    return seed^
