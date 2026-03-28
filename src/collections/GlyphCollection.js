/**
 * GlyphCollection - Batched, deferred glyph rendering abstraction
 *
 * Wraps GlyphRendererV15 for batched, deferred updates.
 * Each collection has its own isolated renderer instance and supports
 * collection-level transforms.
 *
 * Key Features:
 * - Deferred GPU updates (batch operations until flush())
 * - Lazy renderer creation (buffer sized to actual content)
 * - Wraps proven GlyphRendererV15 rendering
 * - Collection-level transforms (position, scale, rotation)
 * - Dirty tracking for efficient updates
 *
 * Inspired by SwiftGlyph's GlyphCollection pattern.
 */

import * as THREE from 'three';
import GlyphRendererV15 from '../GlyphRenderer.js';
import { getWorkerBridge, isWorkersSupported } from '../workers/WorkerBridge.js';

/**
 * @typedef {Object} TextEntry
 * @property {number} id - Our local ID
 * @property {number} rendererId - GlyphRendererV15's ID
 * @property {string} text - The text content
 * @property {Object} position - Position {x, y, z}
 * @property {Object} options - Rendering options
 */

class GlyphCollection {
    /**
     * Create a glyph collection
     * @param {THREE.Scene} scene - Three.js scene
     * @param {GlyphAtlas} atlas - Glyph atlas with font metrics
     * @param {Object} options - Configuration options
     */
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;
        this.config = {
            maxInstances: options.maxInstances,  // Optional override
            defaultColor: options.defaultColor || { r: 1.0, g: 1.0, b: 1.0 },
            worldScale: options.worldScale,  // Pass through to renderer
            bufferHeadroom: options.bufferHeadroom || 1.1  // 10% extra by default
        };

        // Collection-level transform via Group
        this._transform = {
            position: new THREE.Vector3(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
            rotation: new THREE.Euler(0, 0, 0)
        };

        // Container group - we pass this to renderer instead of scene
        // This allows collection-level transforms to work
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Lazy renderer creation - created on first flush() with right-sized buffer
        this._renderer = null;
        this._bufferSize = 0;  // Track allocated buffer size

        // Pending operations (batched until flush)
        this._pendingAdds = [];      // {text, position, options}
        this._pendingRemovals = [];  // renderer IDs to remove
        this._pendingUpdates = [];   // {id, newText} or {id, newPosition} etc.

        // ID mapping: our ID -> renderer ID
        this._idMap = new Map();
        this._reverseIdMap = new Map();  // renderer ID -> our ID
        this._nextId = 1;
        this._dirty = false;

        // Committed entries for queries
        this._committedTexts = new Map();  // our ID -> TextEntry

        // Bounds cache
        this._boundsCache = null;
        this._boundsDirty = true;

        // Worker path bounds cache (separate from renderer-based bounds)
        this._workerBoundsCache = null;

        // Cached metrics (computed from atlas, avoids creating renderer just for metrics)
        this._metricsCache = null;
    }

    /**
     * Get metrics from atlas (cached, avoids renderer creation)
     * @private
     */
    _getMetrics() {
        if (this._metricsCache) return this._metricsCache;

        const atlasCharSize = this.atlas.getCharSize();
        const scale = this.config.worldScale || 0.025;

        this._metricsCache = {
            charWidth: atlasCharSize.width * scale,
            charHeight: atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width * scale * 0.05,
            lineSpacing: atlasCharSize.height * scale * 1.2,
            atlasSize: this.atlas.getAtlasTexture().width,
            pixelWidth: atlasCharSize.width,
            pixelHeight: atlasCharSize.height
        };

        return this._metricsCache;
    }

    // ============ Batched Text Operations ============

    /**
     * Add text to the collection (deferred until flush)
     * @param {string} text - Text to add
     * @param {Object} position - Position {x, y, z}
     * @param {Object} options - Optional overrides (color, scale)
     * @returns {number} ID for this text
     */
    addText(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        const id = this._nextId++;

        this._pendingAdds.push({
            id,
            text,
            position: { ...position },
            options: { ...options }
        });

        this._dirty = true;
        this._boundsDirty = true;

        return id;
    }

