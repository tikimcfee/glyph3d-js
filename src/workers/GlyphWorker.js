/**
 * GlyphWorker - Web Worker for glyph buffer computation
 *
 * Handles messages from main thread, processes glyph data,
 * and transfers results back with zero-copy Transferable arrays.
 *
 * Two builder paths:
 * - HarfBuzz-shaped: when shaper is initialized (INIT_FONT), uses
 *   buildShapedBatchBuffers() which emits HarfBuzz glyph IDs for Slug rendering.
 * - Legacy fallback: grapheme-based buildBatchBuffers() with atlas UV map.
 *
 * Caches UV map to avoid repeated serialization (legacy path).
 *
 * HarfBuzz integration: INIT_FONT message initializes a per-worker
 * HarfBuzzShaper instance with the font buffer and WASM URL sent from
 * the main thread. CLEANUP destroys the shaper to free WASM memory.
 */

import { buildGlyphBuffers, buildBatchBuffers, buildShapedBatchBuffers } from './builders/index.js';
import HarfBuzzShaper from '../shaping/HarfBuzzShaper.js';

// Cached UV map and per-glyph widths (sent once, reused)
let cachedUVMap = null;
let cachedGlyphWidths = null;

// HarfBuzz shaper instance (initialized via INIT_FONT message)
let shaper = null;

// Set of glyph IDs known to have 0 curves (space, .notdef) — avoids redundant checks
let emptyGlyphCache = null;

/**
 * Handle incoming messages
 */
self.onmessage = async function(event) {
    const { type, jobId, payload } = event.data;

    try {
        switch (type) {
            case 'INIT_FONT': {
                // Initialize HarfBuzz WASM + load font in this worker.
                // Main thread sends fontBuffer (structured clone) and the
                // absolute wasmUrl so we can locate hb.wasm.
                shaper = new HarfBuzzShaper();
                await shaper.init(payload.fontBuffer, payload.wasmUrl);
                self.postMessage({ type: 'FONT_READY', jobId });
                break;
            }

            case 'CLEANUP': {
                // Destroy HarfBuzz objects to free WASM memory
                if (shaper) {
                    shaper.destroy();
                    shaper = null;
                }
                self.postMessage({ type: 'CLEANUP_DONE', jobId });
                break;
            }

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

                if (shaper && shaper.ready) {
                    // HarfBuzz-shaped path — emit glyph IDs for Slug rendering
                    const shared = {
                        metrics: payload.shared.metrics,
                        defaultColor: payload.shared.defaultColor,
                    };
                    // Lazy-build empty glyph cache from emptyGlyphs in payload
                    if (!emptyGlyphCache && payload.shared.emptyGlyphs) {
                        emptyGlyphCache = new Set(payload.shared.emptyGlyphs);
                    }
                    result = buildShapedBatchBuffers(payload.items, shared, shaper, emptyGlyphCache);
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
