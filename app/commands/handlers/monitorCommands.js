/**
 * Monitor commands: monitor.stats, monitor.reset
 *
 * THE RESOURCE READOUT. Every other stat verb answers about one subsystem
 * (atlas.info, atlas.cache, cull.stats, load.stats); this one folds the ones that
 * cost MEMORY or TIME into a single structured answer, so "load a repo and see
 * where the memory actually went" is one call instead of six.
 *
 * The framing is a time / space / compute tradeoff, because that is what these
 * knobs are: the slug-core cache spends disk to buy boot time, the bake index
 * spends disk to buy layout compute, the arena spends VRAM to buy a single
 * pipeline. Which trade is right differs per machine, so the numbers are all
 * MEASURED HERE — never assumed from a config.
 *
 * Read-and-reset: `monitor.stats` reports, `monitor.reset <target>` clears one
 * store and reports what it reclaimed. Nothing here mutates the scene.
 *
 * Structured `data` is the contract (MonitorPanel renders it one-way); the text
 * box is for the CLI. Every field is nullable — a subsystem that has not booted,
 * or a browser that does not expose a counter, reports null rather than a zero
 * that reads as "measured, and it's empty".
 */

import { box } from '../formatResponse.js';
import { getSlugCacheState, clearSlugCore } from '@glyph3d/core/shaping';
import { peekWorkerBridge } from '@glyph3d/core/workers';

const KB = 1024, MB = 1024 * 1024;

/** Human bytes. null → '—' so an unmeasurable value never renders as '0 B'. */
export function fmtBytes(b) {
    if (b == null || Number.isNaN(b)) return '—';
    if (b < KB) return `${b} B`;
    if (b < MB) return `${(b / KB).toFixed(1)} KB`;
    return `${(b / MB).toFixed(1)} MB`;
}

/**
 * JS heap. Chromium-only (`performance.memory`), and behind a flag at that —
 * Firefox and Safari report nothing. Absence is reported as absence.
 */
function readHeap() {
    const m = typeof performance !== 'undefined' ? performance.memory : null;
    if (!m) return { available: false, used: null, total: null, limit: null };
    return { available: true, used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit };
}

/**
 * GPU-side objects three is tracking, plus the canvas backing (which is real VRAM:
 * width × height × 4 bytes for the color target, and again for depth).
 */
function readRenderer(renderer) {
    if (!renderer) return null;
    const info = renderer.info || {};
    const canvas = renderer.domElement || null;
    const backingPx = canvas ? canvas.width * canvas.height : null;
    return {
        geometries: info.memory?.geometries ?? null,
        textures: info.memory?.textures ?? null,
        drawCalls: info.render?.drawCalls ?? info.render?.calls ?? null,
        triangles: info.render?.triangles ?? null,
        backing: canvas ? { width: canvas.width, height: canvas.height, pixelRatio: renderer.getPixelRatio?.() ?? null } : null,
        // Colour + depth at 4B/px. An estimate, and labelled as one.
        backingBytesEstimate: backingPx != null ? backingPx * 4 * 2 : null,
    };
}

/**
 * The glyph index: how many codepoints are encoded and what that costs in texture
 * memory. Texture bytes are computed from the live image dimensions rather than
 * guessed — curve data is RGBA float (16 B/texel), the glyph map RGBA float too.
 */
