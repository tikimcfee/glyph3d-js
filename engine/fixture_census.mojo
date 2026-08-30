# fixture_census.mojo — WHAT CAN OUR CORPUS ACTUALLY DISCRIMINATE?
#
# Every .pipe.bin turned out to carry exactly ONE item, which made the GPU item
# search unreachable: `return 0` in place of the entire binary search passed the
# suite. That was found by mutation, one property at a time, by guessing which
# property to check. This finds the rest by construction.
#
# A field that takes the SAME VALUE in every fixture cannot discriminate anything
# that depends on it. That is not a bug in any one test — it is a ceiling on what
# the whole corpus can prove, and it is invisible from inside any single suite.
#
# Run: mojo run -I engine --fp-mode contract=off engine/fixture_census.mojo \
#          engine/fixtures/*.pipe.bin

from std.sys import argv
from fixture_io import load_pipe_fixture
from glyph_pipeline import Item, F_LEADER, F_MISSING
from glyph_schema import FIXTURE_COUNT_STRIDE as COUNT_STRIDE, FIX_C_FLAGS as C_FLAGS


struct Range(Copyable, Movable):
    var lo: Float64
    var hi: Float64
    var seen: Bool

    def __init__(out self):
        self.lo = 0
        self.hi = 0
        self.seen = False

    def add(mut self, v: Float64):
        if not self.seen:
            self.lo = v
            self.hi = v
            self.seen = True
        else:
            if v < self.lo:
                self.lo = v
            if v > self.hi:
                self.hi = v

    def uniform(self) -> Bool:
        # NaN != NaN, so an all-NaN field reports lo != hi and would look varied.
        # Treat two NaNs as the same value: for this purpose "always unset" IS
        # uniform, and is exactly the kind of thing worth reporting.
        if self.lo != self.lo and self.hi != self.hi:
            return True
        return self.lo == self.hi


comptime NFIELD = 16
comptime NPROP = 5


def item_field(t: Item, i: Int) -> Float64:
    if i == 0: return Float64(t.wrap_width)
    if i == 1: return t.z_step
    if i == 2: return t.line_height
    if i == 3: return Float64(t.page_rows)
    if i == 4: return Float64(t.page_cols)
    if i == 5: return Float64(t.scroll_rows)
    if i == 6: return Float64(t.pages_wide)
    if i == 7: return t.page_gap_x
    if i == 8: return t.band_stride_y
    if i == 9: return t.depth_per_band
    if i == 10: return t.depth_per_col
    if i == 11: return t.page_line_height
    if i == 12: return t.origin_x
    if i == 13: return t.origin_y
    if i == 14: return t.origin_z
    return 1.0 if t.has_page else 0.0


def prop_name(i: Int) -> String:
    if i == 0: return "in-multi-arena"
    if i == 1: return "paged"
    if i == 2: return "wrapped"
    if i == 3: return "trie-miss"
    return "scrolled"


