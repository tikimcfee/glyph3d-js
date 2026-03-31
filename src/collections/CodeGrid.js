/**
 * CodeGrid - Single source file representation in 3D space
 *
 * Wraps a GlyphCollection to represent a single source file with visual
 * elements like background panel and filename label.
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> GlyphCollection -> CodeGrid -> GridLayoutManager
 */

import * as THREE from 'three';
import GlyphCollection from './GlyphCollection.js';

class CodeGrid extends THREE.Object3D {
    /**
     * Create a CodeGrid
     * @param {THREE.Scene} scene - Three.js scene
     * @param {GlyphAtlas} atlas - Glyph atlas for rendering
     * @param {Object} options - Configuration options
     */
    constructor(scene, atlas, options = {}) {
        super();

        this.scene = scene;
        this.atlas = atlas;
        this.name = options.name || 'CodeGrid';

        // Configuration
        this.config = {
            maxChars: options.maxChars || 50000,
            showBackground: options.showBackground !== false,
            backgroundColor: options.backgroundColor || 0x1a1a2e,
            backgroundOpacity: options.backgroundOpacity || 0.85,
            backgroundPadding: options.backgroundPadding || 1.0,
            showFilename: options.showFilename !== false,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            textColor: options.textColor || { r: 0.0, g: 1.0, b: 0.0 },
            // Overall grid scale - scales the entire code view
            gridScale: options.gridScale || 1.0,
            // World scale passed to renderer (pixels to world units)
            worldScale: options.worldScale || 0.025
        };

        // Content state
        this.filename = '';
        this.sourcePath = null;
        this.content = '';
        this.lines = [];

        // Use GlyphCollection for rendering (not our own implementation!)
        this._collection = new GlyphCollection(scene, atlas, {
            maxInstances: this.config.maxChars,
            defaultColor: this.config.textColor,
            worldScale: this.config.worldScale
        });

        // Derive metrics from atlas via GlyphCollection (no renderer needed)
        const collectionMetrics = this._collection._getMetrics();
        this.metrics = {
            charWidth: collectionMetrics.charWidth,
            charHeight: collectionMetrics.charHeight,
            lineHeight: collectionMetrics.lineSpacing,
            spacing: collectionMetrics.letterSpacing
        };

        // Track text IDs for content management
        this._filenameTextId = null;
        this._contentTextIds = [];

        // Background element (separate from collection)
        this._background = null;
        this._initBackground();

        // Add collection's group as our child for proper transforms
        this.add(this._collection.group);

        // Apply overall grid scale
        if (this.config.gridScale !== 1.0) {
            this.scale.setScalar(this.config.gridScale);
        }
    }

    // ============ Content Loading ============

    /**
     * Load text content into the grid
     * @param {string} text - Text content to display
     * @param {Object} options - Loading options
     * @returns {this} For chaining
     */
    loadText(text, options = {}) {
        this.content = text;
        this.lines = text.split('\n');

        // Clear previous content
        this._clearContent();

        // Layout text using collection
        this._layoutContent();

        // Update background
        this._updateBackground();

        return this;
    }

    /**
     * Load file content with filename
     * @param {string} filename - Name of the file
     * @param {string} content - File content
     * @returns {this} For chaining
     */
    loadFile(filename, content) {
        this.filename = filename;
        return this.loadText(content);
    }

    /**
     * Load text content using Web Workers (async)
     * @param {string} text - Text content to display
     * @returns {Promise<this>} For chaining
     */
    async loadTextAsync(text) {
        this.content = text;
        // Note: lines array populated lazily only if needed (getLineCount, getMaxLineWidth)

        // Clear previous content
        this._clearContent();

        // Layout text using collection (async worker path)
        await this._layoutContentAsync();

        // Update background
        this._updateBackground();

        return this;
    }

    /**
     * Load file content with filename (async worker path)
     * @param {string} filename - Name of the file
     * @param {string} content - File content
     * @returns {Promise<this>} For chaining
     */
    async loadFileAsync(filename, content) {
        this.filename = filename;
        return this.loadTextAsync(content);
    }

    /**
     * Clear all content
     */
    clear() {
        this.content = '';
        this.lines = [];
        this.filename = '';

        this._collection.clear();
        this._filenameTextId = null;
        this._contentTextIds = [];

        this._updateBackground();
    }

    // ============ Visual Elements ============

