/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, packs pre-shaped HarfBuzz glyph data
 * into Float32Arrays, and transfers results back with zero-copy Transferable arrays.
 *
 * Text is shaped on the main thread (single HarfBuzz WASM instance) and the
 * pre-shaped arrays are attached to each item before posting. Workers contain
 * no WASM — they only do buffer math.
 *
 * GLYPH_MAP: The main thread transfers the per-codepoint monospace shape cache
 * once at init. Workers rebuild it into a shaper-less MonospaceShapeCache and
 * shape raw text locally (BUILD_BATCH carries `text`, not pre-shaped arrays) —
 * this keeps the bulky shaped {g,ax,dx,dy} arrays out of postMessage, whose
 * structured-clone was the dominant main-thread cost of a reload.
 */

import { buildBatchBuffers } from './builders/index.js';
import { shapeText } from '../shaping/shapeText.js';
import MonospaceShapeCache from '../shaping/MonospaceShapeCache.js';

// Worker-side monospace shape cache, rebuilt from the GLYPH_MAP message. Has a
// working shapeLine() with no WASM (misses fall back to a blank monospace cell).
let workerCache = null;

/**
 * Handle incoming messages
 */
self.onmessage = function(event) {
    const { type, jobId, payload } = event.data;

    try {
        switch (type) {
            case 'BUILD_BATCH': {
                const shared = {
                    metrics: payload.shared.metrics,
                    defaultColor: payload.shared.defaultColor,
                    upem: payload.shared.upem,
                    layout: payload.shared.layout,  // per-grid layout params (else builder falls back to defaults)
                };
                // Shape raw text → glyph arrays here, off the main thread. The
                // builder reads item.shaped, so attach it before building. (Items
                // arrive with `text`; the cache must have been delivered first via
                // GLYPH_MAP, which the bridge guarantees before any BUILD_BATCH.)
                const items = payload.items;
                if (workerCache) {
                    for (let i = 0; i < items.length; i++) {
                        if (items[i].shaped === undefined) {
                            items[i].shaped = shapeText(workerCache, items[i].text || '');
                        }
                    }
                }
                const result = buildBatchBuffers(items, shared);

                // Transfer buffers — glyphIds/codepoints alias the same array
                const glyphIdsBuf = result.glyphIds || result.codepoints;
                self.postMessage(
                    { type: 'RESULT', jobId, buffers: result },
                    [
                        result.positions.buffer,
                        result.sizes.buffer,
                        glyphIdsBuf.buffer,
                        result.colors.buffer,
                        result.groupIds.buffer
                    ]
                );
                break;
            }

            case 'GLYPH_MAP': {
                // Receive the per-codepoint shape cache from the main thread and
                // rebuild a shaper-less MonospaceShapeCache for local shaping.
                // Sent once after priming (and again to late-created workers).
                const arr = event.data.glyphMap;
                workerCache = MonospaceShapeCache.fromTransferArray(arr);
                console.debug(`[GlyphWorker] Shape cache received: ${workerCache.size} entries`);
                break;
            }

            case 'PING': {
                self.postMessage({ type: 'PONG', jobId });
                break;
            }

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            jobId,
            error: error.message || String(error)
        });
    }
};

self.onerror = function(error) {
    console.error('GlyphWorker error:', error);
};
