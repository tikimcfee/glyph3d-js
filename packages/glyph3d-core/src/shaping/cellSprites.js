/**
 * cellSprites.js — the glyphs a terminal draws itself: outlines GENERATED to the cell instead of
 * taken from a font, so they meet the cell's edges exactly and join their neighbours.
 *
 *   box drawing            U+2500–257F   light, heavy and double lines, every join, rounded corners,
 *                                        dashes, diagonals, half lines
 *   block elements         U+2580–259F   eighths, halves, quadrants, shades
 *   braille                U+2800–28FF
 *   legacy computing       U+1FB00–1FB90, 1FB9A–1FB9B   sextants, wedges, triangular blocks, eighth
 *                                        blocks, half shades
 *   powerline              U+E0B0–E0BF   triangles, half ellipses and their thin forms
 *
 * A sprite is one more glyph SOURCE of the Slug atlas (as a font's outline or an emoji's bitmap
 * is): FontChain routes these codepoints to a sprite slot before any font, LiveSlugAtlas lands
 * their curves in the same curve texture, and the one glyph shader draws them — in glyph-map mode
 * 3, whose coverage is counted over the part of each pixel inside the cell (core/glyphMaterial.js),
 * which is what makes shared cell edges seamless. A shade is a full rectangle with an ink alpha
 * (the glyph-map texel's fourth value): ░ 25 %, ▒ 50 %, ▓ 75 %.
 *
 * Shapes are built in the unit cell — x right, y UP, (0,0) the cell's bottom-left — from the
 * cell's aspect and the font's own line weights (FontChain.spriteMetrics), after Ghostty's sprite
 * font (src/font/sprite): lines centred in the cell, heavy twice light, a double line two light
 * lines a light gap apart, a rounded corner an arc of radius half the cell's shorter side.
 * Contours wind CLOCKWISE (y up), as a TrueType outline's do: the shader's winding sum reads that
 * as inside. Overlapping contours are fine (non-zero winding, clamped).
 *
 * Pure: no DOM, no three.js, no font. Generation is a few rectangles per glyph (microseconds), so
 * it runs where the slot is needed, synchronously — a sprite is never "in flight".
 */

import { CURVE_U32_PER_CURVE, packUint16 } from './slug-constants.js';

/** Bump when any shape changes: it is part of the slug-core cache key (a cached core holds sprite curves). */
export const SPRITE_VERSION = 1;

/**
 * @typedef {Object} SpriteMetrics
 * @property {number} aspect  the cell's width / height
 * @property {number} light   a light line's thickness, as a fraction of the cell's height
 * @property {number} heavy   a heavy line's
 */

/**
 * Whether a codepoint is drawn as a sprite.
 * @param {number} cp
 * @returns {boolean}
 */
export function isSpriteCodepoint(cp) {
    return (cp >= 0x2500 && cp <= 0x259F)
        || (cp >= 0x2800 && cp <= 0x28FF)
        || (cp >= 0xE0B0 && cp <= 0xE0BF)
        || (cp >= 0x1FB00 && cp <= 0x1FB90)
        || cp === 0x1FB9A || cp === 0x1FB9B;
}

// ── Path building ─────────────────────────────────────────────────────────────────────────────

/** Accumulates one glyph's contours as quadratic segments [p0x, p0y, p1x, p1y, p2x, p2y, …]. */
class Path {
    constructor() {
        /** @type {number[]} */ this.q = [];
        this.alpha = 255;
    }

    /**
     * A closed contour of segments ({x0,y0,cx,cy,x1,y1}; a line's control point is its midpoint),
     * emitted clockwise whichever way it was given.
     * @param {number[]} segs  flat [x0, y0, cx, cy, x1, y1, …], each segment starting where the last ended
     */
    contour(segs) {
        const n = segs.length / 6;
        if (n < 2) return;
        // Signed area of the control polygon (shoelace, y up: > 0 is counter-clockwise).
        let area = 0;
        for (let i = 0; i < n; i++) {
            const o = i * 6;
            area += segs[o] * segs[o + 3] - segs[o + 2] * segs[o + 1];
            area += segs[o + 2] * segs[o + 5] - segs[o + 4] * segs[o + 3];
        }
        if (Math.abs(area) < 1e-12) return;   // nothing enclosed
        const unit = (v) => Math.min(1, Math.max(0, v));   // a rounding hair outside the cell stays in it
        if (area < 0) {
            for (let i = 0; i < segs.length; i++) this.q.push(unit(segs[i]));
        } else {
            for (let i = n - 1; i >= 0; i--) {
                const o = i * 6;
                this.q.push(unit(segs[o + 4]), unit(segs[o + 5]), unit(segs[o + 2]), unit(segs[o + 3]), unit(segs[o]), unit(segs[o + 1]));
            }
        }
    }

