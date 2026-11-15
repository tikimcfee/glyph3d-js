// font-faces.test.mjs — real font faces, font families and cell clusters, headless, on the
// package's own font chain (fonts/families.js):
//
//   [1] the chain        every family and face is one more font of ONE chain; a variable file's
//                        faces are instances that share its bytes; the encode worker is told which
//   [2] face routing     bold / italic / bold-italic answer their face's glyph for a codepoint its
//                        font routes, the upright one for fallback glyphs, sprites and emoji; a
//                        font with no bold-italic draws it in its italic, else its bold; the bold
//                        face inks more, the italic leans
//   [3] variable fonts   an instance draws at its axis values; a wrong axis or value is refused
//   [4] families         each routes its own font first and shares the fallbacks; its cell, lines
//                        and sprites are its own; an unknown family is refused; the cache keys know
//   [5] the shape cache  faces and clusters are cached per face
//   [6] clusters         a base + combining marks is one cell: interned ids; the precomposed glyph
//                        where a font has one (NFC), else a composite — the base AND its marks,
//                        each mark centred over the base's ink and clear of it, stacked — encoded
//                        from its parts; selectors are dropped; an uncovered mark leaves the base
//   [7] the atlas        a composite lands through the encode worker and is not persisted
//   [8] the reader       TerminalEmulator hands a combined cell's cluster (not its last mark), and
//                        allocates nothing reading it again; boldIsBright (off by default): a
//                        bold cell in a standard colour takes its bright twin only when on
//
//   bun tools/font-faces.test.mjs

import { ROOT, bootHeadlessFontChain } from './headlessFontChain.mjs';

const S = await import(`${ROOT}/packages/glyph3d-core/src/shaping/index.js`);
const { fontChainIdentity, expandFontSpecs } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/FontChain.js`);
const { default: HarfBuzzShaper } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/HarfBuzzShaper.js`);
const { COMPOSITE_PART_STRIDE, unpackUint16 } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/slug-constants.js`);
const { default: SlugEncodeClient } = await import(`${ROOT}/packages/glyph3d-core/src/workers/SlugEncodeClient.js`);
const { default: TextureUploads } = await import(`${ROOT}/packages/glyph3d-core/src/core/TextureUploads.js`);
const { default: GlyphAtlas } = await import(`${ROOT}/packages/glyph3d-core/src/GlyphAtlas.js`);
const { deriveCharSize } = await import(`${ROOT}/packages/glyph3d-core/src/core/cellMetrics.js`);
const C = await import(`${ROOT}/packages/glyph3d-core/src/core/cellClusters.js`);
const A = await import(`${ROOT}/packages/glyph3d-core/src/core/cellAttrs.js`);
const F = await import(`${ROOT}/packages/glyph3d-core/src/fonts/families.js`);
const { default: TerminalEmulator, BOLD_IS_BRIGHT_DEFAULT, DEFAULT_FG } = await import(`${ROOT}/packages/glyph3d-core/src/collections/TerminalEmulator.js`);
const { ansi256toRGB } = await import(`${ROOT}/packages/glyph3d-core/src/collections/terminalPalette.js`);
const { FontChain, LiveSlugAtlas, MonospaceShapeCache, encodeGlyphBatch, encodeGlyph, slugCoreKey, slugGrowthKey } = S;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${a}, want ${b}`);
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

const { chain, fonts } = await quiet(() => bootHeadlessFontChain());
const fontOf = (g) => chain.describeSlot(g.g).font;
const nameOf = (g) => chain.describeSlot(g.g).name;

