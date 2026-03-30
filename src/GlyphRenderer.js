/**
 * GlyphRendererV15 - Clean Architecture 3D Text Rendering
 *
 * A streamlined glyph rendering system using existing abstractions
 * with optimized batch handling and instance management.
 *
 * Key Features:
 * - Uses standardized dimensions from RenderingConstants
 * - Leverages improved UV handling from GlyphAtlas
 * - Natural batch rendering as primary path
 * - Efficient glyph referencing with WeakMap
 * - Zero allocation hot paths
 */

import * as THREE from 'three';
import { PERF_THRESHOLDS, shouldDebugLog } from './core/constants.js';
import GlyphLayout from './layout/GlyphLayout.js';
import { createLogger, LogLevel } from './utils/index.js';

// Create logger for v1.5
const logger = createLogger('GlyphRendererV15');
logger.setLevel(shouldDebugLog('instancing') ? LogLevel.DEBUG : LogLevel.INFO);

class GlyphRendererV15 {
    /**
     * Create a clean glyph renderer
     * @param {THREE.Scene} scene - Three.js scene
     * @param {GlyphAtlas} atlas - Glyph atlas with font metrics
     * @param {Object} options - Configuration options
     */
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;

        // Configuration with sensible defaults
        this.config = {
            maxInstances: options.maxInstances || PERF_THRESHOLDS.maxInstancesPerMesh,
            defaultColor: options.defaultColor || { r: 0.0, g: 1.0, b: 0.0 },
            alignment: options.alignment || 'center',
            // World units per pixel - controls overall text size
            // Higher = larger text. With 48px font, 0.1 gives ~4.8 world units per char
            worldScale: options.worldScale || 0.1,
            // Skip buffer pre-allocation for worker path (buffers provided via applyPrebuiltBuffers)
            skipPrealloc: options.skipPrealloc || false
        };

        // Derive dimensions from atlas metrics (not hardcoded!)
        // This ensures glyph size matches actual rendered font
        const atlasCharSize = atlas.getCharSize();
        const scale = this.config.worldScale;

        this.metrics = {
            // Convert pixel dimensions to world units
            charWidth: atlasCharSize.width * scale,
            charHeight: atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width * scale * 0.05,  // 5% spacing
            lineSpacing: atlasCharSize.height * scale * 1.2,    // 120% line height

            // Atlas info for UV calculations
            atlasSize: atlas.getAtlasTexture().width,

            // Keep original pixel size for reference
            pixelWidth: atlasCharSize.width,
            pixelHeight: atlasCharSize.height
        };

        // Group transform DataTexture (4 columns x maxGroups rows, RGBA Float)
        // WebGL max texture dimension is typically 16384; cap with headroom
        const MAX_GROUP_TEXTURE_DIM = 16000;
        const requestedGroups = options.maxGroups || PERF_THRESHOLDS.defaultMaxGroups;
        this._maxGroups = Math.min(requestedGroups, MAX_GROUP_TEXTURE_DIM);
        if (requestedGroups > MAX_GROUP_TEXTURE_DIM) {
            logger.warn(`maxGroups ${requestedGroups} exceeds texture limit, capped at ${MAX_GROUP_TEXTURE_DIM}`);
        }
        this._groupData = new Float32Array(this._maxGroups * 4 * 4);
        this._initGroupDefaults();
        this._groupTexture = null; // created in _createInstanceMesh
        this._groupCount = 1; // group 0 always exists (identity)

        // Subsystems created lazily (only when needed for sync path)
        // Worker path uses applyPrebuiltBuffers() directly - no need for these
        this._layout = null;

        // Use shared atlas texture (one texture for all renderers)
        this.texture = atlas.getSharedThreeTexture(THREE);

        // Pre-create instance mesh
        this.instanceMesh = this._createInstanceMesh();
        this.scene.add(this.instanceMesh);

        // Track rendered content with better structure
        this.renderedTexts = new Map();      // id -> TextEntry
        this.textsByMesh = new WeakMap();    // mesh -> Set<id>
        this.nextId = 1;

