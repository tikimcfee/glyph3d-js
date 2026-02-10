/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, processes glyph data,
 * and transfers results back with zero-copy Transferable arrays.
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
                self.postMessage(
                    { type: 'RESULT', jobId, buffers: result },
                    [
                        result.positions.buffer,
                        result.sizes.buffer,
                        result.uvs.buffer,
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

                // itemMeta is plain objects — goes through structured clone
                // Float32Arrays are transferred zero-copy
                self.postMessage(
                    { type: 'RESULT', jobId, buffers: result },
                    [
                        result.positions.buffer,
                        result.sizes.buffer,
                        result.uvs.buffer,
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
