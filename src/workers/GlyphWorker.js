/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, processes glyph data,
 * and transfers results back with zero-copy Transferable arrays.
 *
 * GPU grapheme → UV path: builders emit a `codepoints` Float32Array of
 * numeric DataTexture IDs (one per grapheme cluster). The vertex shader
 * resolves IDs to UV rects via atlasMapTexture at draw time. The uvMap is
 * keyed by grapheme cluster string and carries the numericId per entry.
 *
 * Caches UV map to avoid repeated serialization.
 */

import { buildGlyphBuffers, buildBatchBuffers } from './builders/index.js';

// Cached UV map and per-glyph widths (sent once, reused)
let cachedUVMap = null;
let cachedGlyphWidths = null;

/**
 * Handle incoming messages
 */
self.onmessage = function(event) {
    const { type, jobId, payload } = event.data;

    try {
        switch (type) {
            case 'BUILD': {
                const result = buildGlyphBuffers(payload);
                // [GPU-Lookup] Transfer codepoints buffer (numeric DataTexture IDs) — main thread
                // renderer binds it as instanceCodepoint; shader resolves UV via atlasMapTexture.
                // console.debug(`[GlyphWorker] BUILD: ${result.count} glyphs`);
                self.postMessage(
                    { type: 'RESULT', jobId, buffers: result },
                    [
                        result.positions.buffer,
                        result.sizes.buffer,
                        result.codepoints.buffer,
                        result.colors.buffer,
                        result.groupIds.buffer
                    ]
                );
                break;
            }

            case 'BUILD_BATCH': {
                // Cache UV map and glyph widths if provided
                if (payload.shared.uvMap) {
                    cachedUVMap = payload.shared.uvMap;
                }
                if (payload.shared.glyphWidths) {
                    cachedGlyphWidths = payload.shared.glyphWidths;
                }

                // Use cached UV map and glyph widths
                const shared = {
                    metrics: payload.shared.metrics,
                    defaultColor: payload.shared.defaultColor,
                    uvMap: cachedUVMap,
                    glyphWidths: cachedGlyphWidths
                };

                const result = buildBatchBuffers(payload.items, shared);

                // [GPU-Lookup] Transfer codepoints buffer (numeric DataTexture IDs) — main thread
                // renderer binds it as instanceCodepoint; shader resolves UV via atlasMapTexture.
                // itemMeta goes through structured clone; Float32Arrays are zero-copy.
                // console.debug(`[GlyphWorker] BUILD_BATCH: ${result.count} glyphs, ${payload.items.length} items`);
                self.postMessage(
                    { type: 'RESULT', jobId, buffers: result },
                    [
                        result.positions.buffer,
                        result.sizes.buffer,
                        result.codepoints.buffer,
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