        logger.trace('Initialized', {
            atlas: `${this.atlas.getAtlasTexture().width}x${this.atlas.getAtlasTexture().height}`,
            fontPixels: `${this.metrics.pixelWidth}x${this.metrics.pixelHeight}px`,
            worldUnits: `${this.metrics.charWidth.toFixed(3)}x${this.metrics.charHeight.toFixed(3)}`,
            worldScale: this.config.worldScale,
            maxInstances: this.config.maxInstances
        });
    }

    /**
     * Create optimized atlas texture using v1.0 settings
     * @private
     */
    _createAtlasTexture() {
        const canvas = this.atlas.getAtlasTexture();
        const texture = new THREE.CanvasTexture(canvas);

        // Use quality settings from v1.0
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 4;  // Better quality at angles
        texture.needsUpdate = true;

        return texture;
    }

    /**
     * Fill group DataTexture with identity values for all groups.
     * Layout: 4 columns per group (pos, rot, color, scale), 4 floats each.
     * Index for group G, column C: (G * 4 + C) * 4
     * @private
     */
    _initGroupDefaults() {
        for (let g = 0; g < this._maxGroups; g++) {
            const base = g * 4 * 4; // 4 columns × 4 floats
            // Col 0: position offset (0,0,0) + visibility (1.0)
            this._groupData[base + 3] = 1.0;
            // Col 1: rotation quaternion identity (0,0,0,1)
            this._groupData[base + 4 + 3] = 1.0;
            // Col 2: color multiplier (1,1,1,1)
            this._groupData[base + 8] = 1.0;
            this._groupData[base + 8 + 1] = 1.0;
            this._groupData[base + 8 + 2] = 1.0;
            this._groupData[base + 8 + 3] = 1.0;
            // Col 3: scale (1,1,1,0)
            this._groupData[base + 12] = 1.0;
            this._groupData[base + 12 + 1] = 1.0;
            this._groupData[base + 12 + 2] = 1.0;
        }
    }

    /**
     * Create Float RGBA DataTexture for group properties.
     * Width=4 (columns: pos, rot, color, scale), Height=maxGroups.
     * @private
     * @returns {THREE.DataTexture}
     */
    _createGroupTexture() {
        const texture = new THREE.DataTexture(
            this._groupData,
            4,                    // width: 4 property columns
            this._maxGroups,      // height: one row per group
            THREE.RGBAFormat,
            THREE.FloatType
        );
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }

    /**
     * Create the single instance mesh used for all rendering
     * @private
     */
    _createInstanceMesh() {
        // Use InstancedBufferGeometry for proper instancing (learned from v1.0)
        const geometry = new THREE.InstancedBufferGeometry();
        const baseGeometry = new THREE.PlaneGeometry(1, 1);

        // Copy base attributes
        geometry.index = baseGeometry.index;
        geometry.attributes.position = baseGeometry.attributes.position;
        geometry.attributes.uv = baseGeometry.attributes.uv;

        // Create group offset DataTexture
        this._groupTexture = this._createGroupTexture();

        // Build atlas map texture for GPU-side codepoint → UV lookup
        const atlasMapTexture = this.atlas.getAtlasMapTexture(THREE);
        const atlasMapDims = this.atlas.getAtlasMapDimensions();
        if (!GlyphRendererV15._gpuLookupLogged) {
            GlyphRendererV15._gpuLookupLogged = true;
            logger.debug('[GPU-Lookup] Pipeline active: instanceCodepoint + atlasMapTexture', {
                atlasMapDims,
                glyphsInMap: this.atlas.uvMap.size
            });
        }

        // Create shader material (clean, no debug paths)
        const material = new THREE.ShaderMaterial({
            uniforms: {
                atlasTexture: { value: this.texture },
                groupTexture: { value: this._groupTexture },
                groupTextureHeight: { value: this._maxGroups },
                atlasMapTexture: { value: atlasMapTexture },
                atlasMapWidth: { value: atlasMapDims.width },
                atlasMapHeight: { value: atlasMapDims.height }
            },
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            transparent: false,
            alphaTest: 0.01,
            side: THREE.DoubleSide,
            depthWrite: true
        });

        // Pre-allocate instance attributes (skip for worker path - buffers provided later)
        if (!this.config.skipPrealloc) {
            const maxCount = this.config.maxInstances;
            geometry.setAttribute('instancePosition',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
            geometry.setAttribute('instanceSize',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2), 2));
            geometry.setAttribute('instanceCodepoint',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
            geometry.setAttribute('instanceColor',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
            geometry.setAttribute('instanceGroupId',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
            geometry.setAttribute('instanceAddedColor',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
            geometry.setAttribute('instancePickingId',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
            geometry._maxInstanceCount = maxCount;
        }

        // Start with zero instances visible
        geometry.instanceCount = 0;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;

        if (shouldDebugLog('instancing')) {
            logger.debug('Instance mesh created', {
                maxInstances: maxCount,
                geometryType: 'InstancedBufferGeometry'
            });
        }

        return mesh;
    }

    /**
     * Get optimized vertex shader (GPU codepoint → UV lookup path)
     * @private
     */
    _getVertexShader() {
        return `
            precision highp float;

            attribute vec3 instancePosition;
            attribute vec2 instanceSize;
            attribute float instanceCodepoint;
            attribute vec3 instanceColor;
            attribute float instanceGroupId;
            attribute vec3 instanceAddedColor;
            attribute float instancePickingId;

            uniform sampler2D groupTexture;
            uniform float groupTextureHeight;

            // Atlas map texture: codepoint -> (u0, v0_webgl, u1, v1_webgl)
            // Layout: atlasMapWidth texels wide x atlasMapHeight rows tall
            uniform sampler2D atlasMapTexture;
            uniform float atlasMapWidth;
            uniform float atlasMapHeight;

            varying highp vec2 vUV;
            varying vec3 vColor;
            varying float vGroupAlpha;
            varying vec3 vAddedColor;

            void main() {
                // Transform quad by instance size
                vec3 scaled = position * vec3(instanceSize, 1.0);

                // Group property lookups (4-column DataTexture)
                float v = (instanceGroupId + 0.5) / groupTextureHeight;
                vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));  // col 0: offset + visibility
                vec4 gColor = texture2D(groupTexture, vec2(0.625, v));  // col 2: color multiplier
                vec4 gScale = texture2D(groupTexture, vec2(0.875, v));  // col 3: scale

                // World position = scale instance position, then add group offset
                vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;

                // Standard projection
                gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

                // -----------------------------------------------------------------
                // GPU codepoint → UV lookup  [GPU-Lookup path]
                //
                // instanceCodepoint holds the raw Unicode codepoint. atlasMapTexture
                // is a 1024-wide RGBA Float DataTexture where texel[cp] stores the
                // pre-flipped (u0, v0_webgl, u1, v1_webgl) for that glyph.
                // mix() maps the unit quad's uv onto the glyph's atlas sub-rect.
                // No CPU-side UV array is used — see GlyphAtlas.getAtlasMapTexture().
                // -----------------------------------------------------------------
                float cp = instanceCodepoint;
                float mapCol = mod(cp, atlasMapWidth);
                float mapRow = floor(cp / atlasMapWidth);
                float tx = (mapCol + 0.5) / atlasMapWidth;
                float ty = (mapRow + 0.5) / atlasMapHeight;
                vec4 uvRect = texture2D(atlasMapTexture, vec2(tx, ty));
                // uvRect = (u0, v0_webgl, u1, v1_webgl) — pre-flipped in GlyphAtlas
                vUV = mix(uvRect.xy, uvRect.zw, uv);

                // gScale.w = color blend factor: 0.0 = multiply (default), 1.0 = replace
                float colorBlend = gScale.w;
                vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend);
                vGroupAlpha = gColor.a;
                vAddedColor = instanceAddedColor;
            }
        `;
    }

    /**
     * Get optimized fragment shader
     * @private
     */
    _getFragmentShader() {
        return `
            precision highp float;

            uniform sampler2D atlasTexture;

            varying highp vec2 vUV;
            varying vec3 vColor;
            varying float vGroupAlpha;
            varying vec3 vAddedColor;

            void main() {
                vec4 texColor = texture2D(atlasTexture, vUV);

                // Apply instance color and group alpha, then additive highlight
                vec4 base = texColor * vec4(vColor, vGroupAlpha);
                gl_FragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);

                // Alpha test for clean edges and group visibility
                if (gl_FragColor.a < 0.01) discard;
            }
        `;
    }

    // ============ Public API with Better Structure ============

    /**
     * Render text at a position
     * @param {string} text - Text to render
     * @param {Object} position - Position {x, y, z}
     * @param {Object} options - Optional overrides
     * @returns {number} ID for this text
     */
    render(text, position = {x: 0, y: 0, z: 0}, options = {}) {
        // Apply deferred CanvasTexture re-upload: batch all ensureCodepoints() calls
        // in this frame into one GPU re-upload at draw time, avoiding a stall per-call.
        if (this.atlas && this.atlas.checkAndClearTextureUpdate()) {
            if (this.texture) this.texture.needsUpdate = true;
        }
        this._ensureGlyphsInAtlas([{ text }]);
        const glyphs = this._textToGlyphs(text, position, options);
        const id = this._registerText(text, glyphs, options);
        this._rebuildAllInstances();
        return id;
    }

    /**
     * Batch render multiple texts efficiently
     * @param {Array} items - Array of {text, position, options}
     * @returns {Array} IDs for the rendered texts
     */
    renderBatch(items) {
        // Apply deferred CanvasTexture re-upload: batch all ensureCodepoints() calls
        // in this frame into one GPU re-upload at draw time, avoiding a stall per-call.
        if (this.atlas && this.atlas.checkAndClearTextureUpdate()) {
            if (this.texture) this.texture.needsUpdate = true;
        }
        this._ensureGlyphsInAtlas(items);
        const ids = [];

        // Collect all glyphs first
        for (const item of items) {
            const glyphs = this._textToGlyphs(
                item.text,
                item.position || {x: 0, y: 0, z: 0},
                item.options || {}
            );
            const id = this._registerText(item.text, glyphs, item.options);
            ids.push(id);
        }

        // Single rebuild for all
        this._rebuildAllInstances();
        return ids;
    }

    /**
     * Get text object by ID for manipulation
     * @param {number} id - Text ID
     * @returns {Object|null} Text entry with methods
     */
    getText(id) {
        const entry = this.renderedTexts.get(id);
        if (!entry) return null;

        // Return a proxy object with manipulation methods
        return {
            id: id,
            text: entry.text,
            glyphs: entry.glyphs,
            options: entry.options,

            // Methods for this text
            updatePosition: (newPos) => this.updatePosition(id, newPos),
            updateColor: (newColor) => this.updateColor(id, newColor),
            remove: () => this.remove(id),
            getBounds: () => this._getTextBounds(entry.glyphs)
        };
    }

    /**
     * Find texts by criteria
     * @param {Function} predicate - Filter function
     * @returns {Array} Matching text objects
     */
    findTexts(predicate) {
        const results = [];
        for (const [id, entry] of this.renderedTexts) {
            if (predicate(entry)) {
                results.push(this.getText(id));
            }
        }
        return results;
    }

    // ============ Batch Update Mode ============
    // Use beginBatchUpdate() / endBatchUpdate() to defer rebuilds
    // when making multiple updates (e.g., highlighting many words)

    /**
     * Begin batch update mode - defers GPU buffer rebuilds
     * Call endBatchUpdate() when done to apply all changes at once
     */
    beginBatchUpdate() {
        this._batchMode = true;
        this._batchDirty = false;
    }

    /**
     * End batch update mode and rebuild if needed
     */
    endBatchUpdate() {
        this._batchMode = false;
        if (this._batchDirty) {
            this._rebuildAllInstances();
            this._batchDirty = false;
        }
    }

    /**
     * Internal: rebuild or mark dirty based on batch mode
     */
    _maybeRebuild() {
        if (this._batchMode) {
            this._batchDirty = true;
        } else {
            this._rebuildAllInstances();
        }
    }

    /**
     * Update text position - DIRECT BUFFER WRITE (no rebuild!)
     * @param {number} id - Text ID from render()
     * @param {Object} newPosition - New position {x, y, z}
     */
    updatePosition(id, newPosition) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;

        // Calculate offset from first glyph's current position
        const offset = {
            x: newPosition.x - entry.glyphs[0].position.x,
            y: newPosition.y - entry.glyphs[0].position.y,
            z: newPosition.z - entry.glyphs[0].position.z
        };

        // Get the position buffer
        const geometry = this.instanceMesh.geometry;
        const positions = geometry.attributes.instancePosition.array;

        // Update both our glyph data AND the GPU buffer directly
        const startIdx = entry.bufferStartIndex;
        for (let i = 0; i < entry.glyphs.length; i++) {
            const glyph = entry.glyphs[i];
            glyph.position.x += offset.x;
            glyph.position.y += offset.y;
            glyph.position.z += offset.z;

            // Direct buffer write
            const bufIdx = (startIdx + i) * 3;
            positions[bufIdx] = glyph.position.x;
            positions[bufIdx + 1] = glyph.position.y;
            positions[bufIdx + 2] = glyph.position.z;
        }

        // Mark only position attribute as needing GPU upload
        geometry.attributes.instancePosition.needsUpdate = true;
    }

    /**
     * Update text color - DIRECT BUFFER WRITE (no rebuild!)
     * @param {number} id - Text ID
     * @param {Object} newColor - New color {r, g, b}
     */
    updateColor(id, newColor) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;

        // Get the color buffer
        const geometry = this.instanceMesh.geometry;
        const colors = geometry.attributes.instanceColor.array;

        // Update both our glyph data AND the GPU buffer directly
        const startIdx = entry.bufferStartIndex;
        for (let i = 0; i < entry.glyphs.length; i++) {
            const glyph = entry.glyphs[i];
            glyph.color = newColor;

            // Direct buffer write
            const bufIdx = (startIdx + i) * 3;
            colors[bufIdx] = newColor.r;
            colors[bufIdx + 1] = newColor.g;
            colors[bufIdx + 2] = newColor.b;
        }

        // Mark only color attribute as needing GPU upload
        geometry.attributes.instanceColor.needsUpdate = true;
    }

    /**
     * Update additive color highlight for all glyphs of a text entry.
     * Direct buffer write — no rebuild triggered.
     * @param {number} id - Renderer-internal text ID
     * @param {{r: number, g: number, b: number}|null} addedColor - null or omitted clears highlight
     */
    updateAddedColor(id, addedColor) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;
        const attr = this.instanceMesh.geometry.attributes.instanceAddedColor;
        if (!attr) return;
        const arr = attr.array;
        const startIdx = entry.bufferStartIndex;
        const r = addedColor?.r ?? 0;
        const g = addedColor?.g ?? 0;
        const b = addedColor?.b ?? 0;
        for (let i = 0; i < entry.glyphs.length; i++) {
            const bufIdx = (startIdx + i) * 3;
            arr[bufIdx]     = r;
            arr[bufIdx + 1] = g;
            arr[bufIdx + 2] = b;
        }
        attr.needsUpdate = true;
    }

    /**
     * Set additive highlight color on a single glyph by absolute buffer slot index.
     * Used for token-level highlighting within a text entry.
     * @param {number} bufferSlotIndex - Absolute index into instanceAddedColor array
     * @param {{r: number, g: number, b: number}|null} color - null clears
     */
    setGlyphHighlight(bufferSlotIndex, color) {
        const attr = this.instanceMesh.geometry.attributes.instanceAddedColor;
        if (!attr) return;
        const i = bufferSlotIndex * 3;
        attr.array[i]     = color?.r ?? 0;
        attr.array[i + 1] = color?.g ?? 0;
        attr.array[i + 2] = color?.b ?? 0;
        attr.needsUpdate = true;
    }

    /**
     * Write contiguous picking IDs for one text entry.
     * Primary path is PickingSystem.registerRenderer() which writes the full buffer;
     * this method is available for per-entry assignment if needed.
     * @param {number} textId - Renderer-internal text ID
     * @param {number} baseId - First glyph gets baseId, subsequent glyphs baseId+1, etc.
     */
    assignPickingIds(textId, baseId) {
        const entry = this.renderedTexts.get(textId);
        if (!entry || entry.bufferStartIndex === undefined) return;
        const attr = this.instanceMesh.geometry.attributes.instancePickingId;
        if (!attr) return;
        const start = entry.bufferStartIndex;
        for (let i = 0; i < entry.glyphs.length; i++) {
            attr.array[start + i] = baseId + i;
        }
        attr.needsUpdate = true;
    }

    /**
     * Bulk update positions for multiple text entries in a single pass.
     * Writes all changes to the position buffer, then flags needsUpdate once.
     * @param {Array<{id: number, position: {x: number, y: number, z: number}}>} updates
     */
    updatePositions(updates) {
        if (!this.instanceMesh || updates.length === 0) return;

        const geometry = this.instanceMesh.geometry;
        const positions = geometry.attributes.instancePosition.array;

        for (let u = 0; u < updates.length; u++) {
            const { id, position: newPosition } = updates[u];
            const entry = this.renderedTexts.get(id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const offset = {
                x: newPosition.x - entry.glyphs[0].position.x,
                y: newPosition.y - entry.glyphs[0].position.y,
                z: newPosition.z - entry.glyphs[0].position.z
            };

            const startIdx = entry.bufferStartIndex;
            for (let i = 0; i < entry.glyphs.length; i++) {
                const glyph = entry.glyphs[i];
                glyph.position.x += offset.x;
                glyph.position.y += offset.y;
                glyph.position.z += offset.z;

                const bufIdx = (startIdx + i) * 3;
                positions[bufIdx] = glyph.position.x;
                positions[bufIdx + 1] = glyph.position.y;
                positions[bufIdx + 2] = glyph.position.z;
            }
        }

        geometry.attributes.instancePosition.needsUpdate = true;
    }

    /**
     * Bulk update colors for multiple text entries in a single pass.
     * Writes all changes to the color buffer, then flags needsUpdate once.
     * @param {Array<{id: number, color: {r: number, g: number, b: number}}>} updates
     */
    updateColors(updates) {
        if (!this.instanceMesh || updates.length === 0) return;

        const geometry = this.instanceMesh.geometry;
        const colors = geometry.attributes.instanceColor.array;

        for (let u = 0; u < updates.length; u++) {
            const { id, color: newColor } = updates[u];
            const entry = this.renderedTexts.get(id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const startIdx = entry.bufferStartIndex;
            for (let i = 0; i < entry.glyphs.length; i++) {
                entry.glyphs[i].color = newColor;

                const bufIdx = (startIdx + i) * 3;
                colors[bufIdx] = newColor.r;
                colors[bufIdx + 1] = newColor.g;
                colors[bufIdx + 2] = newColor.b;
            }
        }

        geometry.attributes.instanceColor.needsUpdate = true;
    }

    /**
     * Bulk update both positions and colors in a single pass.
     * Most efficient for operations like layout animations that change both.
     * @param {Array<{id: number, position?: {x: number, y: number, z: number}, color?: {r: number, g: number, b: number}}>} updates
     */
    updateTransforms(updates) {
        if (!this.instanceMesh || updates.length === 0) return;

        const geometry = this.instanceMesh.geometry;
        const positions = geometry.attributes.instancePosition.array;
        const colors = geometry.attributes.instanceColor.array;
        let positionDirty = false;
        let colorDirty = false;

        for (let u = 0; u < updates.length; u++) {
            const update = updates[u];
            const entry = this.renderedTexts.get(update.id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const startIdx = entry.bufferStartIndex;

            if (update.position) {
                const offset = {
                    x: update.position.x - entry.glyphs[0].position.x,
                    y: update.position.y - entry.glyphs[0].position.y,
                    z: update.position.z - entry.glyphs[0].position.z
                };

                for (let i = 0; i < entry.glyphs.length; i++) {
                    const glyph = entry.glyphs[i];
                    glyph.position.x += offset.x;
                    glyph.position.y += offset.y;
                    glyph.position.z += offset.z;

                    const bufIdx = (startIdx + i) * 3;
                    positions[bufIdx] = glyph.position.x;
                    positions[bufIdx + 1] = glyph.position.y;
                    positions[bufIdx + 2] = glyph.position.z;
                }
                positionDirty = true;
            }

            if (update.color) {
                for (let i = 0; i < entry.glyphs.length; i++) {
                    entry.glyphs[i].color = update.color;

                    const bufIdx = (startIdx + i) * 3;
                    colors[bufIdx] = update.color.r;
                    colors[bufIdx + 1] = update.color.g;
                    colors[bufIdx + 2] = update.color.b;
                }
                colorDirty = true;
            }
        }

        if (positionDirty) geometry.attributes.instancePosition.needsUpdate = true;
        if (colorDirty) geometry.attributes.instanceColor.needsUpdate = true;
    }

    // ============ Stats ============

    /**
     * Get memory and instance statistics for this renderer.
     * @returns {Object}
     */
    getMemoryStats() {
        const geom = this.instanceMesh?.geometry;
        const instanceCount = geom?.instanceCount ?? 0;
        const maxInstances = geom?._maxInstanceCount ?? this.config.maxInstances;

        // Sum actual GPU buffer bytes from all instance attributes
        let allocatedBytes = 0;
        let usedBytes = 0;
        const attributes = {};
        if (geom) {
            for (const name of Object.keys(geom.attributes)) {
                if (!name.startsWith('instance')) continue;
                const attr = geom.attributes[name];
                const totalBytes = attr.array.byteLength;
                const activeBytes = instanceCount * attr.itemSize * 4;
                allocatedBytes += totalBytes;
                usedBytes += activeBytes;
                attributes[name] = { itemSize: attr.itemSize, totalBytes, activeBytes };
            }
        }

        // Group DataTexture
        const groupBytes = this._groupData?.byteLength ?? 0;

        return {
            instanceCount,
            maxInstances,
            allocatedBytes,
            usedBytes,
            wasteBytes: allocatedBytes - usedBytes,
            groupTextureBytes: groupBytes * 2, // CPU + GPU
            totalBytes: allocatedBytes + groupBytes * 2,
            attributes,
            textEntryCount: this.renderedTexts.size,
        };
    }

    // ============ Group Transform API ============

    /**
     * Create a new group. Returns a groupId for use with addText options
     * and setGroupOffset/setGroupColor.
     * @returns {number} The new groupId
     */
    createGroup() {
        const groupId = this._groupCount++;
        if (groupId >= this._maxGroups) {
            this._growGroupTexture();
            // If growth failed (hit texture limit), fall back to group 0
            if (groupId >= this._maxGroups) {
                this._groupCount--;
                return 0;
            }
        }
        return groupId;
    }

    /**
     * Set the world-space position offset for a group. O(1) GPU update.
     * @param {number} groupId
     * @param {{x: number, y: number, z: number}} offset
     */
    setGroupOffset(groupId, offset) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 0) * 4; // column 0
        this._groupData[base] = offset.x;
        this._groupData[base + 1] = offset.y;
        this._groupData[base + 2] = offset.z;
        // base + 3 = visibility, preserved
        this._groupTexture.needsUpdate = true;
    }

    /**
     * Get the current offset for a group.
     * @param {number} groupId
     * @returns {{x: number, y: number, z: number}}
     */
    getGroupOffset(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 0, y: 0, z: 0 };
        const base = (groupId * 4 + 0) * 4;
        return {
            x: this._groupData[base],
            y: this._groupData[base + 1],
            z: this._groupData[base + 2]
        };
    }

    /**
     * Set the color multiplier for a group. O(1) GPU update.
     * Instance colors are multiplied by this value in the shader.
     * Alpha controls group opacity (0 = invisible, 1 = fully visible).
     * @param {number} groupId
     * @param {{r: number, g: number, b: number, a?: number}} color
     */
    setGroupColor(groupId, color) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 2) * 4; // column 2
        this._groupData[base] = color.r;
        this._groupData[base + 1] = color.g;
        this._groupData[base + 2] = color.b;
        this._groupData[base + 3] = color.a !== undefined ? color.a : 1.0;
        this._groupTexture.needsUpdate = true;
    }

    /**
     * Set the color blend mode for a group. O(1) GPU update.
     * Controls how group color interacts with instance colors in the shader:
     *   0.0 = multiply (default) — group color multiplies instance color
     *   1.0 = replace — group color fully replaces instance color
     *   0.0..1.0 = mix between multiplied and replaced result
     * Stored in gScale.w (column 3, w component) of the group texture.
     * @param {number} groupId
     * @param {number} blend - 0.0 (multiply) to 1.0 (replace)
     */
    setGroupColorBlend(groupId, blend) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 3) * 4; // column 3 (scale)
        this._groupData[base + 3] = blend;   // w component
        this._groupTexture.needsUpdate = true;
    }

    /**
     * Get the current color multiplier for a group.
     * @param {number} groupId
     * @returns {{r: number, g: number, b: number, a: number}}
     */
    getGroupColor(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { r: 1, g: 1, b: 1, a: 1 };
        const base = (groupId * 4 + 2) * 4;
        return {
            r: this._groupData[base],
            g: this._groupData[base + 1],
            b: this._groupData[base + 2],
            a: this._groupData[base + 3]
        };
    }

    /**
     * Set group visibility. Uses color alpha channel — invisible groups
     * have alpha 0 which triggers the fragment shader's alpha discard.
     * @param {number} groupId
     * @param {boolean} visible
     */
    setGroupVisibility(groupId, visible) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 2) * 4; // column 2 (color)
        this._groupData[base + 3] = visible ? 1.0 : 0.0;
        this._groupTexture.needsUpdate = true;
    }

    /**
     * Set the scale for a group. O(1) GPU update.
     * Scales instance positions within the group (not the quad size).
     * Default is (1,1,1) — identity.
     * @param {number} groupId
     * @param {{x: number, y: number, z: number}} scale
     */
    setGroupScale(groupId, scale) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 3) * 4; // column 3
        this._groupData[base] = scale.x;
        this._groupData[base + 1] = scale.y;
        this._groupData[base + 2] = scale.z;
        this._groupTexture.needsUpdate = true;
    }

    /**
     * Get the current scale for a group.
     * @param {number} groupId
     * @returns {{x: number, y: number, z: number}}
     */
    getGroupScale(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 1, y: 1, z: 1 };
        const base = (groupId * 4 + 3) * 4;
        return {
            x: this._groupData[base],
            y: this._groupData[base + 1],
            z: this._groupData[base + 2]
        };
    }

    /**
     * Grow the group DataTexture when capacity is exceeded.
     * @private
     */
    _growGroupTexture() {
        const MAX_GROUP_TEXTURE_DIM = 16000;
        const oldMax = this._maxGroups;
        if (oldMax >= MAX_GROUP_TEXTURE_DIM) {
            logger.warn(`Group texture at max capacity (${oldMax}), cannot grow`);
            return;
        }
        this._maxGroups = Math.min(oldMax * 2, MAX_GROUP_TEXTURE_DIM);

        const newData = new Float32Array(this._maxGroups * 4 * 4);
        // Copy existing data
        newData.set(this._groupData);
        this._groupData = newData;

        // Initialize new groups with identity defaults
        for (let g = oldMax; g < this._maxGroups; g++) {
            const base = g * 4 * 4;
            this._groupData[base + 3] = 1.0;        // col 0: visibility
            this._groupData[base + 4 + 3] = 1.0;    // col 1: quat.w
            this._groupData[base + 8] = 1.0;         // col 2: color.r
            this._groupData[base + 8 + 1] = 1.0;     // col 2: color.g
            this._groupData[base + 8 + 2] = 1.0;     // col 2: color.b
            this._groupData[base + 8 + 3] = 1.0;     // col 2: color.a
            this._groupData[base + 12] = 1.0;         // col 3: scale.x
            this._groupData[base + 12 + 1] = 1.0;     // col 3: scale.y
            this._groupData[base + 12 + 2] = 1.0;     // col 3: scale.z
        }

        // Dispose old texture, create new one
        if (this._groupTexture) {
            this._groupTexture.dispose();
        }
        this._groupTexture = this._createGroupTexture();

        // Update material uniforms
        if (this.instanceMesh) {
            this.instanceMesh.material.uniforms.groupTexture.value = this._groupTexture;
            this.instanceMesh.material.uniforms.groupTextureHeight.value = this._maxGroups;
        }
    }

    /**
     * Remove rendered text
     * @param {number} id - Text ID to remove
     */
    remove(id) {
        if (this.renderedTexts.delete(id)) {
            this._rebuildAllInstances();
        }
    }

    /**
     * Remove multiple texts efficiently
     * @param {Array<number>} ids - Array of text IDs
     */
    removeBatch(ids) {
        let removed = false;
        for (const id of ids) {
            if (this.renderedTexts.delete(id)) {
                removed = true;
            }
        }
        if (removed) {
            this._rebuildAllInstances();
        }
    }

    /**
     * Clear all rendered text
     */
    clear() {
        this.renderedTexts.clear();
        this.instanceMesh.geometry.instanceCount = 0;
    }

    // ============ Internal Methods ============

    /**
     * Ensure all codepoints in the given text items exist in the atlas.
     * Dynamically adds missing glyphs and invalidates the atlas map texture cache.
     * @param {Array<{text: string}>} items
     * @private
     */
    _ensureGlyphsInAtlas(items) {
        const missing = [];
        for (const item of items) {
            if (!item.text) continue;
            for (let i = 0; i < item.text.length; i++) {
                const code = item.text.charCodeAt(i);
                if (code > 32 && !this.atlas.uvMap.has(code)) {
                    missing.push(code);
                }
            }
        }
        if (missing.length > 0) {
            // Delegate to the unified entry point: handles canvas pack, DataTexture
            // update, textureNeedsUpdate flag, serialized cache invalidation, and
            // _uvMapVersion increment. All renderers share the same atlas object so
            // the DataTexture needsUpdate propagates automatically.
            this.atlas.ensureCodepoints(missing);
        }
    }

    /**
     * Convert text to glyph instances
     * @private
     */
    _textToGlyphs(text, position, options) {
        const color = options.color || this.config.defaultColor;
        const scale = options.scale || 1.0;

        // Get layout positions for each character
        // NOTE: layoutText skips newlines in the positions array
        // Lazy-create layout only when sync path is used
        if (!this._layout) {
            this._layout = new GlyphLayout(this.metrics);
        }
        const positions = this._layout.layoutText(text, position, options.alignment);

        // Build glyph data
        // Use separate index for positions array since it skips newlines
        const glyphs = [];
        let posIndex = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Newlines are not in positions array - skip without incrementing posIndex
            if (char === '\n') continue;

            // Spaces are in positions array but we don't render them
            if (char === ' ') {
                posIndex++;
                continue;
            }

            const pos = positions[posIndex++];
            if (!pos) continue; // Safety check

            const charCode = char.charCodeAt(0);
            if (!this.atlas.hasGlyph(charCode)) continue; // Skip unsupported chars

            glyphs.push({
                position: pos,
                size: {
                    width: this.metrics.charWidth * scale,
                    height: this.metrics.charHeight * scale
                },
                charCode: charCode,
                color: color,
                char: char,  // Keep for debugging
                groupId: options.groupId || 0
            });
        }

        return glyphs;
    }

    /**
     * Register text and return ID
     * @private
     */
    _registerText(text, glyphs, options) {
        const id = this.nextId++;
        this.renderedTexts.set(id, {
            id: id,
            text: text,
            glyphs: glyphs,
            options: options || {},
            timestamp: Date.now()
        });
        return id;
    }

    /**
     * Get bounds of text glyphs
     * @private
     */
    _getTextBounds(glyphs) {
        if (glyphs.length === 0) return null;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const g of glyphs) {
            minX = Math.min(minX, g.position.x);
            minY = Math.min(minY, g.position.y);
            minZ = Math.min(minZ, g.position.z);
            maxX = Math.max(maxX, g.position.x + g.size.width);
            maxY = Math.max(maxY, g.position.y + g.size.height);
            maxZ = Math.max(maxZ, g.position.z);
        }

        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            width: maxX - minX,
            height: maxY - minY,
            depth: maxZ - minZ
        };
    }

    /**
     * Rebuild all instance data
     * @private
     */
    _rebuildAllInstances() {
        // Collect all glyphs AND track buffer indices for each text entry
        const allGlyphs = [];
        let bufferIndex = 0;

        for (const entry of this.renderedTexts.values()) {
            // Store where this text's glyphs start in the buffer
            entry.bufferStartIndex = bufferIndex;
            entry.glyphCount = entry.glyphs.length;

            allGlyphs.push(...entry.glyphs);
            bufferIndex += entry.glyphs.length;
        }

        this._updateInstanceMesh(allGlyphs);
    }

    /**
     * Update instance mesh with glyph data
     * @private
     */
    _updateInstanceMesh(glyphs) {
        const count = Math.min(glyphs.length, this.config.maxInstances);

        if (count === 0) {
            this.instanceMesh.geometry.instanceCount = 0;
            return;
        }

        // Get attribute arrays
        const geometry = this.instanceMesh.geometry;
        const positions = geometry.attributes.instancePosition.array;
        const sizes = geometry.attributes.instanceSize.array;
        const codepoints = geometry.attributes.instanceCodepoint.array;
        const colors = geometry.attributes.instanceColor.array;
        const groupIds = geometry.attributes.instanceGroupId.array;
        const addedColors = geometry.attributes.instanceAddedColor?.array;

        // Fill arrays
        for (let i = 0; i < count; i++) {
            const g = glyphs[i];

            // Position
            positions[i * 3] = g.position.x;
            positions[i * 3 + 1] = g.position.y;
            positions[i * 3 + 2] = g.position.z;

            // Size
            sizes[i * 2] = g.size.width;
            sizes[i * 2 + 1] = g.size.height;

            // Codepoint — GPU resolves to UV via atlasMapTexture
            codepoints[i] = g.charCode || 63; // fallback to '?'

            // Color
            colors[i * 3] = g.color.r;
            colors[i * 3 + 1] = g.color.g;
            colors[i * 3 + 2] = g.color.b;

            // Group ID
            groupIds[i] = g.groupId || 0;

            // Added color (highlight) — default 0,0,0 (no additive change)
            if (addedColors) {
                const ac = g.addedColor;
                addedColors[i * 3]     = ac ? ac.r : 0;
                addedColors[i * 3 + 1] = ac ? ac.g : 0;
                addedColors[i * 3 + 2] = ac ? ac.b : 0;
            }
        }

        // Mark attributes as needing update
        geometry.attributes.instancePosition.needsUpdate = true;
        geometry.attributes.instanceSize.needsUpdate = true;
        geometry.attributes.instanceCodepoint.needsUpdate = true;
        geometry.attributes.instanceColor.needsUpdate = true;
        geometry.attributes.instanceGroupId.needsUpdate = true;
        if (geometry.attributes.instanceAddedColor) {
            geometry.attributes.instanceAddedColor.needsUpdate = true;
        }
        // instancePickingId.needsUpdate is set by PickingSystem.registerRenderer(), not here

        // Set instance count
        geometry.instanceCount = count;

        if (shouldDebugLog('firstInstance') && count > 0) {
            logger.debug('[GPU-Lookup] First instance sample (UV resolved on GPU via atlasMapTexture)', {
                position: `(${glyphs[0].position.x.toFixed(2)}, ${glyphs[0].position.y.toFixed(2)})`,
                char: glyphs[0].char,
                codepoint: glyphs[0].charCode
            });
        }
    }

    /**
     * Apply pre-built buffers directly to GPU
     *
     * Used by worker pipeline to skip main-thread computation.
     * Buffers come from WorkerBridge.buildBuffers() or buildBatchBuffers().
     *
     * When itemMeta and items are provided, reconstructs renderedTexts entries
     * from the buffer data so that updatePosition(), updateColor(), getText(),
     * and other per-text operations work after the worker path.
     *
     * @param {Object} buffers - Pre-computed buffer data
     * @param {Float32Array} buffers.positions - [x,y,z] per glyph
     * @param {Float32Array} buffers.sizes - [w,h] per glyph
     * @param {Float32Array} buffers.codepoints - Unicode codepoint per glyph. The vertex shader
     *   resolves each codepoint to its atlas UV rect via the atlasMapTexture DataTexture lookup
     *   (GPU codepoint→UV path). No CPU-side UV coordinates are needed.
     * @param {Float32Array} buffers.colors - [r,g,b] per glyph
     * @param {number} buffers.count - Number of glyphs
     * @param {Array} [buffers.itemMeta] - Per-item metadata from buildBatchBuffers
     * @param {Array} [items] - Original items array (text, position, options)
     * @returns {Array<number>|null} Array of renderer IDs if itemMeta provided, null otherwise
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, codepoints, colors, groupIds, addedColors, count } = buffers;
        // pickingIds intentionally NOT destructured — not emitted by builders;
        // PickingSystem.registerRenderer() writes instancePickingId after flush
        let { itemMeta } = buffers;
        const geometry = this.instanceMesh.geometry;

        // Swap in worker's arrays directly - no copying!
        // Create new BufferAttributes with the pre-built arrays
        geometry.setAttribute('instancePosition',
            new THREE.InstancedBufferAttribute(positions, 3));
        geometry.setAttribute('instanceSize',
            new THREE.InstancedBufferAttribute(sizes, 2));
        geometry.setAttribute('instanceCodepoint',
            new THREE.InstancedBufferAttribute(codepoints || new Float32Array(count), 1));
        geometry.setAttribute('instanceColor',
            new THREE.InstancedBufferAttribute(colors, 3));
        geometry.setAttribute('instanceGroupId',
            new THREE.InstancedBufferAttribute(groupIds || new Float32Array(count), 1));
        geometry.setAttribute('instanceAddedColor',
            new THREE.InstancedBufferAttribute(
                addedColors || new Float32Array(count * 3), 3));
        // instancePickingId: always zeros here — PickingSystem overwrites post-flush
        geometry.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(new Float32Array(count), 1));

        // Set instance count
        geometry.instanceCount = count;

        // Update max instances to reflect actual capacity
        this.config.maxInstances = Math.max(this.config.maxInstances, count);

        // If itemMeta wasn't provided (e.g., old worker code, structured clone issue),
        // compute it from items by counting renderable glyphs per text entry.
        // This matches the counting logic in buildBatchBuffers.
        if (!itemMeta && items && items.length > 0) {
            itemMeta = [];
            let offset = 0;
            for (const item of items) {
                const text = item.text || '';
                let glyphCount = 0;
                for (let c = 0; c < text.length; c++) {
                    const ch = text.charCodeAt(c);
                    // Skip space (32), newline (10), carriage return (13), tab (9)
                    if (ch !== 32 && ch !== 10 && ch !== 13 && ch !== 9) glyphCount++;
                }
                // Clamp to remaining buffer space
                glyphCount = Math.min(glyphCount, count - offset);
                itemMeta.push({ bufferStartIndex: offset, glyphCount, bounds: null });
                offset += glyphCount;
            }
            logger.debug('Computed itemMeta from items (fallback)', { itemCount: items.length });
        }

        // Reconstruct renderedTexts entries from buffer data + metadata
        // This enables updatePosition, updateColor, getText, etc. after worker path
        let rendererIds = null;
        if (itemMeta && items) {
            rendererIds = [];
            for (let i = 0; i < itemMeta.length; i++) {
                const meta = itemMeta[i];
                const item = items[i];
                const id = this.nextId++;

                // Reconstruct glyph array by reading back from the buffers
                const glyphs = new Array(meta.glyphCount);
                for (let g = 0; g < meta.glyphCount; g++) {
                    const bufIdx = meta.bufferStartIndex + g;
                    glyphs[g] = {
                        position: {
                            x: positions[bufIdx * 3],
                            y: positions[bufIdx * 3 + 1],
                            z: positions[bufIdx * 3 + 2]
                        },
                        size: {
                            width: sizes[bufIdx * 2],
                            height: sizes[bufIdx * 2 + 1]
                        },
                        color: {
                            r: colors[bufIdx * 3],
                            g: colors[bufIdx * 3 + 1],
                            b: colors[bufIdx * 3 + 2]
                        },
                        charCode: codepoints ? codepoints[bufIdx] : 63,
                        char: '',
                        groupId: groupIds ? groupIds[bufIdx] : 0
                    };
                }

                this.renderedTexts.set(id, {
                    id,
                    text: item.text || '',
                    glyphs,
                    options: item.options || {},
                    timestamp: Date.now(),
                    bufferStartIndex: meta.bufferStartIndex,
                    glyphCount: meta.glyphCount
                });

                rendererIds.push(id);
            }
        }

        logger.debug('[GPU-Lookup] Applied pre-built buffers', {
            count,
            hasCodepoints: !!codepoints && codepoints.length > 0,
            entries: rendererIds ? rendererIds.length : 0,
        });

        return rendererIds;
    }

    /**
     * Get renderer statistics
     */
    getStats() {
        let totalGlyphs = 0;
        for (const entry of this.renderedTexts.values()) {
            totalGlyphs += entry.glyphs.length;
        }

        return {
            textCount: this.renderedTexts.size,
            glyphCount: totalGlyphs,
            maxInstances: this.config.maxInstances,
            utilization: (totalGlyphs / this.config.maxInstances * 100).toFixed(1) + '%'
        };
    }

    /**
     * Dispose of resources
     */
    dispose() {
        this.clear();

        if (this.instanceMesh) {
            this.scene.remove(this.instanceMesh);
            this.instanceMesh.geometry.dispose();
            this.instanceMesh.material.dispose();
        }

        // Don't dispose atlas texture - it's shared across all renderers
        this.texture = null;

        // Dispose group DataTexture (owned by this renderer)
        if (this._groupTexture) {
            this._groupTexture.dispose();
            this._groupTexture = null;
        }

        logger.trace('Disposed');
    }
}

export default GlyphRendererV15;