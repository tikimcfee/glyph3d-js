/**
 * pixel-check.mjs — CLI driver for pixel-exactness analysis over PNG screenshots or the live display.
 *
 * Measures the four felt properties required for orthographic plane carrels (1 world unit = 1 px):
 *   (a) text row pitch in device px (projection profiles of ink rows),
 *   (b) edge crispness — stem transition width in px (half-pixel blur -> 2-px ramps),
 *   (c) stillness — exact frame-to-frame difference between two captures N ms apart,
 *   (d) scale — ratio of measured glyph advance to runtime atlas advance.
 *
 * Modes:
 *   bun tools/pixel-check.mjs --self-test [--out-dir /tmp/pixel-fixtures]
 *   bun tools/pixel-check.mjs --live [--port 8080] [--interval-ms 250] [--crop x,y,w,h]
 *                             [--expected-pitch 13] [--expected-advance N] [--gate] [--json]
 *   bun tools/pixel-check.mjs <shot.png> [--second <shot2.png>] [--crop x,y,w,h]
 *                             [--expected-pitch 13] [--expected-advance N] [--gate] [--json]
 */

import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    readPng,
    writePng,
    cropImage,
    parseCropSpec,
    computeInkMap,
    measureRowPitch,
    measureEdgeCrispness,
    measureStillness,
    measureGlyphScale,
    findTextRegions,
    loadAtlasReferenceMetrics,
    evaluatePixelGates,
    renderSyntheticTextPng,
} from './lib/pixel-metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT, 'glyph3d-cli');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const out = {
        selfTest: false,
        live: false,
        port: 8080,
        intervalMs: 250,
        shotA: /** @type {string | null} */ (null),
        shotB: /** @type {string | null} */ (null),
        crops: /** @type {string[]} */ ([]),
        expectedPitch: /** @type {number | null} */ (13),
        expectedAdvance: /** @type {number | undefined} */ (undefined),
        advanceMode: /** @type {'shaper' | 'cell'} */ ('shaper'),
        outDir: /** @type {string | null} */ (null),
        gate: false,
        json: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--self-test') out.selfTest = true;
        else if (a === '--live') out.live = true;
        else if (a === '--port') out.port = Number(argv[++i]);
        else if (a === '--interval-ms') out.intervalMs = Number(argv[++i]);
        else if (a === '--second' || a === '-2') out.shotB = argv[++i];
        else if (a === '--crop') out.crops.push(argv[++i]);
        else if (a === '--expected-pitch') {
            const v = argv[++i];
            out.expectedPitch = v === 'none' ? null : Number(v);
        } else if (a === '--expected-advance') out.expectedAdvance = Number(argv[++i]);
        else if (a === '--advance-mode') out.advanceMode = /** @type {'shaper'|'cell'} */ (argv[++i]);
        else if (a === '--out-dir') out.outDir = argv[++i];
        else if (a === '--gate') out.gate = true;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (!a.startsWith('-') && !out.shotA) out.shotA = a;
        else if (!a.startsWith('-') && !out.shotB) out.shotB = a;
        else throw new Error(`Unknown flag: ${a}`);
    }
    return out;
}

/**
 * Capture a screenshot from the live display via ./glyph3d-cli screenshot (read-only).
 * @param {string} outPath
 * @param {number} port
 */
