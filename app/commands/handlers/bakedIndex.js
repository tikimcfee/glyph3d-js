/**
 * bakedIndex — fetch + validate a repo's baked layout index (.glyph3d/bake/, written
 * by `bun tools/bake.mjs`) and hand each file's record to its grid.
 *
 * PURE ADDITIVE: no index (the normal state of most dirs) means the load path runs
 * exactly as before — absence is silent. A PRESENT index that disagrees with the
 * live session (version, metrics, cell size) is refused LOUDLY: a stale index
 * consumed quietly would plant wrong measures and misdirect layout debugging.
 *
 * Validation is the metrics identity, checked against the LIVE atlas: the baked
 * charSize/worldScale/lineHeight must equal what this session derives — those three
 * are the whole advance expression (ax/upem × worldScale × height), so equality
 * here means baked advances are the live trie's advances. The per-file gate
 * (CodeGrid, post-laid) then proves each record against the GPU's actual bounds.
 */

import { BAKE_VERSION } from '@glyph3d/core/compute/glyphBake.js';
import { computeCellMetrics } from '@glyph3d/core';

/** The worldScale every file grid boots with (prepFileGrid) — the arena's scale. */
const GRID_WORLD_SCALE = 0.025;

const INDEX_PATH = '.glyph3d/bake/index.json';
const HIST_PATH = '.glyph3d/bake/hist.bin';

/**
 * Load the baked index for `dir`, or null. Null is NORMAL (no index baked); only a
 * present-but-unusable index warns.
 * @param {Object} ctx - command context (fileProvider + atlas)
 * @param {string} dir - the openDir root ('' = the served root)
 * @returns {Promise<Map<string, Object>|null>} absolute-path → per-file record
 */
export async function loadBakedIndex(ctx, dir) {
    const fp = ctx.fileProvider;
    if (!fp?.getFile || typeof fp.getBytes !== 'function' || !ctx.atlas) return null;
    const base = dir && dir !== '/' ? `${dir}/` : dir === '/' ? '/' : '';

    let index;
    try {
        index = JSON.parse(await fp.getFile(`${base}${INDEX_PATH}`));
    } catch {
        return null;                                   // no index — the normal state
    }

    // ── the metrics identity, against THIS session ──
    if (index.version !== BAKE_VERSION) {
        console.warn(`[bake] index at ${base}${INDEX_PATH} is version ${index.version}, runtime is ${BAKE_VERSION} — rebake (ignored)`);
        return null;
    }
    const live = ctx.atlas.getCharSize();
    const m = computeCellMetrics(live, GRID_WORLD_SCALE);
    const ok = index.worldScale === GRID_WORLD_SCALE
        && index.charSize?.width === live.width && index.charSize?.height === live.height
        && index.lineHeight === m.lineSpacing;
    if (!ok) {
        console.warn(`[bake] index metrics differ from the live session — ignored. `
            + `baked {charSize ${index.charSize?.width}×${index.charSize?.height}, scale ${index.worldScale}, lh ${index.lineHeight}} `
            + `vs live {${live.width}×${live.height}, ${GRID_WORLD_SCALE}, ${m.lineSpacing}} — rebake with tools/bake.mjs`);
        return null;
    }

    let hist;
    try {
        const bytes = await fp.getBytes(`${base}${HIST_PATH}`);
        hist = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    } catch (err) {
        console.warn(`[bake] index present but ${HIST_PATH} unreadable (${err?.message || err}) — ignored`);
        return null;
    }

    const map = new Map();
    for (const [rel, r] of Object.entries(index.files)) {
        const lineHist = new Map();
        let maxLineLen = r.total.tailLen;
        const off = r.hist[0] / 4;                     // u32 index into the blob
        for (let i = 0; i < r.hist[1]; i++) {
            const len = hist[off + i * 2], count = hist[off + i * 2 + 1];
            lineHist.set(len, count);
            if (len > maxLineLen) maxLineLen = len;
        }
        map.set(`${base}${rel}`, {
            leaders: r.leaders,
            rows: r.rows,
            maxRowExtent: r.maxRowExtent,
            maxLineWidth: r.maxLineWidth,
            maxLineLen,
            box: r.box,
            total: r.total,
            lineHist,
        });
    }
    console.info(`[bake] index: ${map.size} records for ${dir || '/'} (metrics ${index.metricsHash})`);
    return map;
}