    /**
     * Set background color
     * @param {number|THREE.Color} color - Background color
     */
    setBackgroundColor(color) {
        if (this._background) {
            this._background.material.color.set(color);
        }
        this.config.backgroundColor = color;
    }

    /**
     * Show or hide background
     * @param {boolean} visible - Whether background is visible
     */
    showBackground(visible) {
        this.config.showBackground = visible;
        if (this._background) {
            this._background.visible = visible;
        }
    }

    /**
     * Hide background
     */
    hideBackground() {
        this.showBackground(false);
    }

    /**
     * Set filename label
     * @param {string} name - Filename to display
     */
    setFilenameLabel(name) {
        this.filename = name;
        // Re-layout to update filename
        if (this.content) {
            this._clearContent();
            this._layoutContent();
            this._updateBackground();
        }
    }

    /**
     * Show or hide filename label
     * @param {boolean} visible - Whether filename is visible
     */
    showFilename(visible) {
        this.config.showFilename = visible;
        if (this.content) {
            this._clearContent();
            this._layoutContent();
            this._updateBackground();
        }
    }

    /**
     * Hide filename label
     */
    hideFilename() {
        this.showFilename(false);
    }

    // ============ Spatial Queries ============

    /**
     * Get bounding box of this grid
     * @returns {THREE.Box3} Bounding box in world coordinates
     */
    getBounds() {
        const box = new THREE.Box3();
        const padding = this.config.backgroundPadding;

        // Get content bounds from collection
        const contentBounds = this._collection.getBounds();

        if (contentBounds) {
            box.min.set(
                contentBounds.min.x - padding,
                contentBounds.min.y - padding,
                contentBounds.min.z
            );
            box.max.set(
                contentBounds.max.x + padding,
                contentBounds.max.y + padding,
                contentBounds.max.z
            );
        }

        // Transform to world coordinates
        box.applyMatrix4(this.matrixWorld);
        return box;
    }

    /**
     * Get local content bounds
     * @returns {Object|null} Bounds object from collection
     */
    getContentBounds() {
        return this._collection.getBounds();
    }

    /**
     * Get the underlying GlyphCollection
     * @returns {GlyphCollection} The collection
     */
    getCollection() {
        return this._collection;
    }

    /**
     * Get glyph count
     * @returns {number} Number of glyphs
     */
    getGlyphCount() {
        return this._collection.getGlyphCount();
    }

    /**
     * Get line count
     * @returns {number} Number of lines
     */
    getLineCount() {
        // Lazy-populate lines if needed (async path doesn't split upfront)
        if (this.lines.length === 0 && this.content.length > 0) {
            this.lines = this.content.split('\n');
        }
        return this.lines.length;
    }

    /**
     * Get maximum line width (in characters)
     * @returns {number} Maximum line width
     */
    getMaxLineWidth() {
        // Lazy-populate lines if needed (async path doesn't split upfront)
        if (this.lines.length === 0 && this.content.length > 0) {
            this.lines = this.content.split('\n');
        }
        return Math.max(...this.lines.map(l => l.length), 0);
    }

    /**
     * Get filename
     * @returns {string|null} Current filename
     */
    getFilename() {
        return this.filename || null;
    }

    /**
     * Get source path
     * @returns {string|null} Source file path
     */
    getSourcePath() {
        return this.sourcePath;
    }

    /**
     * Set source path metadata
     * @param {string} path - Source file path
     */
    setSourcePath(path) {
        this.sourcePath = path;
    }

    // ============ Lifecycle ============

    /**
     * Update any animated elements
     * @param {number} deltaTime - Time since last update
     */
    update(deltaTime) {
        // Future: add hover effects, selection highlights, etc.
    }

    /**
     * Dispose of all resources
     */
    dispose() {
        // Dispose collection
        if (this._collection) {
            this._collection.dispose();
            this._collection = null;
        }

        // Dispose background
        if (this._background) {
            this._background.geometry.dispose();
            this._background.material.dispose();
            this.remove(this._background);
            this._background = null;
        }

        this.content = '';
        this.lines = [];
        this._contentTextIds = [];
    }

    // ============ Private Methods ============

    /**
     * Initialize background plane
     * @private
     */
    _initBackground() {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
            color: this.config.backgroundColor,
            transparent: true,
            opacity: this.config.backgroundOpacity,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        this._background = new THREE.Mesh(geometry, material);
        this._background.renderOrder = -1; // Draw backgrounds before glyphs
        this._background.position.z = -0.1; // Just behind text — minimal float
        this._background.visible = this.config.showBackground;
        this.add(this._background);
    }

