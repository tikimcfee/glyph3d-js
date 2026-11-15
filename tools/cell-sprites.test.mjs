// cell-sprites.test.mjs — the glyphs a terminal draws itself, as generated outlines
// (shaping/cellSprites.js): every sprite codepoint yields curves inside the cell, wound the way
// a font's outline is; shapes reach the cell edges they must join across and stay clear of the
// ones they must not; and they land in the Slug atlas as one more glyph source — routed by the
// font chain before any font, encoded synchronously, in glyph-map mode 3 with their ink alpha.
// Also here: the font's line metrics, the cache keys, and the cell lattice that makes
// neighbouring cells share their edge to the bit.
//
//   bun tools/cell-sprites.test.mjs

const { isSpriteCodepoint, spriteOutline, encodeSprites, SPRITE_VERSION } = await import('../packages/glyph3d-core/src/shaping/cellSprites.js');
const { SlugBuffer, encodeGlyph } = await import('../packages/glyph3d-core/src/shaping/slugData.js');
const { default: LiveSlugAtlas } = await import('../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js');
const { slugCoreKey, slugGrowthKey } = await import('../packages/glyph3d-core/src/shaping/slugCoreCache.js');
const { default: TextureUploads } = await import('../packages/glyph3d-core/src/core/TextureUploads.js');
const { snapCellDimension, computeCellMetrics } = await import('../packages/glyph3d-core/src/core/cellMetrics.js');
const { readFontLines } = await import('../packages/glyph3d-core/src/shaping/fontTables.js');
const { bootHeadlessFontChain } = await import('./headlessFontChain.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${a}, want ${b}`);
const hex = (cp) => `U+${cp.toString(16).toUpperCase()}`;

const quiet = console.log;
console.log = () => {};
const { chain, fonts } = await bootHeadlessFontChain();
console.log = quiet;
const M = chain.spriteMetrics();

// ── winding number of a point against a glyph's curves (each quadratic flattened) ────────────
// The shader's own rule, plainly: the sum of signed crossings of a ray to +x. A font's outer
// contour (clockwise, y up) gives +1 inside by the sign convention below; so must a sprite's.
function winding(curves, x, y) {
    let w = 0;
    for (let k = 0; k < curves.length; k += 6) {
        let px = curves[k], py = curves[k + 1];
        for (let s = 1; s <= 12; s++) {
            const t = s / 12, u = 1 - t;
            const qx = u * u * curves[k] + 2 * u * t * curves[k + 2] + t * t * curves[k + 4];
            const qy = u * u * curves[k + 1] + 2 * u * t * curves[k + 3] + t * t * curves[k + 5];
            if ((py <= y) !== (qy <= y)) {
                const at = px + (y - py) / (qy - py) * (qx - px);
                if (at > x) w += qy > py ? -1 : 1;   // a clockwise contour's right side runs downward: +1
            }
            px = qx; py = qy;
        }
    }
    return w;
}
const inked = (cp, x, y) => winding(spriteOutline(cp, M).curves, x, y) > 0;
/** The share of the cell a sprite inks, sampled on a grid. */
function area(cp, n = 60) {
    const c = spriteOutline(cp, M).curves;
    let hit = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (winding(c, (i + 0.5) / n, (j + 0.5) / n) > 0) hit++;
    return hit / (n * n);
}

// ── 1. every sprite: curves in the cell, wound as a font's outline is ────────────────────────
console.log('every sprite codepoint');
{
    // The font's own convention, measured: the stem of Cousine's 'l'.
    const l = chain.lookup(0x6c).g;
    const fontCurves = encodeGlyph(chain, l).curves.flatMap((c) => [c.p0x, c.p0y, c.p1x, c.p1y, c.p2x, c.p2y]);
    let fontInside = 0;
    for (let y = 0.3; y < 0.8; y += 0.05) fontInside = Math.max(fontInside, winding(fontCurves, 0.5, y));
    eq(fontInside, 1, 'a font outline\'s ink has winding +1 under this test\'s rule (its teeth)');
    eq(winding(spriteOutline(0x2588, M).curves, 0.5, 0.5), 1, '█ has the same winding at its centre: sprites wind as fonts do');

    let n = 0, out = 0, empty = [], negative = [], most = 0;
    for (let cp = 0x2500; cp <= 0x1FBFF; cp++) {
        if (!isSpriteCodepoint(cp)) continue;
        n++;
        const { curves, alpha } = spriteOutline(cp, M);
        if (curves.length % 6 || !(alpha > 0 && alpha <= 255)) out++;
        for (const v of curves) if (!(v >= 0 && v <= 1)) { out++; break; }
        if (!curves.length && cp !== 0x2800) empty.push(hex(cp));
        most = Math.max(most, curves.length / 6);
        // No point of the cell may read as "inside, negatively": that would be a contour wound backwards.
        for (let i = 0; i < 9 && negative.at(-1) !== hex(cp); i++) for (let j = 0; j < 9; j++) {
            if (winding(curves, (i + 0.5) / 9, (j + 0.5) / 9) < 0) { negative.push(hex(cp)); break; }
        }
    }
    eq(n, 128 + 32 + 256 + 16 + 145 + 2, 'box drawing, blocks, braille, powerline and the legacy-computing set are sprites');
    eq(out, 0, 'every sprite\'s curves lie in the unit cell, six numbers each, with an ink alpha');
    eq(empty.length, 0, `none is empty but blank braille (${empty.slice(0, 8).join(' ')})`);
    eq(negative.length, 0, `none has a contour wound backwards (${negative.slice(0, 8).join(' ')})`);
    ok(most <= 256, `the busiest sprite has ${most} curves (the shader reads at most 256)`);
    ok(!isSpriteCodepoint(0x41) && !isSpriteCodepoint(0x25A0) && !isSpriteCodepoint(0xE0A0) && !isSpriteCodepoint(0x1F600) && !isSpriteCodepoint(0x1FB95),
        'letters, geometric shapes, the powerline branch glyph, emoji and the unbuilt legacy codepoints are not');
    let threw = false;
    try { spriteOutline(0x41, M); } catch { threw = true; }
    ok(threw, 'asking for a non-sprite outline throws');
}

// ── 2. blocks: exact areas, on the right side ───────────────────────────────────────────────
console.log('block elements');
{
    const near = (a, b, msg, tol = 0.02) => ok(Math.abs(a - b) <= tol, `${msg} — got ${a.toFixed(3)}, want ${b}`);
    near(area(0x2588), 1, '█ fills the cell', 0);
    near(area(0x2580), 0.5, '▀ is half');
    ok(inked(0x2580, 0.5, 0.9) && !inked(0x2580, 0.5, 0.1), '▀ is the upper half');
    ok(inked(0x2584, 0.5, 0.1) && !inked(0x2584, 0.5, 0.9), '▄ is the lower half');
    for (let k = 1; k <= 8; k++) near(area(0x2580 + k), k / 8, `${String.fromCodePoint(0x2580 + k)} is ${k}/8 from the bottom`);
    for (let k = 1; k <= 7; k++) near(area(0x2590 - k), k / 8, `${String.fromCodePoint(0x2590 - k)} is ${k}/8 from the left`);
    ok(inked(0x258C, 0.1, 0.5) && !inked(0x258C, 0.9, 0.5) && inked(0x2590, 0.9, 0.5) && !inked(0x2590, 0.1, 0.5), '▌ is the left half, ▐ the right');
    ok(inked(0x2594, 0.5, 0.97) && !inked(0x2594, 0.5, 0.8) && inked(0x2595, 0.97, 0.5) && !inked(0x2595, 0.8, 0.5), '▔ is the top eighth, ▕ the right eighth');
    eq([0x2591, 0x2592, 0x2593].map((cp) => spriteOutline(cp, M).alpha).join(), '64,128,191', 'the shades are the full cell at 25, 50 and 75 % ink');
    near(area(0x2592), 1, '▒ covers the whole cell (its lightness is its alpha)', 0);
    const quad = { 0x2596: 'll', 0x2597: 'lr', 0x2598: 'ul', 0x259D: 'ur', 0x2599: 'ul ll lr', 0x259A: 'ul lr', 0x259B: 'ul ur ll', 0x259C: 'ul ur lr', 0x259E: 'ur ll', 0x259F: 'ur ll lr' };
    const at = { ul: [0.25, 0.75], ur: [0.75, 0.75], ll: [0.25, 0.25], lr: [0.75, 0.25] };
    for (const [cp, want] of Object.entries(quad)) {
        const got = Object.keys(at).filter((q) => inked(Number(cp), ...at[q])).sort().join(' ');
        eq(got, want.split(' ').sort().join(' '), `${String.fromCodePoint(cp)} inks its quadrants`);
    }
}

// ── 3. box drawing: arms reach their edges, centred, at the font's weights ──────────────────
console.log('box drawing');
{
    const edge = { up: [0.5, 0.995], right: [0.995, 0.5], down: [0.5, 0.005], left: [0.005, 0.5] };
    const arms = (cp) => Object.keys(edge).filter((d) => inked(cp, ...edge[d])).join(' ');
    const want = {
        0x2500: 'right left', 0x2502: 'up down', 0x250C: 'right down', 0x2510: 'down left', 0x2514: 'up right', 0x2518: 'up left',
        0x251C: 'up right down', 0x2524: 'up down left', 0x252C: 'right down left', 0x2534: 'up right left', 0x253C: 'up right down left',
        0x2501: 'right left', 0x2503: 'up down', 0x254B: 'up right down left', 0x250F: 'right down', 0x2521: 'up right down',
        0x256D: 'right down', 0x256E: 'down left', 0x256F: 'up left', 0x2570: 'up right',
        0x2574: 'left', 0x2575: 'up', 0x2576: 'right', 0x2577: 'down', 0x257C: 'right left', 0x257F: 'up down',
    };
    for (const [cp, w] of Object.entries(want)) eq(arms(Number(cp)), w, `${String.fromCodePoint(cp)} (${hex(Number(cp))}) reaches the cell edges of its arms`);
    ok(inked(0x2500, 0.5, 0.5) && !inked(0x2500, 0.5, 0.5 + M.light) && !inked(0x2500, 0.5, 0.5 - M.light), '─ is one light line through the centre');
    ok(inked(0x2501, 0.5, 0.5 + M.light * 0.8) && !inked(0x2501, 0.5, 0.5 + M.heavy), '━ is heavy: thicker than light, no thicker than heavy');
    ok(Math.abs(area(0x2500, 200) - M.light) < 0.004, `─ inks the line's share of the cell (${area(0x2500, 200).toFixed(4)} for ${M.light})`);
    ok(Math.abs(area(0x2502, 200) - M.light / M.aspect) < 0.006, '│ is as thick in the world as ─ (the cell\'s aspect is in its width)');
    ok(inked(0x250C, 0.5, 0.5) && !inked(0x250C, 0.5 - M.light, 0.5 + M.light), '┌ has a square corner: inked at the centre, clear outside the turn');
    ok(!inked(0x256D, 0.5, 0.5) && inked(0x256D, 0.5, 0.2), '╭ rounds its corner: the centre is clear, the line below it is there');
    // Light and heavy meeting: ┡ (down light, right and up heavy).
    ok(inked(0x2521, 0.5 + M.heavy / M.aspect * 0.4, 0.9) && !inked(0x2521, 0.5 + M.heavy / M.aspect * 0.4, 0.1), '┡: the heavy arm is up, the light one down');

    // Double lines: two light lines a light gap apart; the gap is clear, through every join.
    const t = M.light, tx = M.light / M.aspect;
    ok(inked(0x2550, 0.1, 0.5 + t) && inked(0x2550, 0.1, 0.5 - t) && !inked(0x2550, 0.1, 0.5), '═ is two lines with a clear gap between');
    ok(inked(0x2551, 0.5 + tx, 0.1) && inked(0x2551, 0.5 - tx, 0.1) && !inked(0x2551, 0.5, 0.1), '║ the same, upright');
    ok(!inked(0x256C, 0.5, 0.5) && !inked(0x256C, 0.1, 0.5) && !inked(0x256C, 0.5, 0.1) && inked(0x256C, 0.5 - tx, 0.5 - t) && inked(0x256C, 0.5 + tx, 0.5 + t),
        '╬ is hollow through its centre and along every arm, inked at the four inner corners');
    ok(inked(0x2554, 0.5 - tx, 0.5 + t) && inked(0x2554, 0.5 + tx, 0.5 - t) && !inked(0x2554, 0.5, 0.5) && !inked(0x2554, 0.5 - tx, 0.99),
        '╔ turns both lines: outer corner, inner corner, a clear gap, nothing above');
    ok(inked(0x2560, 0.5 - tx, 0.5) && !inked(0x2560, 0.5 + tx, 0.5) && inked(0x2560, 0.99, 0.5 + t), '╠ keeps its left line whole and opens its right one into the arm');
    ok(inked(0x2552, 0.5, 0.1) && inked(0x2552, 0.9, 0.5 + t) && inked(0x2552, 0.9, 0.5 - t) && !inked(0x2552, 0.9, 0.5) && !inked(0x2552, 0.1, 0.5 + t),
        '╒ joins a single line from below to a double one to the right');
    ok(inked(0x256A, 0.5, 0.5) && inked(0x256A, 0.1, 0.5 + t) && !inked(0x256A, 0.1, 0.5), '╪ runs its single line through a double one');

    // Dashes leave gaps and stay on the line; diagonals run corner to corner.
    for (const [cp, nDash] of [[0x2504, 3], [0x2508, 4], [0x254C, 2]]) {
        let runs = 0, was = false;
        for (let i = 0; i < 400; i++) { const on = inked(cp, (i + 0.5) / 400, 0.5); if (on && !was) runs++; was = on; }
        eq(runs, nDash, `${String.fromCodePoint(cp)} is ${nDash} dashes`);
        ok(!inked(cp, 0.001, 0.5) && !inked(cp, 0.999, 0.5), `${String.fromCodePoint(cp)} leaves half a gap at each cell edge (dashes space evenly across cells)`);
    }
    ok(inked(0x2506, 0.5, 0.5) && !inked(0x2506, 0.2, 0.5), '┆ is upright');
    ok(inked(0x2571, 0.02, 0.02) && inked(0x2571, 0.98, 0.98) && inked(0x2571, 0.5, 0.5) && !inked(0x2571, 0.1, 0.9), '╱ runs lower left to upper right, into both corners');
    ok(inked(0x2572, 0.02, 0.98) && inked(0x2572, 0.98, 0.02) && !inked(0x2572, 0.9, 0.9), '╲ the other way');
    ok(inked(0x2573, 0.02, 0.02) && inked(0x2573, 0.02, 0.98) && inked(0x2573, 0.98, 0.02) && inked(0x2573, 0.98, 0.98), '╳ reaches all four corners');
}

// ── 4. braille, sextants, wedges, powerline ─────────────────────────────────────────────────
console.log('braille, legacy computing, powerline');
{
    const dots = [[0.25, 7 / 8], [0.25, 5 / 8], [0.25, 3 / 8], [0.75, 7 / 8], [0.75, 5 / 8], [0.75, 3 / 8], [0.25, 1 / 8], [0.75, 1 / 8]];
    let good = true;
    for (let bits = 0; bits < 256; bits++) {
        for (let d = 0; d < 8; d++) if (inked(0x2800 + bits, ...dots[d]) !== !!(bits & (1 << d))) good = false;
    }
    ok(good, 'every braille pattern inks exactly its dots (dot n is bit n − 1; 1 2 3 7 down the left, 4 5 6 8 down the right)');
    ok(!inked(0x28FF, 0.5, 0.5) && !inked(0x28FF, 0.25, 0.5), 'braille dots are apart: clear between columns and between rows');

    // Sextants: U+1FB00.. are the 2 × 3 patterns 1..62 without the two half blocks (21, 42).
    const cell = (b) => [(b & 1) ? 0.75 : 0.25, 1 - ((b >> 1) + 0.5) / 3];
    let sext = true;
    for (let i = 0, bits = 1; i < 60; i++, bits++) {
        if (bits === 21 || bits === 42) bits++;
        for (let b = 0; b < 6; b++) if (inked(0x1FB00 + i, ...cell(b)) !== !!(bits & (1 << b))) sext = false;
    }
    ok(sext, 'every sextant inks exactly its sixths');
    ok(inked(0x1FB00, 0.01, 0.99) && inked(0x1FB3B, 0.99, 0.01), 'sextants reach the cell edges (they tile)');

    // Wedges: each of U+1FB3C–1FB51 and its complement 22 later share the cell exactly.
    let whole = true;
    for (let i = 0; i < 22; i++) if (Math.abs(area(0x1FB3C + i, 40) + area(0x1FB52 + i, 40) - 1) > 0.03) whole = false;
    ok(whole, 'a wedge and its complement fill the cell between them');
    ok(inked(0x1FB3C, 0.05, 0.05) && !inked(0x1FB3C, 0.9, 0.9) && Math.abs(area(0x1FB3C) - 1 / 12) < 0.02, '🬼 is the small lower-left triangle (a twelfth of the cell)');
    ok(inked(0x1FB6C, 0.1, 0.5) && !inked(0x1FB6C, 0.9, 0.5) && Math.abs(area(0x1FB6C) - 0.25) < 0.02, '🭬 is the left triangular quarter');
    ok(Math.abs(area(0x1FB68) - 0.75) < 0.02 && !inked(0x1FB68, 0.1, 0.5), '🭨 is everything but the left triangle');
    ok(inked(0x1FB70, 1.5 / 8, 0.5) && !inked(0x1FB70, 0.5 / 8, 0.5) && inked(0x1FB76, 0.5, 1 - 1.5 / 8) && !inked(0x1FB76, 0.5, 1 - 0.5 / 8), 'the eighth blocks count columns from the left and rows from the top');
    eq(spriteOutline(0x1FB90, M).alpha, 128, 'the medium shades are half ink');

    ok(inked(0xE0B0, 0.01, 0.5) && inked(0xE0B0, 0.01, 0.99) && inked(0xE0B0, 0.01, 0.01) && !inked(0xE0B0, 0.9, 0.9) && Math.abs(area(0xE0B0) - 0.5) < 0.02,
        'the powerline arrow is a triangle on the cell\'s whole left edge, pointing right');
    ok(inked(0xE0B2, 0.99, 0.99) && !inked(0xE0B2, 0.1, 0.9), 'its mirror sits on the right edge');
    ok(Math.abs(area(0xE0B4) - Math.PI / 4) < 0.02 && inked(0xE0B4, 0.01, 0.5) && !inked(0xE0B4, 0.9, 0.95), 'the rounded separator is a half ellipse (π/4 of the cell)');
    ok(Math.abs(area(0xE0B8) - 0.5) < 0.02 && inked(0xE0B8, 0.1, 0.1) && !inked(0xE0B8, 0.9, 0.9), 'the slanted separator is the lower-left triangle');
    ok(area(0xE0B1) < 0.25 && inked(0xE0B1, 0.98, 0.5) && !inked(0xE0B1, 0.2, 0.5), 'the thin arrow is an outline: its point inked, its inside clear');
    ok(area(0xE0B5) < 0.3 && !inked(0xE0B5, 0.3, 0.5), 'the thin round separator too');
}

// ── 5. into the atlas: one more glyph source ────────────────────────────────────────────────
console.log('the atlas');
{
    const batch = encodeSprites([{ slot: 7, cp: 0x2588 }, { slot: 9, cp: 0x2592 }, { slot: 11, cp: 0x2800 }], M, 3);
    ok(batch.slots.join() === '7,9,11' && batch.counts.join() === '4,4,0' && batch.modes.join() === '3,3,3' && batch.args.join() === '255,128,255',
        `encodeSprites: slots, curve counts, mode 3, ink alphas (${batch.counts.join()} | ${batch.args.join()})`);
    eq(batch.texels.length, 8 * 8, 'eight packed values a curve');
    ok(batch.texels.every((v) => v <= 65535), 'packed as uint16 coordinates');
    const buf = new SlugBuffer();
    buf.appendEncoded(batch);
    const map = buf.glyphMapTexture().data;
    ok(map[7 * 4 + 1] === 4 && map[7 * 4 + 2] === 3 && map[7 * 4 + 3] === 255 && map[9 * 4 + 2] === 3 && map[9 * 4 + 3] === 128,
        'the glyph map holds a sprite as [curve start, curve count, mode 3, ink alpha]');
    const back = SlugBuffer.deserialize(buf.serialize()).glyphMapTexture().data;
    ok(back[9 * 4 + 2] === 3 && back[9 * 4 + 3] === 128, 'and a serialized core keeps both');

    // Through the real chain: a sprite codepoint routes to a sprite slot before any font.
    const box = chain.lookup(0x2500), full = chain.lookup(0x2588);
    ok(chain.isSpriteSlot(box.g) && chain.spriteCodepointOf(box.g) === 0x2500 && !chain.isBitmapSlot(box.g) && chain.slotSource(box.g) === null,
        '─ routes to a sprite slot (no font glyph behind it), though Cousine has a ─');
    eq(chain.lookup(0x2500).g, box.g, 'the same slot every time');
    eq(box.ax, chain.lookup(0x41).ax, 'at the cell\'s advance');
    eq(chain.describeSlot(box.g).font, '<cell-sprite>', 'and names itself in logs');
    ok(chain.isSpriteSlot(chain.lookup(0x1FB00).g) && chain.isSpriteSlot(chain.lookup(0xE0B0).g) && chain.isSpriteSlot(chain.lookup(0x28FF).g), 'so do a sextant, a powerline arrow and braille');
    ok(!chain.isSpriteSlot(chain.lookup(0x41).g) && !chain.isSpriteSlot(chain.lookup(0xE0A0).g), 'a letter and the powerline branch glyph still come from fonts');

    // LiveSlugAtlas lands sprites at once: nothing in flight, no encode worker call.
    let encodes = 0;
    const live = new LiveSlugAtlas({ atlas: {}, shaper: chain, uploads: new TextureUploads(), encoder: { encode: () => { encodes++; return new Promise(() => {}); } } });
    const res = live.ensureCodepoints([0x2500, 0x2588, 0x2592], chain);
    ok(res.queued === 3 && res.pending === 0 && live.pending === 0 && encodes === 0, `three sprites land synchronously (${res.queued} queued, ${res.pending} pending, ${encodes} worker calls)`);
    const lm = live.slugData.glyphMapTexture.image.data;
    ok(lm[box.g * 4 + 1] === 8 && lm[box.g * 4 + 2] === 3 && lm[full.g * 4 + 1] === 4 && lm[full.g * 4 + 3] === 255, 'their map entries are there to draw from (─ is its two arms, █ one rectangle)');
    eq(live.ensureCodepoints([0x2500], chain).queued, 0, 'a second ask is a no-op');
    eq(live.grownCount, 0, 'sprites are not persisted as growth (they are regenerated)');
    live.dispose();
}

// ── 6. the font's lines, the cache keys (faces and families: font-faces.test.mjs) ───────────
console.log('line metrics, keys');
{
    const L = chain.lineMetrics(), raw = readFontLines(chain._fonts[0].bytes), ext = chain._fonts[0].shaper.fontExtents();
    const em = ext.ascender - ext.descender;
    ok(raw.underlineThickness > 0 && raw.underlineTop < 0 && raw.strikeoutTop > 0, `the font's post and OS/2 tables are read (underline ${raw.underlineTop}/${raw.underlineThickness}, strikeout ${raw.strikeoutTop}/${raw.strikeoutSize})`);
    ok(Math.abs(L.thickness - raw.underlineThickness / em) < 1e-12, 'line thickness is the font\'s underline thickness over the cell\'s height');
    ok(L.underlineY > 0 && L.underlineY < -ext.descender / em, 'the underline sits below the baseline, inside the cell');
    ok(L.strikeY > -ext.descender / em && L.strikeY < 0.6, 'the strikethrough sits above the baseline, through the x-height');
    ok(Math.abs(M.aspect - chain.cellAdvance() / em) < 1e-12 && M.light > 0 && M.heavy >= 2 * M.light - 1e-12, `sprites are drawn to the font's cell and weights (aspect ${M.aspect.toFixed(4)}, light ${M.light}, heavy ${M.heavy})`);
    let threw = false;
    try { readFontLines(new Uint8Array(64)); } catch { threw = true; }
    ok(threw, 'bytes that are not a font are refused loudly');

    const plain = fonts.map((f) => ({ name: f.name, url: f.url }));
    ok(slugCoreKey({ fonts, encodeRanges: [[32, 126]] }) !== slugCoreKey({ fonts: plain, encodeRanges: [[32, 126]] }), 'the core cache key knows the fonts\' faces and families');
    ok(slugGrowthKey({ fonts }) !== slugGrowthKey({ fonts: plain }), 'and so does the growth key');
    ok(SPRITE_VERSION >= 1, 'the sprite version is part of the core key');
}

// ── 7. the cell lattice: neighbours share their edge to the bit ─────────────────────────────
console.log('cell lattice');
{
    const m = computeCellMetrics({ width: 29, height: 54.375 }, 0.025);
    ok(Math.abs(m.charWidth / (29 * 0.025) - 1) < 1e-3 && Math.abs(m.charHeight / (54.375 * 0.025) - 1) < 1e-3, 'snapping moves a cell dimension by under 0.1 %');
    eq(snapCellDimension(m.charWidth), m.charWidth, 'a snapped dimension is its own snap');
    const f = Math.fround;
    let cols = true, rows = true;
    for (let k = 0; k < 16000; k++) {
        // The vertex shader: this cell's right edge = pen + advance; the next cell's left = its pen.
        if (f(f(k * m.charWidth) + f(m.charWidth)) !== f((k + 1) * m.charWidth)) cols = false;
        // A row's bottom = its centre − h/2; the next row's top = its centre + h/2 (row poses are the group table's).
        if (f(f(-k * m.lineSpacing) - f(m.charHeight / 2)) !== f(f(-(k + 1) * m.lineSpacing) + f(m.charHeight / 2))) rows = false;
    }
    ok(cols, 'in float32, column k\'s right edge IS column k + 1\'s left edge, for 16000 columns');
    ok(rows, 'and row k\'s bottom IS row k + 1\'s top, for 16000 rows');
    // Teeth: the unsnapped width does not have that property.
    const w = 29 * 0.025;
    let cracks = 0;
    for (let k = 0; k < 2000; k++) if (f(f(k * w) + f(w)) !== f((k + 1) * w)) cracks++;
    ok(cracks > 0, `the unsnapped width leaves ${cracks} of 2000 column edges a float apart (the test has teeth)`);
}

console.log(`\ncell-sprites: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