    /** A closed polygon (flat [x, y, …]); zero-length edges are dropped. */
    poly(pts) {
        const segs = [];
        const n = pts.length / 2;
        for (let i = 0; i < n; i++) {
            const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
            const x1 = pts[((i + 1) % n) * 2], y1 = pts[((i + 1) % n) * 2 + 1];
            if (Math.abs(x1 - x0) < 1e-9 && Math.abs(y1 - y0) < 1e-9) continue;
            segs.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1);
        }
        this.contour(segs);
    }

    /** An axis-aligned rectangle, clipped to the cell. */
    rect(x0, y0, x1, y1) {
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
        if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) return;
        this.poly([x0, y0, x0, y1, x1, y1, x1, y0]);
    }
}

/** Clip a convex polygon (flat [x, y, …]) to the half-plane a·x + b·y ≤ c (Sutherland–Hodgman). */
function clipHalf(pts, a, b, c) {
    const out = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
        const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
        const x1 = pts[((i + 1) % n) * 2], y1 = pts[((i + 1) % n) * 2 + 1];
        const d0 = a * x0 + b * y0 - c, d1 = a * x1 + b * y1 - c;
        if (d0 <= 0) out.push(x0, y0);
        if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
            const t = d0 / (d0 - d1);
            out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }
    return out;
}

/** Clip a convex polygon to the unit cell. */
function clipCell(pts) {
    let p = clipHalf(pts, -1, 0, 0);
    p = clipHalf(p, 1, 0, 1);
    p = clipHalf(p, 0, -1, 0);
    return clipHalf(p, 0, 1, 1);
}

/**
 * A straight stroke from (x0, y0) to (x1, y1), `t` thick (a fraction of the cell's height),
 * run past both ends and clipped to the cell — so one that ends on a cell edge or corner fills it
 * and joins the stroke in the next cell.
 */
function stroke(path, m, x0, y0, x1, y1, t) {
    // World units: x × aspect, y × 1.
    const ax = x0 * m.aspect, bx = x1 * m.aspect;
    const dx = bx - ax, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    const ux = dx / len, uy = dy / len, nx = -uy * t / 2, ny = ux * t / 2, ex = ux * t, ey = uy * t;
    const pts = [
        ax - ex + nx, y0 - ey + ny, bx + ex + nx, y1 + ey + ny,
        bx + ex - nx, y1 + ey - ny, ax - ex - nx, y0 - ey - ny,
    ];
    for (let i = 0; i < pts.length; i += 2) pts[i] /= m.aspect;
    path.poly(clipCell(pts));
}

/**
 * Append an elliptical arc (centre cx, cy; radii rx, ry; from angle a0 to a1, radians) to `segs`
 * as quadratic segments, at most 45° each.
 */
function arcTo(segs, cx, cy, rx, ry, a0, a1) {
    const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 4) - 1e-9));
    const d = (a1 - a0) / steps, k = 1 / Math.cos(d / 2);
    for (let i = 0; i < steps; i++) {
        const s = a0 + i * d, e = s + d, mid = s + d / 2;
        segs.push(
            cx + rx * Math.cos(s), cy + ry * Math.sin(s),
            cx + rx * k * Math.cos(mid), cy + ry * k * Math.sin(mid),
            cx + rx * Math.cos(e), cy + ry * Math.sin(e),
        );
    }
}

