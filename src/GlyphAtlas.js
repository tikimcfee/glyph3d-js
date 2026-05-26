/**
 * Glyph Atlas Generator (Browser Version)
 *
 * Generates a texture atlas of font glyphs using Canvas 2D API.
 * This is the browser equivalent of our Python Cairo/Pango implementation.
 *
 * ### Grapheme-cluster aware (Phase A fix)
 *
 * The atlas is now keyed by grapheme cluster string rather than Unicode
 * codepoint number. This correctly handles:
 *   - Supplementary plane characters (emoji, CJK Extension B) that JS splits
 *     into two UTF-16 surrogates — each is a single grapheme string.
 *   - ZWJ sequences (family emoji, skin-tone modifiers) — the full sequence
 *     is one grapheme string; Canvas fillText renders it as one glyph.
 *
 * Key maps:
 *   uvMap          Map<string, UV>    grapheme string → atlas UV rect
 *   metrics        Map<string, Metrics> grapheme string → pixel metrics
 *   _graphemeIds   Map<string, number>  grapheme string → numeric DataTexture ID
 *   _nextSyntheticId  number           dense counter for multi-codepoint graphemes
 *
 * Numeric IDs:
 *   - Single-codepoint graphemes: ID = the codepoint (backward compatible with
 *     the existing DataTexture layout and shader codepoint lookup).
 *   - Multi-codepoint graphemes: ID = _nextSyntheticId++ (dense, starting
 *     above the highest codepoint in the initial charset). Hard cap: 4096
 *     synthetic IDs. This keeps the DataTexture compact (~10-15 rows).
 */

