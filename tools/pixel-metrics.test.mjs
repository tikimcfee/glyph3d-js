/**
 * pixel-metrics.test.mjs — Headless unit & teeth test for tools/lib/pixel-metrics.mjs.
 *
 * Proves the four pixel-exactness metrics have teeth on synthetic PNG fixtures:
 *   1. Crisp integer-aligned 13 px text (1.00x scale, 0.0 px offset) -> PASSES all gates.
 *   2. Half-pixel shifted text (+0.5 px X/Y offset) -> FAILS edge crispness gate (2-px ramps).
 *   3. Scaled 1.03x text (13.39 px row pitch, 1.03x advance) -> FAILS rowPitch + scale gates.
 *   4. Unstill frame pair (sub-pixel drift / glyph change) -> FAILS stillness gate.
 *   5. Blank-vs-blank pair (0 changed pixels, no ink) -> FAILS as vacuous (never passes).
 *
 * Run:
 *   bun tools/pixel-metrics.test.mjs
 */

import {
    encodePng,
    decodePng,
    cropImage,
    parseCropSpec,
    computeInkMap,
    measureRowPitch,
    measureEdgeCrispness,
    measureStillness,
    measureGlyphScale,
    loadAtlasReferenceMetrics,
    evaluatePixelGates,
    renderSyntheticTextPng,
} from './lib/pixel-metrics.mjs';

let passed = 0;
let failed = 0;

/**
 * @param {boolean} cond
 * @param {string} msg
 */
function assert(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        console.error(`  ✗ FAIL: ${msg}`);
    }
}

console.log('── pixel-metrics.test.mjs ──');

// 1. Runtime atlas metrics derived from HarfBuzz FontChain (no hardcoded font sizes)
const atlas = await loadAtlasReferenceMetrics();
assert(atlas.upem === 2048, `atlas upem === 2048 (got ${atlas.upem})`);
assert(atlas.charSize.width > 0 && atlas.charSize.height > 0, `deriveCharSize positive (${JSON.stringify(atlas.charSize)})`);
assert(
    Math.abs(atlas.shaperAdvanceToPitch - (atlas.mAdvanceUnits / atlas.upem) / 1.15) < 1e-9,
    'shaperAdvanceToPitch matches LayoutGenerator formula'
);
const expectedAdv13 = atlas.advanceAtRowPitch(13, 'shaper');
assert(expectedAdv13 > 6.5 && expectedAdv13 < 7.1, `13 px shaper advance in expected range (got ${expectedAdv13.toFixed(4)} px)`);

// 2. PNG encode/decode round-trip and crop validation
const baseAdv = 7;
const crispImg = renderSyntheticTextPng({
    width: 320,
    height: 200,
    rowPitchPx: 13,
    advancePx: baseAdv,
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
});
const reDecoded = decodePng(encodePng(crispImg));
assert(reDecoded.width === 320 && reDecoded.height === 200, 'PNG round-trip preserves dimensions');
const subCrop = cropImage(reDecoded, parseCropSpec('10,10,280,170'));
assert(subCrop.width === 280 && subCrop.height === 170, 'cropImage extracts requested dimensions');
let cropThrew = false;
try {
    cropImage(reDecoded, { x: 200, y: 10, w: 200, h: 50 });
} catch {
    cropThrew = true;
}
assert(cropThrew, 'cropImage throws on out-of-bounds rectangle');