/** Append a line from the last point in `segs` to (x, y). */
function lineTo(segs, x, y) {
    const n = segs.length, x0 = segs[n - 2], y0 = segs[n - 1];
    if (Math.abs(x - x0) < 1e-9 && Math.abs(y - y0) < 1e-9) return;
    segs.push(x0, y0, (x0 + x) / 2, (y0 + y) / 2, x, y);
}

// ── Box drawing ───────────────────────────────────────────────────────────────────────────────

// U+2500–257F: each character's four arms — up, right, down, left — as 0 none · 1 light ·
// 2 heavy · 3 double (from the Unicode names: tools/cell-sprites.test.mjs holds the rule and
// checks samples); '....' marks the dashes, arcs and diagonals, drawn by their own rules.
// 32 characters a line.
const BOX_ARMS =
    '0101020210102020................................01100210012002200011001200210022110012002100220010011002200120021110121021101120'
    + '21202210122022201011101220111021202120121022202201110112021102120121012202210222110111021201120221012102220122021111111212111212'
    + '211111212121211222111122122122121222212222212222................0303303003100130033000130031003313003100330010033001300313103130'
    + '3330101330313033031301310333130331013303131331313333............................000110000100001000022000020000200201102001022010';

/**
 * Double-line junctions, U+2550–256C: which of the 3 × 3 squares at the cell's centre (each one
 * light line thick) are inked — rows top to bottom, columns left to right, '#' inked. The arms
 * outside the centre come from BOX_ARMS (a double arm inks the outer two lanes, a single arm
 * the middle one).
 */
const DOUBLE_JOINS = [
    '###...###', '#.##.##.#', '.##.#..##', '...####.#', '####..#.#', '##..#.##.', '...####.#', '###..##.#',
    '.##.#..##', '#.####...', '#.##..###', '##..#.##.', '#.####...', '#.#..####', '.##.#..##', '#.##.##.#',
    '#.##..#.#', '##..#.##.', '#.##.##.#', '#.#..##.#', '###...###', '...####.#', '###...#.#', '###...###',
    '#.####...', '#.#...###', '###.#.###', '#.#####.#', '#.#...#.#',
];

/** Light and heavy joins: each arm a rectangle from its cell edge to (and through) the centre. */
function boxLines(path, m, up, right, down, left) {
    const tx = (w) => (w === 2 ? m.heavy : m.light) / m.aspect;   // a vertical line's width, in x
    const ty = (w) => (w === 2 ? m.heavy : m.light);              // a horizontal line's height, in y
    // An arm runs past the centre by half the crossing lines' thickness, so a corner is square.
    const jx = Math.max(up ? tx(up) : 0, down ? tx(down) : 0) / 2;
    const jy = Math.max(left ? ty(left) : 0, right ? ty(right) : 0) / 2;
    if (up) path.rect(0.5 - tx(up) / 2, 0.5 - jy, 0.5 + tx(up) / 2, 1);
    if (down) path.rect(0.5 - tx(down) / 2, 0, 0.5 + tx(down) / 2, 0.5 + jy);
    if (left) path.rect(0, 0.5 - ty(left) / 2, 0.5 + jx, 0.5 + ty(left) / 2);
    if (right) path.rect(0.5 - jx, 0.5 - ty(right) / 2, 1, 0.5 + ty(right) / 2);
}

/** Double-line joins: the arms' lanes outside the centre, and the centre's 3 × 3 squares. */
function boxDouble(path, m, up, right, down, left, join) {
    const tx = m.light / m.aspect, ty = m.light;
    const xs = [0.5 - 1.5 * tx, 0.5 - 0.5 * tx, 0.5 + 0.5 * tx, 0.5 + 1.5 * tx];
    const ys = [0.5 - 1.5 * ty, 0.5 - 0.5 * ty, 0.5 + 0.5 * ty, 0.5 + 1.5 * ty];
    const lanes = (w) => (w === 3 ? [0, 2] : w === 1 ? [1] : []);
    for (const i of lanes(up)) path.rect(xs[i], ys[3], xs[i + 1], 1);
    for (const i of lanes(down)) path.rect(xs[i], 0, xs[i + 1], ys[0]);
    for (const j of lanes(left)) path.rect(0, ys[j], xs[0], ys[j + 1]);
    for (const j of lanes(right)) path.rect(xs[3], ys[j], 1, ys[j + 1]);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            if (join[r * 3 + c] === '#') path.rect(xs[c], ys[2 - r], xs[c + 1], ys[3 - r]);
        }
    }
}