function readAtlas(atlas) {
    const live = atlas?._live;
    if (!live) return { ready: false };
    const sd = live.slugData || {};
    const texBytes = (t, bytesPerTexel) => {
        const img = t?.image;
        return img?.width && img?.height ? img.width * img.height * bytesPerTexel : null;
    };
    // The live Slug pipeline has exactly two textures. (An `atlasMapTexture` appears
    // in older notes; it belongs to the superseded bitmap path and does not exist
    // here — reporting it would have shown a permanent '—' beside real numbers.)
    const curve = texBytes(sd.curveTexture, 16);
    const glyphMap = texBytes(sd.glyphMapTexture, 16);
    const sum = [curve, glyphMap].filter((n) => n != null).reduce((a, b) => a + b, 0);
    const dims = (t) => (t?.image?.width ? `${t.image.width}x${t.image.height}` : null);
    return {
        ready: true,
        encodedGlyphs: live.size ?? null,
        version: live.version ?? null,
        fonts: atlas._shaper?.fontCount ?? null,
        curveTexture: dims(sd.curveTexture),
        glyphMapTexture: dims(sd.glyphMapTexture),
        textureBytes: sum || null,
    };
}

/**
 * The byte pipeline. `maxBytes` is the arena's SLOT capacity — one slot per source
 * byte, and a slot is 11 f32 = 44 B of GPU buffer, so the buffer cost is the
 * multiplier, not the byte count. That multiplier is the whole reason this readout
 * exists: 1 MB of source is ~44 MB of VRAM, which is not obvious from any log line.
 */
function readArena(renderer) {
    const arena = renderer?.glyphPipelineArena;
    if (!arena) return { ready: false };
    const live = arena._liveCount ?? null;
    const staged = arena._items?.length ?? null;
    const freeBytes = (arena._free || []).reduce((a, r) => a + (r.length || 0), 0);
    return {
        ready: true,
        liveItems: live,
        stagedItems: staged,
        deadItems: live != null && staged != null ? staged - live : null,
        maxItems: arena.maxItems ?? null,
        watermarkBytes: arena._byteTotal ?? null,
        capacityBytes: arena.maxBytes ?? null,
        freeListBytes: freeBytes,
        bytesPerSlot: 44,
        bufferBytesEstimate: arena.maxBytes != null ? arena.maxBytes * 44 : null,
    };
}

/** Worker pool: per-worker UV-map caches scale with core count, so it is per-device. */
function readWorkers(ctx) {
    // peek, NOT get — getWorkerBridge() would BUILD the pool we are trying to measure.
    const bridge = peekWorkerBridge();
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null;
    return {
        hardwareConcurrency: hw ?? null,
        spawned: !!bridge,
        workers: bridge ? (bridge.workers?.length ?? null) : 0,
        uvMapVersion: ctx.atlas?._uvMapVersion ?? null,
    };
}

/** Scene census — what is actually resident, from the registry. */
function readScene(ctx) {
    const reg = ctx.registry;
    if (!reg || typeof reg.list !== 'function') return { ready: false };
    let entries = [];
    try { entries = reg.list() || []; } catch { return { ready: false }; }
    const byType = {};
    for (const e of entries) {
        const t = e?.type || 'unknown';
        byType[t] = (byType[t] || 0) + 1;
    }
    return { ready: true, total: entries.length, byType };
}

