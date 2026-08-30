# conformance_real.mojo — the CROSS-FORM RUNNER: any directory becomes a corpus.
#
# No fixtures, no stored expectations. Two sources of truth that exist anyway:
#
#   AGREEMENT   run_pipeline (serial fold) and run_scan_pipeline (the GPU's
#               dispatch structure) are STRUCTURALLY DIFFERENT implementations
#               since the amortized segment walk — different schedules, different
#               accumulators, one contract. Their agreement over arbitrary real
#               text is oracle-free evidence; a shared fault between two forms
#               this different has to be a shared DESIGN, which is what the
#               pinned fixtures are for.
#   INVARIANTS  the schema's ord witness and per-item permutation — true for any
#               input whatsoever.
#
# THE CROSS-FORM TIER RULE (conformance_scan's contract, restated):
#   counts (ROW COL FLAGS ORD), leaders, misses   exact, always
#   X                                             bit-exact when the item has a
#                                                 fold unit (wrap or page_cols);
#                                                 1e-4 relative otherwise (the
#                                                 serial fold carries line_adv in
#                                                 f64, the scan reads the f32
#                                                 lane — one rounding apart)
#   Y, Z                                          bit-exact (integer rows + f64
#                                                 params, identical formulas)
#
# Params are DERIVED from each file's size, so a directory sweep exercises
# wrap/page/scroll combinations deterministically — including scrolled over real
# text with real misses, the co-occurrence the pinned corpus cannot produce.
#
# Run (the shell points at directories; the runner takes files):
#   mojo run -I engine --fp-mode contract=off engine/conformance_real.mojo \
#       engine/fixtures/repo-file.pipe.bin $(find packages/glyph3d-core/src -name '*.js')

from std.sys import argv
from glyph_pipeline import (
    run_pipeline, Item, Trie, F_LEADER, F_RENDERED, PipelineResult, page_active,
)
from glyph_scan import run_scan_pipeline
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 6


def item_for(size: Int) -> Item:
    """Layout params derived from the file's size — deterministic variety.
    size%3 picks the wrap tier, size%2 pages, size%5 scrolls, so a real tree
    sweeps the combination space without anyone choosing the cases."""
    var it = Item()
    it.byte_start = 0
    it.byte_count = size
    it.line_height = 1.1
    it.origin_x = 2.0
    it.origin_y = 3.0
    it.origin_z = 0.5
    it.z_step = 0.2
    var w = size % 3
    it.wrap_width = 0.0 if w == 0 else (80.0 if w == 1 else 120.0)
    if size % 2 == 1:
        it.has_page = True
        it.page_rows = 32
        it.pages_wide = 2
        it.page_gap_x = 1.5
        it.band_stride_y = 2.0
        it.depth_per_band = 0.25
    if size % 5 == 0:
        it.has_page = True
        it.scroll_rows = 3
    return it^


def rel_close(a: Float32, b: Float32) -> Bool:
    var fa = Float64(a)
    var fb = Float64(b)
    var d = fa - fb
    if d < 0:
        d = -d
    var m = fa if fa > fb else fb
    if m < 0:
        m = -m
    return d <= 1e-4 * (m if m > 1.0 else 1.0)


def check_file(path: String, trie: Trie) raises -> Int:
    var f = open(path, "r")
    var bytes = f.read_bytes()
    f.close()
    var n = len(bytes)
    if n == 0:
        return 0
    var items = List[Item]()
    items.append(item_for(n))
    var fold_exact = items[0].wrap_width > 0 or (
        items[0].has_page and items[0].page_cols > 0
    )

    var a = run_pipeline(bytes, trie, items)
    var b = run_scan_pipeline(bytes, trie, items, 64, 256)

    var bad = 0
    var printed = 0
    if a.leaders != b.leaders:
        print("  ", path, "leaders:", a.leaders, "vs", b.leaders)
        bad += 1
    if len(a.misses) != len(b.misses):
        print("  ", path, "miss count:", len(a.misses), "vs", len(b.misses))
        bad += 1
    else:
        for i in range(len(a.misses)):
            if a.misses[i] != b.misses[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", path, "miss[", i, "]:", a.misses[i], "vs", b.misses[i])
                    printed += 1

    for id in range(n):
        # counts: exact, both forms, always — including FLAGS and ORD
        for lane in range(4):
            if a.c_at(id, lane) != b.c_at(id, lane):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", path, "byte", id, "count lane", lane,
                          a.c_at(id, lane), "vs", b.c_at(id, lane))
                    printed += 1
                break
        if (Int(a.fl[id]) & F_LEADER) == 0:
            continue
        # X: tiered. Y, Z: bit.
        var ax = a.m_at(id, 0)
        var bx = b.m_at(id, 0)
        var x_ok: Bool
        if fold_exact:
            x_ok = ax.to_bits() == bx.to_bits()
        else:
            x_ok = rel_close(ax, bx)
        if not x_ok:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ", path, "byte", id, "X", ax, "vs", bx,
                      " (fold_exact:", fold_exact, ")")
                printed += 1
        for lane in range(1, 3):
            if a.m_at(id, lane).to_bits() != b.m_at(id, lane).to_bits():
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", path, "byte", id, "lane", lane,
                          a.m_at(id, lane), "vs", b.m_at(id, lane))
                    printed += 1
        # ADVANCE/HEIGHT/GLYPH_ID: decode is the shared kernel; still assert.
        for lane in range(3, 6):
            if a.m_at(id, lane).to_bits() != b.m_at(id, lane).to_bits():
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", path, "byte", id, "static lane", lane)
                    printed += 1

    # the ord witness, on BOTH forms independently
    for which in range(2):
        var seen = List[Bool](length=n, fill=False)
        for id in range(n):
            var fl = Int(a.fl[id]) if which == 0 else Int(b.fl[id])
            if (fl & F_LEADER) == 0 or (fl & F_RENDERED) == 0:
                continue
            var ordv = Int(a.c_at(id, 3)) if which == 0 else Int(b.c_at(id, 3))
            var otb = Int(a.ord_to_byte[ordv]) if which == 0 else Int(b.ord_to_byte[ordv])
            if ordv >= n or otb != id or seen[ordv]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", path, "form", which, "ord witness: byte", id, "ord", ordv)
                    printed += 1
            else:
                seen[ordv] = True
    return bad


def main() raises:
    var args = argv()
    if len(args) < 3:
        print("usage: conformance_real <trie-fixture.pipe.bin> <file> [file ...]")
        return
    var fx = load_pipe_fixture(String(args[1]))
    var total_bad = 0
    var files = 0
    var bytes_total = 0
    for i in range(2, len(args)):
        var path = String(args[i])
        var bad = check_file(path, fx.trie)
        files += 1
        try:
            var f = open(path, "r")
            bytes_total += len(f.read_bytes())
            f.close()
        except:
            pass
        if bad != 0:
            print("FAIL", path, "-", bad, "defects")
            total_bad += bad
    if total_bad != 0:
        raise Error("cross-form disagreement on real corpus")
    print("real-corpus conformance:", files, "files,", bytes_total,
          "bytes — serial and scan forms agree, witnesses hold, no fixtures needed")