// ── ink: a glyph's curves as the shader counts them (winding along +x) ───────────────────────
/** Normalized curves [{p0x…p2y}] of an outline slot, from the main thread's own shapers. */
const curvesOf = (slot) => {
    const parts = chain.compositeOf(slot);
    const shaperOf = (i) => { const s = chain._fonts[i].shaper; return { glyphOutline: (g) => s.glyphOutline(g), glyphAdvance: (g) => s.glyphAdvance(g), fontExtents: () => s.fontExtents(), glyphName: (g) => s.glyphName(g) }; };
    const src = chain.slotSource(slot);
    const batch = parts
        ? encodeGlyphBatch([], shaperOf, [slot, parts.length / COMPOSITE_PART_STRIDE, ...parts])
        : encodeGlyphBatch([slot, src.fontIdx, src.gid], shaperOf);
    const out = [];
    for (let o = 0; o < batch.texels.length; o += 8) {
        out.push([0, 1, 2, 3, 4, 5].map((k) => unpackUint16(batch.texels[o + k])));
    }
    return out;
};
function winding(curves, x, y) {
    let w = 0;
    for (const c of curves) {
        let px = c[0], py = c[1];
        for (let s = 1; s <= 10; s++) {
            const t = s / 10, u = 1 - t;
            const qx = u * u * c[0] + 2 * u * t * c[2] + t * t * c[4];
            const qy = u * u * c[1] + 2 * u * t * c[3] + t * t * c[5];
            if ((py <= y) !== (qy <= y)) { const at = px + (y - py) / (qy - py) * (qx - px); if (at > x) w += qy > py ? -1 : 1; }
            px = qx; py = qy;
        }
    }
    return w;
}
/** A glyph's inked cells on an n × n grid over its cell: the share inked, its bounds, its centre of ink per row band. */
function inkOf(slot, n = 80) {
    const curves = curvesOf(slot);
    let hit = 0, x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    const rows = [];
    for (let j = 0; j < n; j++) {
        const y = (j + 0.5) / n;
        let lo = 1, hi = 0, c = 0;
        for (let i = 0; i < n; i++) {
            const x = (i + 0.5) / n;
            if (winding(curves, x, y) === 0) continue;
            hit++; c++;
            lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
        rows.push({ y, n: c, lo, hi });
        if (c) { x0 = Math.min(x0, lo); x1 = Math.max(x1, hi); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { area: hit / (n * n), x0, x1, y0, y1, rows, curves: curves.length };
}

// ── [1] the chain ────────────────────────────────────────────────────────────────────────────
console.log('the chain');
{
    const ids = chain.families;
    eq(ids[0], F.DEFAULT_FONT_FAMILY, 'the default family is the chain\'s first');
    ok(F.FONT_FAMILY_IDS.every((id) => ids.includes(id)) && ids.length === F.FONT_FAMILY_IDS.length, `every registered family is a family of the chain (${ids.join(', ')})`);
    const { WALL_CONFIG } = await import(`${ROOT}/wall/wallConfig.js`);
    ok(F.FONT_FAMILY_IDS.includes(WALL_CONFIG.fontFamily), `the wall's default terminal family (${WALL_CONFIG.fontFamily}) is registered`);
    const expanded = expandFontSpecs(fonts);
    eq(chain.fontCount, expanded.length, 'every listed font and every face loaded');
    ok(fonts.every((f, i) => chain._fonts[i].name === f.name), 'a listed font\'s index is its place in the list (faces follow them all)');
    ok(expanded.slice(fonts.length).every((e) => e.of >= 0 && e.face > 0), 'the faces come after every listed font');
    const neon = chain._fonts.findIndex((f) => f.name === 'Monaspace Neon'), neonBold = chain._fonts.findIndex((f) => f.name === 'Monaspace Neon Bold');
    ok(neon >= 0 && neonBold > neon && chain._fonts[neonBold].instanceOf === neon && chain._fonts[neonBold].bytes === chain._fonts[neon].bytes && chain._fonts[neonBold].coverage === chain._fonts[neon].coverage,
        'a variable family\'s bold is an INSTANCE of its one file: the same bytes and cmap, no second copy');
    const src = chain.fontSources();
    ok(src.length === chain.fontCount && src[neonBold].bytes === null && src[neonBold].instanceOf === neon && src[neonBold].variations.wght === 700 && src[neon].bytes && src[neon].variations.wght === 400,
        'the encode worker is told so: an instance names its file\'s font and carries no bytes');
    const cb = chain._fonts.findIndex((f) => f.name === 'Cousine Bold');
    ok(cb >= 0 && chain._fonts[cb].instanceOf === -1 && src[cb].bytes && chain._fonts[cb].bytes !== chain._fonts[0].bytes, 'a face with its own file is its own font');
    const sizes = new Map();
    for (const f of chain._fonts) if (f.instanceOf < 0) sizes.set(f.name, f.bytes.byteLength);
    console.log(`  files: ${[...sizes].map(([n, b]) => `${n} ${(b / 1024).toFixed(0)} KB`).join(' · ')}`);
}

// ── [2] face routing ─────────────────────────────────────────────────────────────────────────
console.log('face routing');
{
    for (const id of chain.families) {
        const v = chain.view(id), label = F.FONT_FAMILIES[id].label;
        const up = v.lookup(0x61), b = v.lookupFace(0x61, A.FACE_BOLD), it = v.lookupFace(0x61, A.FACE_ITALIC), bi = v.lookupFace(0x61, A.FACE_BOLD_ITALIC);
        ok(fontOf(up) === label && fontOf(b) === `${label} Bold` && fontOf(it) === `${label} Italic` && fontOf(bi) === `${label} Bold Italic`,
            `${id}: a is its regular / bold / italic / bold-italic face's glyph (${[up, b, it, bi].map(fontOf).join(' · ')})`);
        ok(new Set([up.g, b.g, it.g, bi.g]).size === 4 && b.ax === up.ax && it.ax === up.ax && bi.ax === up.ax, `${id}: four slots, one advance`);
        eq(v.lookupFace(0x61, A.FACE_REGULAR).g, up.g, `${id}: face 0 is the regular glyph`);
        eq(v.lookupFace(0x2500, A.FACE_BOLD).g, v.lookup(0x2500).g, `${id}: a sprite has no faces`);
        // Bold inks more; italic leans (its ink sits further right at the top than at the foot).
        const ia = inkOf(v.lookup(0x48).g), ib = inkOf(v.lookupFace(0x48, A.FACE_BOLD).g);
        ok(ib.area > ia.area * 1.12, `${id}: bold H inks more than regular (${(ib.area * 100).toFixed(1)} % of the cell vs ${(ia.area * 100).toFixed(1)} %)`);
        const lean = (slot) => { const r = inkOf(slot).rows.filter((x) => x.n); const top = r.slice(-4), foot = r.slice(0, 4); const mid = (a) => a.reduce((s, x) => s + (x.lo + x.hi) / 2, 0) / a.length; return mid(top) - mid(foot); };
        const lu = lean(v.lookup(0x6c).g), li = lean(v.lookupFace(0x6c, A.FACE_ITALIC).g);
        ok(li > lu + 0.04, `${id}: italic l leans right (top − foot ${li.toFixed(3)} of a cell; upright ${lu.toFixed(3)})`);
    }
    // A fallback font's glyph, in the default family: no faces, never synthesized.
    const fallbackOnly = [...chain._fonts[2].coverage].find((cp) => cp > 0x2000 && !chain._fonts[0].coverage.has(cp) && !chain._fonts[1].coverage.has(cp) && fontOf(chain.lookup(cp)) === 'DejaVu Sans');
    ok(fallbackOnly !== undefined && [1, 2, 3].every((face) => chain.lookupFace(fallbackOnly, face).g === chain.lookup(fallbackOnly).g),
        `a glyph from a fallback font (U+${fallbackOnly?.toString(16)}, DejaVu Sans) stays upright in every face`);
    eq(chain.routeCodepoint(0x61), 0, 'the faces take no part in routing');

    // A font with no bold-italic draws it in its italic, else its bold.
    const bytes = (name) => chain._fonts.find((f) => f.name === name).bytes;
    const partial = async (faces) => { const c = new FontChain(); await quiet(() => c.init([{ name: 'P', buffer: bytes('Cousine'), faces }], { hb: chain._fonts[0].shaper.hb })); return c; };
    const onlyItalic = await partial({ italic: { buffer: bytes('Cousine Italic') } });
    ok(onlyItalic.describeSlot(onlyItalic.lookupFace(0x61, 3).g).font === 'P Italic' && onlyItalic.lookupFace(0x61, 1).g === onlyItalic.lookup(0x61).g,
        'a font with only an italic: bold-italic is its italic, bold its upright');
    const onlyBold = await partial({ bold: { buffer: bytes('Cousine Bold') } });
    ok(onlyBold.describeSlot(onlyBold.lookupFace(0x61, 3).g).font === 'P Bold' && onlyBold.lookupFace(0x61, 2).g === onlyBold.lookup(0x61).g,
        'a font with only a bold: bold-italic is its bold, italic its upright');
    eq(onlyBold.families.length, 1, 'a chain that names no family has one, the default');
}

// ── [3] variable fonts ───────────────────────────────────────────────────────────────────────
console.log('variable fonts');
{
    const neon = chain._fonts.find((f) => f.name === 'Monaspace Neon');
    const hb = neon.shaper.hb;
    const light = neon.shaper.instance({ wght: 200 }, 'light'), heavy = neon.shaper.instance({ wght: 800 }, 'heavy');
    const stem = (s) => { const g = s.shape('l')[0].g; let lo = 1e9, hi = -1e9; for (const seg of s.glyphOutline(g)) for (let i = 0; i < seg.values.length; i += 2) { lo = Math.min(lo, seg.values[i]); hi = Math.max(hi, seg.values[i]); } return hi - lo; };
    ok(stem(light) < stem(neon.shaper) && stem(neon.shaper) < stem(heavy), `an instance draws at its weight (l is ${stem(light).toFixed(0)} / ${stem(neon.shaper).toFixed(0)} / ${stem(heavy).toFixed(0)} units wide at wght 200 / 400 / 800)`);
    eq(heavy.glyphAdvance(heavy.shape('l')[0].g), neon.shaper.glyphAdvance(neon.shaper.shape('l')[0].g), 'at the same advance');
    ok(!neon.shaper.glyphOutline(neon.shaper.shape('g')[0].g).some((s) => s.type === 'C'), 'its outlines are quadratic (glyf): what the Slug encoder takes');
    ok(/no 'wgth' axis/.test(throws(() => neon.shaper.instance({ wgth: 700 }))), 'an axis the font lacks is refused, naming it');
    ok(/outside the axis/.test(throws(() => neon.shaper.instance({ wght: 950 }))), 'a value outside the axis is refused');
    const cousine = chain._fonts[0];
    ok(/not a variable font/.test(throws(() => cousine.shaper.instance({ wght: 700 }))), 'a static font has no instances');
    light.destroy(); heavy.destroy();
    ok(neon.shaper.shape('l').length === 1, 'destroying an instance leaves the font it shares its face with');
    // The line gap: a font loaded with it has its cell grown by the gap, half above and half below.
    const withGap = new HarfBuzzShaper();
    await quiet(() => withGap.init(neon.bytes, { hb, name: 'gap', lineGap: true }));
    const e0 = neon.shaper.fontExtents(), e1 = withGap.fontExtents();
    ok(e0.lineGap > 0 && e1.ascender - e1.descender === e0.ascender - e0.descender + e0.lineGap && e1.ascender - e0.ascender === e0.lineGap / 2,
        `lineGap: the cell takes in the font's line gap, half above and half below (${e0.ascender - e0.descender} → ${e1.ascender - e1.descender} units)`);
    withGap.destroy();
}

// ── [4] families ─────────────────────────────────────────────────────────────────────────────
console.log('families');
{
    const cousine = chain.view('cousine'), neon = chain.view('monaspace-neon');
    ok(chain.view() === cousine && chain.view(null) === cousine && cousine.index === 0, 'no id is the default family');
    ok(fontOf(cousine.lookup(0x41)) === 'Cousine' && fontOf(neon.lookup(0x41)) === 'Monaspace Neon', 'each family routes its own font first');
    const shared = [...chain._fonts[2].coverage].find((cp) => cp > 0x2000 && chain.routeCodepoint(cp, 0) === 2 && chain.routeCodepoint(cp, neon.index) === 2);
    ok(shared !== undefined && cousine.lookup(shared).g === neon.lookup(shared).g, `and falls back to the same fonts: U+${shared?.toString(16)} is one slot (DejaVu's) in both`);
    ok(chain._families.every((f, k) => chain._families.every((o, j) => j === k || !f.route.includes(o.primary))), 'another family\'s font is never on a family\'s route (no fallback into it)');
    const cs = deriveCharSize(cousine, 48), ns = deriveCharSize(neon, 48);
    ok(ns.width !== cs.width && ns.height !== cs.height, `a family's cell is its own font's (Cousine ${cs.width} × ${cs.height.toFixed(2)}, Neon ${ns.width} × ${ns.height.toFixed(2)} at 48 px)`);
    const cl = cousine.lineMetrics(), nl = neon.lineMetrics();
    ok(cl.underlineY !== nl.underlineY && nl.thickness > 0 && nl.underlineY > 0 && nl.underlineY < 0.3, `and so are its lines (underline at ${cl.underlineY.toFixed(3)} vs ${nl.underlineY.toFixed(3)} of the cell)`);
    const sc = cousine.lookup(0x2500), sn = neon.lookup(0x2500);
    ok(chain.isSpriteSlot(sc.g) && chain.isSpriteSlot(sn.g) && sc.g !== sn.g && chain.spriteFamilyOf(sc.g) === 0 && chain.spriteFamilyOf(sn.g) === neon.index,
        'a sprite is drawn to its family\'s cell: each family has its own sprite slot');
    ok(Math.abs(cousine.spriteMetrics().aspect - neon.spriteMetrics().aspect) > 1e-3, 'whose aspect is the family\'s');
    ok(/no font family 'helvetica'/.test(throws(() => chain.view('helvetica'))) && /cousine/.test(throws(() => chain.view('helvetica'))), 'an unknown family is refused, naming the ones there are');

    // The atlas hands a field a family: its shape cache, its cell, its lines.
    const atlas = new GlyphAtlas('x', 48);
    atlas._shaper = chain;
    atlas._shapeCache = new MonospaceShapeCache(chain);
    atlas._charSize = deriveCharSize(chain, 48);
    const d = atlas.fontFamily(), n = atlas.fontFamily('monaspace-neon');
    ok(d.index === 0 && d.shapeCache === atlas._shapeCache && d.charSize === atlas.getCharSize(), 'atlas.fontFamily(): the default family is the atlas\'s own cache and cell');
    ok(n.id === 'monaspace-neon' && n.shapeCache !== d.shapeCache && n.charSize.width === ns.width && fontOf(n.shapeCache.lookupFace(0x61, 1)) === 'Monaspace Neon Bold', 'atlas.fontFamily(id): that family\'s cache, routed for it, and its cell');
    eq(atlas.fontFamily('monaspace-neon'), n, 'made once and shared by every field that draws in it');
    ok(/helvetica/.test(throws(() => atlas.fontFamily('helvetica'))), 'an unknown family throws there too');

    // Cache keys: the chain's identity is every font it loads — name, instance, family.
    const identity = fontChainIdentity(fonts);
    eq(identity.length, chain.fontCount, 'the identity names every font the chain loads');
    ok(identity.includes('Cousine@cousine') && identity.some((n) => /^Monaspace Neon Bold\{slnt=0,wght=700\}/.test(n)), `by name, variation instance and family (${identity.slice(0, 2).join(', ')}, …, ${identity.find((n) => n.startsWith('Monaspace Neon Bold{'))})`);
    const heavier = fonts.map((f) => (f.family === 'monaspace-neon' ? { ...f, faces: { ...f.faces, bold: { variations: { wght: 800, slnt: 0 } } } } : f));
    ok(slugGrowthKey({ fonts }) !== slugGrowthKey({ fonts: heavier }) && slugCoreKey({ fonts, encodeRanges: [[32, 126]] }) !== slugCoreKey({ fonts: heavier, encodeRanges: [[32, 126]] }),
        'another weight for a face is another chain: the growth and core keys move');
    const gapped = fonts.map((f) => (f.family === 'monaspace-neon' ? { ...f, lineGap: !f.lineGap } : f));
    ok(slugGrowthKey({ fonts }) !== slugGrowthKey({ fonts: gapped }), 'and so is another line-gap choice');
}

// ── [5] the shape cache ──────────────────────────────────────────────────────────────────────
console.log('the shape cache');
{
    const cache = new MonospaceShapeCache(chain.view('monaspace-argon'));
    const b = cache.lookupFace(0x67, A.FACE_BOLD);
    ok(fontOf(b) === 'Monaspace Argon Bold' && cache.lookupFace(0x67, A.FACE_BOLD) === b, 'a face\'s glyph is looked up once and cached per face');
    ok(cache.lookupFace(0x67, A.FACE_REGULAR) === cache.lookup(0x67) && cache.lookup(0x67).g !== b.g, 'face 0 is the plain lookup');
    cache.invalidate();
    ok(cache.lookupFace(0x67, A.FACE_BOLD) !== b && cache.lookupFace(0x67, A.FACE_BOLD).g === b.g, 'invalidate clears the faces too (the slot is the chain\'s, and stays)');
}

// ── [6] clusters ─────────────────────────────────────────────────────────────────────────────
console.log('clusters');
{
    const E_ACUTE = 'é', X_ACUTE = 'x́', STACK = 'q̈̄';
    eq(C.clusterId('e'), 0x65, 'one codepoint is itself, not a cluster');
    eq(C.clusterId('\u{1F600}'), 0x1F600, 'an astral codepoint too');
    const id = C.clusterId(E_ACUTE);
    ok(id >= C.CLUSTER_BASE && C.isCluster(id) && !C.isCluster(0x10FFFF) && C.CLUSTER_BASE > 0x10FFFF, `a base and a mark is a cluster id above every codepoint (${id.toString(16)})`);
    ok(C.clusterId(E_ACUTE) === id && C.clusterId('e' + '́') === id && C.clusterText(id) === E_ACUTE && C.cellText(id) === E_ACUTE && C.cellText(0x41) === 'A', 'interned: the same text is the same id, and reads back');
    ok(C.clusterId(X_ACUTE) !== id, 'another cluster is another id');
    ok(/not an interned cluster/.test(throws(() => C.clusterText(C.CLUSTER_BASE + 1e6))), 'an id that was never interned is refused');
    const count = C.clusterCount();
    C.setClusterLimit(count);
    const w = console.warn; let warned = 0; console.warn = () => { warned++; };
    const over = C.clusterId('ź'), over2 = C.clusterId('ẑ');
    console.warn = w;
    ok(over === 0x7A && over2 === 0x7A && C.clusterCount() === count && warned === 1, 'past the limit a new cluster reads as its first codepoint, said once');
    C.setClusterLimit(C.CLUSTER_LIMIT_DEFAULT);
    ok(C.isCluster(C.clusterId('ź')), 'and interns again once the limit is raised');

    for (const famId of ['cousine', 'monaspace-neon', 'monaspace-argon']) {
        const v = chain.view(famId), label = F.FONT_FAMILIES[famId].label;
        // NFC: the precomposed glyph, in the cell's face.
        ok(v.lookupCluster(E_ACUTE).g === v.lookup(0xE9).g && v.lookupCluster(E_ACUTE, A.FACE_BOLD).g === v.lookupFace(0xE9, A.FACE_BOLD).g && nameOf(v.lookup(0xE9)) === 'eacute',
            `${famId}: e + U+0301 is the precomposed é (NFC), in the cell's face`);
        ok(v.lookupCluster('ế').g === v.lookup(0x1EBF).g && chain.compositeOf(v.lookup(0x1EBF).g) === null, `${famId}: a Vietnamese stack the font has precomposed (ế) is that one glyph`);
        // No precomposed form: a composite of the base and its mark.
        const c = v.lookupCluster(X_ACUTE), parts = chain.compositeOf(c.g);
        ok(parts && parts.length === 2 * COMPOSITE_PART_STRIDE && chain.slotSource(c.g) === null && !chain.isSpriteSlot(c.g) && !chain.isBitmapSlot(c.g),
            `${famId}: x + U+0301 (no precomposed form) is a composite slot of two parts`);
        ok(chain.describeSlot(c.g).font === '<cluster>' && chain.describeSlot(c.g).name === `${label}:x + ${label}:acutecomb`, `${famId}: named by its parts (${chain.describeSlot(c.g).name})`);
        eq(v.lookupCluster(X_ACUTE).g, c.g, `${famId}: the same cluster is the same slot`);
        eq(c.ax, v.lookup(0x78).ax, `${famId}: one cell wide`);
        const cb = v.lookupCluster(X_ACUTE, A.FACE_BOLD);
        ok(cb.g !== c.g && chain.describeSlot(cb.g).name === `${label} Bold:x + ${label} Bold:acutecomb`, `${famId}: in bold, a composite of the bold face's parts`);
        ok(chain.view('cousine').lookupCluster(X_ACUTE).g !== chain.view('monaspace-neon').lookupCluster(X_ACUTE).g, 'each family shapes its own');

        // The ink: the base letter is there (what today's reader loses), and the mark sits over it.
        const base = inkOf(v.lookup(0x78).g), both = inkOf(c.g);
        const baseInk = both.rows.filter((r) => r.y >= base.y0 && r.y <= base.y1).reduce((s, r) => s + r.n, 0);
        ok(baseInk >= base.area * 80 * 80 * 0.98, `${famId}: the composite draws the base letter (its x inks ${baseInk} cells of the grid, the lone x ${Math.round(base.area * 6400)})`);
        const mark = both.rows.filter((r) => r.y > base.y1 + 0.01 && r.n);
        const mx0 = Math.min(...mark.map((r) => r.lo)), mx1 = Math.max(...mark.map((r) => r.hi)), my0 = Math.min(...mark.map((r) => r.y));
        ok(mark.length > 0 && both.area > base.area, `${famId}: and its mark, above the x (${mark.length} rows of ink over it)`);
        ok(Math.abs((mx0 + mx1) / 2 - (base.x0 + base.x1) / 2) < 0.04, `${famId}: the mark is centred over the letter's ink (${((mx0 + mx1) / 2).toFixed(3)} vs ${((base.x0 + base.x1) / 2).toFixed(3)} across the cell)`);
        ok(my0 - base.y1 > 0.01 && my0 - base.y1 < 0.2, `${famId}: clear of it, and close (${(my0 - base.y1).toFixed(3)} of the cell above the x-height)`);
        ok(mx0 >= 0 && mx1 <= 1 && both.y1 < 1, `${famId}: inside the cell`);

        // Two marks stack: the second sits over the first.
        const st = v.lookupCluster(STACK), sp = chain.compositeOf(st.g);
        ok(sp && sp.length === 3 * COMPOSITE_PART_STRIDE, `${famId}: q + U+0308 + U+0304 is three parts`);
        const q = inkOf(v.lookup(0x71).g), qs = inkOf(st.g);
        const over = qs.rows.filter((r) => r.y > q.y1 + 0.005 && r.n);
        const gaps = over.filter((r, k) => k > 0 && r.y - over[k - 1].y > 1.5 / 80).length;
        ok(over.length >= 3 && gaps >= 1, `${famId}: the two marks stack, one clear above the other (${over.length} inked rows over the q, ${gaps} gap between them)`);
    }

    // Selectors and joiners are not drawn; an uncovered mark leaves the base.
    eq(chain.lookupCluster('❤️').g, chain.lookup(0x2764).g, 'a variation selector is dropped: the base\'s glyph');
    eq(chain.lookupCluster('a︎').g, chain.lookup(0x61).g, 'a text-presentation selector too');
    const uncovered = [0x20DD, 0x20E3, 0x1AB0].find((cp) => chain.routeCodepoint(cp) < 0);
    ok(uncovered !== undefined && chain.lookupCluster(`a${String.fromCodePoint(uncovered)}`).g === chain.lookup(0x61).g, `a mark no font has (U+${uncovered?.toString(16)}) is left out: the base still draws`);
    eq(chain.lookupCluster('─́').g, chain.lookup(0x2500).g, 'a sprite draws alone');

    // A mark the base's font lacks comes from the font that has it.
    const bytes = (name) => chain._fonts.find((f) => f.name === name).bytes;
    const two = new FontChain();
    // A base font with letters but no combining marks: Meslo's PUA-free subset can't be made here,
    // so use the real fallback pair — a mark only DejaVu covers, under a Cousine base.
    await quiet(() => two.init([{ name: 'Cousine', buffer: bytes('Cousine') }, { name: 'DejaVu Sans', buffer: bytes('DejaVu Sans') }], { hb: chain._fonts[0].shaper.hb }));
    const dejavuOnly = [...two._fonts[1].coverage].find((cp) => cp >= 0x300 && cp <= 0x36F && !two._fonts[0].coverage.has(cp));
    if (dejavuOnly !== undefined) {
        const mixed = two.lookupCluster(`x${String.fromCodePoint(dejavuOnly)}`), mp = two.compositeOf(mixed.g);
        ok(mp && mp[0] === 0 && mp[COMPOSITE_PART_STRIDE] === 1, `a mark the base's font lacks (U+${dejavuOnly.toString(16)}) comes from the font that has it, as one composite`);
    } else {
        ok(true, 'Cousine covers every combining mark DejaVu does (no mixed-font case to draw)');
    }

    // The shape cache: a cluster id is a cell's content like any codepoint.
    const cache = new MonospaceShapeCache(chain.view('monaspace-neon'));
    const xid = C.clusterId(X_ACUTE);
    ok(cache.lookup(xid).g === chain.view('monaspace-neon').lookupCluster(X_ACUTE).g && cache.lookup(xid) === cache.lookup(xid), 'the shape cache resolves a cluster id through the chain, once');
    ok(cache.lookupFace(xid, A.FACE_BOLD).g === chain.view('monaspace-neon').lookupCluster(X_ACUTE, A.FACE_BOLD).g, 'in a face too');
    eq(cache.lookup(C.clusterId(E_ACUTE)).g, cache.lookup(0xE9).g, 'a cluster with a precomposed form is that glyph\'s slot');
}

// ── [7] the atlas: a composite lands through the worker ──────────────────────────────────────
console.log('the atlas');
{
    const encoder = new SlugEncodeClient({ fonts: chain.fontSources() });
    const live = new LiveSlugAtlas({ atlas: {}, shaper: chain, encoder, uploads: new TextureUploads(), persist: { save: async () => 1 }, persistDebounceMs: 1e9 });
    const v = chain.view('monaspace-neon');
    const comp = v.lookupCluster('x́').g, x = v.lookup(0x78).g, boldG = v.lookupFace(0x67, A.FACE_BOLD).g, sprite = v.lookup(0x2502).g;
    const buf = live._textures.buffer;
    const r = live.ensureGlyphsEncoded([comp, x, boldG, sprite], new Map([[comp, C.clusterId('x́')]]));
    ok(r.queued === 4 && buf.has(sprite) && !buf.has(comp), 'a composite is queued for the worker like any outline (the sprite landed at once)');
    await quiet(() => live.whenIdle());
    ok(buf.has(comp) && buf.has(x) && buf.has(boldG), 'and lands');
    const nComp = buf.slotTexels(comp).length / 8, nX = buf.slotTexels(x).length / 8;
    const acute = v.chain._fonts[chain.slotSource(x).fontIdx].shaper;
    const nMark = encodeGlyph(acute, acute.shape('́')[0].g).curves.length;
    eq(nComp, nX + nMark, `with the base's curves and the mark's (${nX} + ${nMark})`);
    eq(buf.slotTexels(comp).length / 8, curvesOf(comp).length, 'the worker\'s encode is the main thread\'s');
    eq(live.grownCount, 2, 'the font glyphs persist as growth; the composite (a cluster\'s shaping) and the sprite do not');
    ok(live.ensureGlyphsEncoded([comp]).queued === 0, 'asking again queues nothing');
    live.dispose();
}

// ── [8] the reader ───────────────────────────────────────────────────────────────────────────
console.log('the reader');
{
    const emu = new TerminalEmulator(40, 4, () => {});
    const write = (bytes) => new Promise((r) => emu._term.write(bytes, r));
    const pack = (r, g, b) => r | (g << 8) | (b << 16);
    const pal = (i) => { const c = ansi256toRGB(i); return pack(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)); };

    await write('aéb x́ \x1b[1mq̈̄\x1b[0m ❤️.');
    let s = emu.readScreen(40, 4);
    eq(s.cp[0], 0x61, 'a plain cell reads its codepoint');
    ok(C.isCluster(s.cp[1]) && C.clusterText(s.cp[1]) === 'é', `a cell holding e + U+0301 reads as that cluster (${s.cp[1].toString(16)}: ${JSON.stringify(C.cellText(s.cp[1]))}) — not as its last mark, U+0301`);
    ok(s.cp[2] === 0x62 && s.cp[3] === 32, 'the mark took no cell of its own: the next cells follow');
    eq(C.clusterText(s.cp[4]), 'x́', 'x + U+0301 too');
    ok(C.clusterText(s.cp[6]) === 'q̈̄' && s.at[6] === A.CELL_BOLD, 'a stack of two marks is one cluster, with its attributes');
    ok(C.clusterText(s.cp[8]) === '❤️', 'a symbol and its variation selector is a cluster too (drawn as the symbol)');
    eq(emu.readText()[0].trim(), 'aéb x́ q̈̄ ❤️.', 'the text itself is the program\'s');
    // Read again: the same ids, nothing interned, the same arrays.
    const ids = [s.cp[1], s.cp[4], s.cp[6], s.cp[8]], n0 = C.clusterCount(), arrays = [s, s.cp, s.fg, s.at];
    emu.dirty = true;
    const s2 = emu.readScreen(40, 4);
    ok([s2.cp[1], s2.cp[4], s2.cp[6], s2.cp[8]].every((v, k) => v === ids[k]) && C.clusterCount() === n0 && [s2, s2.cp, s2.fg, s2.at].every((o, k) => o === arrays[k]),
        'a second read hands the same ids from the same arrays and interns nothing');

    // boldIsBright: off by default.
    eq(BOLD_IS_BRIGHT_DEFAULT, false, 'boldIsBright is off by default (Ghostty\'s default: bold keeps its colour)');
    eq(emu.boldIsBright, false, 'an emulator is born with the default');
    await write('\r\n\x1b[31mr\x1b[1mR\x1b[0m\x1b[1mD\x1b[0m\x1b[1;38;2;10;20;30mT\x1b[0m\x1b[1;38;5;4mP\x1b[0m\x1b[1;38;5;100mQ\x1b[0m\x1b[1;91mB\x1b[0m\x1b[1;7;32mI\x1b[0m');
    s = emu.readScreen(40, 4);
    const row = 40;
    ok(s.fg[row] === pal(1) && s.fg[row + 1] === pal(1) && s.at[row + 1] === A.CELL_BOLD, 'off: bold red is red — bold is the face (the attrs word), not the colour');
    ok(s.fg[row + 2] === DEFAULT_FG && s.fg[row + 3] === pack(10, 20, 30) && s.fg[row + 4] === pal(4) && s.fg[row + 5] === pal(100) && s.fg[row + 6] === pal(9),
        'off: the default colour, a true colour and palette colours are all unchanged by bold');
    let dirtied = 0;
    emu._onDirty = () => { dirtied++; };
    emu.dirty = false;
    emu.setBoldIsBright(true);
    ok(emu.dirty && dirtied === 1 && emu.boldIsBright, 'turning it on marks the screen dirty (the next frame redraws)');
    s = emu.readScreen(40, 4);
    ok(s.fg[row] === pal(1) && s.fg[row + 1] === pal(9), 'on: bold red draws in bright red; plain red stays red');
    ok(s.fg[row + 4] === pal(12), 'on: a 256-colour index below 8 takes its bright twin too');
    ok(s.fg[row + 2] === DEFAULT_FG && s.fg[row + 3] === pack(10, 20, 30) && s.fg[row + 5] === pal(100) && s.fg[row + 6] === pal(9),
        'on: the default colour, true colours, other palette colours and already-bright ones are unchanged');
    ok(s.at[row + 7] === (A.CELL_BOLD | A.CELL_INVERSE) && (s.bg[row + 7] & 0xffffff) === pal(10), 'on: under inverse the bright colour is the cell\'s fill');
    emu.setBoldIsBright(true);
    eq(dirtied, 1, 'setting it to what it is does nothing');
    emu.setBoldIsBright(false);
    s = emu.readScreen(40, 4);
    ok(s.fg[row + 1] === pal(1) && dirtied === 2, 'and off again: red');
    emu.dispose();
}

console.log(`\nfont-faces: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
