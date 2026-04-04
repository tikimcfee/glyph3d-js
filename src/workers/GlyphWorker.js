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
 * GLYPH_MAP: The main thread transfers a per-codepoint glyph map once at init
 * (when MonospaceShapeCache is used). Workers store it for future worker-side
 * reconstruction (Tier 3 optimization), where workers will shape from raw text
 * + glyph map locally, eliminating shaped data from postMessage entirely.
 */

import { buildBatchBuffers } from './builders/index.js';

// Set of glyph IDs known to have 0 curves (space, .notdef) — avoids redundant checks
let emptyGlyphCache = null;

// Per-codepoint glyph map transferred from main thread. Populated by GLYPH_MAP message.
// Layout: Map<codepoint, {g: glyphId, ax: xAdvance}> rebuilt from a flat Uint32Array.
// Used in future Tier 3 optimization for worker-side text reconstruction.
let glyphMap = null;

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

            case 'GLYPH_MAP': {
                // Receive the per-codepoint glyph map from the main thread.
                // Sent once after MonospaceShapeCache priming. Layout: [cp, g, ax, ...]
                const arr = event.data.glyphMap;
                glyphMap = new Map();
                for (let i = 0; i < arr.length; i += 3) {
                    glyphMap.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
                }
                console.debug(`[GlyphWorker] Glyph map received: ${glyphMap.size} entries`);
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