    /**
     * Add multiple texts at once (deferred until flush)
     * @param {Array} items - Array of {text, position, options}
     * @returns {Array<number>} IDs for the added texts
     */
    addTexts(items) {
        const ids = [];
        for (const item of items) {
            const id = this.addText(
                item.text,
                item.position || { x: 0, y: 0, z: 0 },
                item.options || {}
            );
            ids.push(id);
        }
        return ids;
    }

    /**
     * Remove text by ID (deferred until flush)
     * @param {number} id - Text ID to remove
     */
    removeText(id) {
        // Check if it's still pending (not yet flushed)
        const pendingIdx = this._pendingAdds.findIndex(p => p.id === id);
        if (pendingIdx !== -1) {
            this._pendingAdds.splice(pendingIdx, 1);
        } else if (this._idMap.has(id)) {
            // Already committed - mark for removal
            const rendererId = this._idMap.get(id);
            this._pendingRemovals.push(rendererId);
        }

        this._dirty = true;
        this._boundsDirty = true;
    }

    /**
     * Update text content (deferred until flush)
     * @param {number} id - Text ID to update
     * @param {string} newText - New text content
     */
    updateText(id, newText) {
        // Check if still pending
        const pending = this._pendingAdds.find(p => p.id === id);
        if (pending) {
            pending.text = newText;
        } else if (this._idMap.has(id)) {
            this._pendingUpdates.push({ type: 'text', id, newText });
        }

        this._dirty = true;
        this._boundsDirty = true;
    }

    /**
     * Update text position
     * @param {number} id - Text ID
     * @param {Object} newPosition - New position {x, y, z}
     */
    updatePosition(id, newPosition) {
        const pending = this._pendingAdds.find(p => p.id === id);
        if (pending) {
            pending.position = { ...newPosition };
        } else if (this._idMap.has(id)) {
            this._pendingUpdates.push({ type: 'position', id, newPosition: { ...newPosition } });
        }

        this._dirty = true;
        this._boundsDirty = true;
    }

    /**
     * Update text color
     * @param {number} id - Text ID
     * @param {Object} newColor - New color {r, g, b}
     */
    updateColor(id, newColor) {
        const pending = this._pendingAdds.find(p => p.id === id);
        if (pending) {
            pending.options.color = { ...newColor };
        } else if (this._idMap.has(id)) {
            this._pendingUpdates.push({ type: 'color', id, newColor: { ...newColor } });
        }

        this._dirty = true;
    }

    /**
     * Bulk update positions for multiple texts. Committed entries go
     * directly to the renderer in a single pass; pending entries are
     * patched in-place. Only one GPU upload is triggered.
     * @param {Array<{id: number, position: {x: number, y: number, z: number}}>} updates
     */
    updatePositions(updates) {
        const rendererUpdates = [];

        for (let i = 0; i < updates.length; i++) {
            const { id, position } = updates[i];

            const pending = this._pendingAdds.find(p => p.id === id);
            if (pending) {
                pending.position = { ...position };
            } else if (this._idMap.has(id)) {
                rendererUpdates.push({ id: this._idMap.get(id), position });
            }
        }

        if (rendererUpdates.length > 0 && this._renderer) {
            this._renderer.updatePositions(rendererUpdates);
        }

        this._boundsDirty = true;
    }

    /**
     * Bulk update colors for multiple texts. Committed entries go
     * directly to the renderer in a single pass; pending entries are
     * patched in-place. Only one GPU upload is triggered.
     * @param {Array<{id: number, color: {r: number, g: number, b: number}}>} updates
     */
    updateColors(updates) {
        const rendererUpdates = [];

        for (let i = 0; i < updates.length; i++) {
            const { id, color } = updates[i];

            const pending = this._pendingAdds.find(p => p.id === id);
            if (pending) {
                pending.options.color = { ...color };
            } else if (this._idMap.has(id)) {
                rendererUpdates.push({ id: this._idMap.get(id), color });
            }
        }

        if (rendererUpdates.length > 0 && this._renderer) {
            this._renderer.updateColors(rendererUpdates);
        }
    }

