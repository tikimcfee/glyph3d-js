/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, processes glyph data,
 * and transfers results back with zero-copy Transferable arrays.
 *
 * Two builder paths:
 * - HarfBuzz-shaped: when items carry item.shaped (pre-shaped by the main thread),
 *   uses buildShapedBatchBuffers() which emits HarfBuzz glyph IDs for Slug rendering.
 *   No WASM in the worker — shaping happens once on the main thread.
 * - Legacy fallback: grapheme-based buildBatchBuffers() with atlas UV map.
 *
 * Caches UV map to avoid repeated serialization (legacy path).
 */

import { buildGlyphBuffers, buildBatchBuffers, buildShapedBatchBuffers } from './builders/index.js';

// Cached UV map and per-glyph widths (sent once, reused)
let cachedUVMap = null;
let cachedGlyphWidths = null;

// Set of glyph IDs known to have 0 curves (space, .notdef) — avoids redundant checks
let emptyGlyphCache = null;

/**
 * Handle incoming messages
 */
self.onmessage = function(event) {
    const { type, jobId, payload } = event.data;

    try {
        switch (type) {
            case 'BUILD': {
                const result = buildGlyphBuffers(payload);
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

            case 'BUILD_BATCH': {
                let result;

                // Check if items carry pre-shaped data from the main thread
                const hasPreShaped = payload.items.length > 0 && payload.items[0].shaped != null;

                if (hasPreShaped) {
                    // HarfBuzz-shaped path — items already have .shaped from main thread.
                    // No WASM in this worker. Just pack the buffers.
                    const shared = {
                        metrics: payload.shared.metrics,
                        defaultColor: payload.shared.defaultColor,
                        upem: payload.shared.upem,
                    };
                    // Lazy-build empty glyph cache from emptyGlyphs in payload
                    if (!emptyGlyphCache && payload.shared.emptyGlyphs) {
                        emptyGlyphCache = new Set(payload.shared.emptyGlyphs);
                    }
                    result = buildShapedBatchBuffers(payload.items, shared, emptyGlyphCache);
                } else {
                    // Fallback: grapheme-based builder (atlas path)
                    if (payload.shared.uvMap) {
                        cachedUVMap = payload.shared.uvMap;
                    }
                    if (payload.shared.glyphWidths) {
                        cachedGlyphWidths = payload.shared.glyphWidths;
                    }
                    const shared = {
                        metrics: payload.shared.metrics,
                        defaultColor: payload.shared.defaultColor,
                        uvMap: cachedUVMap,
                        glyphWidths: cachedGlyphWidths
                    };
                    result = buildBatchBuffers(payload.items, shared);
                }

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
