/**
 * WandField.js — Multi-resolution semantic vector field
 *
 * Each z-layer is a grid of small wand-probes tiling the code area.
 * Rows consume consecutive lines (no gaps), and each row is filled
 * with as many probes as fit the code width — controlled by a density
 * multiplier the user can adjust via slider.
 *
 * PERFORMANCE: Each sheet shares ONE GlyphRenderer and ONE group ID.
 * All probes in a sheet render into a single instanced mesh — so the
 * entire field is just 3 draw calls regardless of probe count.
 * The sheet's z-depth is a group offset in the DataTexture, so
 * setLayerGap() moves all 3 layers with 3 texel writes (no buffer
 * rebuilds, no per-glyph updates).
 * Color updates still use direct per-glyph buffer writes via updateColor().
 * No THREE.Group per probe, no per-frame animation.  tick() is a no-op.
 *
 * Sheets stack behind the code, front-to-back, fine → coarse:
 *
 *   z=0   ── code text ──────────────────────────────────
 *   z=-2  ── sheet 0: 3-line context, auto-filled columns  ← fine
 *   z=-5  ── sheet 1: 15-line context, auto-filled columns  ← medium
 *   z=-8  ── sheet 2: full file, auto-filled columns         ← coarse
 *
 * Factory function, no classes:
 *   createWandField(scene, atlas, words, options?) → field
 *
 *   field.load({ code, analyzer, words, lineSpacing, codeWidth, totalLines })
 *   field.setDensity(d)    — adjust fill and rebuild (instant, no re-analysis)
 *   field.tick(dt)          — no-op (kept for API compat)
 *   field.setVisible(bool)
 *   field.dispose()
 */

import * as THREE from 'three';
import GlyphRenderer from '../../src/GlyphRenderer.js';
import { buildSphereLayout } from './Wand.js';
import { BLOCKS } from './taxonomy.js';
import { mergePicks } from './spectrometer.js';


// ─── Default sheet configs ──────────────────────────────────────────

const DEFAULT_SHEETS = [
    {
        name: 'fine',
        contextLines: 25,      // fewer rows → fewer probes
        wandRadius: 4,
        groupScale: 0.8,       // y-axis (vertical column height)
        hSquash: 0.10,         // squash x/z → tall thin columns
        dimBrightness: 0.06,
    },
    {
        name: 'detail',
        contextLines: 60,
        wandRadius: 5,
        groupScale: 1.0,
        hSquash: 0.12,
        dimBrightness: 0.07,
    },
    {
        name: 'medium',
        contextLines: 120,
        wandRadius: 6,
        groupScale: 1.3,
        hSquash: 0.15,
        dimBrightness: 0.08,
    },
    {
        name: 'broad',
        contextLines: 250,
        wandRadius: 8,
        groupScale: 1.6,
        hSquash: 0.18,
        dimBrightness: 0.09,
    },
    {
        name: 'wide',
        contextLines: 500,
        wandRadius: 10,
        groupScale: 2.0,
        hSquash: 0.20,
        dimBrightness: 0.10,
    },
    {
        name: 'coarse',
        contextLines: Infinity,
        wandRadius: 12,
        groupScale: 2.5,
        hSquash: 0.25,
        dimBrightness: 0.12,
    },
];

const Z_START = -2;
const Z_SHEET_GAP = 10;
const BASE_SPACING = 2.5;


// ─── Concurrency pool ───────────────────────────────────────────────

async function runPool(tasks, concurrency = 8) {
    const results = new Array(tasks.length);
    let next = 0;

    async function worker() {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, tasks.length) },
            () => worker(),
        ),
    );
    return results;
}


// ─── Color helpers (small, no need to import from Wand) ─────────────

function scale3(c, s) { return { r: c.r * s, g: c.g * s, b: c.b * s }; }
function lerp3(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function clamp01(v) { return Math.min(1, Math.max(0, v)); }
function clamp3(c) { return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) }; }


// ─── Column count from density ──────────────────────────────────────

function computeColumns(sheet, codeWidth, density) {
    const diameter = sheet.wandRadius * sheet.groupScale * 2;
    const spacing = diameter * BASE_SPACING / Math.max(density, 0.1);
    return Math.max(1, Math.floor(codeWidth / spacing));
}


// ─── Lightweight probe wrapper ──────────────────────────────────────
//
// Owns a set of glyph IDs inside a shared GlyphRenderer.
// No THREE.Group, no animation.  Just color updates.