    /**
     * Bulk update positions and/or colors in a single pass.
     * Most efficient for layout animations that change both attributes.
     * @param {Array<{id: number, position?: {x: number, y: number, z: number}, color?: {r: number, g: number, b: number}}>} updates
     */
    updateTransforms(updates) {
        const rendererUpdates = [];

        for (let i = 0; i < updates.length; i++) {
            const { id, position, color } = updates[i];

            const pending = this._pendingAdds.find(p => p.id === id);
            if (pending) {
                if (position) pending.position = { ...position };
                if (color) pending.options.color = { ...color };
            } else if (this._idMap.has(id)) {
                const entry = { id: this._idMap.get(id) };
                if (position) entry.position = position;
                if (color) entry.color = color;
                rendererUpdates.push(entry);
            }
        }

        if (rendererUpdates.length > 0 && this._renderer) {
            this._renderer.updateTransforms(rendererUpdates);
        }

        this._boundsDirty = true;
    }

    // ============ Group Transform API ============

    /**
     * Create a new group for GPU-side transforms.
     * Returns a groupId that can be passed via addText options.
     * @returns {number} The new groupId
     */
    createGroup() {
        if (this._renderer) {
            return this._renderer.createGroup();
        }
        // Queue for deferred creation
        if (!this._pendingGroupCount) this._pendingGroupCount = 1;
        return this._pendingGroupCount++;
    }

    /**
     * Set the world-space offset for a group. O(1) GPU update.
     * @param {number} groupId
     * @param {{x: number, y: number, z: number}} offset
     */
    setGroupOffset(groupId, offset) {
        if (this._renderer) {
            this._renderer.setGroupOffset(groupId, offset);
        } else {
            if (!this._pendingGroupOffsets) this._pendingGroupOffsets = new Map();
            this._pendingGroupOffsets.set(groupId, { ...offset });
        }
    }

    /**
     * Get the current offset for a group.
     * @param {number} groupId
     * @returns {{x: number, y: number, z: number}}
     */
    getGroupOffset(groupId) {
        if (!this._renderer) return { x: 0, y: 0, z: 0 };
        return this._renderer.getGroupOffset(groupId);
    }

    /**
     * Set the color multiplier for a group. O(1) GPU update.
     * @param {number} groupId
     * @param {{r: number, g: number, b: number, a?: number}} color
     */
    setGroupColor(groupId, color) {
        if (this._renderer) {
            this._renderer.setGroupColor(groupId, color);
        } else {
            if (!this._pendingGroupColors) this._pendingGroupColors = new Map();
            this._pendingGroupColors.set(groupId, { ...color });
        }
    }

    /**
     * Set the color blend mode for a group. O(1) GPU update.
     * Controls how group color interacts with instance colors:
     *   0.0 = multiply (default), 1.0 = replace
     * @param {number} groupId
     * @param {number} blend - 0.0 to 1.0
     */
    setGroupColorBlend(groupId, blend) {
        if (this._renderer) {
            this._renderer.setGroupColorBlend(groupId, blend);
        } else {
            if (!this._pendingGroupColorBlends) this._pendingGroupColorBlends = new Map();
            this._pendingGroupColorBlends.set(groupId, blend);
        }
    }

    /**
     * Get the current color multiplier for a group.
     * @param {number} groupId
     * @returns {{r: number, g: number, b: number, a: number}}
     */
    getGroupColor(groupId) {
        if (!this._renderer) return { r: 1, g: 1, b: 1, a: 1 };
        return this._renderer.getGroupColor(groupId);
    }

