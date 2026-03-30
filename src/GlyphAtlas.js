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

        // Track canvas texture update state (for deferred Three.js re-upload via checkAndClearTextureUpdate)
        this.textureNeedsUpdate = false;

        // UV map version counter — incremented on every ensureCodepoints() call that
        // adds new glyphs. WorkerBridge uses this to detect stale serialized UV maps
        // and reset per-worker _hasUVMap flags so fresh maps are re-sent to workers.
        this._uvMapVersion = 0;
    }

    _buildCharset() {
        const chars = [];

        // Printable ASCII (32-126)
        for (let i = 32; i < 127; i++) {
            chars.push(i);
        }

        // Box drawing characters — full range (thin, heavy, double, rounded)
        for (let i = 0x2500; i <= 0x257F; i++) {
            chars.push(i);
        }

        // Block elements
        for (let i = 0x2580; i <= 0x259F; i++) {
            chars.push(i);
        }

        // Arrows
        for (let i = 0x2190; i <= 0x21FF; i++) {
            chars.push(i);
        }

        // Common symbols: check marks, bullets, stars, geometric shapes
        const symbols = [
            0x2713, 0x2714, // ✓ ✔
            0x2717, 0x2718, // ✗ ✘
            0x2022, 0x2023, // • ‣
            0x25A0, 0x25A1, // ■ □
            0x25B2, 0x25B6, 0x25BC, 0x25C0, // ▲ ▶ ▼ ◀
            0x25C6, 0x25CB, 0x25CF, // ◆ ○ ●
            0x2605, 0x2606, // ★ ☆
            0x2026, // …
            0x2014, 0x2013, // — –
            0x201C, 0x201D, 0x2018, 0x2019, // " " ' '
        ];
        chars.push(...symbols);

        // Extended ASCII / Latin-1
        for (let i = 160; i < 256; i++) {
            chars.push(i);
        }

        return chars;
    }

    async generate(progressCallback) {
        console.debug(`[GlyphAtlas] Generating: ${this.charset.length} glyphs, ${this.fontFamily} ${this.fontSize}px, ${this.atlasSize}x${this.atlasSize}`);

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

        console.debug(`[GlyphAtlas] Cell size: ${this.standardCellWidth}x${this.standardCellHeight}`);

        // Render each glyph using shelf packing
        for (let i = 0; i < this.charset.length; i++) {
            const charCode = this.charset[i];

            // Use shelf packing to place glyph
            const uv = this._packGlyph(charCode);

            if (!uv) {
                console.warn(`Atlas full at glyph ${i}/${this.charset.length}`);
                break;
            }

            // If the atlas map DataTexture was created before generate() was called
            // (e.g., under shared-renderer architecture), update it in-place now.
            if (this._atlasMapTexture) {
                this._updateAtlasMapEntry(charCode, uv);
            }

            // Progress callback - update every 10 glyphs AND on last iteration
            if (progressCallback && (i % 10 === 0 || i === this.charset.length - 1)) {
                progressCallback(i + 1, this.charset.length);
                // Yield to browser to keep UI responsive
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // If a shared CanvasTexture exists (same latent pre-construction case),
        // mark it for re-upload on the next render pass.
        if (this._sharedThreeTexture) {
            this._sharedThreeTexture.needsUpdate = true;
        }

        console.debug(`[GlyphAtlas] Generated: ${this.packingState.glyphsAdded} glyphs in ${this.atlasCanvas.width}x${this.atlasCanvas.height}`);

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

        // Pre-allocate for full Unicode range (U+0000–U+10FFFF): 1024 wide × 1088 rows.
        // Math.ceil(0x110000 / 1024) = 1088 rows; 1024 * 1088 = 1,114,112 texels.
        // ~17.8 MB of Float32 data. Allocated once; never needs to grow, so every
        // GlyphRenderer's uniform reference stays valid for the lifetime of the atlas.
        const ATLAS_MAP_WIDTH = 1024;
        const ATLAS_MAP_HEIGHT = Math.ceil(0x110000 / 1024); // 1088 — full Unicode
        const totalTexels = ATLAS_MAP_WIDTH * ATLAS_MAP_HEIGHT;

        const data = new Float32Array(totalTexels * 4);

        // Fill in current UV mappings
        for (const [code, uv] of this.uvMap) {
            if (code >= totalTexels) continue;
            const base = code * 4;
            data[base]     = uv.u0;
            data[base + 1] = 1.0 - uv.v1; // pre-flip V: bottom edge in WebGL
            data[base + 2] = uv.u1;
            data[base + 3] = 1.0 - uv.v0; // pre-flip V: top edge in WebGL
        }

        const texture = new THREE.DataTexture(
            data,
            ATLAS_MAP_WIDTH,
            ATLAS_MAP_HEIGHT,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        // Store metadata on the texture for shader use
        texture.userData = { width: ATLAS_MAP_WIDTH, height: ATLAS_MAP_HEIGHT };

        this._atlasMapTexture = texture;
        this._atlasMapTextureWidth = ATLAS_MAP_WIDTH;
        this._atlasMapTextureHeight = ATLAS_MAP_HEIGHT;

        console.debug(`[GlyphAtlas] Atlas map DataTexture: ${ATLAS_MAP_WIDTH}x${ATLAS_MAP_HEIGHT}, glyphs=${this.uvMap.size}`);

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
     * Unified entry point for ensuring codepoints are present in the atlas.
     *
     * Atomically handles all side effects of adding new glyphs:
     * 1. Packs each missing codepoint via _packGlyph() (canvas 2D draw)
     * 2. Updates the GPU atlas map DataTexture in-place via _updateAtlasMapEntry()
     *    (if the DataTexture exists)
     * 3. Sets textureNeedsUpdate = true so GlyphRenderer picks up the CanvasTexture
     *    re-upload flag at draw time via checkAndClearTextureUpdate()
     * 4. Sets _atlasMapTexture.needsUpdate = true immediately — the DataTexture is
     *    shared by reference across all renderers, so one flag covers all
     * 5. Invalidates the serialized UV map cache used by WorkerBridge
     * 6. Increments _uvMapVersion so WorkerBridge detects the change and resets
     *    per-worker _hasUVMap flags on its next getSerializedUVMap() call
     *
     * Safe to call on the main thread immediately before worker dispatch.
     * Workers cannot access DOM or Three.js canvas — all atlas mutations must
     * happen here before the UV map snapshot is serialized for worker transfer.
     *
     * @param {number[]} codepoints - Array of Unicode code points to ensure
     * @returns {number} Count of newly-added glyphs
     */
    ensureCodepoints(codepoints) {
        if (!this.ctx) {
            console.warn('GlyphAtlas.ensureCodepoints: atlas not initialized. Call generate() first.');
            return 0;
        }
        this._setupContextFont();

        let added = 0;
        for (const code of codepoints) {
            if (this.uvMap.has(code)) continue;
            const uv = this._packGlyph(code);
            if (uv) {
                added++;
                if (this._atlasMapTexture) {
                    this._updateAtlasMapEntry(code, uv);
                }
            } else {
                console.warn(`GlyphAtlas: atlas full, cannot pack codepoint ${code} (${String.fromCodePoint(code)})`);
            }
        }

        if (added > 0) {
            // CanvasTexture: set flag for deferred renderer-poll at draw time.
            // GlyphRenderer calls checkAndClearTextureUpdate() at render entry and
            // sets this.texture.needsUpdate = true only then, batching multiple
            // same-frame ensureCodepoints() calls into a single GPU re-upload.
            this.textureNeedsUpdate = true;

            // DataTexture: mark for re-upload immediately. The DataTexture is shared
            // by reference across all renderers — one needsUpdate = true here covers
            // all of them. Three.js defers the actual GPU transfer to next draw call.
            if (this._atlasMapTexture) {
                this._atlasMapTexture.needsUpdate = true;
            }

            this.invalidateSerializedCache();
            this._uvMapVersion++;
            console.debug(`[GlyphAtlas] ensureCodepoints: +${added} glyphs`);
        }

        return added;
    }

    /**
     * Add a glyph to the atlas if it doesn't exist.
     * Thin wrapper around ensureCodepoints() — preserves original return-value contract.
     * @param {number} charCode - Unicode code point
     * @returns {Object|null} UV coordinates {u0, v0, u1, v1} or null if atlas is full
     */
    addGlyphIfMissing(charCode) {
        if (this.uvMap.has(charCode)) {
            return this.uvMap.get(charCode);
        }
        this.ensureCodepoints([charCode]);
        return this.uvMap.get(charCode) || null;
    }

    /**
     * Add multiple glyphs at once.
     * Thin wrapper around ensureCodepoints() — preserves original return-value contract.
     * @param {number[]} charCodes - Array of Unicode code points
     * @returns {Map<number, Object|null>} Map of charCode to UV coordinates
     */
    addGlyphsIfMissing(charCodes) {
        const newCodes = charCodes.filter(c => !this.uvMap.has(c));
        if (newCodes.length > 0) {
            this.ensureCodepoints(newCodes);
        }
        const results = new Map();
        for (const c of charCodes) {
            results.set(c, this.uvMap.get(c) || null);
        }
        return results;
    }

    /**
     * Write a single glyph's UV rect into the shared atlas map DataTexture.
     * No-op if the texture hasn't been created yet (pre-generate() calls).
     * @param {number} charCode - Unicode codepoint
     * @param {Object} uv - {u0, v0, u1, v1}
     */
    _updateAtlasMapEntry(charCode, uv) {
        const tex = this._atlasMapTexture;
        if (!tex) return; // texture not yet created — will be filled on first getAtlasMapTexture()

        const totalTexels = this._atlasMapTextureWidth * this._atlasMapTextureHeight;
        if (charCode >= totalTexels) return; // outside pre-allocated Unicode range

        const data = tex.image.data;
        const base = charCode * 4;
        data[base]     = uv.u0;
        data[base + 1] = 1.0 - uv.v1;
        data[base + 2] = uv.u1;
        data[base + 3] = 1.0 - uv.v0;
        tex.needsUpdate = true;
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

    /**
     * Current UV map version. Incremented each time ensureCodepoints() adds new glyphs.
     * WorkerBridge uses this to detect when the serialized UV map cache is stale
     * and to reset per-worker _hasUVMap flags so workers receive the updated map.
     * @returns {number}
     */
    get uvMapVersion() {
        return this._uvMapVersion;
    }
}

export default GlyphAtlas;