// 3. Fixture 1: Crisp integer-snapped 13 px text -> must PASS all gates
{
    const inkMap = computeInkMap(crispImg);
    const rowPitch = measureRowPitch(crispImg, { inkMap });
    const crispness = measureEdgeCrispness(crispImg, { inkMap });
    const scale = measureGlyphScale(crispImg, {
        inkMap,
        rowPitch,
        expectedAdvancePx: baseAdv,
        atlasMetrics: atlas,
    });
    const stillness = measureStillness(crispImg, reDecoded, { inkMapA: inkMap, inkMapB: inkMap });
    const gate = evaluatePixelGates({ rowPitch, crispness, scale, stillness }, { expectedRowPitchPx: 13 });

    console.log(
        `  [fixture:crisp] pitch=${rowPitch.pitchPx}px (snapErr=${rowPitch.integerSnapErrorPx}px) ` +
        `rampMed=${crispness.rampWidthMedianPx}px 2pxShare=${crispness.twoPxRampShare} ` +
        `adv=${scale.measuredAdvancePx}px (${scale.scaleRatio}x) still=${stillness.still}`
    );

    assert(!rowPitch.vacuous && rowPitch.rowCount === 12, `crisp detects 12 rows (got ${rowPitch.rowCount})`);
    assert(rowPitch.pitchPx !== null && Math.abs(rowPitch.pitchPx - 13) < 0.02, `crisp rowPitch ~ 13.00 px (got ${rowPitch.pitchPx})`);
    assert(rowPitch.integerSnapErrorPx !== null && rowPitch.integerSnapErrorPx < 0.02, `crisp integerSnapError < 0.02 px (got ${rowPitch.integerSnapErrorPx})`);
    assert(crispness.rampWidthMedianPx === 1, `crisp median ramp width === 1.0 px (got ${crispness.rampWidthMedianPx})`);
    assert(crispness.twoPxRampShare === 0, `crisp twoPxRampShare === 0 (got ${crispness.twoPxRampShare})`);
    assert(crispness.midGrayInkShare === 0, `crisp midGrayInkShare === 0 (got ${crispness.midGrayInkShare})`);
    assert(scale.measuredAdvancePx !== null && Math.abs(scale.measuredAdvancePx - baseAdv) < 0.02, `crisp advance ~ 7.00 px (got ${scale.measuredAdvancePx})`);
    assert(scale.scaleRatio !== null && Math.abs(scale.scaleRatio - 1.0) < 0.003, `crisp scaleRatio ~ 1.000 (got ${scale.scaleRatio})`);
    assert(stillness.still && stillness.changedPixels === 0 && !stillness.vacuous, 'crisp stillness passes');
    assert(gate.passed, `crisp fixture passes all pixel gates (failures: ${gate.failures.join('; ')})`);
}

// 4. Fixture 2: Half-pixel shifted (+0.5 px X/Y) text -> must FAIL edge crispness gate
{
    const halfPxImg = renderSyntheticTextPng({
        width: 320,
        height: 200,
        rowPitchPx: 13,
        advancePx: baseAdv,
        scale: 1.0,
        offsetX: 0.5,
        offsetY: 0.5,
    });
    const inkMap = computeInkMap(halfPxImg);
    const rowPitch = measureRowPitch(halfPxImg, { inkMap });
    const crispness = measureEdgeCrispness(halfPxImg, { inkMap });
    const scale = measureGlyphScale(halfPxImg, {
        inkMap,
        rowPitch,
        expectedAdvancePx: baseAdv,
        atlasMetrics: atlas,
    });
    const gate = evaluatePixelGates({ rowPitch, crispness, scale }, { expectedRowPitchPx: 13 });

    console.log(
        `  [fixture:half-px] pitch=${rowPitch.pitchPx}px rampMed=${crispness.rampWidthMedianPx}px ` +
        `2pxShare=${crispness.twoPxRampShare} midGray=${crispness.midGrayInkShare} ` +
        `adv=${scale.measuredAdvancePx}px → failures=${gate.failures.length}`
    );

    assert(rowPitch.pitchPx !== null && Math.abs(rowPitch.pitchPx - 13) < 0.02, `half-px preserves 13 px pitch (got ${rowPitch.pitchPx})`);
    assert(scale.scaleRatio !== null && Math.abs(scale.scaleRatio - 1.0) < 0.005, `half-px preserves 1.0x scale (got ${scale.scaleRatio})`);
    assert(crispness.rampWidthMedianPx !== null && crispness.rampWidthMedianPx >= 1.8, `half-px rampWidthMedianPx >= 1.8 px (got ${crispness.rampWidthMedianPx})`);
    assert(crispness.twoPxRampShare !== null && crispness.twoPxRampShare >= 0.90, `half-px twoPxRampShare >= 90% (got ${crispness.twoPxRampShare})`);
    assert(crispness.midGrayInkShare >= 0.70, `half-px midGrayInkShare >= 70% (got ${crispness.midGrayInkShare})`);
    assert(!gate.passed && gate.failures.some((f) => f.startsWith('crispness:')), 'half-px fixture fails crispness gate');
}

