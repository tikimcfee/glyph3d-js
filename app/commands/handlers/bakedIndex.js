/**
 * bakedIndex — fetch + validate a repo's baked layout index (.glyph3d/bake/index.bin,
 * written by `bun tools/bake.mjs`) and hand each file's record to its grid.
 *
 * ONE fetch, zero JSON: the index is a single binary file (glyphBakeIndex.js) and
 * records are typed-array views over the fetched buffer — a file that is never
 * opened costs only its row in the path table.
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
 *
 * A valid index also PRE-ARMS THE ATLAS: the repo census primes the shape cache and
 * Slug-encodes every glyph the repo will need BEFORE the storm stages a byte — the
 * mid-storm miss → trie-rebuild → re-dispatch-everything loop never fires for a
 * baked repo.
 */

import { decodeBakeIndex } from '@glyph3d/core/compute/glyphBakeIndex.js';
import { encodeMisses } from '@glyph3d/core/compute/liveTrie.js';
import { getPipelineArena } from '@glyph3d/core/compute/GlyphLayoutCompute.js';
import { computeCellMetrics } from '@glyph3d/core';

/** Fallback when no arena exists yet — mirrors GlyphCanvas's construction value.
 *  The LIVE arena's scale is the truth whenever it's up (the validation below
 *  compares baked advances against what the trie actually baked at). */
const GRID_WORLD_SCALE = 0.025;

const INDEX_PATH = '.glyph3d/bake/index.bin';

/**
 * Load the baked index for `dir`, or null. Null is NORMAL (no index baked); only a
 * present-but-unusable index warns.
 * @param {Object} ctx - command context (fileProvider + atlas)
 * @param {string} dir - the openDir root ('' = the served root)
 * @returns {Promise<{get:(path:string)=>Object|undefined, size:number}|null>}
 */
export async function loadBakedIndex(ctx, dir) {
    const fp = ctx.fileProvider;
    if (typeof fp?.getBytes !== 'function' || !ctx.atlas) return null;
    const base = dir && dir !== '/' ? `${dir}/` : dir === '/' ? '/' : '';

    let bytes;
    try {
        bytes = await fp.getBytes(`${base}${INDEX_PATH}`);
    } catch {
        return null;                                   // no index — the normal state
    }

    let decoded;
    try {
        decoded = decodeBakeIndex(bytes);
    } catch (err) {
        console.warn(`[bake] index at ${base}${INDEX_PATH} unusable: ${err?.message || err} — rebake with tools/bake.mjs (ignored)`);
        return null;
    }
    const h = decoded.header;

    // ── the metrics identity, against THIS session (the LIVE arena's scale) ──
    const liveScale = getPipelineArena()?.worldScale ?? GRID_WORLD_SCALE;
    const live = ctx.atlas.getCharSize();
    const m = computeCellMetrics(live, liveScale);
    const ok = h.worldScale === liveScale
        && h.charSize.width === live.width && h.charSize.height === live.height
        && h.lineHeight === m.lineSpacing;
    if (!ok) {
        console.warn(`[bake] index metrics differ from the live session — ignored. `
            + `baked {charSize ${h.charSize.width}×${h.charSize.height}, scale ${h.worldScale}, lh ${h.lineHeight}} `
            + `vs live {${live.width}×${live.height}, ${liveScale}, ${m.lineSpacing}} — rebake with tools/bake.mjs`);
        return null;
    }

    // ── pre-arm the atlas from the census: prime + encode BEFORE the storm ──
    try {
        const cache = ctx.atlas._shapeCache;
        if (cache?.prime && decoded.census.length > 0) {
            const t0 = performance.now();
            let s = '';
            for (const cp of decoded.census) s += String.fromCodePoint(cp);
            cache.prime(s);
            const grew = encodeMisses(ctx.atlas, [...decoded.census]);
            console.info(`[bake] census pre-armed the atlas: ${decoded.census.length} codepoints, `
                + `${grew.grew ? 'encoded new glyphs' : 'already covered'} (${Math.round(performance.now() - t0)}ms)`);
        }
    } catch (err) {
        console.warn('[bake] census pre-arm failed (load continues without it):', err);
    }

    // PRE-SIZE the arena: the index knows every file's byteLength, so the storm's
    // total is known BEFORE a byte stages — one cheap realloc now (ideally while
    // the arena is near-empty) instead of a mid-storm doubling ladder whose top
    // steps land as multi-second main-thread blocks. Headroom covers filenames,
    // edit slack, and already-staged content.
    try {
        const arena = getPipelineArena();
        if (arena) {
            let total = 0;
            for (let i = 0; i < decoded.header.fileCount; i++) total += decoded.recordAt(i).byteLength;
            arena.ensureCapacity((arena.byteWatermark ?? 0) + total * 1.2);
        }
    } catch (err) {
        console.warn('[bake] arena pre-size failed (load continues, growth is the fallback):', err);
    }

    // Absolute-path lookup over lazy records — decode work happens per OPENED file.
    const { pathIndex, recordAt } = decoded;
    const prefix = base;
    console.info(`[bake] index: ${pathIndex.size} records for ${dir || '/'} (metrics ${h.metricsHash})`);
    return {
        size: pathIndex.size,
        get(path) {
            const rel = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
            const i = pathIndex.get(rel);
            return i === undefined ? undefined : recordAt(i);
        },
    };
}
