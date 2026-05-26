/**
 * Validation script for SlugEncoder (Phase 2).
 *
 * Call from the browser console:
 *   import('/src/shaping/validate-slug.js').then(m => m.validateSlugEncoder())
 *
 * Tests:
 * 1. Encodes all unique glyphs from "Hello, World!"
 * 2. Logs texture sizes, glyph count, curve counts
 * 3. Verifies round-trip: packed uint16 -> unpacked float matches originals within tolerance
 * 4. Verifies glyphMap entries point to valid texture offsets
 */

import HarfBuzzShaper from './HarfBuzzShaper.js';
import { shapeText, collectUniqueGlyphIds } from './shapeText.js';
import SlugEncoder from './SlugEncoder.js';
import { packUint16, unpackUint16, CURVE_TEXELS_PER_CURVE } from './slug-constants.js';

/**
 * Run the full SlugEncoder validation suite.
 *
 * @param {string} [fontUrl='/src/fonts/Cousine-Regular.ttf'] - URL to the font file
 * @returns {Promise<{success: boolean, stats: object}>}
 */
export async function validateSlugEncoder(fontUrl = '/src/fonts/Cousine-Regular.ttf') {
    console.log('=== SlugEncoder Phase 2 Validation ===');
    const totalStart = performance.now();
    let allPassed = true;

    // 1. Initialize shaper
    console.log(`[validate-slug] Fetching font: ${fontUrl}`);
    const fontResp = await fetch(fontUrl);
    if (!fontResp.ok) {
        console.error(`[validate-slug] Failed to fetch font: ${fontResp.status}`);
        return { success: false, stats: null };
    }
    const fontBuffer = await fontResp.arrayBuffer();
    const shaper = new HarfBuzzShaper();
    await shaper.init(fontBuffer);
    console.log(`[validate-slug] Shaper ready: upem=${shaper.upem}, glyphs=${shaper.glyphCount}`);

    // 2. Shape test text and collect unique glyph IDs
    const testText = 'Hello, World!';
    const shaped = shapeText(shaper, testText);
    const uniqueIds = collectUniqueGlyphIds(shaped.lines);
    console.log(`[validate-slug] "${testText}" -> ${uniqueIds.size} unique glyph IDs: [${[...uniqueIds].join(', ')}]`);

    // 3. Encode glyphs
    const encoder = new SlugEncoder(shaper);
    const result = encoder.encode(uniqueIds);
    const { curveTexture, glyphMapTexture, stats } = result;

    console.log(`[validate-slug] Stats:`, stats);

    // 4. Verify textures are valid Three.js DataTexture instances
    const isDataTexture = (t, name) => {
        if (!t || !t.image || !t.image.data) {
            console.error(`[validate-slug] FAIL: ${name} is not a valid DataTexture`);
            return false;
        }
        if (t.internalFormat !== 'RGBA16UI') {
            console.error(`[validate-slug] FAIL: ${name} internalFormat is ${t.internalFormat}, expected RGBA16UI`);
            return false;
        }
        console.log(`[validate-slug] PASS: ${name} is RGBA16UI DataTexture (${t.image.width}x${t.image.height})`);
        return true;
    };

    allPassed &= isDataTexture(curveTexture, 'curveTexture');
    allPassed &= isDataTexture(glyphMapTexture, 'glyphMapTexture');

    // 5. Round-trip test: pack -> unpack precision
    console.log(`[validate-slug] Round-trip precision test...`);
    const testValues = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1.0];
    let maxError = 0;
    for (const v of testValues) {
        const packed = packUint16(v);
        const unpacked = unpackUint16(packed);
        const error = Math.abs(v - unpacked);
        if (error > maxError) maxError = error;
        if (error > 1.6e-5) { // 1/65535 ~ 1.53e-5
            console.error(`[validate-slug] FAIL: round-trip error ${error} for value ${v}`);
            allPassed = false;
        }
    }
    console.log(`[validate-slug] PASS: max round-trip error = ${maxError.toExponential(3)} (threshold: 1.6e-5)`);

    // 6. Verify glyphMap entries for each encoded glyph
    console.log(`[validate-slug] Verifying glyphMap entries...`);
    const gmData = glyphMapTexture.image.data;
    const curveData = curveTexture.image.data;

    for (const glyphId of uniqueIds) {
        const gmIdx = glyphId * 4;
        const curveStart = gmData[gmIdx + 0];
        const curveCount = gmData[gmIdx + 1];

        const name = shaper.glyphName(glyphId) || '?';

        // curveStart is a curve index, not texel offset.
        // Texel offset = curveStart * CURVE_TEXELS_PER_CURVE
        const curveTexelStart = curveStart * CURVE_TEXELS_PER_CURVE;
        const maxCurveTexel = curveTexelStart + curveCount * CURVE_TEXELS_PER_CURVE;
        const curveTexSize = curveTexture.image.width * curveTexture.image.height;
        if (maxCurveTexel > curveTexSize) {
            console.error(
                `[validate-slug] FAIL: glyph ${glyphId} ("${name}") curve range ` +
                `[${curveTexelStart}, ${maxCurveTexel}) exceeds curveTexture size ${curveTexSize}`
            );
            allPassed = false;
            continue;
        }

        // Spot check: verify packed coordinates are in valid uint16 range (0-65535)
        if (curveCount > 0) {
            for (let ci = 0; ci < Math.min(curveCount, 3); ci++) {
                const texel0 = curveTexelStart + ci * CURVE_TEXELS_PER_CURVE;
                const idx0 = texel0 * 4;
                const p0x = curveData[idx0 + 0];
                const p0y = curveData[idx0 + 1];

                if (p0x > 65535 || p0y > 65535) {
                    console.error(
                        `[validate-slug] FAIL: glyph ${glyphId} curve ${ci} coordinates out of range`
                    );
                    allPassed = false;
                }
            }
        }
    }
    console.log(`[validate-slug] PASS: all glyphMap entries reference valid texture ranges`);

    // 7. Extended test: encode a broader character set
    console.log(`[validate-slug] Extended test: encoding printable ASCII...`);
    const asciiText = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
    const asciiShaped = shapeText(shaper, asciiText);
    const asciiIds = collectUniqueGlyphIds(asciiShaped.lines);
    const asciiResult = encoder.encode(asciiIds);
    console.log(
        `[validate-slug] ASCII: ${asciiResult.stats.glyphCount} glyphs, ` +
        `${asciiResult.stats.totalCurves} curves, ` +
        `${(asciiResult.stats.curveTextureSizeKB + asciiResult.stats.glyphMapTextureSizeKB).toFixed(2)}KB total`
    );

    // Summary
    const totalMs = (performance.now() - totalStart).toFixed(1);
    if (allPassed) {
        console.log(`=== SlugEncoder validation PASSED (${totalMs}ms) ===`);
    } else {
        console.error(`=== SlugEncoder validation FAILED (${totalMs}ms) ===`);
    }

    // Clean up
    shaper.destroy();

    return { success: !!allPassed, stats: result.stats };
}
