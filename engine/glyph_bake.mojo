# glyph_bake.mojo — a file's layout as an idempotent fold, natively.
#
# Port of glyphBake.js + the scan monoid it rides (glyphPipelineScan.js:
# scanIdentity / scanLeafValue / scanCombine / lanesFromPrefix). This is the SEED
# FORMAT of the state split: bytes + trie + these records are what a client needs
# to materialize layout locally — checkpoints give random access into the layout
# of a file that was never fully materialized.
#
# Float discipline, matched to the oracle exactly:
#   tailAdv combines fround-per-add (Float32 here ≡ the oracle's Math.fround chain)
#   every count (nl, glyphs, rows, headLen, tailLen) is an exact integer
#   checkpoint lanes serialize as f64 (counts stay exact past 2^24)
#   bake maxima reduce in f64 over f32-exact addends (xw = x + advance is an
#   EXACT f64 sum of two f32 values — never rounded to f32)
#
# One structural subtlety locked by fixtures: only LEADER leaves fold (continuation
# bytes are skipped before combining), so total.reset is 1 iff byte 0 is a leader.
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphBake.js
#                          packages/glyph3d-core/src/compute/glyphPipelineScan.js

from glyph_pipeline import (
    Trie,
    NEWLINE,
    LANE_GLYPH_ID,
    LANE_ADVANCE,
    LANE_HEIGHT,
    LANE_FLAGS,
    FLAG_MISSING,
    F64_INF,
    sequence_length,
    byte_at,
    trie_lookup_base,
    rows_for_line,
    decode_codepoint_at,
)

comptime BAKE_VERSION = 2
comptime CHECKPOINT_INTERVAL = 4096

# Checkpoint lanes — one monoid summary, f64 so counts stay exact past 2^24.
comptime CK_STRIDE = 6
comptime CK_NL = 0
comptime CK_GLYPHS = 1
comptime CK_ROWS = 2
comptime CK_HEAD_LEN = 3
comptime CK_TAIL_LEN = 4
comptime CK_TAIL_ADV = 5


struct ScanElem(Copyable, Movable):
    """The segmented monoid's element (glyphPipelineScan.js). `reset` absorbs:
    combine(a, b) = b when b.reset — file isolation is structural."""
    var reset: Int
    var nl: Int
    var glyphs: Int
    var rows: Int
    var head_len: Int
    var tail_len: Int
    var tail_adv: Float32
    var wrap: Int

    def __init__(out self):
        self.reset = 0
        self.nl = 0
        self.glyphs = 0
        self.rows = 0
        self.head_len = 0
        self.tail_len = 0
        self.tail_adv = 0
        self.wrap = 0


def scan_identity() -> ScanElem:
    return ScanElem()


def scan_leaf_value(
    is_newline: Bool, advance: Float32, is_leader: Bool, wrap: Int, is_item_start: Bool
) -> ScanElem:
    """One byte's monoid element from its decoded facts alone."""
    var e = ScanElem()
    e.reset = 1 if is_item_start else 0
    e.wrap = wrap
    if not is_leader:
        return e^  # continuation byte: reset/wrap only
    e.glyphs = 1
    if is_newline:
        e.nl = 1  # head/tail stay 0: the line it closes started before this interval
    else:
        e.head_len = 1
        e.tail_len = 1
        e.tail_adv = advance
    return e^


def scan_combine(mut a: ScanElem, b: ScanElem):
    """combine(a, b) — a's interval followed by b's; associative; b.reset absorbs.
    tailAdv is fround-per-add: Float32 + Float32 IS the oracle's Math.fround chain."""
    if b.reset != 0:
        a.reset = 1
        a.nl = b.nl
        a.glyphs = b.glyphs
        a.rows = b.rows
        a.head_len = b.head_len
        a.tail_len = b.tail_len
        a.tail_adv = b.tail_adv
        a.wrap = b.wrap
        return
    a.wrap = b.wrap
    if b.nl == 0:
        a.tail_len += b.tail_len
        a.tail_adv = a.tail_adv + b.tail_adv
        if a.nl == 0:
            a.head_len = a.tail_len  # still one open line: head == tail
    else:
        if a.nl == 0:
            a.head_len += b.head_len  # a's open run extends b's head line
            a.rows = b.rows
        else:
            # The junction line: a's tail + b's head, closed by b's first newline.
            a.rows += rows_for_line(a.tail_len + b.head_len, b.wrap) + b.rows
        a.tail_len = b.tail_len
        a.tail_adv = b.tail_adv
    a.nl += b.nl
    a.glyphs += b.glyphs