function captureLivePng(outPath, port) {
    const res = spawnSync(CLI_BIN, ['--port', String(port), 'screenshot', '-o', outPath], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 25000,
    });
    if (res.status !== 0) {
        throw new Error(`glyph3d-cli screenshot failed (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
}

/**
 * Analyze one image (or region crop) and optional second frame.
 * @param {import('./lib/pixel-metrics.mjs').RgbaImage} imgA
 * @param {import('./lib/pixel-metrics.mjs').RgbaImage | null} imgB
 * @param {import('./lib/pixel-metrics.mjs').AtlasReferenceMetrics} atlas
 * @param {{
 *   label: string,
 *   expectedPitch: number | null,
 *   expectedAdvance?: number,
 *   advanceMode?: 'shaper' | 'cell'
 * }} opts
 */
function analyzeRegion(imgA, imgB, atlas, opts) {
    const inkMap = computeInkMap(imgA);
    const rowPitch = measureRowPitch(imgA, { inkMap });
    const crispness = measureEdgeCrispness(imgA, { inkMap });
    const scale = measureGlyphScale(imgA, {
        inkMap,
        rowPitch,
        atlasMetrics: atlas,
        expectedAdvancePx: opts.expectedAdvance,
        targetRowPitchPx: opts.expectedPitch ?? rowPitch.pitchPx ?? 13,
        advanceMode: opts.advanceMode ?? 'shaper',
    });
    const stillness = imgB ? measureStillness(imgA, imgB, { inkMapA: inkMap }) : null;
    const gate = evaluatePixelGates(
        { rowPitch, crispness, scale, stillness },
        { expectedRowPitchPx: opts.expectedPitch }
    );
    return {
        label: opts.label,
        dimensions: { width: imgA.width, height: imgA.height, crop: imgA.crop ?? null },
        ink: {
            bg: inkMap.bg,
            inkPixels: inkMap.inkPixels,
            inkCoverage: inkMap.inkCoverage,
            maxContrast: inkMap.maxContrast,
            p95Ink: inkMap.p95Ink,
            vacuous: inkMap.vacuous,
        },
        rowPitch: {
            pitchPx: rowPitch.pitchPx,
            medianDiffPx: rowPitch.medianDiffPx,
            stdDiffPx: rowPitch.stdDiffPx,
            autocorrPitchPx: rowPitch.autocorrPitchPx,
            autocorrStrength: rowPitch.autocorrStrength,
            integerSnapErrorPx: rowPitch.integerSnapErrorPx,
            nearestIntegerPx: rowPitch.nearestIntegerPx,
            rowCount: rowPitch.rowCount,
            medianBandHeightPx: rowPitch.medianBandHeightPx,
            vacuous: rowPitch.vacuous,
        },
        crispness,
        scale,
        stillness,
        gate,
    };
}

/**
 * Print a concise human-readable summary of a region analysis.
 * @param {ReturnType<typeof analyzeRegion>} r
 */
function printRegionReport(r) {
    const status = r.gate.passed ? '✓ PASS' : '✗ FAIL';
    const cropStr = r.dimensions.crop
        ? ` crop=(${r.dimensions.crop.x},${r.dimensions.crop.y},${r.dimensions.crop.w},${r.dimensions.crop.h})`
        : ` (${r.dimensions.width}x${r.dimensions.height})`;
    console.log(`\n== ${r.label}${cropStr} [${status}]`);
    console.log(
        `  (a) rowPitch:  pitch=${r.rowPitch.pitchPx ?? 'n/a'} px ` +
        `(medianDiff=${r.rowPitch.medianDiffPx ?? 'n/a'}, std=${r.rowPitch.stdDiffPx ?? 'n/a'}, ` +
        `autocorr=${r.rowPitch.autocorrPitchPx ?? 'n/a'} @ ${r.rowPitch.autocorrStrength}) ` +
        `snapErr=${r.rowPitch.integerSnapErrorPx ?? 'n/a'} px · rows=${r.rowPitch.rowCount}`
    );
    console.log(
        `  (b) crispness: medianRamp=${r.crispness.rampWidthMedianPx ?? 'n/a'} px ` +
        `(vStem=${r.crispness.verticalStemRampPx ?? 'n/a'} px, hStem=${r.crispness.horizontalStemRampPx ?? 'n/a'} px) ` +
        `>=2pxRampShare=${r.crispness.twoPxRampShare !== null ? (r.crispness.twoPxRampShare * 100).toFixed(1) + '%' : 'n/a'} ` +
        `midGrayShare=${(r.crispness.midGrayInkShare * 100).toFixed(1)}% · edges=${r.crispness.edgeCount}`
    );
    if (r.stillness) {
        console.log(
            `  (c) stillness: changed=${r.stillness.changedPixels}/${r.stillness.totalPixels} px ` +
            `(${(r.stillness.changedRatio * 100).toFixed(4)}%) ` +
            `aboveTol(${r.stillness.tolerance})=${r.stillness.changedAboveTol} px ` +
            `maxDiff=${r.stillness.maxDiff}/255 meanAbsDiff=${r.stillness.meanAbsDiff} ` +
            `still=${r.stillness.still}${r.stillness.vacuous ? ' (VACUOUS)' : ''}`
        );
    }
    console.log(
        `  (d) scale:     measuredAdv=${r.scale.measuredAdvancePx ?? 'n/a'} px ` +
        `(autocorr=${r.scale.autocorrAdvancePx ?? 'n/a'} px, blobMed=${r.scale.blobMedianAdvancePx ?? 'n/a'} px) ` +
        `expectedAdv=${r.scale.expectedAdvancePx ?? 'n/a'} px → ` +
        `ratio=${r.scale.scaleRatio !== null ? r.scale.scaleRatio + 'x' : 'n/a'} ` +
        `(${r.scale.scaleErrorPct !== null ? (r.scale.scaleErrorPct > 0 ? '+' : '') + r.scale.scaleErrorPct + '%' : 'n/a'}) · ` +
        `glyphs=${r.scale.glyphCount} across ${r.scale.rowsMeasured} rows`
    );
    for (const f of r.gate.failures) {
        console.log(`      ✗ ${f}`);
    }
}

/**
 * Run synthetic fixture teeth suite.
 * @param {import('./lib/pixel-metrics.mjs').AtlasReferenceMetrics} atlas
 * @param {string | null} outDir
 * @param {boolean} json
 */
function runSelfTest(atlas, outDir, json) {
    if (outDir) mkdirSync(outDir, { recursive: true });
    const baseAdv = 7;

    const crisp = renderSyntheticTextPng({ rowPitchPx: 13, advancePx: baseAdv, scale: 1.0, offsetX: 0, offsetY: 0 });
    const halfPx = renderSyntheticTextPng({ rowPitchPx: 13, advancePx: baseAdv, scale: 1.0, offsetX: 0.5, offsetY: 0.5 });
    const scaled = renderSyntheticTextPng({ rowPitchPx: 13, advancePx: baseAdv, scale: 1.03, offsetX: 0, offsetY: 0 });
    const drifted = renderSyntheticTextPng({ rowPitchPx: 13, advancePx: baseAdv, scale: 1.0, offsetX: 0.25, offsetY: 0 });
    const blank = { width: 160, height: 100, data: new Uint8Array(160 * 100 * 4).fill(20) };

    if (outDir) {
        writePng(join(outDir, 'crisp-13px.png'), crisp);
        writePng(join(outDir, 'half-px-shifted.png'), halfPx);
        writePng(join(outDir, 'scaled-1.03x.png'), scaled);
        writePng(join(outDir, 'drifted-frameB.png'), drifted);
        writePng(join(outDir, 'blank.png'), blank);
    }

    const cases = [
        {
            name: 'crisp-13px (expect PASS)',
            expectPass: true,
            report: analyzeRegion(crisp, crisp, atlas, { label: 'crisp-13px', expectedPitch: 13, expectedAdvance: baseAdv }),
        },
        {
            name: 'half-px-shifted (expect FAIL on crispness)',
            expectPass: false,
            report: analyzeRegion(halfPx, halfPx, atlas, { label: 'half-px-shifted', expectedPitch: 13, expectedAdvance: baseAdv }),
        },
        {
            name: 'scaled-1.03x (expect FAIL on rowPitch + scale)',
            expectPass: false,
            report: analyzeRegion(scaled, scaled, atlas, { label: 'scaled-1.03x', expectedPitch: 13, expectedAdvance: baseAdv }),
        },
        {
            name: 'unstill-pair (expect FAIL on stillness)',
            expectPass: false,
            report: analyzeRegion(crisp, drifted, atlas, { label: 'unstill-pair', expectedPitch: 13, expectedAdvance: baseAdv }),
        },
        {
            name: 'blank-vs-blank (expect FAIL as vacuous)',
            expectPass: false,
            report: analyzeRegion(blank, blank, atlas, { label: 'blank-vs-blank', expectedPitch: 13, expectedAdvance: baseAdv }),
        },
    ];

    let allTeethOk = true;
    for (const c of cases) {
        const ok = c.report.gate.passed === c.expectPass;
        if (!ok) allTeethOk = false;
        if (!json) {
            printRegionReport(c.report);
            console.log(`  → teeth check: ${ok ? '✓ behaved as expected' : '✗ UNEXPECTED gate outcome'}`);
        }
    }

    if (json) {
        console.log(JSON.stringify({ selfTestPassed: allTeethOk, cases }, null, 2));
    } else {
        console.log(`\nSelf-test teeth verdict: ${allTeethOk ? '✓ PASS (all 5 fixtures behaved as expected)' : '✗ FAIL'}`);
    }
    process.exit(allTeethOk ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.selfTest && !args.live && !args.shotA)) {
    console.log(
        'Usage:\n' +
        '  bun tools/pixel-check.mjs --self-test [--out-dir DIR]\n' +
        '  bun tools/pixel-check.mjs --live [--port 8080] [--interval-ms 250] [--crop x,y,w,h]… [--expected-pitch 13] [--gate] [--json]\n' +
        '  bun tools/pixel-check.mjs <shot.png> [--second <shot2.png>] [--crop x,y,w,h]… [--expected-pitch 13] [--gate] [--json]'
    );
    process.exit(args.help ? 0 : 2);
}

const atlas = await loadAtlasReferenceMetrics();
if (args.selfTest) {
    runSelfTest(atlas, args.outDir, args.json);
}

let shotAPath = args.shotA;
let shotBPath = args.shotB;

if (args.live) {
    const dir = args.outDir || '/tmp';
    mkdirSync(dir, { recursive: true });
    shotAPath = join(dir, 'pixel-check-live-a.png');
    shotBPath = join(dir, 'pixel-check-live-b.png');
    captureLivePng(shotAPath, args.port);
    await new Promise((r) => setTimeout(r, Math.max(0, args.intervalMs)));
    captureLivePng(shotBPath, args.port);
}

if (!shotAPath) throw new Error('No input PNG specified');
const imgA = readPng(shotAPath);
const imgB = shotBPath ? readPng(shotBPath) : null;

const fullStillness = imgB ? measureStillness(imgA, imgB) : null;
/** @type {ReturnType<typeof analyzeRegion>[]} */
const reports = [];

if (args.crops.length > 0) {
    for (const spec of args.crops) {
        const rect = parseCropSpec(spec);
        const subA = cropImage(imgA, rect);
        const subB = imgB ? cropImage(imgB, rect) : null;
        reports.push(
            analyzeRegion(subA, subB, atlas, {
                label: `crop ${spec}`,
                expectedPitch: args.expectedPitch,
                expectedAdvance: args.expectedAdvance,
                advanceMode: args.advanceMode,
            })
        );
    }
} else {
    // Analyze full image + top auto-detected text regions if it's a large canvas
    reports.push(
        analyzeRegion(imgA, imgB, atlas, {
            label: 'full-canvas',
            expectedPitch: args.expectedPitch,
            expectedAdvance: args.expectedAdvance,
            advanceMode: args.advanceMode,
        })
    );
    if (imgA.width >= 600 && imgA.height >= 400) {
        const detected = findTextRegions(imgA).slice(0, 3);
        for (const reg of detected) {
            if (reg.w === imgA.width && reg.h === imgA.height) continue;
            const subA = cropImage(imgA, reg);
            const subB = imgB ? cropImage(imgB, reg) : null;
            reports.push(
                analyzeRegion(subA, subB, atlas, {
                    label: `auto-region (${reg.x},${reg.y},${reg.w},${reg.h})`,
                    expectedPitch: args.expectedPitch,
                    expectedAdvance: args.expectedAdvance,
                    advanceMode: args.advanceMode,
                })
            );
        }
    }
}

if (args.json) {
    console.log(
        JSON.stringify(
            {
                shotA: shotAPath,
                shotB: shotBPath,
                atlas: {
                    fontSize: atlas.fontSize,
                    worldScale: atlas.worldScale,
                    charSize: atlas.charSize,
                    shaperAdvanceToPitch: +atlas.shaperAdvanceToPitch.toFixed(6),
                    cellAdvanceToPitch: +atlas.cellAdvanceToPitch.toFixed(6),
                    advanceAt13PxShaper: +atlas.advanceAtRowPitch(13, 'shaper').toFixed(4),
                    advanceAt13PxCell: +atlas.advanceAtRowPitch(13, 'cell').toFixed(4),
                },
                fullStillness,
                reports,
            },
            null,
            2
        )
    );
} else {
    console.log(
        `[atlas] Cousine upem=${atlas.upem} charSize=${atlas.charSize.width}x${atlas.charSize.height} ` +
        `shaperAdv/pitch=${atlas.shaperAdvanceToPitch.toFixed(4)} (at 13px → ${atlas.advanceAtRowPitch(13, 'shaper').toFixed(3)} px) ` +
        `cellAdv/pitch=${atlas.cellAdvanceToPitch.toFixed(4)} (at 13px → ${atlas.advanceAtRowPitch(13, 'cell').toFixed(3)} px)`
    );
    if (fullStillness) {
        console.log(
            `[canvas stillness] ${fullStillness.width}x${fullStillness.height}: ` +
            `changed=${fullStillness.changedPixels} px (${(fullStillness.changedRatio * 100).toFixed(4)}%), ` +
            `maxDiff=${fullStillness.maxDiff}/255, still=${fullStillness.still}`
        );
    }
    for (const r of reports) {
        printRegionReport(r);
    }
}

if (args.gate) {
    const anyFailed = reports.some((r) => !r.gate.passed) || (fullStillness !== null && !fullStillness.still);
    process.exit(anyFailed ? 1 : 0);
}
