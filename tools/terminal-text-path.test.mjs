// terminal-text-path.test.mjs — the terminal text path, headless: a screen update writes and
// uploads only what changed, a scroll moves the ring instead of the cells, nothing is allocated
// per update in steady state, and output is applied by the frame BEFORE it renders.
//
//   bun tools/terminal-text-path.test.mjs
//
// Ground truth is what the GPU would draw, read back implementation-blind: every slot through its
// group-table row (offset, tint, alpha), its style byte (the group lane's high bits), its
// highlight texel and its decoration texel, gathered into rows by where they land. A random walk
// of screens (scrolls, edits, recolors, backgrounds, attributes — italic, dim, strike, overline,
// every underline style, underline colours —, alt-screen, clears,
// depth toggles, seeds, depth and size changes) is checked against a reference model of the
// terminal's documented semantics after every step. Uploads are observed the way three takes
// them: this file plays the renderer (reads the pending ranges, empties them, fires the upload
// callbacks).

await import('./headless-canvas.mjs');
const THREE = await import('three');
const { default: TerminalGrid } = await import('../packages/glyph3d-core/src/collections/TerminalGrid.js');
const { createTerminalScreen, DEFAULT_FG, BG_SET } = await import('../packages/glyph3d-core/src/collections/TerminalEmulator.js');
const { default: TerminalScreenQueue } = await import('../packages/glyph3d-core/src/collections/TerminalScreenQueue.js');
const { default: SceneSystems } = await import('../packages/glyph3d-core/src/collections/SceneSystems.js');
const { default: InstancedField } = await import('../packages/glyph3d-core/src/collections/InstancedField.js');
const { SLOT_FLOATS, groupOf, styleOf } = await import('../packages/glyph3d-core/src/core/InstancedSlotBuffer.js');
const { CELL_ITALIC, CELL_DIM, CELL_STRIKE, CELL_OVERLINE, CELL_UNDERLINE_SHIFT, CELL_UNDERLINE_COLOR, CELL_BOLD, CELL_INVERSE,
    STYLE_UNDERLINE_COLOR, cellStyle } = await import('../packages/glyph3d-core/src/core/cellAttrs.js');
