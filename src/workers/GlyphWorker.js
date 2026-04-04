/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, packs pre-shaped HarfBuzz glyph data
 * into Float32Arrays, and transfers results back with zero-copy Transferable arrays.
 *
 * Text is shaped on the main thread (single HarfBuzz WASM instance) and the
 * pre-shaped arrays are attached to each item before posting. Workers contain
 * no WASM — they only do buffer math.
 */

import { buildBatchBuffers } from './builders/index.js';

// Set of glyph IDs known to have 0 curves (space, .notdef) — avoids redundant checks
let emptyGlyphCache = null;

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
                };
                // Lazy-build empty glyph cache from emptyGlyphs in payload
                if (!emptyGlyphCache && payload.shared.emptyGlyphs) {
                    emptyGlyphCache = new Set(payload.shared.emptyGlyphs);
                }
                const result = buildBatchBuffers(payload.items, shared, emptyGlyphCache);

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