struct Lanes(Copyable, Movable):
    var row: Int
    var col: Int
    var line_adv: Float32
    var ord: Int

    def __init__(out self, row: Int, col: Int, line_adv: Float32, ord: Int):
        self.row = row
        self.col = col
        self.line_adv = line_adv
        self.ord = ord


def lanes_from_prefix(p: ScanElem, wrap: Int) -> Lanes:
    """A leader's exact lanes from its exclusive prefix — the O(1) query."""
    var col = p.tail_len
    var closed = (rows_for_line(p.head_len, wrap) + p.rows) if p.nl > 0 else 0
    var wrap_row = (col // wrap) if wrap > 0 else 0
    return Lanes(closed + wrap_row, col, p.tail_adv, p.glyphs)


def fold_bytes(bytes: List[UInt8], trie: Trie, from_byte: Int, to_byte: Int, mut acc: ScanElem):
    """Fold bytes [from, to) onto `acc` — the seeding primitive: identity (or a
    checkpoint) + this reaches the exact exclusive prefix of byte `to`."""
    var id = from_byte
    while id < to_byte:
        var n = sequence_length(bytes, id)
        if n == 0:
            id += 1
            continue  # continuation byte: identity leaf (skipped, matching the oracle)
        var cp = decode_codepoint_at(bytes, id, n)
        var tb = trie_lookup_base(trie, cp)
        var leaf = scan_leaf_value(
            cp == NEWLINE, trie.blocks[tb + LANE_ADVANCE], True, 0, id == 0
        )
        scan_combine(acc, leaf)
        id += 1


struct BakeRecord(Copyable, Movable):
    var byte_length: Int
    var leaders: Int
    var newlines: Int
    var total_rows: Int
    var max_line_len: Int
    var max_row_extent: Float64
    var max_line_width: Float64
    var max_height: Float64
    var has_box: Bool
    var box: List[Float64]  # minX minY minZ maxX maxY maxZ
    var total: ScanElem
    var checkpoints: List[Float64]  # ckCount × CK_STRIDE
    var checkpoint_interval: Int
    var hist_lens: List[Int]  # sorted ascending
    var hist_counts: List[Int]
    var census: List[Int]  # sorted unique codepoints
    var missing: List[Int]
    var line_height: Float64

    def __init__(out self):
        self.byte_length = 0
        self.leaders = 0
        self.newlines = 0
        self.total_rows = 0
        self.max_line_len = 0
        self.max_row_extent = 0
        self.max_line_width = 0
        self.max_height = 0
        self.has_box = False
        self.box = List[Float64](length=6, fill=0)
        self.total = ScanElem()
        self.checkpoints = List[Float64]()
        self.checkpoint_interval = CHECKPOINT_INTERVAL
        self.hist_lens = List[Int]()
        self.hist_counts = List[Int]()
        self.census = List[Int]()
        self.missing = List[Int]()
        self.line_height = 0


def _sorted_insert_unique(mut xs: List[Int], v: Int):
    """Keep `xs` sorted-unique — census sets are small (a file's distinct codepoints)."""
    var lo = 0
    var hi = len(xs)
    while lo < hi:
        var mid = (lo + hi) // 2
        if xs[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    if lo < len(xs) and xs[lo] == v:
        return
    xs.insert(lo, v)


def _hist_bump(mut lens: List[Int], mut counts: List[Int], length: Int):
    var lo = 0
    var hi = len(lens)
    while lo < hi:
        var mid = (lo + hi) // 2
        if lens[mid] < length:
            lo = mid + 1
        else:
            hi = mid
    if lo < len(lens) and lens[lo] == length:
        counts[lo] += 1
        return
    lens.insert(lo, length)
    counts.insert(lo, 1)


def bake_file(
    bytes: List[UInt8], trie: Trie, line_height: Float64, checkpoint_interval: Int
) raises -> BakeRecord:
    """THE BAKE — one streaming pass, the record out (bakeFile in the oracle)."""
    if not (line_height > 0):
        raise Error("bake_file: a positive lineHeight is required")
    var k = checkpoint_interval if checkpoint_interval > 0 else 1
    var n = len(bytes)

    var r = BakeRecord()
    r.byte_length = n
    r.checkpoint_interval = k
    r.line_height = line_height

    var ck_count = ((n - 1) // k) if n > 0 else 0
    r.checkpoints = List[Float64](length=ck_count * CK_STRIDE, fill=0)

    var acc = scan_identity()
    var max_row = -1
    var max_top = -F64_INF

    var id = 0
    while id < n:
        if id > 0 and id % k == 0:
            var o = (id // k - 1) * CK_STRIDE
            r.checkpoints[o + CK_NL] = Float64(acc.nl)
            r.checkpoints[o + CK_GLYPHS] = Float64(acc.glyphs)
            r.checkpoints[o + CK_ROWS] = Float64(acc.rows)
            r.checkpoints[o + CK_HEAD_LEN] = Float64(acc.head_len)
            r.checkpoints[o + CK_TAIL_LEN] = Float64(acc.tail_len)
            r.checkpoints[o + CK_TAIL_ADV] = Float64(acc.tail_adv)

        var seq = sequence_length(bytes, id)
        if seq == 0:
            id += 1
            continue
        var cp = decode_codepoint_at(bytes, id, seq)
        var tb = trie_lookup_base(trie, cp)
        var advance = trie.blocks[tb + LANE_ADVANCE]
        var height = trie.blocks[tb + LANE_HEIGHT]
        var is_missing = (Int(trie.blocks[tb + LANE_FLAGS]) & FLAG_MISSING) != 0
        _sorted_insert_unique(r.census, cp)
        if is_missing:
            _sorted_insert_unique(r.missing, cp)
        r.leaders += 1

        # The exclusive prefix IS the accumulator right now — read the leader's
        # wrap-0 lanes before its own leaf folds in (mirrors layoutItem's order).
        var row = acc.nl  # wrap 0: every closed line is one row
        var x = Float64(acc.tail_adv)  # foldless x IS the line prefix
        if row > max_row:
            max_row = row
        if x > r.max_row_extent:
            r.max_row_extent = x  # the fold scalar (lane 7): max x
        var xw = x + Float64(advance)  # the box edge (lane 3): max x+w, exact f64
        if xw > r.max_line_width:
            r.max_line_width = xw
        var top = Float64(height) - Float64(row) * line_height
        if top > max_top:
            max_top = top
        if Float64(height) > r.max_height:
            r.max_height = Float64(height)
        if cp == NEWLINE:
            _hist_bump(r.hist_lens, r.hist_counts, acc.tail_len)

        var leaf = scan_leaf_value(cp == NEWLINE, advance, True, 0, id == 0)
        scan_combine(acc, leaf)
        id += 1

    r.newlines = acc.nl
    r.total_rows = max_row + 1
    r.max_line_len = acc.tail_len
    var i = 0
    while i < len(r.hist_lens):
        if r.hist_lens[i] > r.max_line_len:
            r.max_line_len = r.hist_lens[i]
        i += 1
    if r.leaders > 0:
        r.has_box = True
        r.box[0] = 0
        r.box[1] = -Float64(max_row) * line_height
        r.box[2] = 0
        r.box[3] = r.max_line_width
        r.box[4] = max_top
        r.box[5] = 0
    r.total = acc^
    return r^


def checkpoint_at(checkpoints: List[Float64], i: Int) -> ScanElem:
    """Checkpoint `i` (the exclusive prefix at byte (i+1)·interval) → an element."""
    var o = i * CK_STRIDE
    var e = scan_identity()
    e.nl = Int(checkpoints[o + CK_NL])
    e.glyphs = Int(checkpoints[o + CK_GLYPHS])
    e.rows = Int(checkpoints[o + CK_ROWS])
    e.head_len = Int(checkpoints[o + CK_HEAD_LEN])
    e.tail_len = Int(checkpoints[o + CK_TAIL_LEN])
    e.tail_adv = Float32(checkpoints[o + CK_TAIL_ADV])
    return e^


def prefix_at(
    bytes: List[UInt8], trie: Trie, record: BakeRecord, byte_index: Int
) -> ScanElem:
    """The exclusive prefix of byte `byteIndex` — nearest checkpoint + a ≤ K tail fold."""
    var k = record.checkpoint_interval
    var ck = byte_index // k
    var ck_total = len(record.checkpoints) // CK_STRIDE
    if ck > ck_total:
        ck = ck_total
    var acc: ScanElem
    if ck > 0:
        acc = checkpoint_at(record.checkpoints, ck - 1)
    else:
        acc = scan_identity()
    fold_bytes(bytes, trie, ck * k, byte_index, acc)
    return acc^


def rows_under_wrap(record: BakeRecord, wrap: Int) -> Int:
    """Exact visual rows under ANY wrap width, from the histogram + total summary."""
    var rows = 0
    var i = 0
    while i < len(record.hist_lens):
        rows += rows_for_line(record.hist_lens[i], wrap) * record.hist_counts[i]
        i += 1
    var tail = record.total.tail_len
    if tail > 0:
        rows += (((tail - 1) // wrap) if wrap > 0 else 0) + 1
    return rows
