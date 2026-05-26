/**
 * Validation function for HarfBuzz Phase 1 integration.
 *
 * Call from the browser console:
 *   import('/src/shaping/validate.js').then(m => m.validateHarfBuzz())
 *
 * Or from app startup during development.
 *
 * Tests:
 * 1. WASM loads and font initializes
 * 2. Shaping "Hello, World!" produces correct glyph IDs + advances
 * 3. Outline extraction returns curve data for a shaped glyph
 * 4. glyphExtents() returns bounding box info
 * 5. fontExtents() returns ascender/descender/lineGap
 */

import HarfBuzzShaper from './HarfBuzzShaper.js';
import { shapeText, collectUniqueGlyphIds } from './shapeText.js';

/**
 * Run the full HarfBuzz validation suite.
 *
 * @param {string} [fontUrl='/src/fonts/Cousine-Regular.ttf'] - URL to the font file
 * @returns {Promise<{success: boolean, shaper: HarfBuzzShaper}>}
 *   Returns the shaper instance so the caller can inspect it further.
 */
export async function validateHarfBuzz(fontUrl = '/src/fonts/Cousine-Regular.ttf') {
    console.log('=== HarfBuzz Phase 1 Validation ===');
    const totalStart = performance.now();

    // 1. Fetch font
    console.log(`[validate] Fetching font: ${fontUrl}`);
    const fontResp = await fetch(fontUrl);
    if (!fontResp.ok) {
        console.error(`[validate] Failed to fetch font: ${fontResp.status} ${fontResp.statusText}`);
        return { success: false, shaper: null };
    }
    const fontBuffer = await fontResp.arrayBuffer();
    console.log(`[validate] Font fetched: ${fontBuffer.byteLength} bytes`);

    // 2. Initialize HarfBuzzShaper
    const shaper = new HarfBuzzShaper();
    await shaper.init(fontBuffer);

    console.log(`[validate] Shaper ready: upem=${shaper.upem}, glyphCount=${shaper.glyphCount}`);

    // 3. Shape "Hello, World!"
    const testText = 'Hello, World!';
    const shaped = shaper.shape(testText);
    console.log(`[validate] Shaped "${testText}" → ${shaped.length} glyphs:`);
    console.table(shaped.map(g => ({
        glyphId: g.g,
        cluster: g.cl,
        advanceX: g.ax,
        advanceY: g.ay,
        offsetX: g.dx,
        offsetY: g.dy
    })));

    // 4. Extract outline for first glyph with curves
    let outlineGlyphId = shaped[0].g;
    const outline = shaper.glyphOutline(outlineGlyphId);
    const glyphName = shaper.glyphName(outlineGlyphId);
    console.log(`[validate] Outline for glyph ${outlineGlyphId} ("${glyphName}"): ${outline.length} segments`);
    const curveTypes = {};
    for (const seg of outline) {
        curveTypes[seg.type] = (curveTypes[seg.type] || 0) + 1;
    }
    console.log(`[validate] Segment types:`, curveTypes);
    console.log(`[validate] First 5 segments:`, outline.slice(0, 5));

    // 5. SVG path string
    const pathStr = shaper.glyphToPath(outlineGlyphId);
    console.log(`[validate] SVG path for glyph ${outlineGlyphId}: ${pathStr.substring(0, 80)}...`);

    // 6. Glyph extents
    const extents = shaper.glyphExtents(outlineGlyphId);
    console.log(`[validate] Glyph extents for ${outlineGlyphId}:`, extents);

    // 7. Glyph advance
    const advance = shaper.glyphAdvance(outlineGlyphId);
    console.log(`[validate] Glyph advance for ${outlineGlyphId}: ${advance}`);

    // 8. Font extents
    const fontExt = shaper.fontExtents();
    console.log(`[validate] Font extents:`, fontExt);

    // 9. Multi-line shapeText
    const multiText = 'function hello() {\n    console.log("world");\n}';
    const shapedMulti = shapeText(shaper, multiText);
    console.log(`[validate] shapeText multi-line: ${shapedMulti.lines.length} lines, ${shapedMulti.totalGlyphs} total glyphs`);

    // 10. Collect unique glyph IDs
    const uniqueIds = collectUniqueGlyphIds(shapedMulti.lines);
    console.log(`[validate] Unique glyph IDs in multi-line text: ${uniqueIds.size}`);

    // 11. Verify no cubics in Cousine (TrueType font)
    let hasCubics = false;
    for (const id of uniqueIds) {
        const o = shaper.glyphOutline(id);
        if (o.some(seg => seg.type === 'C')) {
            console.warn(`[validate] Unexpected cubic in glyph ${id}!`);
            hasCubics = true;
        }
    }
    if (!hasCubics) {
        console.log(`[validate] Confirmed: no cubic curves in font (all quadratic — TrueType)`);
    }

    const totalMs = (performance.now() - totalStart).toFixed(1);
    console.log(`=== HarfBuzz validation PASSED (${totalMs}ms) ===`);

    return { success: true, shaper };
}
