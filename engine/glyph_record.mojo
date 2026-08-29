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