    /**
     * Set group visibility. O(1) GPU update.
     * @param {number} groupId
     * @param {boolean} visible
     */
    setGroupVisibility(groupId, visible) {
        if (this._renderer) {
            this._renderer.setGroupVisibility(groupId, visible);
        } else {
            // Store as color alpha for deferred application
            if (!this._pendingGroupColors) this._pendingGroupColors = new Map();
            const existing = this._pendingGroupColors.get(groupId) || { r: 1, g: 1, b: 1, a: 1 };
            existing.a = visible ? 1.0 : 0.0;
            this._pendingGroupColors.set(groupId, existing);
        }
    }

    // ============ GPU Sync ============

    /**
     * Flush pending changes to GPU
     * This triggers the actual GPU buffer update via GlyphRendererV15
     */
    flush() {
        if (!this._dirty) return;

        // Lazy renderer creation - size buffer based on actual content
        if (!this._renderer && this._pendingAdds.length > 0) {
            this._createRenderer();
        }

        // If still no renderer (nothing to render), bail
        if (!this._renderer) {
            this._dirty = false;
            return;
        }

        // Process removals first
        for (const rendererId of this._pendingRemovals) {
            this._renderer.remove(rendererId);

            // Clean up mappings
            const ourId = this._reverseIdMap.get(rendererId);
            if (ourId !== undefined) {
                this._idMap.delete(ourId);
                this._reverseIdMap.delete(rendererId);
                this._committedTexts.delete(ourId);
            }
        }
        this._pendingRemovals = [];

        // Process updates
        for (const update of this._pendingUpdates) {
            const rendererId = this._idMap.get(update.id);
            if (rendererId === undefined) continue;

            if (update.type === 'position') {
                this._renderer.updatePosition(rendererId, update.newPosition);
                // Update committed entry
                const entry = this._committedTexts.get(update.id);
                if (entry) entry.position = update.newPosition;
            } else if (update.type === 'color') {
                this._renderer.updateColor(rendererId, update.newColor);
                const entry = this._committedTexts.get(update.id);
                if (entry) entry.options.color = update.newColor;
            } else if (update.type === 'text') {
                // For text updates, we need to remove and re-add
                // because GlyphRendererV15 doesn't have updateText
                const entry = this._committedTexts.get(update.id);
                if (entry) {
                    this._renderer.remove(rendererId);
                    const newRendererId = this._renderer.render(
                        update.newText,
                        entry.position,
                        entry.options
                    );
                    this._idMap.set(update.id, newRendererId);
                    this._reverseIdMap.delete(rendererId);
                    this._reverseIdMap.set(newRendererId, update.id);
                    entry.text = update.newText;
                    entry.rendererId = newRendererId;
                }
            }
        }
        this._pendingUpdates = [];

        // Process adds - use batch for efficiency
        if (this._pendingAdds.length > 0) {
            const batchItems = this._pendingAdds.map(p => ({
                text: p.text,
                position: p.position,
                options: p.options
            }));

            const rendererIds = this._renderer.renderBatch(batchItems);

            // Map our IDs to renderer IDs
            for (let i = 0; i < this._pendingAdds.length; i++) {
                const ourId = this._pendingAdds[i].id;
                const rendererId = rendererIds[i];

                this._idMap.set(ourId, rendererId);
                this._reverseIdMap.set(rendererId, ourId);

                // Store committed entry
                this._committedTexts.set(ourId, {
                    id: ourId,
                    rendererId,
                    text: this._pendingAdds[i].text,
                    position: this._pendingAdds[i].position,
                    options: this._pendingAdds[i].options
                });
            }

            this._pendingAdds = [];
        }

        this._dirty = false;
    }

    /**
     * Check if collection has pending changes
     * @returns {boolean} True if flush is needed
     */
    isDirty() {
        return this._dirty;
    }

