/**
 * Glyph Atlas Generator (Browser Version)
 *
 * Generates a texture atlas of font glyphs using Canvas 2D API.
 * This is the browser equivalent of our Python Cairo/Pango implementation.
 */

class GlyphAtlas {
    constructor(fontFamily = 'Monaco, Menlo, Courier New, monospace', fontSize = 48, atlasSize = 2048) {
        this.fontFamily = fontFamily;
        this.fontSize = fontSize;  // Default 48px for crisp rendering (was 16px - too small)
        this.atlasSize = atlasSize;
        this.glyphPadding = 6;  // Increased padding for larger glyphs

        // UV coordinate mapping: charCode → {u0, v0, u1, v1}
        this.uvMap = new Map();

        // Glyph metrics: charCode → {width, height, advance}
        this.metrics = new Map();

        // The actual atlas texture
        this.atlasTexture = null;
        this.atlasCanvas = null;

        // Character set to render
        this.charset = this._buildCharset();

        // Shelf packing state for dynamic glyph addition
        this.packingState = {
            currentX: 0,
            currentY: 0,
            currentRowHeight: 0,
            glyphsAdded: 0
        };

        // Canvas context preserved for dynamic additions
        this.ctx = null;

        // Track texture update state (for Three.js integration)
        this.textureNeedsUpdate = false;
    }

    _buildCharset() {
        const chars = [];

        // Printable ASCII (32-126)
        for (let i = 32; i < 127; i++) {
            chars.push(i);
        }

        // Box drawing characters (common in tmux)
        const boxDrawing = [
            0x2500, // ─
            0x2502, // │
            0x250C, // ┌
            0x2510, // ┐
            0x2514, // └
            0x2518, // ┘
            0x251C, // ├
            0x2524, // ┤
            0x252C, // ┬
            0x2534, // ┴
            0x253C, // ┼
        ];
        chars.push(...boxDrawing);

        // Block elements
        for (let i = 0x2580; i <= 0x258F; i++) {
            chars.push(i);
        }

        // Extended ASCII / Latin-1
        for (let i = 160; i < 256; i++) {
            chars.push(i);
        }

        return chars;
    }

