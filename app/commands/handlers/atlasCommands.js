/**
 * Atlas commands: atlas.info, atlas.encode
 *
 * Drive the live, growable Slug curve atlas (LiveSlugAtlas, stashed on
 * atlas._live). The renderer draws glyphs from curve/glyph-map textures that are
 * encoded on demand; these commands inspect and force-grow that encoded set so a
 * codepoint range renders without waiting for a grid to first encounter it.
 *
 * `atlas.encode` is the manual lever used to verify the live re-encode + GPU
 * texture growth + field hot-swap pipeline end to end; grids also call the same
 * LiveSlugAtlas path automatically as content arrives.
 */

import { box, kvLines } from '../formatResponse.js';

/** Parse a codepoint token: hex by default ("2500"), or "U+2500"/"0x2500". */
function parseCodepoint(tok) {
    if (tok == null) return NaN;
    const s = String(tok).trim().replace(/^(U\+|0x)/i, '');
    return parseInt(s, 16);
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerAtlasCommands(router) {

    // ================================================================
    //  atlas.info
    // ================================================================
    router.register('atlas.info', (args, ctx) => {
        const atlas = ctx.atlas;
        const live = atlas && atlas._live;
        if (!live) {
            return { text: box('ATLAS', ['(live slug atlas not ready)'], 50) + '\nERR: no atlas._live', data: null };
        }
        const sd = live.slugData;
        const chain = atlas._shaper;
        const info = {
            encodedGlyphs: live.size,
            version: live.version,
            fonts: chain && chain.fontCount != null ? chain.fontCount : '(single?)',
            slots: chain && chain.slotCount != null ? chain.slotCount : '-',
            curveTexture: sd?.curveTexture
                ? `${sd.curveTexture.image.width}x${sd.curveTexture.image.height}`
                : '(none)',
            glyphMapTexture: sd?.glyphMapTexture
                ? `${sd.glyphMapTexture.image.width}x${sd.glyphMapTexture.image.height}`
                : '(none)',
        };
        // Per-font coverage detail (reaches into chain internals — diagnostic only).
        const lines = kvLines(info);
        if (chain && Array.isArray(chain._fonts)) {
            for (let i = 0; i < chain._fonts.length; i++) {
                const f = chain._fonts[i];
                lines.push(`[${i}] ${f.name}: ${f.coverage.size} cps`);
            }
        }
        return {
            text: box('ATLAS', lines, 50) + `\nOK: ${live.size} glyphs encoded (v${live.version})`,
            data: info,
        };
    }, {
        description: 'Show live Slug atlas state (encoded glyph count, version, texture sizes)',
        usage: '',
    });

    // ================================================================
    //  atlas.encode <lo> [hi]
    //  Codepoints are hex ("2500"), "U+2500", or "0x2500". With one arg,
    //  encodes a single codepoint; with two, the inclusive range [lo, hi].
    // ================================================================
    router.register('atlas.encode', (args, ctx) => {
        const atlas = ctx.atlas;
        const live = atlas && atlas._live;
        const shapeCache = atlas && atlas._shapeCache;
        if (!live || !shapeCache) {
            return { text: 'ERR: live slug atlas not ready (need atlas._live + atlas._shapeCache)', data: null };
        }

        const lo = parseCodepoint(args[0]);
        const hi = args[1] != null ? parseCodepoint(args[1]) : lo;
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) {
            return { text: 'ERR: usage: atlas.encode <lo-hex> [hi-hex]  (e.g. atlas.encode 2500 257f)', data: null };
        }
        if (hi - lo > 0x4000) {
            return { text: `ERR: range too large (${hi - lo + 1} codepoints; cap 16384)`, data: null };
        }

        const cps = [];
        for (let cp = lo; cp <= hi; cp++) cps.push(cp);
        const result = live.ensureCodepoints(cps, shapeCache);

        const summary = {
            requested: cps.length,
            range: `U+${lo.toString(16).toUpperCase()}..U+${hi.toString(16).toUpperCase()}`,
            added: result.added,
            grew: result.grew,
            totalEncoded: result.total,
            version: live.version,
        };
        return {
            text: box('ATLAS.ENCODE', kvLines(summary), 50) +
                `\nOK: +${result.added} glyphs (${result.total} total, v${live.version})`,
            data: summary,
        };
    }, {
        description: 'Encode a codepoint range into the live Slug atlas and hot-swap all fields',
        usage: '<lo-hex> [hi-hex]',
    });

    // ================================================================
    //  atlas.probe <cp>
    //  Trace how a single codepoint routes through the font chain.
    // ================================================================
    router.register('atlas.probe', (args, ctx) => {
        const atlas = ctx.atlas;
        const chain = atlas && atlas._shaper;
        const shapeCache = atlas && atlas._shapeCache;
        const cp = parseCodepoint(args[0]);
        if (!Number.isFinite(cp)) {
            return { text: 'ERR: usage: atlas.probe <cp-hex>  (e.g. atlas.probe 2736)', data: null };
        }
        const ch = String.fromCodePoint(cp);
        const out = { codepoint: `U+${cp.toString(16).toUpperCase()}`, char: ch };

        if (chain && typeof chain.routeCodepoint === 'function') {
            const fontIdx = chain.routeCodepoint(cp);
            out.routedToFont = fontIdx;
            out.fontName = (fontIdx >= 0 && chain._fonts && chain._fonts[fontIdx])
                ? chain._fonts[fontIdx].name : '(none — blank)';
        } else {
            out.routedToFont = '(no chain)';
        }
        if (shapeCache) {
            const entry = shapeCache.lookup(cp);
            out.slot = entry ? entry.g : '(no entry)';
            out.advance = entry ? entry.ax : '-';
        }
        return {
            text: box('ATLAS.PROBE', kvLines(out), 50) +
                `\nOK: U+${cp.toString(16).toUpperCase()} → font ${out.routedToFont} (${out.fontName || '?'}), slot ${out.slot}`,
            data: out,
        };
    }, {
        description: 'Trace how a codepoint routes through the font chain (font + slot)',
        usage: '<cp-hex>',
    });
}