const { GROUP_STRIDE } = await import('../packages/glyph3d-core/src/core/glyphMaterial.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${a}, want ${b}`);

// An atlas with a shape cache (glyph id = codepoint + GID; its italic face's = that + ITALIC) and
// a live atlas that records what it is asked to encode.
const GID = 10000, ITALIC = 500000;
const ensured = [], ensuredItalic = [];
const atlas = {
    getCharSize: () => ({ width: 8, height: 16 }),
    _shaper: null, _slugData: null,
    _shapeCache: { lookup: (cp) => ({ g: cp + GID, ax: 8 }), lookupItalic: (cp) => ({ g: cp + GID + ITALIC, ax: 8 }) },
    _live: {
        ensureCodepoints(cps) { ensured.push(...cps); },
        ensureGlyphsEncoded(gids) { ensuredItalic.push(...gids); },
        registerField() {}, unregisterField() {},
    },
    _textureUploads: { flush() {} },   // SceneSystems flushes it at the renderer seam; nothing queued here
};

// ── the renderer's side of an upload ─────────────────────────────────────────────────────────
// What three does for a field it draws: a target whose version moved uploads its pending ranges
// (or, with none, the whole thing), empties them and fires its upload callback.
const seen = new WeakMap();
function upload(field) {
    const out = { slotBytes: 0, slotRanges: [], hlBytes: 0, hlRanges: [], decorBytes: 0, decorRanges: [], groupBytes: 0 };
    const ib = field._interleavedBuffer;
    if (seen.get(ib) !== ib.version) {
        seen.set(ib, ib.version);
        if (ib.updateRanges.length) { for (const r of ib.updateRanges) { out.slotRanges.push([r.start, r.count]); out.slotBytes += r.count * 4; } }
        else out.slotBytes = ib.array.byteLength;
        ib.clearUpdateRanges();   // three's own clear, after it uploaded them
        ib.onUploadCallback();
    }
    const tex = field._highlightTexture;
    if (tex && seen.get(tex) !== tex.version) {
        seen.set(tex, tex.version);
        if (tex.updateRanges.length) { for (const r of tex.updateRanges) { out.hlRanges.push([r.start, r.count]); out.hlBytes += r.count; } }
        else out.hlBytes = tex.image.data.length;
        tex.clearUpdateRanges();
        tex.onUpdate?.(tex);
    }
    const dt = field._decor.texture;
    if (dt && seen.get(dt) !== dt.version) {
        seen.set(dt, dt.version);
        if (dt.updateRanges.length) { for (const r of dt.updateRanges) { out.decorRanges.push([r.start, r.count]); out.decorBytes += r.count; } }
        else out.decorBytes = dt.image.data.length;
        dt.clearUpdateRanges();
        dt.onUpdate?.(dt);
    }
    const gt = field._groupTexture;
    if (seen.get(gt) !== gt.version) { seen.set(gt, gt.version); out.groupBytes = gt.image.data.byteLength; }
    return out;
}

// ── what the GPU would draw ──────────────────────────────────────────────────────────────────
// Every slot whose group row is shown, placed by its group's offset, gathered into rows keyed by
// where they land. Each cell: codepoint (glyph id − GID) and whether its glyph is the italic
// face's, effective color bytes (slot color × group tint), its highlight word, its style byte and,
// where the style says the underline has its own colour, its decoration word.
const key = (y, z) => `${Math.round(y * 1000)}|${Math.round(z * 1000)}`;
function drawn(grid) {
    const f = grid._renderer, f32 = f.slotBuffer.f32, G = f._groupData, gs = GROUP_STRIDE * 4;
    const words = f._highlightTexture ? new Uint32Array(f._highlightTexture.image.data.buffer) : null;
    const decor = f._decor.texture ? new Uint32Array(f._decor.texture.image.data.buffer) : null;
    const strideX = grid._metrics.charWidth + grid._metrics.letterSpacing;
    const rows = new Map();
    for (let i = 0; i < f.slotBuffer.count; i++) {
        const o = i * SLOT_FLOATS, g = groupOf(f32[o + 5]) * gs, style = styleOf(f32[o + 5]);
        if (G[g + 11] <= 0.01) continue;
        const k = key(f32[o + 1] + G[g + 1], f32[o + 2] + G[g + 2]);
        let r = rows.get(k);
        if (!r) rows.set(k, r = { cp: [], italic: [], rgb: [], bg: [], style: [], ul: [] });
        const col = Math.round((f32[o] + G[g]) / strideX);
        const c = Math.round(f32[o + 4]), t = G[g + 8];
        const gid = Math.round(f32[o + 3]) - GID;
        r.italic[col] = gid >= ITALIC;
        r.cp[col] = gid % ITALIC;
        r.rgb[col] = [(c & 0xff) * t, ((c >> 8) & 0xff) * t, ((c >> 16) & 0xff) * t];
        r.bg[col] = words ? words[i] : 0;
        r.style[col] = style;
        r.ul[col] = (style & STYLE_UNDERLINE_COLOR) ? (decor ? decor[i] : -1) : null;
    }
    return rows;
}

// ── the reference: the terminal's documented semantics, written plainly ──────────────────────
// Live rows show the screen. A scroll of k (the smallest k≥1 for which every overlapping row
// matches shifted up by k, trailing rows blank in both trimmed, some non-blank cell in the
// overlap) is detected against the last screen shown — only while depth history is on and the
// screen isn't the alternate one — and pushes the k rows that left the top onto the history,
// newest first, at most depthMax. History draws behind in pages (rows lines each), page p one
// pitch further back and faded per page; hidden while off or in the alt screen; it keeps no
// background, but keeps its attributes (a struck-through line is still struck through in history).
// A cell's attributes draw as its style byte (cellStyle), its italic bit as the italic face's
// glyph, and an underline's own colour as its decoration texel. Colors are bytes; a faded history
// cell is its bytes × the page's fade.
class Ref {
    constructor(cols, rows, depthMax, metrics, zFactor, fadeMin) {
        Object.assign(this, { cols, rows, depthMax, metrics, zFactor, fadeMin });
        this.history = []; this.prev = null; this.enabled = true; this.alt = false; this.screen = null;
    }
    static blank(cols) { return { cp: Array(cols).fill(32), fg: Array(cols).fill(DEFAULT_FG), bg: Array(cols).fill(0), at: Array(cols).fill(0), ul: Array(cols).fill(0) }; }
    rowsOf(s) {
        const out = [];
        const cut = (a, y) => [...a.subarray(y * s.cols, (y + 1) * s.cols)];
        for (let y = 0; y < s.rows; y++) out.push({ cp: cut(s.cp, y), fg: cut(s.fg, y), bg: cut(s.bg, y), at: cut(s.at, y), ul: cut(s.ul, y) });
        return out;
    }
    detect(cur) {
        const prev = this.prev, R = this.rows;
        const blank = (r) => r.cp.every((c) => c === 32);
        let eff = R;
        while (eff > 0 && blank(cur[eff - 1]) && blank(prev[eff - 1])) eff--;
        if (eff < 2) return 0;
        for (let k = 1; k < eff; k++) {
            let okk = true, content = false;
            for (let y = 0; y + k < eff && okk; y++) for (let x = 0; x < this.cols; x++) {
                if (cur[y].cp[x] !== prev[y + k].cp[x]) { okk = false; break; }
                if (cur[y].cp[x] !== 32) content = true;
            }
            if (okk && content) return k;
        }
        return 0;
    }
    apply(s) {
        const cur = this.rowsOf(s);
        this.alt = s.alt;
        if (this.enabled && !this.alt && this.prev) {
            const k = this.detect(cur);
            if (k > 0) {
                this.history.unshift(...this.prev.slice(0, k).reverse().map((r) => ({ cp: r.cp, fg: r.fg, bg: r.bg.map(() => 0), at: r.at, ul: r.ul })));
                this.history.length = Math.min(this.history.length, this.depthMax);
            }
        }
        this.prev = cur;
        this.screen = cur;
    }
    expected() {
        const m = this.metrics, ls = m.lineSpacing, zStep = ls * this.zFactor, R = this.rows, D = this.depthMax;
        const pages = Math.max(1, Math.ceil(D / R));
        const out = new Map();
        this.screen.forEach((r, y) => out.set(key(-y * ls, 0), { ...r, fade: 1 }));
        if (this.enabled && !this.alt) {
            for (let h = 0; h < D; h++) {
                const p = Math.floor(h / R), rowFromTop = (R - 1) - (h % R);
                const fade = pages > 1 ? 1 - (p / (pages - 1)) * (1 - this.fadeMin) : 1;
                out.set(key(-rowFromTop * ls, -(p + 1) * zStep), { ...(this.history[h] ?? Ref.blank(this.cols)), fade });
            }
        }
        return out;
    }
}

function compare(grid, ref, label) {
    const got = drawn(grid), want = ref.expected();
    const problems = [];
    if (got.size !== want.size) problems.push(`${got.size} rows drawn, ${want.size} expected`);
    for (const [k, w] of want) {
        const g = got.get(k);
        if (!g) { problems.push(`no row at ${k}`); continue; }
        for (let x = 0; x < ref.cols; x++) {
            if (g.cp[x] !== w.cp[x]) { problems.push(`${k} col ${x}: cp ${g.cp[x]} ≠ ${w.cp[x]}`); break; }
            if (w.cp[x] !== 32) {
                const f = w.fg[x], e = [(f & 0xff) * w.fade, ((f >> 8) & 0xff) * w.fade, ((f >> 16) & 0xff) * w.fade];
                if (e.some((v, j) => Math.abs(v - g.rgb[x][j]) > 1.001)) { problems.push(`${k} col ${x}: color ${g.rgb[x].map(Math.round)} ≠ ${e.map(Math.round)}`); break; }
            }
            const wantBg = w.bg[x] ? ((w.bg[x] & 0xffffff) | (255 << 24)) >>> 0 : 0;
            if (g.bg[x] !== wantBg) { problems.push(`${k} col ${x}: bg ${g.bg[x]?.toString(16)} ≠ ${wantBg.toString(16)}`); break; }
            const at = w.at[x];
            if (g.style[x] !== cellStyle(at)) { problems.push(`${k} col ${x}: style ${g.style[x]} ≠ ${cellStyle(at)} (attrs ${at.toString(2)})`); break; }
            if (g.italic[x] !== !!(at & CELL_ITALIC)) { problems.push(`${k} col ${x}: italic glyph ${g.italic[x]} for attrs ${at.toString(2)}`); break; }
            if ((at & CELL_UNDERLINE_COLOR) && (at >> CELL_UNDERLINE_SHIFT & 7) && g.ul[x] !== w.ul[x]) { problems.push(`${k} col ${x}: underline colour ${g.ul[x]?.toString(16)} ≠ ${w.ul[x].toString(16)}`); break; }
        }
    }
    ok(problems.length === 0, `${label}: drawn ≠ reference — ${problems.slice(0, 4).join('; ')}`);
    return problems.length === 0;
}

// A seeded PRNG, so a failure replays.
let seed = 0x5eed;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const ri = (n) => Math.floor(rnd() * n);
const letter = () => 33 + ri(90);
const color = () => (ri(256)) | (ri(256) << 8) | (ri(256) << 16);

function screenFrom(prev, cols, rows) {
    const s = createTerminalScreen(cols, rows);
    if (prev && prev.cols === cols && prev.rows === rows) { s.cp.set(prev.cp); s.fg.set(prev.fg); s.bg.set(prev.bg); s.at.set(prev.at); s.ul.set(prev.ul); s.alt = prev.alt; }
    return s;
}
/** Random attributes a renderer draws: any of italic, dim, strike, overline, an underline style, its colour. */
function attrs() {
    const ul = rnd() < 0.5 ? 1 + ri(5) : 0;
    return (rnd() < 0.3 ? CELL_ITALIC : 0) | (rnd() < 0.3 ? CELL_DIM : 0) | (rnd() < 0.3 ? CELL_STRIKE : 0) | (rnd() < 0.3 ? CELL_OVERLINE : 0)
        | (rnd() < 0.2 ? CELL_BOLD : 0) | (rnd() < 0.2 ? CELL_INVERSE : 0)   // already in the colours: they must not reach the style byte
        | (ul << CELL_UNDERLINE_SHIFT) | (ul && rnd() < 0.5 ? CELL_UNDERLINE_COLOR : 0);
}
function randomLine(s, y, blankTail = true) {
    const n = blankTail ? ri(s.cols + 1) : s.cols;
    for (let x = 0; x < s.cols; x++) {
        const i = y * s.cols + x;
        s.cp[i] = x < n ? letter() : 32; s.fg[i] = rnd() < 0.7 ? DEFAULT_FG : color(); s.bg[i] = rnd() < 0.1 ? (BG_SET | color()) : 0;
        s.at[i] = rnd() < 0.15 ? attrs() : 0;
        s.ul[i] = (s.at[i] & CELL_UNDERLINE_COLOR) ? (rnd() < 0.2 ? 0 : color()) : 0;   // black too: a colour equal to a blank texel
    }
}

// ── 1. the random walk against the reference ─────────────────────────────────────────────────
console.log('random walk vs the reference');
{
    const scene = new THREE.Scene();
    new TerminalScreenQueue(scene);
    let cols = 8, rows = 6, depthMax = 10;
    const grid = new TerminalGrid(scene, atlas, { id: 'walk', cols, rows, depthMax });
    const ref = new Ref(cols, rows, depthMax, grid._metrics, grid._depthZFactor, grid._depthFadeMin);
    let s = createTerminalScreen(cols, rows);
    for (let y = 0; y < rows - 1; y++) randomLine(s, y);
    grid.applyScreen(s); ref.apply(s); upload(grid._renderer);
    compare(grid, ref, 'first screen');
    let steps = 0, scrolls = 0, good = true, deepest = 0;
    for (let step = 0; step < 1500 && good; step++) {
        const kind = rnd();
        let next = screenFrom(s, cols, rows);
        if (kind < 0.40) {                               // scroll by k, new lines below, cursor line blank
            const k = 1 + ri(Math.min(3, rows - 1));
            next.cp.copyWithin(0, k * cols); next.fg.copyWithin(0, k * cols); next.bg.copyWithin(0, k * cols);
            next.at.copyWithin(0, k * cols); next.ul.copyWithin(0, k * cols);
            for (let y = rows - k; y < rows; y++) randomLine(next, y);
            if (rnd() < 0.5) { const b = (rows - 1) * cols; next.cp.fill(32, b); next.bg.fill(0, b); next.at.fill(0, b); next.ul.fill(0, b); }
            scrolls++;
        } else if (kind < 0.55) {                        // edit a few cells
            for (let n = 1 + ri(4); n > 0; n--) next.cp[ri(cols * rows)] = letter();
        } else if (kind < 0.62) {                        // recolor
            for (let n = 1 + ri(6); n > 0; n--) next.fg[ri(cols * rows)] = color();
        } else if (kind < 0.66) {                        // backgrounds on/off
            for (let n = 1 + ri(6); n > 0; n--) next.bg[ri(cols * rows)] = rnd() < 0.5 ? 0 : (BG_SET | color());
        } else if (kind < 0.70) {                        // attributes on/off, underline colours
            for (let n = 1 + ri(6); n > 0; n--) {
                const i = ri(cols * rows);
                next.at[i] = rnd() < 0.3 ? 0 : attrs();
                next.ul[i] = (next.at[i] & CELL_UNDERLINE_COLOR) ? color() : 0;
            }
        } else if (kind < 0.76) {                        // alt screen toggles with a full repaint
            next.alt = !next.alt;
            for (let y = 0; y < rows; y++) randomLine(next, y);
        } else if (kind < 0.79) {                        // clear
            next = createTerminalScreen(cols, rows); next.alt = s.alt;
        } else if (kind < 0.81) {                        // depth history off / on
            const on = !grid.depthHistory;
            grid.setDepthHistory(on); ref.enabled = on; if (!on) ref.history = [];
        } else if (kind < 0.82) {                        // seed from external scrollback
            const lines = Array.from({ length: ri(depthMax + 3) }, () => String.fromCodePoint(...Array.from({ length: ri(cols + 3) }, letter)));
            grid.seedHistory(lines);
            ref.history = lines.slice(0, ref.depthMax).map((l) => { const r = Ref.blank(cols); [...l].slice(0, cols).forEach((ch, x) => { r.cp[x] = ch.codePointAt(0); }); return r; });
        } else if (kind < 0.83) {                        // depth budget
            depthMax = ri(14);
            grid.setDepthMax(depthMax); ref.depthMax = depthMax; ref.history.length = Math.min(ref.history.length, depthMax);
        } else if (kind < 0.84) {                        // resize: history clipped / padded, no scroll across it
            const nc = 4 + ri(8), nr = 3 + ri(5);
            grid.resize(nc, nr);
            ref.history = ref.history.map((r) => { const b = Ref.blank(nc); for (let x = 0; x < Math.min(nc, cols); x++) { b.cp[x] = r.cp[x]; b.fg[x] = r.fg[x]; b.at[x] = r.at[x]; b.ul[x] = r.ul[x]; } return b; });
            ref.cols = nc; ref.rows = nr; ref.prev = null;
            cols = nc; rows = nr;
            next = createTerminalScreen(cols, rows); next.alt = s.alt;
            for (let y = 0; y < rows - 1; y++) randomLine(next, y);
        } // else: a static repaint
        s = next;
        grid.applyScreen(s); ref.apply(s); upload(grid._renderer);
        good = compare(grid, ref, `step ${step}`);
        deepest = Math.max(deepest, ref.history.length);
        steps++;
    }
    ok(scrolls > 300 && steps === 1500, `the walk ran (${steps} steps, ${scrolls} scrolls)`);
    ok(deepest > 5, `the walk built history (${deepest} lines at its deepest: the comparison has teeth)`);
    ok(grid._renderer._decor.texture !== null, 'the walk named underline colours (the decoration texels exist)');
    grid.dispose();
}

// ── 2. only what changed is written, and only that is uploaded ───────────────────────────────
console.log('only changed cells are written and uploaded');
{
    const scene = new THREE.Scene();
    new TerminalScreenQueue(scene);
    const cols = 80, rows = 24, D = 80;
    const grid = new TerminalGrid(scene, atlas, { id: 'diff', cols, rows, depthMax: D });
    const f = grid._renderer;
    let s = createTerminalScreen(cols, rows);
    for (let y = 0; y < rows - 1; y++) randomLine(s, y, false);
    grid.applyScreen(s); upload(f);
    s = screenFrom(s, cols, rows); grid.applyScreen(s); upload(f);   // settle: the buffer now uploads by range

    // Type "abc" at row 5, cols 10..12.
    const before = f.slotBuffer.f32.slice();
    const next = screenFrom(s, cols, rows);
    'abc'.split('').forEach((ch, j) => { next.cp[5 * cols + 10 + j] = ch.charCodeAt(0); next.fg[5 * cols + 10 + j] = 0x123456; });
    grid.applyScreen(next);
    const after = f.slotBuffer.f32;
    const changed = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(Math.floor(i / SLOT_FLOATS));
    const slots = [...new Set(changed)];
    const want = [0, 1, 2].map((j) => grid._liveRowBase[5] + 10 + j);
    ok(slots.length === 3 && want.every((w) => slots.includes(w)), `typing 3 cells rewrites exactly their 3 slots (rewrote ${slots.length}: ${slots.slice(0, 6)})`);
    const up = upload(f);
    eq(up.slotBytes, 3 * SLOT_FLOATS * 4, 'and uploads exactly those 3 slots (96 B), not the 266 KB buffer');
    ok(up.slotRanges.length === 1 && up.slotRanges[0][0] === want[0] * SLOT_FLOATS, 'as one range starting at the first typed cell');
    eq(up.hlBytes, 0, 'no background changed → no highlight upload');
    eq(up.groupBytes, 0, 'no scroll → the row poses are untouched');

    // Two separate spans on two rows: per-row spans [first changed … last changed].
    const n2 = screenFrom(next, cols, rows);
    n2.cp[2 * cols + 3] = 65; n2.cp[2 * cols + 7] = 66; n2.fg[9 * cols + 70] = 0xabcdef;
    grid.applyScreen(n2);
    const up2 = upload(f);
    const spans = up2.slotRanges.map(([st, c]) => [st / SLOT_FLOATS, c / SLOT_FLOATS]).sort((a, b) => a[0] - b[0]);
    const w2 = [[grid._liveRowBase[2] + 3, 5], [grid._liveRowBase[9] + 70, 1]].sort((a, b) => a[0] - b[0]);
    ok(JSON.stringify(spans) === JSON.stringify(w2), `two rows' edits upload each row's changed span (${JSON.stringify(spans)} vs ${JSON.stringify(w2)})`);

    // A background on two cells: their highlight texels, 8 bytes.
    const n3 = screenFrom(n2, cols, rows);
    n3.bg[3 * cols + 40] = BG_SET | 0x0000ff; n3.bg[3 * cols + 41] = BG_SET | 0x00ff00;
    grid.applyScreen(n3);
    const up3 = upload(f);
    eq(up3.slotBytes, 0, 'a background change writes no slot');
    ok(up3.hlBytes === 8 && up3.hlRanges[0][0] === (grid._liveRowBase[3] + 40) * 4, `and uploads its two texels (${up3.hlBytes} B)`);

    // The fill pass draws only while some cell has a background.
    ok(f.fillMaterial && f.fillsActive, 'a cell with a background turns the fill pass on');
    ok(Array.isArray(f.instanceMesh.material) && f.instanceMesh.material[0] === f.fillMaterial && f.instanceMesh.material[1] === f.material,
        'the field\'s mesh draws the fill material first, then the ink material');
    const nb = screenFrom(n3, cols, rows);
    nb.bg.fill(0);
    grid.applyScreen(nb); upload(f);
    ok(!f.fillsActive && f.fillMaterial.visible === false, 'with no background left the fill pass is not drawn at all');
    grid.applyScreen(n3);
    const upb = upload(f);
    ok(f.fillsActive && upb.hlBytes > 0, 'and it comes back with the next background');

    // An attribute on one cell: its slot (the style byte rides the group lane), nothing else.
    const na = screenFrom(n3, cols, rows);
    na.at[7 * cols + 20] = CELL_STRIKE | (3 << CELL_UNDERLINE_SHIFT);
    const preA = f.slotBuffer.f32.slice();
    grid.applyScreen(na);
    const slotA = grid._liveRowBase[7] + 20;
    const diffA = [];
    for (let i = 0; i < preA.length; i++) if (preA[i] !== f.slotBuffer.f32[i]) diffA.push(i);
    ok(diffA.length === 1 && diffA[0] === slotA * SLOT_FLOATS + 5, `an attribute change writes one lane of one slot: the group lane (${diffA.length} floats changed)`);
    eq(styleOf(f.slotBuffer.f32[slotA * SLOT_FLOATS + 5]), cellStyle(na.at[7 * cols + 20]), 'which now carries the cell\'s style byte');
    eq(groupOf(f.slotBuffer.f32[slotA * SLOT_FLOATS + 5]), grid._rowGroups[grid._liveRowBase[7] / cols], 'above its row\'s group');
    const upA = upload(f);
    ok(upA.slotBytes === SLOT_FLOATS * 4 && upA.hlBytes === 0 && upA.decorBytes === 0, `and uploads that one slot (${upA.slotBytes} B), no texel`);

    // An underline colour: the decoration texels are made on the first one (even a black one — a
    // colour equal to a blank texel), then upload by span.
    {
        const plainGrid = new TerminalGrid(scene, atlas, { id: 'decor', cols: 10, rows: 3, depthMax: 4 });
        const pf = plainGrid._renderer;
        const p0 = createTerminalScreen(10, 3);
        p0.cp[3] = 0x41; p0.at[3] = (1 << CELL_UNDERLINE_SHIFT) | CELL_STRIKE;
        plainGrid.applyScreen(p0);
        ok(pf._decor.texture === null && pf.material.uniforms.hasDecor.value === 0, 'no decoration texture while no cell names an underline colour');
        const p1 = screenFrom(p0, 10, 3);
        p1.at[3] |= CELL_UNDERLINE_COLOR; p1.ul[3] = 0;
        plainGrid.applyScreen(p1);
        ok(pf._decor.texture !== null && pf.material.uniforms.hasDecor.value === 1 && pf.material.uniforms.decorTexture.value === pf._decor.texture,
            'the first one — black — makes it and binds it to the ink material');
        plainGrid.dispose();
    }
    const nu = screenFrom(na, cols, rows);
    nu.at[8 * cols + 5] = (1 << CELL_UNDERLINE_SHIFT) | CELL_UNDERLINE_COLOR; nu.ul[8 * cols + 5] = 0x3050ff;
    grid.applyScreen(nu);
    upload(f);
    const nu2 = screenFrom(nu, cols, rows);
    nu2.ul[8 * cols + 5] = 0x00ff00;
    grid.applyScreen(nu2);
    const upU = upload(f);
    ok(upU.decorBytes === 4 && upU.decorRanges[0][0] === (grid._liveRowBase[8] + 5) * 4 && upU.slotBytes === 0, `a changed underline colour uploads its one texel (${upU.decorBytes} B) and no slot`);

    // Italic: the italic face's glyph, asked of the atlas once.
    ensuredItalic.length = 0;
    const ni = screenFrom(nu2, cols, rows);
    ni.cp[9 * cols + 1] = 0x51; ni.at[9 * cols + 1] = CELL_ITALIC;
    grid.applyScreen(ni);
    eq(Math.round(f.slotBuffer.f32[(grid._liveRowBase[9] + 1) * SLOT_FLOATS + 3]), 0x51 + GID + ITALIC, 'an italic cell takes the italic face\'s glyph');
    ok(ensuredItalic.length === 1 && ensuredItalic[0] === 0x51 + GID + ITALIC, 'which the atlas is asked for');
    const ni2 = screenFrom(ni, cols, rows);
    ni2.cp[9 * cols + 2] = 0x51; ni2.at[9 * cols + 2] = CELL_ITALIC;
    grid.applyScreen(ni2);
    eq(ensuredItalic.length, 1, 'once');
    upload(f);
    s = n3;

    // A scroll by one: the ring moves; the cells written are the new bottom row's only.
    grid.applyScreen(n3); upload(f);
    const n4 = screenFrom(n3, cols, rows);
    n4.cp.copyWithin(0, cols); n4.fg.copyWithin(0, cols); n4.bg.copyWithin(0, cols); n4.at.copyWithin(0, cols); n4.ul.copyWithin(0, cols);
    randomLine(n4, rows - 2, false); n4.cp.fill(32, (rows - 1) * cols); n4.bg.fill(0, (rows - 1) * cols); n4.at.fill(0, (rows - 1) * cols);
    const pre = f.slotBuffer.f32.slice();
    const start = grid._ringStart;
    grid.applyScreen(n4);
    eq(grid._ringStart, (start + 1) % (rows + D), 'a one-line scroll moves the ring head by one');
    const touched = new Set();
    for (let i = 0; i < pre.length; i++) if (pre[i] !== f.slotBuffer.f32[i]) touched.add(Math.floor(i / SLOT_FLOATS));
    ok(touched.size <= 2 * cols, `a scroll rewrites at most the rows that came round (${touched.size} slots, not ${(rows + D) * cols})`);
    const up4 = upload(f);
    ok(up4.slotBytes <= 2 * cols * 32 && up4.slotBytes > 0, `and uploads ${up4.slotBytes} B of slots (the full rewrite was ${(rows + D) * cols * 32})`);
    ok(up4.groupBytes > 0, 'the row poses go up instead (the group table)');
    grid.dispose();
}

// ── 3. range bookkeeping in InstancedField ───────────────────────────────────────────────────
console.log('InstancedField upload ranges');
{
    const scene = new THREE.Scene();
    const f = new InstancedField(scene, atlas, { maxInstances: 3000 });
    f.slotBuffer.ensureCapacity(3000); f.setSlots(f.slotBuffer, 3000);
    const words = f.highlightWords(3000);
    upload(f);
    // A fresh target uploads whole: no ranges until its first upload.
    ok(f._interleavedBuffer.updateRanges.length === 0, 'a fresh buffer has no pending ranges');
    f.markSlotsDirty(10, 2);
    eq(f._interleavedBuffer.updateRanges.length, 1, 'after its first upload a mark adds a range');
    f.writeColor(5, 0xff);   // a whole-buffer write while a range is pending
    const r = f._interleavedBuffer.updateRanges;
    ok(r.some((x) => x.start === 0 && x.count === f._interleavedBuffer.array.length), 'a whole-buffer write with ranges pending widens them to everything (nothing dropped)');
    f.markSlotsDirty(20, 1);
    eq(f._interleavedBuffer.updateRanges.length, r.length, 'and while it is whole, marks add no range');
    upload(f);
    // A span across the texture's 1024-texel row edge goes up as two row strips.
    words[1020] = 1;
    f.markHighlightDirty(1020, 10);
    const hr = f._highlightTexture.updateRanges.map((x) => [x.start / 4, x.count / 4]);
    ok(JSON.stringify(hr) === JSON.stringify([[1020, 4], [1024, 6]]), `a highlight span crossing a texture row splits at the edge (${JSON.stringify(hr)})`);
    upload(f);
    // A target left un-uploaded stops collecting ranges and goes whole.
    for (let i = 0; i < 200; i++) f.markSlotsDirty(i * 10, 1);
    ok(f._interleavedBuffer.updateRanges.length <= 65, `an un-uploaded buffer's ranges stay bounded (${f._interleavedBuffer.updateRanges.length})`);
    ok(f._interleavedBuffer.updateRanges.some((x) => x.start === 0 && x.count === f._interleavedBuffer.array.length), 'by going whole');
    f.dispose();
}

// ── 4. no allocation per update, through the real emulator ───────────────────────────────────
console.log('zero allocation per steady-state update');
{
    const scene = new THREE.Scene();
    const queue = new TerminalScreenQueue(scene);
    const grid = new TerminalGrid(scene, atlas, { id: 'alloc', cols: 80, rows: 24, depthMax: 80 });
    const emu = grid._emulator, f = grid._renderer;
    const parsed = () => new Promise((r) => emu._term.write('', r));
    // xterm's public getLine builds a wrapper per call: the read must go under it.
    let getLines = 0;
    const view = emu._term.buffer.active, origGetLine = view.getLine;
    view.getLine = function (...a) { getLines++; return origGetLine.apply(this, a); };
    const feed = async (bytes) => { grid.writeBytes(bytes); await parsed(); queue.flush(); upload(f); };
    // The workload: typing, colored output, scrolling. Warm it once (every glyph seen, the ring
    // wrapped, the range pool at the most this workload ever holds pending), then run it again.
    const work = async () => { for (let i = 0; i < 300; i++) await feed(i % 3 ? 'x' : `line ${i % 10} \x1b[3${i % 8}mcolor\x1b[0m \x1b[3;4:3;58:2::255:${i % 200}:0;9;4${i % 8}mstyled\x1b[0m\r\n`); };
    await work();
    ensured.length = 0;
    const ids = () => [emu._screen, emu._screen.cp, emu._screen.fg, emu._screen.bg, emu._screen.at, emu._screen.ul,
        grid._cp, grid._fg, grid._bg, grid._at, grid._ul,
        grid._liveRowBase, grid._spanLo, grid._spanHi, grid._bgLo, grid._bgHi, grid._ulLo, grid._ulHi, grid._rowGroups, grid._rowLayout,
        f.slotBuffer.f32, f._interleavedBuffer, f._highlightTexture, f.highlightWords(grid._totalCount),
        f._decor.texture, f.decorWords(grid._totalCount), f.fillMaterial, f.instanceMesh.material];
    const pool = () => f._slotUploads._pool.length + f._highlight.uploads._pool.length + f._decor.uploads._pool.length;
    const id0 = ids(), pool0 = pool();
    await work();
    const id1 = ids();
    ok(id0.every((o, i) => o === id1[i]), `every buffer the update path touches is the same object after 300 updates (${id0.map((o, i) => o === id1[i] ? '' : i).filter(String).join(',') || 'all same'})`);
    eq(pool(), pool0, 'the upload-range pool did not grow (ranges are reused, not made)');
    eq(getLines, 0, 'the screen read never builds xterm line views');
    eq(ensured.length, 0, 'no glyph is handed to the atlas once seen');
    ok(f._decor.texture !== null && f.fillsActive, 'the workload drew styled text: underline colours and backgrounds (the check has teeth)');
    ok(grid.readText()[22].startsWith('line') || grid.readText().some((l) => l.includes('line')), 'the emulator really ran');
    grid.dispose();
}

// ── 5. the frame applies output before it renders, never through rAF ────────────────────────
console.log('apply before render');
{
    let rafs = 0;
    globalThis.requestAnimationFrame = () => { rafs++; return 0; };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    let drawnAtRender = null;
    const renderer = { render() { drawnAtRender = [...drawn(grid).values()].map((r) => String.fromCodePoint(...r.cp)); } };
    const systems = new SceneSystems(scene, atlas, renderer);
    const grid = new TerminalGrid(scene, atlas, { id: 'order', cols: 20, rows: 4, depthMax: 0 });
    const parsed = () => new Promise((r) => grid._emulator._term.write('', r));
    grid.writeBytes('hello frame');
    await parsed();
    eq(systems.screens.size, 1, 'a parse queues the terminal for the next frame');
    ok(!drawn(grid).values().next().value.cp.includes('h'.charCodeAt(0)), 'nothing is applied before the frame runs');
    // One frame: the app's update, then its render.
    systems.update(camera, 800);
    renderer.render(scene, camera);
    ok(drawnAtRender.some((l) => l.startsWith('hello frame')), `the frame that follows the parse draws it (${JSON.stringify(drawnAtRender[0])})`);
    eq(systems.screens.size, 0, 'and the queue is empty after it');
    eq(rafs, 0, 'the emulator schedules no animation frame of its own');
    // Writes between two frames coalesce into one read.
    let reads = 0;
    const orig = grid._emulator.readScreen.bind(grid._emulator);
    grid._emulator.readScreen = (c, r) => { reads++; return orig(c, r); };
    for (let i = 0; i < 5; i++) grid.writeBytes(` ${i}`);
    await parsed();
    systems.update(camera, 800);
    eq(reads, 1, 'five writes between two frames → one screen read');
    grid.dispose();
    eq(systems.screens.size, 0, 'a disposed grid leaves the queue');
    systems.dispose();
    ok(TerminalScreenQueue.of(scene) === null, 'disposing the systems retires the scene\'s queue');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