/** A dashed line: `n` dashes, each centred in its nth of the cell, a gap's half at each end. */
function boxDashes(path, m, n, heavy, vertical) {
    const t = heavy ? m.heavy : m.light, gap = 0.4 / n;
    for (let i = 0; i < n; i++) {
        const a = i / n + gap / 2, b = (i + 1) / n - gap / 2;
        if (vertical) path.rect(0.5 - t / m.aspect / 2, a, 0.5 + t / m.aspect / 2, b);
        else path.rect(a, 0.5 - t / 2, b, 0.5 + t / 2);
    }
}

/**
 * A rounded corner: a light line from the cell's bottom edge up, through a quarter arc, to its
 * right edge (╭), mirrored for the other three.
 */
function boxArc(path, m, flipX, flipY) {
    const w = m.aspect, t = m.light;                 // world units: the cell is w × 1
    const r = Math.min(w, 1) / 2, ro = r + t / 2, ri = Math.max(r - t / 2, 0);
    const cx = w / 2 + r, cy = 0.5 - r;              // the arc's centre
    const segs = [];
    arcTo(segs, cx, cy, ro, ro, Math.PI, Math.PI / 2);          // outer: left side up to the top
    lineTo(segs, w, 0.5 + t / 2);
    lineTo(segs, w, 0.5 - t / 2);
    lineTo(segs, cx, cy + ri);
    if (ri > 0) arcTo(segs, cx, cy, ri, ri, Math.PI / 2, Math.PI);   // inner: back down
    else lineTo(segs, cx, cy);
    lineTo(segs, w / 2 + t / 2, 0);
    lineTo(segs, w / 2 - t / 2, 0);
    lineTo(segs, segs[0], segs[1]);
    for (let i = 0; i < segs.length; i += 2) {
        const x = segs[i] / w, y = segs[i + 1];
        segs[i] = Math.min(1, Math.max(0, flipX ? 1 - x : x));
        segs[i + 1] = Math.min(1, Math.max(0, flipY ? 1 - y : y));
    }
    path.contour(segs);
}

function boxDrawing(path, m, cp) {
    const i = cp - 0x2500;
    const arms = BOX_ARMS.slice(i * 4, i * 4 + 4);
    if (arms !== '....') {
        const [up, right, down, left] = [...arms].map(Number);
        if (cp >= 0x2550 && cp <= 0x256C) boxDouble(path, m, up, right, down, left, DOUBLE_JOINS[cp - 0x2550]);
        else boxLines(path, m, up, right, down, left);
        return;
    }
    if (cp >= 0x2504 && cp <= 0x250B) { const k = cp - 0x2504; boxDashes(path, m, k < 4 ? 3 : 4, (k & 1) === 1, (k & 2) === 2); return; }
    if (cp >= 0x254C && cp <= 0x254F) { const k = cp - 0x254C; boxDashes(path, m, 2, (k & 1) === 1, (k & 2) === 2); return; }
    if (cp === 0x256D) boxArc(path, m, false, false);       // ╭ down and right
    else if (cp === 0x256E) boxArc(path, m, true, false);   // ╮ down and left
    else if (cp === 0x256F) boxArc(path, m, true, true);    // ╯ up and left
    else if (cp === 0x2570) boxArc(path, m, false, true);   // ╰ up and right
    if (cp === 0x2571 || cp === 0x2573) stroke(path, m, 0, 0, 1, 1, m.light);   // ╱
    if (cp === 0x2572 || cp === 0x2573) stroke(path, m, 0, 1, 1, 0, m.light);   // ╲
}

// ── Blocks, braille, legacy computing, powerline ──────────────────────────────────────────────

/** Quadrants of U+2596–259F as bits: 1 upper left · 2 upper right · 4 lower left · 8 lower right. */
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];

