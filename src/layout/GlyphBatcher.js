/**
 * @deprecated This file is no longer used. Worker-based rendering handles
 * batching directly in builders/index.js. Safe to delete.
 *
 * GlyphBatcher - Efficient batch management for glyph rendering
 *
 * Manages batching of glyphs for optimal GPU performance.
 * Handles sorting, culling, and state management.
 *
 * Uses the atlas's improved UV handling with proper insets
 * to prevent bleeding artifacts.
 */

class GlyphBatcher {
    /**
     * Create a glyph batcher
     * @param {Object} metrics - Font metrics from renderer (via RenderingConstants)
     * @param {GlyphAtlas} atlas - Glyph atlas with UV insets for quality
     */
    constructor(metrics, atlas) {
        this.metrics = metrics;
        this.atlas = atlas;

        // Batch state
        this.currentBatch = [];
        this.batchSize = 0;
        this.isDirty = false;

        // Performance tracking
        this.stats = {
            batchesCreated: 0,
            glyphsProcessed: 0,
            lastBatchSize: 0
        };
    }

    /**
     * Start a new batch
     */
    begin() {
        this.currentBatch = [];
        this.batchSize = 0;
        this.isDirty = false;
    }

    /**
     * Add text to the current batch
     * @param {string} text - Text to add
     * @param {Object} position - Starting position
     * @param {Object} options - Rendering options
     */
    addText(text, position, options = {}) {
        const {
            color = { r: 1, g: 1, b: 1 },
            scale = 1.0,
            letterSpacing = this.metrics.letterSpacing
        } = options;

        let x = position.x;
        const y = position.y;
        const z = position.z;

        // Process each character
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Handle special characters
            if (char === ' ') {
                x += (this.metrics.charWidth + letterSpacing) * scale;
                continue;
            }

            if (char === '\n') {
                x = position.x;
                position.y -= this.metrics.lineSpacing * scale;
                continue;
            }

            // Get UV coordinates
            const uv = this.atlas.getUV(char.charCodeAt(0));
            if (!uv) {
                // Skip unsupported characters
                x += (this.metrics.charWidth + letterSpacing) * scale;
                continue;
            }

            // Add glyph to batch
            this.currentBatch.push({
                position: { x, y, z },
                size: {
                    width: this.metrics.charWidth * scale,
                    height: this.metrics.charHeight * scale
                },
                uv: uv,
                color: color,
                char: char  // Keep for debugging
            });

            // Advance cursor
            x += (this.metrics.charWidth + letterSpacing) * scale;
            this.batchSize++;
        }

        this.isDirty = true;
        this.stats.glyphsProcessed += text.length;
    }

    /**
     * Add a single glyph to the batch
     * @param {Object} glyph - Glyph data
     */
    addGlyph(glyph) {
        this.currentBatch.push(glyph);
        this.batchSize++;
        this.isDirty = true;
        this.stats.glyphsProcessed++;
    }

    /**
     * Add multiple glyphs at once
     * @param {Array} glyphs - Array of glyph data
     */
    addGlyphs(glyphs) {
        this.currentBatch.push(...glyphs);
        this.batchSize += glyphs.length;
        this.isDirty = true;
        this.stats.glyphsProcessed += glyphs.length;
    }

    /**
     * Get the current batch
     * @returns {Array} Current batch of glyphs
     */
    getBatch() {
        return this.currentBatch;
    }

    /**
     * Finalize and return the batch
     * @returns {Object} Batch data ready for rendering
     */
    finalize() {
        if (!this.isDirty || this.batchSize === 0) {
            return null;
        }

        // Sort by Z for proper depth ordering (if needed)
        // this.currentBatch.sort((a, b) => b.position.z - a.position.z);

        const result = {
            glyphs: this.currentBatch,
            count: this.batchSize
        };

        // Update stats
        this.stats.batchesCreated++;
        this.stats.lastBatchSize = this.batchSize;

        // Reset for next batch
        this.begin();

        return result;
    }

    /**
     * Apply frustum culling to batch
     * @param {THREE.Frustum} frustum - Camera frustum
     * @returns {Array} Visible glyphs
     */
    cullToFrustum(frustum) {
        // TODO: Implement frustum culling
        // For now, return all glyphs
        return this.currentBatch;
    }

    /**
     * Sort batch by distance from camera
     * @param {THREE.Vector3} cameraPosition - Camera position
     */
    sortByDistance(cameraPosition) {
        this.currentBatch.sort((a, b) => {
            const distA = Math.sqrt(
                Math.pow(a.position.x - cameraPosition.x, 2) +
                Math.pow(a.position.y - cameraPosition.y, 2) +
                Math.pow(a.position.z - cameraPosition.z, 2)
            );
            const distB = Math.sqrt(
                Math.pow(b.position.x - cameraPosition.x, 2) +
                Math.pow(b.position.y - cameraPosition.y, 2) +
                Math.pow(b.position.z - cameraPosition.z, 2)
            );
            return distA - distB;
        });
    }

    /**
     * Merge another batch into this one
     * @param {GlyphBatcher} otherBatcher - Batcher to merge from
     */
    merge(otherBatcher) {
        const otherBatch = otherBatcher.getBatch();
        this.addGlyphs(otherBatch);
    }

    /**
     * Clear the current batch
     */
    clear() {
        this.currentBatch = [];
        this.batchSize = 0;
        this.isDirty = false;
    }

    /**
     * Get batcher statistics
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            ...this.stats,
            currentBatchSize: this.batchSize
        };
    }

    /**
     * Check if batch needs updating
     * @returns {boolean} True if batch has changes
     */
    needsUpdate() {
        return this.isDirty;
    }

    /**
     * Optimize batch by removing duplicates and merging adjacent glyphs
     */
    optimize() {
        if (this.batchSize < 2) return;

        // Remove duplicate glyphs at same position
        const seen = new Set();
        const optimized = [];

        for (const glyph of this.currentBatch) {
            const key = `${glyph.position.x.toFixed(3)},${glyph.position.y.toFixed(3)},${glyph.position.z.toFixed(3)},${glyph.char}`;
            if (!seen.has(key)) {
                seen.add(key);
                optimized.push(glyph);
            }
        }

        this.currentBatch = optimized;
        this.batchSize = optimized.length;
    }
}

export default GlyphBatcher;