function createProbe(renderer, layout, textIds, dimBrightness) {
    const fallback = { r: 0.5, g: 0.5, b: 0.5 };

    const wordMap = new Map();
    layout.forEach((entry, i) => {
        wordMap.set(entry.word.name, {
            textId: textIds[i],
            blockColor: BLOCKS[entry.word.block]?.color || fallback,
        });
    });

    return {
        update(picks, wordsArg) {
            const merged = mergePicks(picks, wordsArg);

            renderer.beginBatchUpdate();
            for (const entry of merged) {
                const info = wordMap.get(entry.word.name);
                if (!info) continue;

                const base = info.blockColor;
                if (entry.intensity > 0) {
                    const t = entry.intensity;
                    const dim = scale3(base, dimBrightness);
                    const bright = clamp3({
                        r: base.r * (0.4 + t * 0.9),
                        g: base.g * (0.4 + t * 0.9),
                        b: base.b * (0.4 + t * 0.9),
                    });
                    renderer.updateColor(info.textId, lerp3(dim, bright, t));
                } else {
                    renderer.updateColor(info.textId, scale3(base, dimBrightness));
                }
            }
            renderer.endBatchUpdate();
        },

        clear() {
            renderer.beginBatchUpdate();
            for (const [, info] of wordMap) {
                renderer.updateColor(info.textId, scale3(info.blockColor, dimBrightness));
            }
            renderer.endBatchUpdate();
        },
    };
}


// ─── Factory ────────────────────────────────────────────────────────