    /**
     * Flush pending changes using Web Workers (async)
     *
     * Uses WorkerBridge to compute glyph buffers in parallel,
     * then applies pre-built buffers directly to GPU.
     *
     * Per-item metadata from the worker enables post-render operations
     * (updatePosition, updateColor, getText) on individual text entries.
     *
     * Falls back to sync flush() if workers unavailable.
     *
     * @returns {Promise<void>}
     */
    async flushAsync() {
        if (!this._dirty) return;

        // Fall back to sync if workers not supported or no pending adds
        if (!isWorkersSupported() || this._pendingAdds.length === 0) {
            return this.flush();
        }

        // Process removals only if renderer exists
        if (this._renderer) {
            for (const rendererId of this._pendingRemovals) {
                this._renderer.remove(rendererId);
                const ourId = this._reverseIdMap.get(rendererId);
                if (ourId !== undefined) {
                    this._idMap.delete(ourId);
                    this._reverseIdMap.delete(rendererId);
                    this._committedTexts.delete(ourId);
                }
            }
        }
        this._pendingRemovals = [];

        // Process adds via worker
        if (this._pendingAdds.length > 0) {
            const bridge = getWorkerBridge();
            const defaultColor = this.config.defaultColor;
            const items = this._pendingAdds;
            const itemCount = items.length;

            // Normalize items in-place for worker
            for (let i = 0; i < itemCount; i++) {
                const p = items[i];
                if (!p.color) p.color = p.options?.color || defaultColor;
                if (!p.scale) p.scale = p.options?.scale || 1.0;
                if (p.groupId === undefined) p.groupId = p.options?.groupId || 0;
            }

            // Get metrics from atlas (no renderer needed!)
            const metrics = this._getMetrics();

            // Ensure all codepoints in the pending items exist in the atlas BEFORE
            // dispatching to workers. Workers cannot access DOM or Three.js canvas and
            // cannot call ensureCodepoints() themselves — they silently fall back to '?'
            // for any codepoint not in the serialized UV map. This is the single
            // authoritative ensure point for the async path.
            // The version counter in ensureCodepoints() will cause WorkerBridge to
            // re-serialize the UV map and clear per-worker _hasUVMap flags, so workers
            // that were previously warmed with an older UV map will receive the fresh
            // one on this dispatch.
            {
                const missingCodes = new Set();
                for (let i = 0; i < itemCount; i++) {
                    const text = items[i].text;
                    if (!text) continue;
                    for (let j = 0; j < text.length; j++) {
                        const code = text.charCodeAt(j);
                        if (code > 32 && !this.atlas.uvMap.has(code)) {
                            missingCodes.add(code);
                        }
                    }
                }
                if (missingCodes.size > 0) {
                    this.atlas.ensureCodepoints(Array.from(missingCodes));
                }
            }

            try {
                // Build buffers in worker — returns itemMeta with per-item tracking
                const buffers = await bridge.buildBatchBuffers(items, { metrics, uvMap: null, defaultColor }, this.atlas);

                // Create renderer AFTER worker returns, with exact size needed
                if (!this._renderer) {
                    this._createRendererWithSize(buffers.count);
                }

                // Apply worker's pre-built buffers and register per-text entries
                // Pass items so renderer can reconstruct renderedTexts for updates
                const rendererIds = this._renderer.applyPrebuiltBuffers(buffers, items);

                // Use bounds from worker
                this._workerBoundsCache = buffers.bounds;

                // Build ID mappings between collection IDs and renderer IDs
                if (rendererIds) {
                    for (let i = 0; i < itemCount; i++) {
                        const p = items[i];
                        const rendererId = rendererIds[i];

                        this._idMap.set(p.id, rendererId);
                        this._reverseIdMap.set(rendererId, p.id);

                        this._committedTexts.set(p.id, {
                            id: p.id,
                            rendererId,
                            text: p.text,
                            position: p.position,
                            options: p.options
                        });
                    }
                } else {
                    // Fallback: no per-text tracking from worker.
                    // Re-render via sync path for proper tracking.
                    console.warn('GlyphCollection: No renderer IDs from worker, falling back to sync re-render');
                    this._renderer.clear();
                    const batchItems = items.map(p => ({
                        text: p.text,
                        position: p.position,
                        options: p.options
                    }));
                    const syncIds = this._renderer.renderBatch(batchItems);
                    for (let i = 0; i < itemCount; i++) {
                        const p = items[i];
                        const rendererId = syncIds[i];
                        this._idMap.set(p.id, rendererId);
                        this._reverseIdMap.set(rendererId, p.id);
                        this._committedTexts.set(p.id, {
                            id: p.id,
                            rendererId,
                            text: p.text,
                            position: p.position,
                            options: p.options
                        });
                    }
                }

                this._pendingAdds = [];
                this._boundsDirty = false;
            } catch (error) {
                console.warn('GlyphCollection: Worker flush failed, falling back to sync:', error);
                this.flush();
                return;
            }
        }

        // Process pending updates now that renderer has per-text tracking
        if (this._renderer && this._pendingUpdates.length > 0) {
            for (const update of this._pendingUpdates) {
                const rendererId = this._idMap.get(update.id);
                if (rendererId === undefined) continue;

                if (update.type === 'position') {
                    this._renderer.updatePosition(rendererId, update.newPosition);
                    const entry = this._committedTexts.get(update.id);
                    if (entry) entry.position = update.newPosition;
                } else if (update.type === 'color') {
                    this._renderer.updateColor(rendererId, update.newColor);
                    const entry = this._committedTexts.get(update.id);
                    if (entry) entry.options.color = update.newColor;
                } else if (update.type === 'text') {
                    const entry = this._committedTexts.get(update.id);
                    if (entry) {
                        this._renderer.remove(rendererId);
                        const newRendererId = this._renderer.render(
                            update.newText,
                            entry.position,
                            entry.options
                        );
                        this._idMap.set(update.id, newRendererId);
                        this._reverseIdMap.delete(rendererId);
                        this._reverseIdMap.set(newRendererId, update.id);
                        entry.text = update.newText;
                        entry.rendererId = newRendererId;
                    }
                }
            }
        }
        this._pendingUpdates = [];

        this._dirty = false;
    }

