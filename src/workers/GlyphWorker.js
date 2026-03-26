/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, processes glyph data,
 * and transfers results back with zero-copy Transferable arrays.
 *
 * GPU codepoint → UV path: builders emit a `codepoints` Float32Array (raw
 * Unicode codepoints) instead of UV coordinates. The vertex shader resolves
 * codepoints to UV rects via atlasMapTexture at draw time. The uvMap is still
 * sent to the worker for glyph-existence validation only.
 *
 * Caches UV map to avoid repeated serialization.
 */

import { buildGlyphBuffers, buildBatchBuffers } from './builders/index.js';

// Cached UV map (sent once, reused)
let cachedUVMap = null;

/**
 * Handle incoming messages
 */
self.onmessage = function(event) {
    const { type, jobId, payload } = event.data;

    try {
        switch (type) {
            case 'BUILD': {
                const result = buildGlyphBuffers(payload);
                // [GPU-Lookup] Transfer codepoints buffer (not UVs) — main thread
                // renderer will bind it as instanceCodepoint; shader resolves UV.
                console.debug(`[GPU-Lookup] GlyphWorker BUILD: transferring codepoints (${result.count} glyphs)`);
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
                // Cache UV map if provided
                if (payload.shared.uvMap) {
                    cachedUVMap = payload.shared.uvMap;
                }

                // Use cached UV map
                const shared = {
                    metrics: payload.shared.metrics,
                    defaultColor: payload.shared.defaultColor,
                    uvMap: cachedUVMap
                };

                const result = buildBatchBuffers(payload.items, shared);

                // [GPU-Lookup] Transfer codepoints buffer (not UVs) — main thread
                // renderer will bind it as instanceCodepoint; shader resolves UV.
                // itemMeta goes through structured clone; Float32Arrays are zero-copy.
                console.debug(`[GPU-Lookup] GlyphWorker BUILD_BATCH: transferring codepoints (${result.count} glyphs, ${payload.items.length} items)`);
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