// 5. Fixture 3: Scaled 1.03x text -> must FAIL rowPitch and scale gates
{
    const scaledImg = renderSyntheticTextPng({
        width: 320,
        height: 200,
        rowPitchPx: 13,
        advancePx: baseAdv,
        scale: 1.03,
        offsetX: 0,
        offsetY: 0,
    });
    const inkMap = computeInkMap(scaledImg);
    const rowPitch = measureRowPitch(scaledImg, { inkMap });
    const crispness = measureEdgeCrispness(scaledImg, { inkMap });
    const scale = measureGlyphScale(scaledImg, {
        inkMap,
        rowPitch,
        expectedAdvancePx: baseAdv,
        atlasMetrics: atlas,
    });
    const gate = evaluatePixelGates({ rowPitch, crispness, scale }, { expectedRowPitchPx: 13 });

    console.log(
        `  [fixture:scaled-1.03x] pitch=${rowPitch.pitchPx}px (snapErr=${rowPitch.integerSnapErrorPx}px) ` +
        `adv=${scale.measuredAdvancePx}px (${scale.scaleRatio}x, +${scale.scaleErrorPct}%) → failures=${gate.failures.length}`
    );

    assert(rowPitch.pitchPx !== null && Math.abs(rowPitch.pitchPx - 13.39) < 0.03, `1.03x pitch ~ 13.39 px (got ${rowPitch.pitchPx})`);
    assert(rowPitch.integerSnapErrorPx !== null && rowPitch.integerSnapErrorPx > 0.35, `1.03x integerSnapError > 0.35 px (got ${rowPitch.integerSnapErrorPx})`);
    assert(scale.scaleRatio !== null && Math.abs(scale.scaleRatio - 1.03) < 0.005, `1.03x scaleRatio ~ 1.030 (got ${scale.scaleRatio})`);
    assert(!gate.passed, '1.03x fixture fails pixel gates');
    assert(gate.failures.some((f) => f.startsWith('rowPitch:')), '1.03x fixture trips rowPitch gate');
    assert(gate.failures.some((f) => f.startsWith('scale:')), '1.03x fixture trips scale gate');
}

// 6. Fixture 4: Unstill frame pair -> must FAIL stillness gate
{
    const shifted1Px = renderSyntheticTextPng({
        width: 320,
        height: 200,
        rowPitchPx: 13,
        advancePx: baseAdv,
        scale: 1.0,
        offsetX: 0.25,
        offsetY: 0,
    });
    const inkMap = computeInkMap(crispImg);
    const rowPitch = measureRowPitch(crispImg, { inkMap });
    const crispness = measureEdgeCrispness(crispImg, { inkMap });
    const scale = measureGlyphScale(crispImg, { inkMap, rowPitch, expectedAdvancePx: baseAdv, atlasMetrics: atlas });
    const stillness = measureStillness(crispImg, shifted1Px);
    const gate = evaluatePixelGates({ rowPitch, crispness, scale, stillness }, { expectedRowPitchPx: 13 });

    console.log(`  [fixture:unstill] changedPixels=${stillness.changedPixels} maxDiff=${stillness.maxDiff} still=${stillness.still}`);

    assert(!stillness.still && stillness.changedPixels > 100, `unstill pair detects changed pixels (${stillness.changedPixels})`);
    assert(!gate.passed && gate.failures.some((f) => f.startsWith('stillness:')), 'unstill pair trips stillness gate');
}

// 7. Fixture 5: Blank-vs-blank -> must FAIL as VACUOUS (0 changed pixels on blank canvas is NOT a pass)
{
    const blankA = decodePng(encodePng({ width: 160, height: 100, data: new Uint8Array(160 * 100 * 4).fill(20) }));
    const blankB = decodePng(encodePng({ width: 160, height: 100, data: new Uint8Array(160 * 100 * 4).fill(20) }));
    const inkMap = computeInkMap(blankA);
    const rowPitch = measureRowPitch(blankA, { inkMap });
    const crispness = measureEdgeCrispness(blankA, { inkMap });
    const scale = measureGlyphScale(blankA, { inkMap, rowPitch, expectedAdvancePx: baseAdv, atlasMetrics: atlas });
    const stillness = measureStillness(blankA, blankB);
    const gate = evaluatePixelGates({ rowPitch, crispness, scale, stillness }, { expectedRowPitchPx: 13 });

    console.log(
        `  [fixture:blank-vacuous] changedPixels=${stillness.changedPixels} vacuous=${stillness.vacuous} ` +
        `still=${stillness.still} → failures=${gate.failures.length}`
    );

    assert(stillness.changedPixels === 0, 'blank-vs-blank has 0 changed pixels');
    assert(stillness.vacuous === true && stillness.still === false, 'blank-vs-blank is flagged vacuous and NOT still');
    assert(rowPitch.vacuous && crispness.vacuous && scale.vacuous, 'blank image is flagged vacuous across all metrics');
    assert(!gate.passed && gate.failures.length === 4, `blank-vs-blank fails all 4 gates as vacuous (got ${gate.failures.length})`);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} (${passed} assertions passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