    // ============ Collection-Level Transforms ============

    /**
     * Set collection position (affects all glyphs)
     * @param {Object|THREE.Vector3} position - Position {x, y, z}
     */
    setPosition(position) {
        if (position instanceof THREE.Vector3) {
            this._transform.position.copy(position);
        } else {
            this._transform.position.set(
                position.x || 0,
                position.y || 0,
                position.z || 0
            );
        }
        this._applyTransform();
    }

    /**
     * Set collection scale
     * @param {number|Object|THREE.Vector3} scale - Uniform scale or {x, y, z}
     */
    setScale(scale) {
        if (typeof scale === 'number') {
            this._transform.scale.set(scale, scale, scale);
        } else if (scale instanceof THREE.Vector3) {
            this._transform.scale.copy(scale);
        } else {
            this._transform.scale.set(
                scale.x || 1,
                scale.y || 1,
                scale.z || 1
            );
        }
        this._applyTransform();
    }

    /**
     * Set collection rotation
     * @param {Object|THREE.Euler} rotation - Euler angles {x, y, z}
     */
    setRotation(rotation) {
        if (rotation instanceof THREE.Euler) {
            this._transform.rotation.copy(rotation);
        } else {
            this._transform.rotation.set(
                rotation.x || 0,
                rotation.y || 0,
                rotation.z || 0
            );
        }
        this._applyTransform();
    }

    /**
     * Get current transform
     * @returns {Object} Transform {position, scale, rotation}
     */
    getTransform() {
        return {
            position: this._transform.position.clone(),
            scale: this._transform.scale.clone(),
            rotation: this._transform.rotation.clone()
        };
    }

    // ============ Queries ============