function quadrants(path, bits) {
    if (bits & 1) path.rect(0, 0.5, 0.5, 1);
    if (bits & 2) path.rect(0.5, 0.5, 1, 1);
    if (bits & 4) path.rect(0, 0, 0.5, 0.5);
    if (bits & 8) path.rect(0.5, 0, 1, 0.5);
}

function blockElement(path, cp) {
    if (cp === 0x2580) path.rect(0, 0.5, 1, 1);                              // ▀
    else if (cp <= 0x2588) path.rect(0, 0, 1, (cp - 0x2580) / 8);            // ▁ … █
    else if (cp <= 0x258F) path.rect(0, 0, (0x2590 - cp) / 8, 1);            // ▉ … ▏
    else if (cp === 0x2590) path.rect(0.5, 0, 1, 1);                         // ▐
    else if (cp <= 0x2593) { path.rect(0, 0, 1, 1); path.alpha = Math.round(255 * (cp - 0x2590) / 4); }   // ░ ▒ ▓
    else if (cp === 0x2594) path.rect(0, 7 / 8, 1, 1);                       // ▔
    else if (cp === 0x2595) path.rect(7 / 8, 0, 1, 1);                       // ▕
    else quadrants(path, QUADRANTS[cp - 0x2596]);
}

/** Braille: dots 1–8 are bits 0–7; dots 1,2,3,7 run down the left column, 4,5,6,8 the right. */
function braille(path, m, cp) {
    const bits = cp - 0x2800;
    // A dot is square in world units: as wide as a quarter of the cell's width or an eighth of
    // its height, whichever is smaller.
    const side = Math.min(m.aspect / 4, 1 / 8), hx = side / m.aspect / 2, hy = side / 2;
    const ROW = [0, 1, 2, 0, 1, 2, 3, 3], COL = [0, 0, 0, 1, 1, 1, 0, 1];
    for (let d = 0; d < 8; d++) {
        if (!(bits & (1 << d))) continue;
        const x = COL[d] ? 0.75 : 0.25, y = 1 - (ROW[d] * 2 + 1) / 8;
        path.rect(x - hx, y - hy, x + hx, y + hy);
    }
}

// Wedges U+1FB3C–1FB51: the cell's corner that stays inked (L lower left · R lower right), and the
// two ends of the diagonal that cuts it — x in halves, y in thirds (from the Unicode names).
// U+1FB52–1FB67 are their complements, in the same order.
const WEDGES = 'L0110L0120L0210L0220L0310R0213R0223R0113R0123R0013R0122R1021R0021R1022R0022R1023L1322L0322L1321L0321L1320L0221';

function wedge(path, index) {
    const i = index % 22, o = i * 5;
    const corner = WEDGES[o] === 'L' ? 0 : 1;
    const ax = WEDGES[o + 1] / 2, ay = WEDGES[o + 2] / 3, bx = WEDGES[o + 3] / 2, by = WEDGES[o + 4] / 3;
    // The line through a and b as n·p = c, with the kept corner on the ≤ side.
    let nx = by - ay, ny = ax - bx, c = nx * ax + ny * ay;
    let keepNeg = nx * corner + ny * 0 - c < 0;
    if (index >= 22) keepNeg = !keepNeg;   // the complement
    if (!keepNeg) { nx = -nx; ny = -ny; c = -c; }
    path.poly(clipHalf([0, 0, 0, 1, 1, 1, 1, 0], nx, ny, c));
}