export function createWandField(scene, atlas, words, options = {}) {
    const sheets = options.sheets || DEFAULT_SHEETS;
    const concurrency = options.concurrency || 8;

    let density = options.density || 1.0;
    let layerGap = options.layerGap || Z_SHEET_GAP;
    let probes = [];            // [{ probe, sheetName, rowKey, ... }]
    let sheetState = [];        // [{ group, renderer, sheetIndex, probeDefs }]
    let visible = true;

    // Cached state for rebuild
    let lastParams = null;
    let analysisCache = new Map();  // rowKey → picks

    // Pre-compute shared layout once per sheet config (all probes in a
    // sheet use the same sphere layout, just offset to different positions).
    const sheetLayouts = new Map();
    for (const sheet of sheets) {
        sheetLayouts.set(sheet.name, buildSphereLayout(words, sheet.wandRadius));
    }

    // Total glyphs per probe (for maxInstances sizing)
    const glyphsPerProbe = words.reduce((n, w) => n + w.symbol.length, 0);

    // ─── Internal: build visual grid from cached analysis ────────
    function buildGrid(params) {
        const { lineSpacing, codeWidth, totalLines } = params;

        for (let si = 0; si < sheets.length; si++) {
            const sheet = sheets[si];
            const z = Z_START - (si + 1) * layerGap;
            const columns = computeColumns(sheet, codeWidth, density);
            const layout = sheetLayouts.get(sheet.name);

            const ctxLines = sheet.contextLines === Infinity
                ? totalLines
                : sheet.contextLines;
            const rowCount = Math.max(1, Math.ceil(totalLines / ctxLines));
            const totalProbes = rowCount * columns;

            const hSquash = sheet.hSquash || 1.0;

            // ─── One Group + Renderer per sheet ─────────────────
            // The entire sheet is ONE group. All probes share the
            // sheet's groupId — setLayerGap moves the whole sheet
            // with a single DataTexture write.
            const group = new THREE.Group();
            group.visible = visible;
            scene.add(group);

            const maxInstances = totalProbes * glyphsPerProbe + 100;
            const renderer = new GlyphRenderer(group, atlas, {
                maxInstances,
                defaultColor: { r: 0.04, g: 0.04, b: 0.06 },
            });

            // Sheet center — positions stored relative to this so group
            // scale works from center instead of pushing things off-screen
            const xCenter = codeWidth / 2;
            const yCenter = -(totalLines * lineSpacing) / 2;

            // Group offset = sheet center + z-depth.
            // GPU group scale stretches y (column height) via DataTexture.
            // hSquash is baked into CPU positions (sphere offsets only)
            // so probe centers still tile correctly across code width.
            const sheetGroupId = renderer.createGroup();
            renderer.setGroupOffset(sheetGroupId, { x: xCenter, y: yCenter, z: z });
            renderer.setGroupScale(sheetGroupId, {
                x: 1,
                y: sheet.groupScale,
                z: 1,
            });

            // ─── Collect ALL glyph items for this sheet ─────────
            // One big renderBatch instead of one per probe.
            const allItems = [];
            const probeDefs = [];

            for (let row = 0; row < rowCount; row++) {
                const startLine = row * ctxLines;
                const endLine = Math.min(startLine + ctxLines, totalLines);
                const centerLine = (startLine + endLine) / 2;
                const yPos = -centerLine * lineSpacing;
                const rowKey = `${sheet.name}:${row}`;

                for (let col = 0; col < columns; col++) {
                    const px = codeWidth * (col + 0.5) / columns;
                    const startIdx = allItems.length;

                    // Glyph positions are CENTERED relative to the sheet center.
                    // Probe centers (px, yPos) are centered and unscaled so
                    // they tile correctly. Sphere offsets get hSquash on x/z
                    // (CPU-side column shape). Y-stretch via GPU group scale.
                    for (const entry of layout) {
                        allItems.push({
                            text: entry.word.symbol,
                            position: {
                                x: (px - xCenter) + entry.position.x * hSquash,
                                y: (yPos - yCenter) + entry.position.y,
                                z: entry.position.z * hSquash,
                            },
                            options: {
                                groupId: sheetGroupId,
                                color: scale3(
                                    BLOCKS[entry.word.block]?.color || { r: 0.5, g: 0.5, b: 0.5 },
                                    sheet.dimBrightness,
                                ),
                            },
                        });
                    }

                    probeDefs.push({
                        startIdx,
                        count: layout.length,
                        rowKey,
                        col,
                        startLine,
                        endLine,
                    });
                }
            }

            // ─── One batch render for the whole sheet ───────────
            const allTextIds = renderer.renderBatch(allItems);

            // ─── Create lightweight probes from ID slices ───────
            const sheetProbes = [];

            for (const def of probeDefs) {
                const probeTextIds = allTextIds.slice(def.startIdx, def.startIdx + def.count);
                const probe = createProbe(renderer, layout, probeTextIds, sheet.dimBrightness);

                // Apply cached analysis
                const cached = analysisCache.get(def.rowKey);
                if (cached) {
                    probe.update(cached, words);
                }

                sheetProbes.push({
                    probe,
                    sheetName: sheet.name,
                    rowKey: def.rowKey,
                    col: def.col,
                    startLine: def.startLine,
                    endLine: def.endLine,
                });
            }

            probes.push(...sheetProbes);
            sheetState.push({ group, renderer, sheetIndex: si, sheetGroupId, xCenter, yCenter });

            console.log(
                `  ${sheet.name}: ${sheetProbes.length} probes ` +
                `(${rowCount} rows × ${columns} cols), ` +
                `${allItems.length} glyphs, group=${sheetGroupId}, z=${z}`
            );
        }

        const totalGlyphs = sheetState.reduce(
            (n, ss) => n + ss.renderer.getInstanceCount?.() || 0, 0
        );
        console.log(
            `WandField: ${probes.length} probes, ` +
            `${sheets.length} draw calls, ` +
            `${analysisCache.size} analyses, ` +
            `density=${density.toFixed(1)}`
        );
    }

    function disposeAll() {
        for (const ss of sheetState) {
            ss.renderer.dispose();
            scene.remove(ss.group);
        }
        probes = [];
        sheetState = [];
    }

    return {
        get probes()     { return probes; },
        get probeCount() { return probes.length; },
        get visible()    { return visible; },
        get density()    { return density; },
        get layerGap()   { return layerGap; },

        /**
         * Build the field from loaded source code.
         * Phase 1: run analysis once per row, cache results.
         * Phase 2: build visual grid (one renderer per sheet).
         */
        async load({ code, analyzer, words, lineSpacing, codeWidth, totalLines }) {
            disposeAll();
            analysisCache.clear();

            const lines = code.split('\n');
            lastParams = { lines, lineSpacing, codeWidth, totalLines };

            // ─── Phase 1: Analyze every row ─────────────────────
            const rowMetas = [];

            for (const sheet of sheets) {
                const ctxLines = sheet.contextLines === Infinity
                    ? totalLines
                    : sheet.contextLines;
                const rowCount = Math.max(1, Math.ceil(totalLines / ctxLines));

                for (let row = 0; row < rowCount; row++) {
                    const startLine = row * ctxLines;
                    const endLine = Math.min(startLine + ctxLines, totalLines);
                    const slice = lines.slice(startLine, endLine).join('\n');
                    const rowKey = `${sheet.name}:${row}`;

                    if (!analysisCache.has(rowKey)) {
                        rowMetas.push({ rowKey, slice });
                    }
                }
            }

            if (analyzer.isSync) {
                for (const meta of rowMetas) {
                    analysisCache.set(meta.rowKey, analyzer.analyze(meta.slice, words));
                }
            } else {
                const tasks = rowMetas.map(meta => async () => {
                    const picks = await analyzer.analyze(meta.slice, words);
                    analysisCache.set(meta.rowKey, picks);
                    return picks;
                });
                await runPool(tasks, concurrency);
            }

            // ─── Phase 2: Build visual grid ─────────────────────
            buildGrid(lastParams);
        },

        /**
         * Set fill density and rebuild grid instantly (no re-analysis).
         */
        setDensity(d) {
            density = Math.max(0.1, d);
            if (lastParams) {
                disposeAll();
                buildGrid(lastParams);
            }
        },

        /**
         * Set z-distance between sheet layers. Updates all probe group
         * offsets via DataTexture — no buffer rebuilds, just texel writes.
         * @param {number} gap - world units between layers
         */
        setLayerGap(gap) {
            layerGap = Math.max(0.1, gap);
            // One setGroupOffset per sheet — O(1) per layer
            // Preserve xCenter/yCenter so centered positions still work
            for (const ss of sheetState) {
                const newZ = Z_START - (ss.sheetIndex + 1) * layerGap;
                ss.renderer.setGroupOffset(ss.sheetGroupId, { x: ss.xCenter, y: ss.yCenter, z: newZ });
            }
        },

        /**
         * No-op — field probes are static, no per-frame work needed.
         * Kept for API compatibility with the animate loop.
         */
        tick(_dt) {},

        setVisible(v) {
            visible = v;
            for (const ss of sheetState) {
                ss.group.visible = v;
            }
        },

        dispose() {
            disposeAll();
            analysisCache.clear();
            lastParams = null;
        },
    };
}