    /**
     * Get bounding box of all glyphs
     * @returns {Object|null} Bounds {min, max, width, height, depth}
     */
    getBounds() {
        if (!this._boundsDirty && this._boundsCache) {
            return this._boundsCache;
        }

        // Worker path: use precomputed bounds cache
        if (this._workerBoundsCache) {
            this._boundsCache = this._workerBoundsCache;
            this._boundsDirty = false;
            return this._boundsCache;
        }

        // Query bounds from all committed texts via renderer
        const allTexts = [];
        if (this._renderer) {
            for (const [ourId, rendererId] of this._idMap) {
                const textObj = this._renderer.getText(rendererId);
                if (textObj) {
                    allTexts.push(textObj);
                }
            }
        }

        if (allTexts.length === 0) {
            this._boundsCache = null;
            this._boundsDirty = false;
            return null;
        }

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const textObj of allTexts) {
            const bounds = textObj.getBounds();
            if (bounds) {
                minX = Math.min(minX, bounds.min.x);
                minY = Math.min(minY, bounds.min.y);
                minZ = Math.min(minZ, bounds.min.z);
                maxX = Math.max(maxX, bounds.max.x);
                maxY = Math.max(maxY, bounds.max.y);
                maxZ = Math.max(maxZ, bounds.max.z);
            }
        }

        if (minX === Infinity) {
            this._boundsCache = null;
        } else {
            this._boundsCache = {
                min: { x: minX, y: minY, z: minZ },
                max: { x: maxX, y: maxY, z: maxZ },
                width: maxX - minX,
                height: maxY - minY,
                depth: maxZ - minZ
            };
        }

