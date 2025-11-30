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
import { CHAR_DIMENSIONS, PERF_THRESHOLDS, shouldDebugLog } from './core/constants.js';
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

        logger.info('Initialized', {
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

        // Create shader material (clean, no debug paths)
        const material = new THREE.ShaderMaterial({
            uniforms: {
                atlasTexture: { value: this.texture }
            },
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        // Pre-allocate instance attributes (skip for worker path - buffers provided later)
        if (!this.config.skipPrealloc) {
            const maxCount = this.config.maxInstances;
            geometry.setAttribute('instancePosition',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
            geometry.setAttribute('instanceSize',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2), 2));
            geometry.setAttribute('instanceUV',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 4), 4));
            geometry.setAttribute('instanceColor',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
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
     * Get optimized vertex shader
     * @private
     */
    _getVertexShader() {
        return `
            attribute vec3 instancePosition;
            attribute vec2 instanceSize;
            attribute vec4 instanceUV;
            attribute vec3 instanceColor;

            varying vec2 vUV;
            varying vec3 vColor;

            void main() {
                // Transform quad by instance size
                vec3 scaled = position * vec3(instanceSize, 1.0);

                // Position in world
                vec3 worldPos = scaled + instancePosition;

                // Standard projection
                gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

                // Pass through interpolated UVs (same as v1.0)
                vUV = mix(instanceUV.xy, instanceUV.zw, uv);
                vColor = instanceColor;
            }
        `;
    }

    /**
     * Get optimized fragment shader
     * @private
     */
    _getFragmentShader() {
        return `
            uniform sampler2D atlasTexture;

            varying vec2 vUV;
            varying vec3 vColor;

            void main() {
                vec4 texColor = texture2D(atlasTexture, vUV);

                // Apply instance color
                gl_FragColor = texColor * vec4(vColor, 1.0);

                // Alpha test for clean edges (matching v1.0)
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

    /**
     * Update text position
     * @param {number} id - Text ID from render()
     * @param {Object} newPosition - New position
     */
    updatePosition(id, newPosition) {
        const entry = this.renderedTexts.get(id);
        if (!entry) return;

        // Calculate offset
        const offset = {
            x: newPosition.x - entry.glyphs[0].position.x,
            y: newPosition.y - entry.glyphs[0].position.y,
            z: newPosition.z - entry.glyphs[0].position.z
        };

        // Update all glyph positions
        for (const glyph of entry.glyphs) {
            glyph.position.x += offset.x;
            glyph.position.y += offset.y;
            glyph.position.z += offset.z;
        }

        this._rebuildAllInstances();
    }

    /**
     * Update text color
     * @param {number} id - Text ID
     * @param {Object} newColor - New color {r, g, b}
     */
    updateColor(id, newColor) {
        const entry = this.renderedTexts.get(id);
        if (!entry) return;

        for (const glyph of entry.glyphs) {
            glyph.color = newColor;
        }

        this._rebuildAllInstances();
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

            const uv = this.atlas.getUV(char.charCodeAt(0));
            if (!uv) continue; // Skip unsupported chars

            glyphs.push({
                position: pos,
                size: {
                    width: this.metrics.charWidth * scale,
                    height: this.metrics.charHeight * scale
                },
                uv: uv,
                color: color,
                char: char  // Keep for debugging
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
        // Collect all glyphs
        const allGlyphs = [];
        for (const entry of this.renderedTexts.values()) {
            allGlyphs.push(...entry.glyphs);
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
        const uvs = geometry.attributes.instanceUV.array;
        const colors = geometry.attributes.instanceColor.array;

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

            // UV coordinates (with V flip for canvas texture - CRITICAL!)
            // Canvas uses top-left origin, WebGL uses bottom-left
            const u0 = g.uv.u0;
            const v0 = 1.0 - g.uv.v0;  // Flip V coordinate
            const u1 = g.uv.u1;
            const v1 = 1.0 - g.uv.v1;  // Flip V coordinate

            uvs[i * 4] = u0;
            uvs[i * 4 + 1] = v1;     // Bottom-left (note: v1, not v0)
            uvs[i * 4 + 2] = u1;
            uvs[i * 4 + 3] = v0;     // Top-right (note: v0, not v1)

            // Color
            colors[i * 3] = g.color.r;
            colors[i * 3 + 1] = g.color.g;
            colors[i * 3 + 2] = g.color.b;
        }

        // Mark attributes as needing update
        geometry.attributes.instancePosition.needsUpdate = true;
        geometry.attributes.instanceSize.needsUpdate = true;
        geometry.attributes.instanceUV.needsUpdate = true;
        geometry.attributes.instanceColor.needsUpdate = true;

        // Set instance count
        geometry.instanceCount = count;

        if (shouldDebugLog('firstInstance') && count > 0) {
            logger.debug('First instance sample', {
                position: `(${glyphs[0].position.x.toFixed(2)}, ${glyphs[0].position.y.toFixed(2)})`,
                char: glyphs[0].char,
                uv: `${glyphs[0].uv.u0.toFixed(3)},${glyphs[0].uv.v0.toFixed(3)}`
            });
        }
    }

    /**
     * Apply pre-built buffers directly to GPU
     *
     * Used by worker pipeline to skip main-thread computation.
     * Buffers come from WorkerBridge.buildBuffers() or buildBatchBuffers().
     *
     * @param {Object} buffers - Pre-computed buffer data
     * @param {Float32Array} buffers.positions - [x,y,z] per glyph
     * @param {Float32Array} buffers.sizes - [w,h] per glyph
     * @param {Float32Array} buffers.uvs - [u0,v1,u1,v0] per glyph (V-flipped)
     * @param {Float32Array} buffers.colors - [r,g,b] per glyph
     * @param {number} buffers.count - Number of glyphs
     */
    applyPrebuiltBuffers(buffers) {
        const { positions, sizes, uvs, colors, count } = buffers;
        const geometry = this.instanceMesh.geometry;

        // Swap in worker's arrays directly - no copying!
        // Create new BufferAttributes with the pre-built arrays
        geometry.setAttribute('instancePosition',
            new THREE.InstancedBufferAttribute(positions, 3));
        geometry.setAttribute('instanceSize',
            new THREE.InstancedBufferAttribute(sizes, 2));
        geometry.setAttribute('instanceUV',
            new THREE.InstancedBufferAttribute(uvs, 4));
        geometry.setAttribute('instanceColor',
            new THREE.InstancedBufferAttribute(colors, 3));

        // Set instance count
        geometry.instanceCount = count;

        // Update max instances to reflect actual capacity
        this.config.maxInstances = Math.max(this.config.maxInstances, count);

        logger.debug('Applied pre-built buffers (zero-copy)', { count });
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

        // Don't dispose texture - it's shared across all renderers
        this.texture = null;

        logger.info('Disposed');
    }
}

export default GlyphRendererV15;