function legacyComputing(path, cp) {
    if (cp <= 0x1FB3B) {
        // Sextants: the 62 patterns of a 2 × 3 grid that are neither a half block nor empty or full.
        let bits = cp - 0x1FB00 + 1;
        if (bits >= 21) bits++;
        if (bits >= 42) bits++;
        for (let b = 0; b < 6; b++) {
            if (!(bits & (1 << b))) continue;
            const col = b & 1, row = b >> 1;
            path.rect(col / 2, 1 - (row + 1) / 3, (col + 1) / 2, 1 - row / 3);
        }
        return;
    }
    if (cp <= 0x1FB67) { wedge(path, cp - 0x1FB3C); return; }
    const L = [0, 0, 0, 1, 0.5, 0.5], U = [0, 1, 1, 1, 0.5, 0.5], R = [1, 1, 1, 0, 0.5, 0.5], D = [1, 0, 0, 0, 0.5, 0.5];
    switch (cp) {
        case 0x1FB68: path.poly(U); path.poly(R); path.poly(D); return;
        case 0x1FB69: path.poly(L); path.poly(D); path.poly(R); return;
        case 0x1FB6A: path.poly(U); path.poly(L); path.poly(D); return;
        case 0x1FB6B: path.poly(L); path.poly(U); path.poly(R); return;
        case 0x1FB6C: path.poly(L); return;
        case 0x1FB6D: path.poly(U); return;
        case 0x1FB6E: path.poly(R); return;
        case 0x1FB6F: path.poly(D); return;
        case 0x1FB7C: path.rect(0, 0, 1 / 8, 1); path.rect(0, 0, 1, 1 / 8); return;
        case 0x1FB7D: path.rect(0, 0, 1 / 8, 1); path.rect(0, 7 / 8, 1, 1); return;
        case 0x1FB7E: path.rect(7 / 8, 0, 1, 1); path.rect(0, 7 / 8, 1, 1); return;
        case 0x1FB7F: path.rect(7 / 8, 0, 1, 1); path.rect(0, 0, 1, 1 / 8); return;
        case 0x1FB80: path.rect(0, 7 / 8, 1, 1); path.rect(0, 0, 1, 1 / 8); return;
        case 0x1FB81: for (const n of [1, 3, 5, 8]) path.rect(0, 1 - n / 8, 1, 1 - (n - 1) / 8); return;
        case 0x1FB8C: path.rect(0, 0, 0.5, 1); path.alpha = 128; return;
        case 0x1FB8D: path.rect(0.5, 0, 1, 1); path.alpha = 128; return;
        case 0x1FB8E: path.rect(0, 0.5, 1, 1); path.alpha = 128; return;
        case 0x1FB8F: path.rect(0, 0, 1, 0.5); path.alpha = 128; return;
        case 0x1FB90: path.rect(0, 0, 1, 1); path.alpha = 128; return;
        case 0x1FB9A: path.poly(U); path.poly(D); return;
        case 0x1FB9B: path.poly(L); path.poly(R); return;
        default: break;
    }
    if (cp <= 0x1FB75) { const n = cp - 0x1FB70 + 2; path.rect((n - 1) / 8, 0, n / 8, 1); return; }          // vertical eighth n
    if (cp <= 0x1FB7B) { const n = cp - 0x1FB76 + 2; path.rect(0, 1 - n / 8, 1, 1 - (n - 1) / 8); return; }  // horizontal eighth n, from the top
    if (cp >= 0x1FB82 && cp <= 0x1FB86) { path.rect(0, 1 - [2, 3, 5, 6, 7][cp - 0x1FB82] / 8, 1, 1); return; }   // upper n eighths
    if (cp >= 0x1FB87 && cp <= 0x1FB8B) { path.rect(1 - [2, 3, 5, 6, 7][cp - 0x1FB87] / 8, 0, 1, 1); }           // right n eighths
}