        this._boundsDirty = false;
        return this._boundsCache;
    }

    /**
     * Get total glyph count
     * @returns {number} Number of glyphs
     */
    getGlyphCount() {
        if (!this._renderer) {
            return this._countPendingGlyphs();
        }
        const stats = this._renderer.getStats();
        return stats.glyphCount;
    }

    /**
     * Get text entry count
     * @returns {number} Number of text entries
     */
    getTextCount() {
        return this._committedTexts.size + this._pendingAdds.length - this._pendingRemovals.length;
    }

    /**
     * Find glyphs matching a predicate
     * @param {Function} predicate - Filter function (glyph) => boolean
     * @returns {Array} Matching glyphs
     */
    findGlyphs(predicate) {
        if (!this._renderer) return [];
        return this._renderer.findTexts(entry => {
            // Check each glyph in the entry
            for (const glyph of entry.glyphs) {
                if (predicate(glyph)) return true;
            }
            return false;
        }).flatMap(textObj => textObj.glyphs.filter(predicate));
    }

    /**
     * Get text entry by ID
     * @param {number} id - Our text ID
     * @returns {Object|null} Text entry
     */
    getText(id) {
        // Check pending first
        const pending = this._pendingAdds.find(p => p.id === id);
        if (pending) {
            return {
                id: pending.id,
                text: pending.text,
                position: pending.position,
                options: pending.options,
                pending: true
            };
        }

        // Check committed
        const entry = this._committedTexts.get(id);
        if (entry) {
            const rendererText = this._renderer?.getText(entry.rendererId);
            return {
                id: entry.id,
                text: entry.text,
                position: entry.position,
                options: entry.options,
                glyphs: rendererText?.glyphs || [],
                getBounds: () => rendererText?.getBounds()
            };
        }

        return null;
    }

    /**
     * Get all text IDs
     * @returns {Array<number>} Array of text IDs
     */
    getTextIds() {
        const ids = new Set([
            ...this._committedTexts.keys(),
            ...this._pendingAdds.map(p => p.id)
        ]);
        return Array.from(ids);
    }

    // ============ Lifecycle ============

    /**
     * Clear all glyphs (immediate)
     */
    clear() {
        if (this._renderer) {
            this._renderer.clear();
        }

        this._pendingAdds = [];
        this._pendingRemovals = [];
        this._pendingUpdates = [];
        this._idMap.clear();
        this._reverseIdMap.clear();
        this._committedTexts.clear();

        this._boundsCache = null;
        this._workerBoundsCache = null;
        this._dirty = false;
        this._boundsDirty = true;
    }

    /**
     * Dispose of all resources
     */
    dispose() {
        this.clear();

        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }

        if (this.group) {
            this.scene.remove(this.group);
            this.group = null;
        }
    }

    /**
     * Get statistics
     * @returns {Object} Collection statistics
     */
    getStats() {
        if (this._renderer) {
            const rendererStats = this._renderer.getStats();
            return {
                textCount: this.getTextCount(),
                glyphCount: rendererStats.glyphCount,
                maxInstances: rendererStats.maxInstances,
                bufferSize: this._bufferSize,
                utilization: rendererStats.utilization,
                pendingAdds: this._pendingAdds.length,
                pendingRemovals: this._pendingRemovals.length,
                pendingUpdates: this._pendingUpdates.length,
                isDirty: this._dirty,
                rendererCreated: true
            };
        }

        // No renderer yet - return pending stats
        const pendingGlyphs = this._countPendingGlyphs();
        return {
            textCount: this.getTextCount(),
            glyphCount: pendingGlyphs,
            maxInstances: this.config.maxInstances || '(auto)',
            bufferSize: 0,
            utilization: '0%',
            pendingAdds: this._pendingAdds.length,
            pendingRemovals: this._pendingRemovals.length,
            pendingUpdates: this._pendingUpdates.length,
            isDirty: this._dirty,
            rendererCreated: false
        };
    }

    /**
     * Get the underlying renderer (for advanced usage)
     * @returns {GlyphRendererV15} The wrapped renderer
     */
    getRenderer() {
        return this._renderer;
    }

    // ============ Internal Methods ============

    /**
     * Create renderer with right-sized buffer based on pending content
     * @private
     */
    _createRenderer() {
        const glyphCount = this._countPendingGlyphs();
        this._createRendererWithSize(Math.ceil(glyphCount * this.config.bufferHeadroom), false);
    }

    /**
     * Create renderer with exact buffer size
     * @param {number} size - Buffer size for instances
     * @param {boolean} [skipPrealloc=true] - Skip pre-allocating instance attributes.
     *   true for worker path (buffers provided via applyPrebuiltBuffers),
     *   false for sync path (renderBatch needs pre-allocated attributes).
     * @private
     */
    _createRendererWithSize(size, skipPrealloc = true) {
        const bufferSize = Math.max(size, 100);
        this._bufferSize = bufferSize;
        this._renderer = new GlyphRendererV15(this.group, this.atlas, {
            maxInstances: bufferSize,
            defaultColor: this.config.defaultColor,
            worldScale: this.config.worldScale,
            skipPrealloc
        });

        // Apply any deferred group operations
        if (this._pendingGroupCount) {
            while (this._renderer._groupCount < this._pendingGroupCount) {
                this._renderer.createGroup();
            }
            this._pendingGroupCount = 0;
        }
        if (this._pendingGroupOffsets) {
            for (const [gid, offset] of this._pendingGroupOffsets) {
                this._renderer.setGroupOffset(gid, offset);
            }
            this._pendingGroupOffsets = null;
        }
        if (this._pendingGroupColors) {
            for (const [gid, color] of this._pendingGroupColors) {
                this._renderer.setGroupColor(gid, color);
            }
            this._pendingGroupColors = null;
        }
        if (this._pendingGroupColorBlends) {
            for (const [gid, blend] of this._pendingGroupColorBlends) {
                this._renderer.setGroupColorBlend(gid, blend);
            }
            this._pendingGroupColorBlends = null;
        }
    }

    /**
     * Estimate glyph count for buffer sizing
     * Just sums text.length - over-allocation from whitespace is fine
     * @private
     * @returns {number} Estimated glyph count
     */
    _countPendingGlyphs() {
        let count = 0;
        for (let i = 0; i < this._pendingAdds.length; i++) {
            count += this._pendingAdds[i].text.length;
        }
        return count;
    }

    /**
     * Apply transform to group
     * @private
     */
    _applyTransform() {
        if (!this.group) return;

        this.group.position.copy(this._transform.position);
        this.group.scale.copy(this._transform.scale);
        this.group.rotation.copy(this._transform.rotation);
    }
}

export default GlyphCollection;