    /**
     * Clear content from collection
     * @private
     */
    _clearContent() {
        // Remove filename text if exists
        if (this._filenameTextId !== null) {
            this._collection.removeText(this._filenameTextId);
            this._filenameTextId = null;
        }

        // Remove all content texts
        for (const id of this._contentTextIds) {
            this._collection.removeText(id);
        }
        this._contentTextIds = [];

        // Flush removals
        this._collection.flush();
    }

    /**
     * Layout content using GlyphCollection
     * @private
     */
    _layoutContent() {
        let currentY = 0;

        // Add filename if enabled
        if (this.config.showFilename && this.filename) {
            this._filenameTextId = this._collection.addText(
                this.filename,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.filenameColor }
            );
            currentY -= this.metrics.lineHeight * 1.5; // Extra space after filename
        }

        // Add content lines
        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];

            // Skip empty lines but still advance Y
            if (line.length > 0) {
                const id = this._collection.addText(
                    line,
                    { x: 0, y: currentY, z: 0 },
                    { color: this.config.textColor }
                );
                this._contentTextIds.push(id);
            }

            currentY -= this.metrics.lineHeight;
        }

        // Flush all additions to GPU
        this._collection.flush();

        // Build line→slot index after flush
        this._buildLineSlotBase();
    }

    /**
     * Layout content using GlyphCollection (async worker path)
     * Optimized: sends entire content as ONE text item (worker handles newlines)
     * @private
     */
    async _layoutContentAsync() {
        let currentY = 0;

        // Add filename if enabled
        if (this.config.showFilename && this.filename) {
            this._filenameTextId = this._collection.addText(
                this.filename,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.filenameColor }
            );
            currentY -= this.metrics.lineHeight * 1.5;
        }

        // Add ENTIRE content as single text item (worker handles newlines)
        // This reduces serialization from N items to 1
        if (this.content.length > 0) {
            const id = this._collection.addText(
                this.content,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.textColor }
            );
            this._contentTextIds.push(id);
        }

        // Flush using worker pipeline
        await this._collection.flushAsync();

        // Build line→slot index from builder's authoritative line offsets.
        // The content is the second item in the batch (after filename, if present).
        // _contentTextIds[0] maps to the content item's metadata.
        const contentItemMeta = this._getContentItemMeta();
        this._buildLineSlotBase(contentItemMeta?.lineSlotOffsets);
    }

    /**
     * Get the renderer's itemMeta for the content text entry.
     * @private
     * @returns {Object|null} itemMeta with lineSlotOffsets if available
     */
    _getContentItemMeta() {
        if (this._contentTextIds.length === 0) return null;
        const renderer = this._collection?.getRenderer();
        if (!renderer) return null;

        const collId = this._contentTextIds[0];
        const rendId = this._collection._idMap?.get(collId);
        if (rendId === undefined) return null;

        const entry = renderer.renderedTexts.get(rendId);
        return entry ?? null;
    }

    // ============ Line → Buffer Slot Mapping ============

    /**
     * Build _lineSlotBase: maps each line index to the buffer slot index
     * of its first visible character. Mirrors the builder's skip logic
     * (newlines, spaces, CR, tabs are not emitted as glyph slots).
     *
     * Must be called after every flush that rebuilds geometry.
     * @private
     */
    _buildLineSlotBase(builderLineSlotOffsets) {
        const content = this.content;
        if (!content) {
            this._lineSlotBase = null;
            return;
        }

        // Ensure this.lines is populated (async path doesn't split upfront)
        if (this.lines.length === 0 && content.length > 0) {
            this.lines = content.split('\n');
        }

        // If the builder provided line→slot offsets, use those directly.
        // These are authoritative — computed in the same pass that built the buffers.
        if (builderLineSlotOffsets) {
            this._lineSlotBase = new Int32Array(builderLineSlotOffsets);
            return;
        }

        // Fallback for sync path: derive from renderer's renderedTexts
        const renderer = this._collection.getRenderer();
        if (!renderer) {
            this._lineSlotBase = null;
            return;
        }

        // Sync path: one text entry per non-empty line
        const lineSlotBase = new Int32Array(this.lines.length);
        let textIdCursor = 0;
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i].length === 0 || textIdCursor >= this._contentTextIds.length) {
                // Empty line or past entries — use previous line's end
                lineSlotBase[i] = i > 0 ? lineSlotBase[i - 1] : 0;
                continue;
            }
            const collId = this._contentTextIds[textIdCursor++];
            const rendId = this._collection._idMap?.get(collId);
            const entry = rendId !== undefined ? renderer.renderedTexts.get(rendId) : null;
            lineSlotBase[i] = entry ? (entry.bufferStartIndex ?? 0) : 0;
        }

        this._lineSlotBase = lineSlotBase;
    }

    /**
     * Get the buffer slot index for a character at (line, col).
     * Col counts visible characters only (spaces are skipped in the buffer).
     * @param {number} line - 0-based line index
     * @param {number} col - 0-based visible-character index within the line
     * @returns {number} Buffer slot index, or -1 if out of range
     */
    getSlotForChar(line, col) {
        if (!this._lineSlotBase || line < 0 || line >= this._lineSlotBase.length) return -1;
        return this._lineSlotBase[line] + col;
    }

    /**
     * Get the number of visible (buffer-slotted) characters on a line.
     * @param {number} line - 0-based line index
     * @returns {number}
     */
    getVisibleCharCount(line) {
        if (!this.lines || line < 0 || line >= this.lines.length) return 0;
        let count = 0;
        const text = this.lines[line];
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code !== 10 && code !== 32 && code !== 13 && code !== 9) count++;
        }
        return count;
    }

    // ============ Glyph Highlighting ============

    /**
     * Highlight a range of characters with additive color.
     * @param {number} startLine - 0-based inclusive
     * @param {number} startCol - 0-based inclusive (visible char index)
     * @param {number} endLine - 0-based inclusive
     * @param {number} endCol - 0-based exclusive (visible char index)
     * @param {{r:number, g:number, b:number}} color
     */
    highlightRange(startLine, startCol, endLine, endCol, color) {
        const renderer = this._collection?.getRenderer();
        if (!renderer || !this._lineSlotBase) return;

        for (let line = startLine; line <= endLine; line++) {
            const cStart = (line === startLine) ? startCol : 0;
            const cEnd = (line === endLine) ? endCol : this.getVisibleCharCount(line);
            const lineBase = this._lineSlotBase[line];
            if (lineBase === undefined) continue;

            for (let col = cStart; col < cEnd; col++) {
                renderer.setGlyphHighlight(lineBase + col, color);
            }
        }
    }

    /**
     * Clear highlights on a specific line.
     * @param {number} line - 0-based line index
     */
    clearLineHighlight(line) {
        const renderer = this._collection?.getRenderer();
        if (!renderer || !this._lineSlotBase) return;
        const count = this.getVisibleCharCount(line);
        const base = this._lineSlotBase[line];
        for (let i = 0; i < count; i++) {
            renderer.setGlyphHighlight(base + i, null);
        }
    }

    /**
     * Clear all glyph highlights on this grid.
     * Delegates to clearLineHighlight() for each line — uses the RGBA8 DataTexture path.
     */
    clearAllHighlights() {
        if (!this._lineSlotBase) return;
        const lineCount = this.getLineCount();
        for (let line = 0; line < lineCount; line++) {
            this.clearLineHighlight(line);
        }
    }

    /**
     * Update background to match content size
     * @private
     */
    _updateBackground() {
        if (!this._background || !this.config.showBackground) {
            if (this._background) {
                this._background.visible = false;
            }
            return;
        }

        const bounds = this._collection.getBounds();
        if (!bounds) {
            this._background.visible = false;
            return;
        }

        const padding = this.config.backgroundPadding;

        // Size background to content
        const width = bounds.width + padding * 2;
        const height = bounds.height + padding * 2;

        if (width > 0 && height > 0) {
            this._background.scale.set(width, height, 1);

            // Position background at the BACK of the bounding box (Z min)
            // This ensures background is behind all Z-wrapped text layers
            const zMin = bounds.min.z !== undefined ? bounds.min.z : 0;
            const backgroundZ = zMin - 0.5;  // Slightly behind the furthest text

            this._background.position.set(
                bounds.min.x + bounds.width / 2,
                bounds.min.y + bounds.height / 2,
                backgroundZ
            );

            this._background.visible = true;
        } else {
            this._background.visible = false;
        }
    }
}

export default CodeGrid;