function powerline(path, m, cp) {
    const t = m.light;
    const mirror = (segs) => { for (let i = 0; i < segs.length; i += 2) segs[i] = 1 - segs[i]; return segs; };
    /** A half ellipse bulging right from the cell's left edge, radii (rx, 0.5). */
    const halfEllipse = (rx, ry) => { const s = []; arcTo(s, 0, 0.5, rx, ry, Math.PI / 2, -Math.PI / 2); return s; };
    switch (cp) {
        case 0xE0B0: path.poly([0, 0, 0, 1, 1, 0.5]); return;
        case 0xE0B1: stroke(path, m, 0, 1, 1, 0.5, t); stroke(path, m, 1, 0.5, 0, 0, t); return;
        case 0xE0B2: path.poly([1, 0, 1, 1, 0, 0.5]); return;
        case 0xE0B3: stroke(path, m, 1, 1, 0, 0.5, t); stroke(path, m, 0, 0.5, 1, 0, t); return;
        case 0xE0B4: case 0xE0B6: {
            const s = halfEllipse(1, 0.5);
            lineTo(s, s[0], s[1]);
            path.contour(cp === 0xE0B6 ? mirror(s) : s);
            return;
        }
        case 0xE0B5: case 0xE0B7: {
            // The outline of that half ellipse: its outer arc, back along one a line's thickness in.
            const tx = t / m.aspect;
            const s = halfEllipse(1, 0.5);
            lineTo(s, 0, t);
            arcTo(s, 0, 0.5, Math.max(1 - tx, 0), Math.max(0.5 - t, 0), -Math.PI / 2, Math.PI / 2);
            lineTo(s, s[0], s[1]);
            path.contour(cp === 0xE0B7 ? mirror(s) : s);
            return;
        }
        case 0xE0B8: path.poly([0, 0, 0, 1, 1, 0]); return;
        case 0xE0B9: case 0xE0BF: stroke(path, m, 0, 1, 1, 0, t); return;
        case 0xE0BA: path.poly([1, 0, 1, 1, 0, 0]); return;
        case 0xE0BB: case 0xE0BD: stroke(path, m, 0, 0, 1, 1, t); return;
        case 0xE0BC: path.poly([0, 0, 0, 1, 1, 1]); return;
        case 0xE0BE: path.poly([0, 1, 1, 1, 1, 0]); return;
        default: break;
    }
}

// ── Public ────────────────────────────────────────────────────────────────────────────────────

/**
 * One sprite's outline for a cell.
 * @param {number} cp  a sprite codepoint (isSpriteCodepoint)
 * @param {SpriteMetrics} m
 * @returns {{ curves: number[], alpha: number }} curves: flat [p0x, p0y, p1x, p1y, p2x, p2y, …] in
 *   the unit cell (y up); alpha: the ink's opacity, 0..255
 */
export function spriteOutline(cp, m) {
    if (!isSpriteCodepoint(cp)) throw new Error(`spriteOutline: U+${cp.toString(16).toUpperCase()} is not a sprite codepoint`);
    if (!(m?.aspect > 0) || !(m.light > 0) || !(m.heavy > 0)) throw new Error(`spriteOutline: needs the cell's aspect and line weights, got ${JSON.stringify(m)}`);
    const path = new Path();
    if (cp <= 0x257F) boxDrawing(path, m, cp);
    else if (cp <= 0x259F) blockElement(path, cp);
    else if (cp <= 0x28FF) braille(path, m, cp);
    else if (cp <= 0xE0BF) powerline(path, m, cp);
    else legacyComputing(path, cp);
    return { curves: path.q, alpha: path.alpha };
}

/**
 * Encode sprites as an EncodedBatch (slugData.js) for SlugBuffer.appendEncoded: each one's curves
 * packed as curve texels, in glyph-map mode 3 with its ink alpha as the mode's argument.
 * @param {Array<{slot:number, cp:number}>} items
 * @param {SpriteMetrics} m
 * @param {number} mode  the glyph-map mode a sprite draws in (GLYPH_MODE.SPRITE)
 * @returns {import('./slugData.js').EncodedBatch}
 */
export function encodeSprites(items, m, mode) {
    const n = items.length;
    const slots = new Uint32Array(n), counts = new Uint32Array(n);
    const modes = new Uint32Array(n).fill(mode), args = new Uint32Array(n);
    const outlines = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
        const o = spriteOutline(items[i].cp, m);
        outlines[i] = o.curves;
        slots[i] = items[i].slot;
        counts[i] = o.curves.length / 6;
        args[i] = o.alpha;
        total += counts[i];
    }
    const texels = new Uint32Array(total * CURVE_U32_PER_CURVE);
    let t = 0;
    for (let i = 0; i < n; i++) {
        const q = outlines[i];
        for (let k = 0; k < q.length; k += 6) {
            // texel 0: [P0.x, P0.y, P1.x, P1.y]   texel 1: [P2.x, P2.y, _, _]
            for (let j = 0; j < 6; j++) texels[t + j] = packUint16(q[k + j]);
            t += CURVE_U32_PER_CURVE;
        }
    }
    return { slots, counts, texels, modes, args, overhang: { count: 0, worstSlot: -1, worstFrac: 0, worstName: '' } };
}