export default function registerMonitorCommands(router) {

    // ================================================================
    //  monitor.stats
    // ================================================================
    router.register('monitor.stats', async (args, ctx) => {
        const renderer = ctx.renderer || null;
        const heap = readHeap();
        const gpu = readRenderer(renderer);
        const atlas = readAtlas(ctx.atlas);
        const arena = readArena(renderer);
        const workers = readWorkers(ctx);
        const scene = readScene(ctx);

        // The one async source: IndexedDB. A locked-down browser (private mode,
        // storage denied) throws rather than returning empty — report the failure
        // instead of an empty cache, which would read as "nothing cached" and send
        // someone rebuilding a cache that is actually unreachable.
        let slugCache = null;
        try {
            const s = await getSlugCacheState();
            slugCache = {
                available: true,
                entries: s.entries.length,
                bytes: s.entries.reduce((a, e) => a + (e.bytes || 0), 0),
                last: s.last || null,
                detail: s.entries,
            };
        } catch (err) {
            slugCache = { available: false, error: err?.message || String(err) };
        }

        const data = { heap, gpu, atlas, arena, workers, scene, caches: { slugCore: slugCache } };

        const lines = [];
        lines.push(`heap:     ${heap.available ? `${fmtBytes(heap.used)} / ${fmtBytes(heap.limit)} cap` : '(not exposed by this browser)'}`);
        if (gpu) {
            lines.push(`canvas:   ${gpu.backing ? `${gpu.backing.width}x${gpu.backing.height} @dpr ${gpu.backing.pixelRatio}  ~${fmtBytes(gpu.backingBytesEstimate)}` : '—'}`);
            lines.push(`three:    ${gpu.geometries ?? '—'} geometries · ${gpu.textures ?? '—'} textures`);
        }
        lines.push('');
        lines.push(`atlas:    ${atlas.ready ? `${atlas.encodedGlyphs} glyphs · v${atlas.version} · ~${fmtBytes(atlas.textureBytes)} textures` : '(not ready)'}`);
        if (atlas.ready) lines.push(`          curve ${atlas.curveTexture ?? '—'} · glyphmap ${atlas.glyphMapTexture ?? '—'}`);
        lines.push(`arena:    ${arena.ready ? `${arena.liveItems}/${arena.stagedItems} items · ${fmtBytes(arena.watermarkBytes)} of ${fmtBytes(arena.capacityBytes)} · ~${fmtBytes(arena.bufferBytesEstimate)} GPU` : '(not ready)'}`);
        lines.push(`workers:  ${workers.spawned ? `${workers.workers} spawned` : 'pool not built'} · ${workers.hardwareConcurrency ?? '—'} cores`);
        lines.push('');
        lines.push(`slug cache: ${slugCache.available
            ? `${slugCache.entries} entr${slugCache.entries === 1 ? 'y' : 'ies'} · ${fmtBytes(slugCache.bytes)}`
            : `UNAVAILABLE (${slugCache.error})`}`);
        lines.push(`scene:      ${scene.ready ? `${scene.total} objects` : '—'}`);

        return { text: box('MONITOR', lines, 62) + '\nOK: monitor.stats', data };
    }, {
        description: 'Resource readout: heap, GPU, atlas, arena, worker pool, caches, scene census',
        usage: '',
    });

    // ================================================================
    //  monitor.reset <target>
    // ================================================================
    router.register('monitor.reset', async (args, ctx) => {
        const target = String(args[0] || '').toLowerCase();
        if (!target) {
            return { text: 'ERR: usage: monitor.reset <slug-cache|renderer-info>', data: null };
        }

        if (target === 'slug-cache') {
            // Measure BEFORE, so the answer says what was reclaimed rather than just
            // "done" — the reclaimed number is the whole point of a reset button on a
            // monitor page. The rebuild happens on next boot (the encode is a load-time
            // step), so say so plainly instead of implying it already happened.
            let before = null;
            try {
                const s = await getSlugCacheState();
                before = s.entries.reduce((a, e) => a + (e.bytes || 0), 0);
            } catch { /* report the clear anyway */ }
            const n = await clearSlugCore();
            return {
                text: `OK: cleared ${n} slug-core entr${n === 1 ? 'y' : 'ies'}, reclaimed ${fmtBytes(before)}`
                    + ' — reload to re-encode and re-cache',
                data: { target, cleared: n, reclaimedBytes: before },
            };
        }

        if (target === 'renderer-info') {
            // three's per-frame counters are cumulative until reset; zeroing them makes
            // the next reading attributable to one interaction instead of the session.
            const info = ctx.renderer?.info;
            if (!info) return { text: 'ERR: no renderer', data: null };
            info.reset?.();
            return { text: 'OK: renderer frame counters zeroed', data: { target } };
        }

        return { text: `ERR: unknown reset target '${target}' (slug-cache|renderer-info)`, data: null };
    }, {
        description: 'Clear one cache/counter and report what it reclaimed',
        usage: '<slug-cache|renderer-info>',
    });
}