class GlyphAtlas {
    constructor(fontFamily = 'Monaco, Menlo, Courier New, monospace', fontSize = 48, atlasSize = 2048) {
        this.fontFamily = fontFamily;
        this.fontSize = fontSize;  // Default 48px for crisp rendering (was 16px - too small)
        this.atlasSize = atlasSize;
        // Pixel gap between glyph cells in the atlas — scales with font size
        // to prevent Canvas 2D anti-aliasing from bleeding into neighbors.
        this.glyphPadding = Math.max(6, Math.ceil(fontSize / 6));

        // UV coordinate mapping: grapheme string → {u0, v0, u1, v1}
        this.uvMap = new Map();

        // Glyph metrics: grapheme string → {width, height, advance}
        this.metrics = new Map();

        // Grapheme string → numeric DataTexture ID
        // Single-codepoint graphemes: ID = codepoint (backward compat with shader)
        // Multi-codepoint graphemes: ID = dense synthetic counter
        this._graphemeIds = new Map();

        // Dense numeric ID counter for multi-codepoint graphemes.
        // Starts above the highest codepoint in the initial charset to avoid
        // colliding with any single-codepoint glyph. Set during generate().
        this._nextSyntheticId = 0x3000; // safe floor; updated after charset scan

        // Cap on synthetic entries — scales with atlas area.
        // A 2048x2048 atlas at 48px font fits ~1700 glyphs, 4096x4096 fits ~6800,
        // 8192x8192 fits ~27000. Set cap generously above what the bitmap can hold.
        this._maxSyntheticIds = 16384;

        // The actual atlas texture
        this.atlasTexture = null;
        this.atlasCanvas = null;

        // Character set to render (numeric codepoints — initial ASCII + symbol ranges)
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

        // UV map version counter — incremented on every ensureGraphemes() call that
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

        // UV insets — shrink the sampled rectangle inward so bilinear
        // filtering and mipmapping don't sample neighboring glyph pixels.
        // Scale with font size: larger glyphs have wider anti-aliased edges.
        const insetScale = this.fontSize / 48;
        this.uvInsets = {
            horizontal: 1.0 * insetScale,
            top: 2.0 * insetScale,
            bottom: 1.5 * insetScale,
        };

        // Reset packing state
        this.packingState = {
            currentX: 0,
            currentY: 0,
            currentRowHeight: 0,
            glyphsAdded: 0
        };

        // Set _nextSyntheticId above the highest codepoint in the initial charset
        // so dense IDs for multi-codepoint graphemes never collide with codepoints.
        const maxCharsetCp = this.charset.length > 0
            ? Math.max(...this.charset) + 1
            : 0x3000;
        this._nextSyntheticId = Math.max(maxCharsetCp, 0x3000);
        // Record base so ensureGraphemes() can compute how many synthetic IDs have been allocated
        this._syntheticIdBase = this._nextSyntheticId;

        console.debug(`[GlyphAtlas] Cell size: ${this.standardCellWidth}x${this.standardCellHeight}, syntheticIdBase: 0x${this._nextSyntheticId.toString(16)}`);

        // Render each glyph using shelf packing
        for (let i = 0; i < this.charset.length; i++) {
            const charCode = this.charset[i];

            // Convert numeric codepoint to grapheme string for packing
            const grapheme = String.fromCodePoint(charCode);
            const uv = this._packGrapheme(grapheme, charCode);

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

        // Cache charSize and atlas dimensions eagerly so the canvas can be freed.
        this._charSize = this.getCharSize();
        this._atlasSize = this.atlasCanvas.width;

        // Free the 16 MB canvas bitmap — no longer needed after Slug takes over rendering.
        // Keep metrics Map for getCharSize() and ensureGraphemes().
        const returnCanvas = this.atlasCanvas;
        this.atlasCanvas = null;
        this.ctx = null;
        this._sharedThreeTexture = null;

        return returnCanvas;
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
     * Pack a single grapheme cluster into the atlas using shelf packing.
     *
     * @private
     * @param {string} grapheme - Grapheme cluster string (1+ Unicode codepoints)
     * @param {number} [numericId] - Explicit numeric ID for the DataTexture index.
     *   For single-codepoint graphemes this is the codepoint itself.
     *   For multi-codepoint graphemes caller should pass undefined to auto-allocate.
     * @returns {Object|null} UV coordinates {u0, v0, u1, v1} or null if atlas is full
     */
    _packGrapheme(grapheme, numericId) {
        // Measure glyph width using the full grapheme string (handles ZWJ, etc.)
        const glyphMetrics = this.ctx.measureText(grapheme);
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
            console.warn(`Atlas overflow: cannot fit grapheme "${grapheme}"`);
            return null;
        }

        // Place glyph at current position
        const x = this.packingState.currentX + this.glyphPadding;
        const y = this.packingState.currentY + this.glyphPadding;

        // Render glyph (Canvas fillText handles multi-codepoint graphemes natively)
        this.ctx.fillText(grapheme, x, y + this.baselineOffset);

        // numericId must always be passed by the caller (generate() or ensureGraphemes()).
        // Single-codepoint graphemes: caller passes the codepoint.
        // Multi-codepoint graphemes: caller allocates a synthetic ID from _nextSyntheticId.
        if (numericId === undefined) {
            console.error(`GlyphAtlas._packGrapheme: numericId not provided for "${grapheme}" — skipping`);
            return null;
        }

        // Store metrics keyed by grapheme string
        this.metrics.set(grapheme, {
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

        // Store by grapheme string
        this.uvMap.set(grapheme, uv);
        this._graphemeIds.set(grapheme, numericId);

        // Advance cursor (shelf packing)
        this.packingState.currentX += cellWidth;
        this.packingState.currentRowHeight = Math.max(
            this.packingState.currentRowHeight,
            cellHeight
        );
        this.packingState.glyphsAdded++;

        return uv;
    }

    /**
     * Get UV rect for a grapheme string.
     * @param {string} grapheme - Grapheme cluster string
     * @returns {{u0,v0,u1,v1}}
     */
    getUV(grapheme) {
        return this.uvMap.get(grapheme) || this.uvMap.get('?') || { u0: 0, v0: 0, u1: 0, v1: 0 };
    }

    /**
     * Get pixel metrics for a grapheme string.
     * @param {string} grapheme
     * @returns {{width,height,advance}|undefined}
     */
    getMetrics(grapheme) {
        return this.metrics.get(grapheme);
    }

    getCharSize() {
        // Return eagerly-cached value set at end of generate() when available.
        if (this._charSize) return this._charSize;
        // Fallback: compute from metrics Map (used during generate() before caching).
        const m = this.metrics.get('M');
        return m ? { width: m.width, height: m.height } : { width: this.fontSize, height: this.fontSize };
    }

    /**
     * Check if a grapheme exists in the atlas.
     * @param {string} grapheme - Grapheme cluster string
     * @returns {boolean}
     */
    hasGrapheme(grapheme) {
        return this.uvMap.has(grapheme);
    }

    /**
     * Get the numeric DataTexture ID for a grapheme string.
     * Returns undefined if the grapheme is not in the atlas.
     * @param {string} grapheme
     * @returns {number|undefined}
     */
    getGraphemeId(grapheme) {
        return this._graphemeIds.get(grapheme);
    }

    /**
     * Get UV map as a serializable plain object (cached).
     * Used by Web Workers which can't access Map objects directly.
     *
     * Keys are grapheme cluster strings (e.g. "A", "😀", "👨‍👩‍👧").
     * Values also include the numeric DataTexture ID as `numericId` so the
     * worker can populate the `codepoints` Float32Array without a second lookup.
     *
     * @returns {Object} Plain object: graphemeString → {u0, v0, u1, v1, numericId}
     */
    getSerializableUVMap() {
        if (this._serializedUVMapCache) {
            return this._serializedUVMapCache;
        }

        const map = {};
        for (const [grapheme, uv] of this.uvMap) {
            map[grapheme] = { ...uv, numericId: this._graphemeIds.get(grapheme) };
        }
        this._serializedUVMapCache = map;
        return map;
    }

    /**
     * Get glyph pixel widths as a serializable plain object (cached).
     * Keys are grapheme cluster strings. Values are pixel widths.
     * @returns {Object} graphemeString → pixelWidth (number)
     */
    getSerializableGlyphWidths() {
        if (this._serializedWidthsCache) {
            return this._serializedWidthsCache;
        }

        const widths = {};
        for (const [grapheme, m] of this.metrics) {
            widths[grapheme] = m.width;
        }
        this._serializedWidthsCache = widths;
        return widths;
    }

    /**
     * Invalidate the serialized UV map and widths caches.
     * Call this when glyphs are added dynamically.
     */
    invalidateSerializedCache() {
        this._serializedUVMapCache = null;
        this._serializedWidthsCache = null;
    }

    /**
     * Get all grapheme strings in the atlas.
     * @returns {string[]}
     */
    getGlyphCodes() {
        return Array.from(this.uvMap.keys());
    }

    getAtlasTexture() {
        // Canvas may be nulled after generate() to free 16 MB bitmap.
        // Return a stub with cached dimensions for callers that only need .width/.height.
        if (!this.atlasCanvas && this._atlasSize) {
            return { width: this._atlasSize, height: this._atlasSize };
        }
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
     * Vertex shader lookup (atlas-map path):
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

        // Size the atlas map to cover all numeric IDs currently assigned.
        // Single-codepoint glyphs use their codepoint as ID (max ~U+2606 for
        // the initial charset, ~10 rows at width 1024).
        // Multi-codepoint graphemes get dense synthetic IDs above the charset max.
        const ATLAS_MAP_WIDTH = 1024;
        const maxId = this._graphemeIds.size > 0
            ? Math.max(...this._graphemeIds.values()) + 1
            : 128;
        const ATLAS_MAP_HEIGHT = Math.ceil(maxId / ATLAS_MAP_WIDTH) || 1;
        const totalTexels = ATLAS_MAP_WIDTH * ATLAS_MAP_HEIGHT;

        const data = new Float32Array(totalTexels * 4);

        // Fill in current UV mappings using numeric IDs as DataTexture indices
        for (const [grapheme, numericId] of this._graphemeIds) {
            if (numericId >= totalTexels) continue;
            const uv = this.uvMap.get(grapheme);
            if (!uv) continue;
            const base = numericId * 4;
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
     * @param {string} grapheme - Grapheme cluster string
     * @returns {boolean} True if glyph exists in atlas
     */
    hasGlyph(grapheme) {
        return this.uvMap.has(grapheme);
    }

    /**
     * Ensure a set of grapheme cluster strings are present in the atlas.
     *
     * This is the primary dynamic-addition entry point. Handles all side effects:
     * 1. Packs each missing grapheme via _packGrapheme() (canvas 2D draw)
     * 2. Updates the GPU atlas map DataTexture in-place via _updateAtlasMapEntry()
     * 3. Sets textureNeedsUpdate = true for deferred CanvasTexture re-upload
     * 4. Sets _atlasMapTexture.needsUpdate = true (shared DataTexture)
     * 5. Invalidates serialized UV map and widths caches used by WorkerBridge
     * 6. Increments _uvMapVersion so WorkerBridge detects stale worker caches
     *
     * @param {string[]} graphemes - Array of grapheme cluster strings to ensure
     * @returns {number} Count of newly-added glyphs
     */
    ensureGraphemes(graphemes) {
        if (!this.ctx) {
            console.warn('GlyphAtlas.ensureGraphemes: atlas not initialized. Call generate() first.');
            return 0;
        }
        this._setupContextFont();

        let added = 0;
        for (const grapheme of graphemes) {
            if (this.uvMap.has(grapheme)) continue;

            // Determine numeric ID: single-codepoint grapheme → use codepoint
            let numericId;
            const cp = grapheme.codePointAt(0);
            const isSingleCodepoint = (cp > 0xFFFF ? 2 : 1) === grapheme.length;
            if (isSingleCodepoint) {
                numericId = cp;
            } else {
                // Multi-codepoint ZWJ sequence: allocate dense synthetic ID
                // _syntheticIdBase is set once in generate() to the initial _nextSyntheticId value.
                const syntheticCount = this._nextSyntheticId - (this._syntheticIdBase || this._nextSyntheticId);
                if (syntheticCount >= this._maxSyntheticIds) {
                    console.warn(`GlyphAtlas: synthetic ID cap (${this._maxSyntheticIds}) reached, cannot pack grapheme "${grapheme}"`);
                    continue;
                }
                numericId = this._nextSyntheticId++;
            }

            const uv = this._packGrapheme(grapheme, numericId);
            if (uv) {
                added++;
                if (this._atlasMapTexture) {
                    this._updateAtlasMapEntry(numericId, uv);
                }
            } else {
                console.warn(`GlyphAtlas: atlas full, cannot pack grapheme "${grapheme}"`);
            }
        }

        if (added > 0) {
            this.textureNeedsUpdate = true;
            if (this._atlasMapTexture) {
                this._atlasMapTexture.needsUpdate = true;
            }
            this.invalidateSerializedCache();
            this._uvMapVersion++;
            console.debug(`[GlyphAtlas] ensureGraphemes: +${added} glyphs`);
        }

        return added;
    }

    /**
     * Ensure a set of Unicode codepoints (numbers) are in the atlas.
     * Converts each to a grapheme string and delegates to ensureGraphemes().
     * Preserved for backward compatibility with callers that have numeric codepoints.
     *
     * @param {number[]} codepoints - Array of Unicode code points to ensure
     * @returns {number} Count of newly-added glyphs
     */
    ensureCodepoints(codepoints) {
        const graphemes = codepoints.map(cp => String.fromCodePoint(cp));
        return this.ensureGraphemes(graphemes);
    }

    /**
     * Add a grapheme to the atlas if it doesn't exist.
     * @param {string} grapheme - Grapheme cluster string
     * @returns {Object|null} UV coordinates {u0, v0, u1, v1} or null if atlas is full
     */
    addGlyphIfMissing(grapheme) {
        if (this.uvMap.has(grapheme)) {
            return this.uvMap.get(grapheme);
        }
        this.ensureGraphemes([grapheme]);
        return this.uvMap.get(grapheme) || null;
    }

    /**
     * Add multiple graphemes at once.
     * @param {string[]} graphemes - Array of grapheme cluster strings
     * @returns {Map<string, Object|null>} Map of grapheme to UV coordinates
     */
    addGlyphsIfMissing(graphemes) {
        const missing = graphemes.filter(g => !this.uvMap.has(g));
        if (missing.length > 0) {
            this.ensureGraphemes(missing);
        }
        const results = new Map();
        for (const g of graphemes) {
            results.set(g, this.uvMap.get(g) || null);
        }
        return results;
    }

    /**
     * Write a single glyph's UV rect into the shared atlas map DataTexture.
     * No-op if the texture hasn't been created yet (pre-generate() calls).
     * @param {number} numericId - The DataTexture index for this glyph
     * @param {Object} uv - {u0, v0, u1, v1}
     */
    _updateAtlasMapEntry(numericId, uv) {
        const tex = this._atlasMapTexture;
        if (!tex) return; // texture not yet created — will be filled on first getAtlasMapTexture()

        const totalTexels = this._atlasMapTextureWidth * this._atlasMapTextureHeight;
        if (numericId >= totalTexels) {
            this._regrowAtlasMap(numericId);
        }

        const data = tex.image.data;
        const base = numericId * 4;
        data[base]     = uv.u0;
        data[base + 1] = 1.0 - uv.v1;
        data[base + 2] = uv.u1;
        data[base + 3] = 1.0 - uv.v0;
        tex.needsUpdate = true;
    }

    /**
     * Grow the atlas map DataTexture to accommodate a numeric ID beyond the current range.
     * Copies existing data into a larger Float32Array and updates the texture in-place
     * so all existing uniform references remain valid.
     * @param {number} numericId - The ID that triggered the regrow
     */
    _regrowAtlasMap(numericId) {
        const tex = this._atlasMapTexture;
        const width = this._atlasMapTextureWidth;
        const newHeight = Math.ceil((numericId + 1) / width);
        const newData = new Float32Array(width * newHeight * 4);

        // Copy existing data
        newData.set(tex.image.data);

        // Update texture in place — same object, new backing data
        tex.image = { data: newData, width, height: newHeight };
        tex.userData.width = width;
        tex.userData.height = newHeight;

        this._atlasMapTextureHeight = newHeight;
        this._atlasMapTextureDirty = true;

        console.debug(`[GlyphAtlas] Atlas map regrown: ${width}x${newHeight} for numeric ID 0x${numericId.toString(16).toUpperCase()}`);

        tex.needsUpdate = true;
    }

    // ========================================
    // Pre-bake Export / Import API
    // ========================================

    /**
     * Serialize atlas state for pre-baking. Run once at build time.
     *
     * The returned `descriptor` contains all glyph metrics, UV coordinates,
     * DataTexture IDs, packing cursor state, and rendering constants needed to
     * fully reconstruct the atlas via {@link GlyphAtlas.fromPrebuilt} without
     * calling generate(). The `image` field is a data URL (PNG) of the atlas
     * canvas, suitable for embedding or writing to disk.
     *
     * @returns {{image: string, descriptor: Object}}
     */
    exportAtlas() {
        if (!this.atlasCanvas || !this.ctx) {
            throw new Error('GlyphAtlas.exportAtlas: atlas not generated yet. Call generate() first.');
        }

        const glyphs = {};
        for (const [grapheme, uv] of this.uvMap) {
            const m = this.metrics.get(grapheme);
            glyphs[grapheme] = {
                numericId: this._graphemeIds.get(grapheme),
                u0: uv.u0,
                v0: uv.v0,
                u1: uv.u1,
                v1: uv.v1,
                width: m ? m.width : 0,
                height: m ? m.height : 0,
                advance: m ? m.advance : 0,
            };
        }

        const descriptor = {
            // Canvas / font configuration
            textureWidth: this.atlasCanvas.width,
            textureHeight: this.atlasCanvas.height,
            fontSize: this.fontSize,
            fontFamily: this.fontFamily,
            glyphPadding: this.glyphPadding,

            // Derived rendering constants (computed once in generate())
            standardCellWidth: this.standardCellWidth,
            standardCellHeight: this.standardCellHeight,
            baselineOffset: this.baselineOffset,
            glyphHeight: this.glyphHeight,
            uvInsets: { ...this.uvInsets },

            // Packing cursor — so ensureGraphemes() can continue without overwriting
            packingState: { ...this.packingState },

            // Synthetic ID allocation state
            nextSyntheticId: this._nextSyntheticId,
            syntheticIdBase: this._syntheticIdBase ?? this._nextSyntheticId,
            maxSyntheticIds: this._maxSyntheticIds,

            // All glyphs: metrics + UVs + numeric DataTexture IDs
            glyphs,
        };

        return {
            image: this.atlasCanvas.toDataURL('image/png'),
            descriptor,
        };
    }

    /**
     * Create a GlyphAtlas from pre-baked data without runtime Canvas 2D rasterization.
     *
     * Reconstructs all internal state (uvMap, metrics, _graphemeIds, packing cursor,
     * rendering constants, Three.js textures) so that:
     *   - getSharedThreeTexture() returns a valid CanvasTexture backed by the loaded image
     *   - getAtlasMapTexture() returns the correct DataTexture for GPU codepoint lookup
     *   - ensureGraphemes() can still add new glyphs not covered by the pre-baked set
     *
     * @param {Object} descriptor - JSON descriptor from exportAtlas()
     * @param {HTMLImageElement|ImageBitmap} image - Loaded atlas PNG
     * @returns {GlyphAtlas}
     */
    static fromPrebuilt(descriptor, image) {
        const atlas = new GlyphAtlas(
            descriptor.fontFamily,
            descriptor.fontSize,
            descriptor.textureWidth  // atlasSize
        );

        // ---- Canvas reconstruction ----
        // Create a canvas of the correct dimensions and draw the pre-baked image onto it.
        // This gives getSharedThreeTexture() and getAtlasTexture() a real canvas to wrap.
        atlas.atlasCanvas = document.createElement('canvas');
        atlas.atlasCanvas.width = descriptor.textureWidth;
        atlas.atlasCanvas.height = descriptor.textureHeight;
        atlas.ctx = atlas.atlasCanvas.getContext('2d', { willReadFrequently: true });

        // Draw pre-baked PNG — this is the pixel data, do not clear first
        atlas.ctx.drawImage(image, 0, 0);

        // ---- Rendering constants ----
        atlas.glyphPadding    = descriptor.glyphPadding;
        atlas.standardCellWidth  = descriptor.standardCellWidth;
        atlas.standardCellHeight = descriptor.standardCellHeight;
        atlas.baselineOffset     = descriptor.baselineOffset;
        atlas.glyphHeight        = descriptor.glyphHeight;
        atlas.uvInsets           = { ...descriptor.uvInsets };

        // ---- Packing cursor ----
        // Set to the state after all pre-baked glyphs were placed.
        // ensureGraphemes() will continue from here, appending new glyphs
        // without overwriting anything already in the image.
        atlas.packingState = { ...descriptor.packingState };

        // ---- Synthetic ID allocation ----
        atlas._nextSyntheticId  = descriptor.nextSyntheticId;
        atlas._syntheticIdBase  = descriptor.syntheticIdBase;
        atlas._maxSyntheticIds  = descriptor.maxSyntheticIds;

        // ---- Glyph maps ----
        for (const [grapheme, entry] of Object.entries(descriptor.glyphs)) {
            atlas.uvMap.set(grapheme, {
                u0: entry.u0,
                v0: entry.v0,
                u1: entry.u1,
                v1: entry.v1,
            });
            atlas.metrics.set(grapheme, {
                width:   entry.width,
                height:  entry.height,
                advance: entry.advance,
            });
            atlas._graphemeIds.set(grapheme, entry.numericId);
        }

        // ---- Context font setup ----
        // Prime the context so ensureGraphemes() can call _setupContextFont() and measure.
        atlas._setupContextFont();

        // Serialized caches are intentionally null — they'll be built lazily.
        atlas._serializedUVMapCache = null;
        atlas._serializedWidthsCache = null;

        return atlas;
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
