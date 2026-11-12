/**
 * EmojiRasterWorker — draws color emoji into EmojiAtlas cells, off the main thread.
 *
 * Canvas2D `fillText` rasterizes color emoji through the platform emoji font; an
 * OffscreenCanvas in a worker does the same work (the glyph decode and raster included)
 * without touching the main thread. A request names a run of CONSECUTIVE atlas cells
 * (`firstIdx`, one codepoint each) and the atlas layout (`cols`, `cellPx`); the answer is the
 * RGBA pixels of the BAND those cells occupy, laid out exactly like the atlas:
 *
 *   rows   cell rows the run spans (row0 … row0 + rows - 1)
 *   col0   first cell column in the band (0 unless the run sits inside one cell row)
 *   wCells band width in cells
 *   band   Uint8ClampedArray, (wCells·cellPx) × (rows·cellPx) RGBA, only the run's cells drawn
 *
 * so the main thread copies whole pixel rows of it into place. WorkerRpc protocol:
 *   { type: 'raster', cps: Uint32Array, firstIdx, cols, cellPx, fontFamily }
 *     → { row0, rows, col0, wCells, band }
 *
 * No DOM, no Three.js.
 */

/** @type {OffscreenCanvas|null} */
let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D|null} */
let ctx = null;

self.onmessage = (event) => {
    const msg = event.data;
    try {
        if (msg.type !== 'raster') throw new Error(`unknown request type ${msg.type}`);
        const { cps, firstIdx, cols, cellPx, fontFamily } = msg;
        const last = firstIdx + cps.length - 1;
        const row0 = Math.floor(firstIdx / cols);
        const rows = Math.floor(last / cols) - row0 + 1;
        const col0 = rows === 1 ? firstIdx % cols : 0;
        const wCells = rows === 1 ? (last % cols) - col0 + 1 : cols;
        const w = wCells * cellPx, h = rows * cellPx;

        if (!canvas) {
            canvas = new OffscreenCanvas(w, h);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable in this worker');
        } else {
            canvas.width = w;      // a resize also clears it
            canvas.height = h;
        }
        ctx.clearRect(0, 0, w, h);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 0.82 leaves a little padding so bilinear sampling at the cell edge doesn't bleed a
        // neighbour in. Emoji metrics vary; a centered baseline is the robust default.
        ctx.font = `${Math.round(cellPx * 0.82)}px ${fontFamily}`;
        for (let i = 0; i < cps.length; i++) {
            const idx = firstIdx + i;
            const x = ((idx % cols) - col0) * cellPx;
            const y = (Math.floor(idx / cols) - row0) * cellPx;
            ctx.fillText(String.fromCodePoint(cps[i]), x + cellPx / 2, y + cellPx / 2);
        }
        const band = ctx.getImageData(0, 0, w, h).data;
        self.postMessage({ id: msg.id, row0, rows, col0, wCells, band }, [band.buffer]);
    } catch (e) {
        self.postMessage({ id: msg.id, error: `${msg.type}: ${e?.message || e}` });
    }
};