def field_name(i: Int) -> String:
    if i == 0: return "wrap_width"
    if i == 1: return "z_step"
    if i == 2: return "line_height"
    if i == 3: return "page_rows"
    if i == 4: return "page_cols"
    if i == 5: return "scroll_rows"
    if i == 6: return "pages_wide"
    if i == 7: return "page_gap_x"
    if i == 8: return "band_stride_y"
    if i == 9: return "depth_per_band"
    if i == 10: return "depth_per_col"
    if i == 11: return "page_line_height"
    if i == 12: return "origin_x"
    if i == 13: return "origin_y"
    if i == 14: return "origin_z"
    return "has_page"


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/fixture_census.mojo <fixture.pipe.bin> ...")
        return

    var f = List[Range]()
    for _ in range(NFIELD):
        f.append(Range())
    var items_r = Range()
    var bytes_r = Range()
    var miss_r = Range()
    var leaders_r = Range()
    # Per-fixture boolean properties, for the co-occurrence matrix below. A field
    # can vary across the corpus and still leave a COMBINATION untested: paginate
    # is the only kernel that resolves an item per thread, and it early-returns
    # unless the item is paged — so "multi-item" and "paged" both being covered
    # means nothing if no single fixture has both.
    var props = List[Bool]()

    print("fixture | bytes | items | misses | leaders | wrap | page")
    for a in range(1, len(args)):
        var path = String(args[a])
        var fx = load_pipe_fixture(path)
        items_r.add(Float64(fx.item_count))
        bytes_r.add(Float64(fx.byte_len))
        miss_r.add(Float64(len(fx.exp_misses)))
        leaders_r.add(Float64(fx.exp_leaders))
        var wrap0 = 0
        var page0 = False
        var any_page = False
        var any_wrap = False
        var any_scroll = False
        for i in range(fx.item_count):
            var t = fx.items[i].copy()
            f[0].add(Float64(t.wrap_width))
            f[1].add(t.z_step)
            f[2].add(t.line_height)
            f[3].add(Float64(t.page_rows))
            f[4].add(Float64(t.page_cols))
            f[5].add(Float64(t.scroll_rows))
            f[6].add(Float64(t.pages_wide))
            f[7].add(t.page_gap_x)
            f[8].add(t.band_stride_y)
            f[9].add(t.depth_per_band)
            f[10].add(t.depth_per_col)
            f[11].add(t.page_line_height)
            f[12].add(t.origin_x)
            f[13].add(t.origin_y)
            f[14].add(t.origin_z)
            f[15].add(1.0 if t.has_page else 0.0)
            if t.has_page:
                any_page = True
            if t.wrap_width > 0:
                any_wrap = True
            if t.scroll_rows > 0:
                any_scroll = True
            if i == 0:
                wrap0 = t.wrap_width
                page0 = t.has_page
        # PER ITEM, not per fixture. The first version OR-ed these across a
        # fixture's items, so an arena with one wrapped item and one paged item
        # reported the pair COVERED when no single item was both — a false
        # negative, which is the worse direction for a blind-spot detector. It hid
        # `paged + wrapped` entirely, and that pair is dangerous precisely because
        # wrap SILENTLY OVERRIDES page_cols as the fold unit, so BASE_X (and hence
        # page_stride_x) means something different while paginate still divides the
        # same col by cols for x_page and by wrap for seg: two query params, two
        # divisors, one lane.
        #
        # Miss-ness is per item too, taken from the per-byte F_MISSING flags rather
        # than from exp_misses — that list holds miss CODEPOINTS, not byte indices,
        # so it cannot be attributed to an item at all.
        for i in range(fx.item_count):
            var t2 = fx.items[i].copy()
            var miss_here = False
            var b0 = t2.byte_start
            var b1 = b0 + t2.byte_count
            for id in range(b0, b1):
                if id < 0 or id >= fx.byte_len:
                    continue
                var fl = Int(fx.exp_counts[id * COUNT_STRIDE + C_FLAGS])
                if (fl & F_LEADER) != 0 and (fl & F_MISSING) != 0:
                    miss_here = True
                    break
            props.append(fx.item_count > 1)
            props.append(t2.has_page)
            props.append(t2.wrap_width > 0)
            props.append(miss_here)
            props.append(t2.scroll_rows > 0)
        var short = path
        var slash = path.rfind("/")
        if slash >= 0:
            short = String(path[byte = slash + 1 :])
        print(
            short, "|", fx.byte_len, "|", fx.item_count, "|",
            len(fx.exp_misses), "|", fx.exp_leaders, "|", wrap0, "|",
            1 if page0 else 0,
        )

    print("")
    print("ITEM DISCRIMINABILITY — a multi-item fixture whose items carry IDENTICAL")
    print("params cannot observe item resolution: picking the wrong item changes")
    print("nothing, so a search replaced by `return 0` still passes.")
    for a in range(1, len(args)):
        var fx2 = load_pipe_fixture(String(args[a]))
        if fx2.item_count < 2:
            continue
        var varies = 0
        var names = String("")
        for fi in range(NFIELD):
            var r = Range()
            for i in range(fx2.item_count):
                var t = fx2.items[i].copy()
                r.add(item_field(t, fi))
            if not r.uniform():
                varies += 1
                names += " " + field_name(fi)
        var full = String(args[a])
        var sl = full.rfind("/")
        var sp = String(full[byte = sl + 1 :]) if sl >= 0 else full
        if varies == 0:
            print("   ", sp, "-", fx2.item_count,
                  "items, ALL PARAMS IDENTICAL -> item resolution unobservable")
        else:
            print("   ", sp, "-", fx2.item_count, "items, differ in:", names)

    print("")
    print("CO-OCCURRENCE, PER ITEM — a pair no single ITEM exhibits together is a")
    print("blind spot even when each half is well covered on its own:")
    var pairs = 0
    for x in range(NPROP):
        for y in range(x + 1, NPROP):
            var both = 0
            for k in range(len(props) // NPROP):
                if props[k * NPROP + x] and props[k * NPROP + y]:
                    both += 1
            if both == 0:
                print("   NEVER TOGETHER:", prop_name(x), "+", prop_name(y))
                pairs += 1
    if pairs == 0:
        print("   (every pair co-occurs somewhere)")

    print("")
    print("UNIFORM ACROSS THE WHOLE CORPUS — these cannot discriminate anything:")
    var uniform = 0
    if items_r.uniform():
        print("  item_count      always", items_r.lo,
              "  <-- item_search is unreachable at 1")
        uniform += 1
    for i in range(NFIELD):
        if f[i].uniform():
            print("  ", field_name(i), "always", f[i].lo)
            uniform += 1
    if miss_r.lo == 0 and miss_r.hi == 0:
        print("  misses          always 0  <-- no fixture exercises a trie miss")
        uniform += 1
    if uniform == 0:
        print("  (none — every field varies)")
    print("")
    print("varies:  bytes", bytes_r.lo, "..", bytes_r.hi,
          "  leaders", leaders_r.lo, "..", leaders_r.hi,
          "  misses", miss_r.lo, "..", miss_r.hi)
    print(uniform, "field(s) pinned to a single value across", len(args) - 1, "fixtures")