    async generate(progressCallback) {
        console.log(`Generating glyph atlas: ${this.charset.length} glyphs`);
        console.log(`  Font: ${this.fontFamily} ${this.fontSize}px`);
        console.log(`  Atlas size: ${this.atlasSize}x${this.atlasSize}`);

        // Create canvas for atlas
        this.atlasCanvas = document.createElement('canvas');
        this.atlasCanvas.width = this.atlasSize;
        this.atlasCanvas.height = this.atlasSize;
        this.ctx = this.atlasCanvas.getContext('2d', { willReadFrequently: true });

        // Clear to transparent
        this.ctx.clearRect(0, 0, this.atlasSize, this.atlasSize);

        // Enable better text rendering
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        // Set font with subpixel rendering
        this._setupContextFont();

        // Calculate standard glyph cell dimensions for shelf packing
        const metrics = this.ctx.measureText('M');
        this.standardCellWidth = Math.ceil(metrics.width) + this.glyphPadding * 2;
        this.standardCellHeight = this.fontSize + 12 + this.glyphPadding * 2;

        // Baseline offset for consistent rendering
        this.baselineOffset = this.fontSize * 0.02;

        // Conservative glyph height to avoid bleeding
        this.glyphHeight = this.fontSize * 1.15;

        // UV insets for edge bleeding prevention
        this.uvInsets = {
            horizontal: 0.25,
            top: 1.0,
            bottom: 0.5
        };

        // Reset packing state
        this.packingState = {
            currentX: 0,
            currentY: 0,
            currentRowHeight: 0,
            glyphsAdded: 0
        };

        console.log(`  Cell size: ${this.standardCellWidth}x${this.standardCellHeight}`);

        // Render each glyph using shelf packing
        for (let i = 0; i < this.charset.length; i++) {
            const charCode = this.charset[i];

            // Use shelf packing to place glyph
            const uv = this._packGlyph(charCode);

            if (!uv) {
                console.warn(`Atlas full at glyph ${i}/${this.charset.length}`);
                break;
            }

            // Progress callback - update every 10 glyphs AND on last iteration
            if (progressCallback && (i % 10 === 0 || i === this.charset.length - 1)) {
                progressCallback(i + 1, this.charset.length);
                // Yield to browser to keep UI responsive
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        console.log('✅ Atlas generated successfully');
        console.log(`  ${this.packingState.glyphsAdded} glyphs in ${this.atlasCanvas.width}x${this.atlasCanvas.height} atlas`);
        console.log(`  Packing stats:`, this.getPackingStats());

        return this.atlasCanvas;
    }

    /**
     * Setup canvas context font properties
     * @private
     */
    _setupContextFont() {
        this.ctx.font = `${this.fontSize}px ${this.fontFamily}`;
        this.ctx.textBaseline = 'top';
        this.ctx.fillStyle = '#ffffff';
        this.ctx.textAlign = 'left';
    }

    /**
     * Pack a single glyph into the atlas using shelf packing algorithm
     * @private
     * @param {number} charCode - Unicode code point
     * @returns {Object|null} UV coordinates or null if atlas is full
     */
    _packGlyph(charCode) {
        const char = String.fromCodePoint(charCode);

        // Measure glyph width
        const glyphMetrics = this.ctx.measureText(char);
        const glyphWidth = Math.ceil(glyphMetrics.width);

        // Calculate cell dimensions with padding
        const cellWidth = glyphWidth + this.glyphPadding * 2;
        const cellHeight = this.standardCellHeight;

        // Shelf packing: check if glyph fits in current row
        if (this.packingState.currentX + cellWidth > this.atlasSize) {
            // Start new row
            this.packingState.currentY += this.packingState.currentRowHeight;
            this.packingState.currentX = 0;
            this.packingState.currentRowHeight = 0;
        }

        // Check if we've run out of vertical space
        if (this.packingState.currentY + cellHeight > this.atlasSize) {
            console.warn(`Atlas overflow: cannot fit charCode ${charCode} (${char})`);
            return null;
        }

        // Place glyph at current position
        const x = this.packingState.currentX + this.glyphPadding;
        const y = this.packingState.currentY + this.glyphPadding;

        // Render glyph
        this.ctx.fillText(char, x, y + this.baselineOffset);

        // Store metrics
        this.metrics.set(charCode, {
            width: glyphWidth,
            height: this.glyphHeight,
            advance: glyphWidth
        });

        // Calculate UV coordinates with insets
        const u0 = (x + this.uvInsets.horizontal) / this.atlasSize;
        const v0 = (y + this.baselineOffset + this.uvInsets.top) / this.atlasSize;
        const u1 = (x + glyphWidth - this.uvInsets.horizontal) / this.atlasSize;
        const v1 = (y + this.baselineOffset + this.glyphHeight - this.uvInsets.bottom) / this.atlasSize;

        const uv = { u0, v0, u1, v1 };
        this.uvMap.set(charCode, uv);

        // Advance cursor (shelf packing)
        this.packingState.currentX += cellWidth;
        this.packingState.currentRowHeight = Math.max(
            this.packingState.currentRowHeight,
            cellHeight
        );
        this.packingState.glyphsAdded++;

        return uv;
    }

    getUV(charCode) {
        // Return UV if found, otherwise return '?' as fallback
        return this.uvMap.get(charCode) || this.uvMap.get(63) || { u0: 0, v0: 0, u1: 0, v1: 0 };
    }

    getMetrics(charCode) {
        return this.metrics.get(charCode);
    }

    getCharSize() {
        // Use 'M' as reference
        const metrics = this.metrics.get(77); // 'M'
        return metrics ? { width: metrics.width, height: metrics.height } : { width: this.fontSize, height: this.fontSize };
    }

    /**
     * Get UV map as a serializable plain object (cached)
     * Used by Web Workers which can't access Map objects directly.
     *
     * @returns {Object} Plain object: charCode (as string key) → {u0, v0, u1, v1}
     */
    getSerializableUVMap() {
        // Return cached version if available
        if (this._serializedUVMapCache) {
            return this._serializedUVMapCache;
        }

        // Build and cache
        const map = {};
        for (const [charCode, uv] of this.uvMap) {
            map[charCode] = uv;
        }
        this._serializedUVMapCache = map;
        return map;
    }

    /**
     * Invalidate the serialized UV map cache
     * Call this if glyphs are added dynamically
     */
    invalidateSerializedCache() {
        this._serializedUVMapCache = null;
    }

    /**
     * Get all glyph char codes in the atlas
     * @returns {Array<number>}
     */
    getGlyphCodes() {
        return Array.from(this.uvMap.keys());
    }

    getAtlasTexture() {
        return this.atlasCanvas;
    }

    /**
     * Get shared Three.js texture (created once, reused by all renderers)
     * @param {THREE} THREE - Three.js module reference
     * @returns {THREE.CanvasTexture} Shared texture instance
     */
    getSharedThreeTexture(THREE) {
        if (!this._sharedThreeTexture) {
            this._sharedThreeTexture = new THREE.CanvasTexture(this.atlasCanvas);
            this._sharedThreeTexture.minFilter = THREE.LinearMipmapLinearFilter;
            this._sharedThreeTexture.magFilter = THREE.LinearFilter;
            this._sharedThreeTexture.generateMipmaps = true;
            this._sharedThreeTexture.anisotropy = 4;
            this._sharedThreeTexture.needsUpdate = true;
        }
        return this._sharedThreeTexture;
    }

    /**
     * Build the GPU-lookup DataTexture that maps a Unicode codepoint directly
     * to its atlas UV rect. This is the heart of the GPU codepoint → UV path:
     * instead of the CPU pre-computing UV coordinates per glyph, each glyph
     * instance only stores its raw codepoint (`instanceCodepoint`), and the
     * vertex shader performs a single `texture2D` fetch here to resolve the UV.
     *
     * Layout: 1024 texels wide × ceil(maxCodepoint / 1024) rows tall, RGBA Float.
     * Each texel stores (u0, v0_webgl, u1, v1_webgl) for that codepoint.
     * Codepoints not in the atlas have all-zero texels (treated as missing).
     *
     * V coordinates are pre-flipped here (1.0 - v) so the shader incurs no
     * canvas→WebGL coordinate conversion at draw time.
     *
     * Vertex shader lookup (see textVertex.glsl):
     *   float mapCol = mod(cp, atlasMapWidth);
     *   float mapRow = floor(cp / atlasMapWidth);
     *   float tx = (mapCol + 0.5) / atlasMapWidth;
     *   float ty = (mapRow + 0.5) / atlasMapHeight;
     *   vec4 uvRect = texture2D(atlasMapTexture, vec2(tx, ty));
     *   vUv = mix(uvRect.xy, uvRect.zw, uv);  // bilinear interp across quad
     *
     * Texture is created once and cached. Call this before constructing any
     * GlyphRenderer so the uniforms can be populated at mesh creation time.
     *
     * @param {THREE} THREE - Three.js module reference
     * @returns {THREE.DataTexture} Atlas map texture (shared, created once)
     */
    getAtlasMapTexture(THREE) {
        if (this._atlasMapTexture) {
            return this._atlasMapTexture;
        }

        // Find the maximum codepoint in the atlas
        let maxCode = 0;
        for (const code of this.uvMap.keys()) {
            if (code > maxCode) maxCode = code;
        }

        const ATLAS_MAP_WIDTH = 1024;
        const rows = Math.ceil((maxCode + 1) / ATLAS_MAP_WIDTH);
        const height = Math.max(rows, 1);
        const totalTexels = ATLAS_MAP_WIDTH * height;

        // RGBA float: 4 floats per texel
        const data = new Float32Array(totalTexels * 4);

        for (const [code, uv] of this.uvMap) {
            const texelIdx = code; // direct codepoint index
            if (texelIdx >= totalTexels) continue;
            const base = texelIdx * 4;
            data[base]     = uv.u0;
            data[base + 1] = 1.0 - uv.v1; // pre-flip V: bottom edge in WebGL
            data[base + 2] = uv.u1;
            data[base + 3] = 1.0 - uv.v0; // pre-flip V: top edge in WebGL
        }

        const texture = new THREE.DataTexture(
            data,
            ATLAS_MAP_WIDTH,
            height,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        // Store metadata on the texture for shader use
        texture.userData = { width: ATLAS_MAP_WIDTH, height };

        this._atlasMapTexture = texture;
        this._atlasMapTextureWidth = ATLAS_MAP_WIDTH;
        this._atlasMapTextureHeight = height;

        console.log(`[GPU-Lookup] Atlas map DataTexture built: ${ATLAS_MAP_WIDTH}x${height} RGBA Float, maxCodepoint=${maxCode}, glyphs=${this.uvMap.size}. Vertex shader will look up UV rects from this texture at draw time.`);

        return texture;
    }

    /**
     * Get the dimensions of the atlas map DataTexture.
     *
     * Must call {@link getAtlasMapTexture} at least once before using this,
     * otherwise returns the default fallback dimensions (1024 x 1).
     *
     * The dimensions are passed to the vertex shader as `atlasMapWidth` and
     * `atlasMapHeight` uniforms so it can correctly convert a flat codepoint
     * index into a (tx, ty) texel coordinate.
     *
     * @returns {{width: number, height: number}} Width is always 1024; height is
     *   ceil((maxCodepoint + 1) / 1024).
     */
    getAtlasMapDimensions() {
        return {
            width: this._atlasMapTextureWidth || 1024,
            height: this._atlasMapTextureHeight || 1
        };
    }

    // For debugging
    saveDebug() {
        const link = document.createElement('a');
        link.download = 'glyph_atlas.png';
        link.href = this.atlasCanvas.toDataURL();
        link.click();
    }

    // ========================================
    // Dynamic Glyph Addition API
    // ========================================

    /**
     * Check if a glyph is already in the atlas
     * @param {number} charCode - Unicode code point
     * @returns {boolean} True if glyph exists in atlas
     */
    hasGlyph(charCode) {
        return this.uvMap.has(charCode);
    }

    /**
     * Add a glyph to the atlas if it doesn't exist
     * Uses shelf packing to find placement
     * @param {number} charCode - Unicode code point
     * @returns {Object|null} UV coordinates {u0, v0, u1, v1} or null if atlas is full
     */
    addGlyphIfMissing(charCode) {
        // Already have it?
        if (this.uvMap.has(charCode)) {
            return this.uvMap.get(charCode);
        }

        // Atlas not initialized?
        if (!this.ctx) {
            console.warn('GlyphAtlas: Cannot add glyph - atlas not initialized. Call generate() first.');
            return null;
        }

        // Ensure font settings are correct (in case context was modified externally)
        this._setupContextFont();

        // Pack the glyph
        const uv = this._packGlyph(charCode);

        if (uv) {
            // Mark texture as needing update
            this.textureNeedsUpdate = true;

            // Invalidate atlas map DataTexture cache — must be rebuilt on next
            // getAtlasMapTexture() call to include this newly-packed glyph.
            this._atlasMapTexture = null;

            // Invalidate serialized cache since UV map changed
            this.invalidateSerializedCache();

            console.log(`Dynamic glyph added: ${charCode} (${String.fromCodePoint(charCode)})`);
        }

        return uv;
    }

    /**
     * Add multiple glyphs at once (more efficient than individual calls)
     * @param {number[]} charCodes - Array of Unicode code points
     * @returns {Map<number, Object|null>} Map of charCode to UV coordinates
     */
    addGlyphsIfMissing(charCodes) {
        const results = new Map();

        if (!this.ctx) {
            console.warn('GlyphAtlas: Cannot add glyphs - atlas not initialized. Call generate() first.');
            for (const code of charCodes) {
                results.set(code, null);
            }
            return results;
        }

        // Ensure font settings are correct
        this._setupContextFont();

        let added = 0;
        for (const charCode of charCodes) {
            if (this.uvMap.has(charCode)) {
                results.set(charCode, this.uvMap.get(charCode));
            } else {
                const uv = this._packGlyph(charCode);
                results.set(charCode, uv);
                if (uv) added++;
            }
        }

        if (added > 0) {
            this.textureNeedsUpdate = true;

            // Invalidate atlas map DataTexture cache — must be rebuilt on next
            // getAtlasMapTexture() call to include newly-packed glyphs.
            this._atlasMapTexture = null;

            // Invalidate serialized cache since UV map changed
            this.invalidateSerializedCache();
            console.log(`Dynamic glyphs batch added: ${added} new glyphs`);
        }

        return results;
    }

    /**
     * Get packing statistics for the atlas
     * @returns {Object} Stats object with usedArea, freeArea, rowCount, canAddMore
     */
    getPackingStats() {
        const totalArea = this.atlasSize * this.atlasSize;

        // Calculate used area (approximate based on current position)
        const usedHeight = this.packingState.currentY + this.packingState.currentRowHeight;
        const usedArea = this.packingState.currentY * this.atlasSize +
                         this.packingState.currentX * this.packingState.currentRowHeight;

        // More accurate: count rows and estimate
        const rowCount = Math.ceil(usedHeight / this.standardCellHeight);

        // Can we add at least one more standard glyph?
        const canAddMore = (
            (this.packingState.currentX + this.standardCellWidth <= this.atlasSize) ||
            (this.packingState.currentY + this.packingState.currentRowHeight + this.standardCellHeight <= this.atlasSize)
        );

        return {
            usedArea: Math.round(usedArea),
            freeArea: Math.round(totalArea - usedArea),
            usedPercent: ((usedArea / totalArea) * 100).toFixed(1),
            rowCount,
            glyphCount: this.packingState.glyphsAdded,
            canAddMore,
            currentPosition: {
                x: this.packingState.currentX,
                y: this.packingState.currentY,
                rowHeight: this.packingState.currentRowHeight
            }
        };
    }

    /**
     * Force texture update flag
     * Call this after adding glyphs to signal Three.js to re-upload
     */
    updateTexture() {
        this.textureNeedsUpdate = true;
    }

    /**
     * Check and clear the texture update flag
     * @returns {boolean} True if texture was updated since last check
     */
    checkAndClearTextureUpdate() {
        const needsUpdate = this.textureNeedsUpdate;
        this.textureNeedsUpdate = false;
        return needsUpdate;
    }

    /**
     * Get all glyphs currently in the atlas
     * @returns {number[]} Array of character codes
     */
    getGlyphCodes() {
        return Array.from(this.uvMap.keys());
    }

    /**
     * Get the number of glyphs in the atlas
     * @returns {number} Glyph count
     */
    get glyphCount() {
        return this.uvMap.size;
    }
}

export default GlyphAtlas;
