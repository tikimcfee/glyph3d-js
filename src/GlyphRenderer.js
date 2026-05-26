/**
 * GlyphRendererV15 - Slug Vector Text Rendering
 *
 * GPU-instanced glyph rendering using the Slug algorithm: quadratic bezier
 * curves evaluated per-pixel in the fragment shader via analytic winding
 * coverage. No bitmap atlas — all glyph shapes stored as compact curve data
 * in two RGBA16UI DataTextures (curve, glyphMap).
 *
 * Key Features:
 * - Resolution-independent vector text (no atlas bitmap)
 * - HarfBuzz-shaped glyph IDs (variable-width advances)
 * - Analytic per-pixel coverage with 2D anti-aliasing (no supersampling)
 * - Group transforms, highlight texture, picking — all preserved
 * - Zero allocation hot paths
 */

import * as THREE from 'three';
import { PERF_THRESHOLDS, shouldDebugLog } from './core/constants.js';
import { createLogger, LogLevel } from './utils/index.js';
import { TEXTURE_WIDTH } from './shaping/slug-constants.js';

// Create logger for v1.5
const logger = createLogger('GlyphRendererV15');
logger.setLevel(shouldDebugLog('instancing') ? LogLevel.DEBUG : LogLevel.INFO);

class GlyphRendererV15 {
    /**
     * Create a Slug vector glyph renderer.
     *
     * @param {THREE.Scene} scene - Three.js scene
     * @param {Object} atlas - GlyphAtlas (used only for metrics in Phase 3 transition)
     * @param {Object} options - Configuration options
     * @param {Object} [options.slugData] - SlugEncoder output: { curveTexture, glyphMapTexture }
     */
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;

        // Slug textures (required for rendering — provided via options, atlas, or setSlugData)
        this._slugData = options.slugData || (atlas && atlas._slugData) || null;

        // HarfBuzz shaper for sync rendering path (optional — main thread only)
        this._shaper = options.shaper || (atlas && atlas._shaper) || null;

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
        this._highlightTexture = null; // RGBA8 DataTexture, created on first flush
        this._highlightSize = 0;       // current texture width (= instance capacity)

        // Pre-create instance mesh
        this.instanceMesh = this._createInstanceMesh();
        this.scene.add(this.instanceMesh);

        // Track rendered content with better structure
        this.renderedTexts = new Map();      // id -> TextEntry
        this.textsByMesh = new WeakMap();    // mesh -> Set<id>
        this.nextId = 1;

        // Cached glyph count — maintained incrementally to avoid O(n) scan in getStats()
        this._cachedGlyphCount = 0;

        // WebGL context loss / restore handling.
        // Attach handlers if the caller passed a canvas (typically renderer.domElement).
        // This is optional — callers can also invoke _setupContextLossHandlers() directly.
        this._contextLost = false;
        if (options.canvas) {
            this._setupContextLossHandlers(options.canvas);
        }

        if (this._slugData && !GlyphRendererV15._slugLogged) {
            GlyphRendererV15._slugLogged = true;
            const ct = this._slugData.curveTexture;
            const gm = this._slugData.glyphMapTexture;
            logger.info(`[GlyphRenderer] Slug textures bound: curves=${ct.image.width}x${ct.image.height}, glyphMap=${gm.image.width}x${gm.image.height}`);
            logger.info('[GlyphRenderer] Slug rendering active — atlas removed');
        }

        logger.trace('Initialized', {
            worldUnits: `${this.metrics.charWidth.toFixed(3)}x${this.metrics.charHeight.toFixed(3)}`,
            worldScale: this.config.worldScale,
            maxInstances: this.config.maxInstances,
            slugActive: !!this._slugData,
        });
    }

    /**
     * Set or update the Slug texture data after construction.
     * Used when SlugEncoder output becomes available after the renderer is created.
     * @param {Object} slugData - { curveTexture, glyphMapTexture }
     * @param {import('./shaping/HarfBuzzShaper.js').default} [shaper] - Main-thread shaper for sync path
     */
    setSlugData(slugData, shaper) {
        if (shaper) this._shaper = shaper;
        this._slugData = slugData;
        if (this.instanceMesh) {
            const u = this.instanceMesh.material.uniforms;
            u.curveTexture.value = slugData.curveTexture;
            u.glyphMapTexture.value = slugData.glyphMapTexture;
            u.glyphMapWidth.value = slugData.glyphMapTexture.image.width;
            u.glyphMapHeight.value = slugData.glyphMapTexture.image.height;
        }
        // Log only once (setSlugData is called per-renderer, not per-frame)
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
     * Ensure the RGBA8 highlight DataTexture exists and is sized for the given instance count.
     * Creates or resizes as needed. Zero-filled (no highlight = black = additive identity).
     * @private
     * @param {number} instanceCount
     */
    _ensureHighlightTexture(instanceCount) {
        if (this._highlightTexture && this._highlightSize >= instanceCount) return;

        // Wrap into a 2D texture to stay within GPU max texture width (typically 16384).
        // Layout: texel at (gl_InstanceID % width, gl_InstanceID / width).
        const HIGHLIGHT_TEX_WIDTH = 1024;
        const count = Math.max(instanceCount, 1);
        const height = Math.ceil(count / HIGHLIGHT_TEX_WIDTH);
        const totalTexels = HIGHLIGHT_TEX_WIDTH * height;
        const data = new Uint8Array(totalTexels * 4); // RGBA8, zero-filled

        if (this._highlightTexture) {
            const oldData = this._highlightTexture.image.data;
            data.set(oldData.subarray(0, Math.min(oldData.length, data.length)));
            this._highlightTexture.dispose();
        }

        const tex = new THREE.DataTexture(data, HIGHLIGHT_TEX_WIDTH, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        this._highlightTexture = tex;
        this._highlightSize = count;
        this._highlightTexWidth = HIGHLIGHT_TEX_WIDTH;

        if (this.instanceMesh) {
            this.instanceMesh.material.uniforms.highlightTexture.value = tex;
        }
    }

    /**
     * Create the single instance mesh used for all rendering.
     * Uses Slug vector textures (curveTexture, glyphMapTexture) instead of a
     * bitmap atlas.
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

        // Slug texture uniforms — populated from SlugEncoder output.
        // If slugData is not available yet, use null placeholders
        // (setSlugData() will populate them later).
        const sd = this._slugData;

        // Create shader material — Slug vector rendering
        const material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: {
                curveTexture:       { value: sd ? sd.curveTexture : null },
                glyphMapTexture:    { value: sd ? sd.glyphMapTexture : null },
                glyphMapWidth:      { value: sd ? sd.glyphMapTexture.image.width : TEXTURE_WIDTH },
                glyphMapHeight:     { value: sd ? sd.glyphMapTexture.image.height : 1 },
                groupTexture:       { value: this._groupTexture },
                groupTextureHeight: { value: this._maxGroups },
                highlightTexture:   { value: null } // set after first flush sizes the texture
            },
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            transparent: false,
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
            geometry.setAttribute('instanceGlyphId',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
            geometry.setAttribute('instanceColor',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
            geometry.setAttribute('instanceGroupId',
                new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
            // instanceAddedColor removed — highlight is now via highlightTexture (RGBA8 DataTexture)
            // instancePickingId removed — derived as uBasePickingId + gl_InstanceID in picking shader
            geometry._maxInstanceCount = maxCount;
        }

        // Start with zero instances visible
        geometry.instanceCount = 0;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;

        if (shouldDebugLog('instancing')) {
            logger.debug('Instance mesh created', {
                geometryType: 'InstancedBufferGeometry',
                slugActive: !!sd,
            });
        }

        return mesh;
    }

    /**
     * Get Slug vertex shader.
     *
     * Reads glyphMapTexture via texelFetch to pass each glyph's curve range
     * (start, count) as flat int varyings. Outputs vGlyphUV for fragment
     * shader position in the glyph's [0,1]^2 coordinate space.
     * @private
     */
    _getVertexShader() {
        return `
            precision highp float;
            precision highp int;

            in vec3 instancePosition;
            in vec2 instanceSize;
            in float instanceGlyphId;
            in vec3 instanceColor;
            in float instanceGroupId;

            uniform highp usampler2D glyphMapTexture;
            uniform float glyphMapWidth;
            uniform float glyphMapHeight;

            uniform sampler2D groupTexture;
            uniform float groupTextureHeight;

            // Per-glyph highlight: RGBA8 DataTexture, 1024 wide, wrapped
            uniform sampler2D highlightTexture;

            flat out int vCurveStart;
            flat out int vCurveCount;
            out vec2 vGlyphUV;
            out vec3 vColor;
            out float vGroupAlpha;
            out vec3 vAddedColor;

            void main() {
                // Transform quad by instance size
                vec3 scaled = position * vec3(instanceSize, 1.0);

                // Group property lookups (4-column DataTexture)
                float v = (instanceGroupId + 0.5) / groupTextureHeight;
                vec4 gPos   = texture(groupTexture, vec2(0.125, v));  // col 0: offset + visibility
                vec4 gColor = texture(groupTexture, vec2(0.625, v));  // col 2: color multiplier
                vec4 gScale = texture(groupTexture, vec2(0.875, v));  // col 3: scale

                // Left-align quad: PlaneGeometry is centered (-0.5 to 0.5) but
                // instancePosition is the left edge. Shift right by half width.
                vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);

                // World position = aligned quad + scaled instance position + group offset
                vec3 worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz;

                // Standard projection
                gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

                // Glyph map lookup: glyphId -> curve range (RGBA16UI)
                int gid = int(instanceGlyphId);
                int mapCol = gid % int(glyphMapWidth);
                int mapRow = gid / int(glyphMapWidth);
                uvec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(mapCol, mapRow), 0);
                vCurveStart      = int(glyphInfo.x);
                vCurveCount      = int(glyphInfo.y);

                // Glyph-local UV: PlaneGeometry's uv attribute goes [0,1] across the quad.
                // Maps directly to glyph-space [0,1]^2 for curve evaluation.
                vGlyphUV = uv;

                // gScale.w = color blend factor: 0.0 = multiply (default), 1.0 = replace
                float colorBlend = gScale.w;
                vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend);
                vGroupAlpha = gColor.a;

                // Per-glyph highlight from RGBA8 DataTexture (2D: 1024 wide, wrapped)
                int hx = gl_InstanceID % 1024;
                int hy = gl_InstanceID / 1024;
                vec4 highlight = texelFetch(highlightTexture, ivec2(hx, hy), 0);
                vAddedColor = highlight.rgb;
            }
        `;
    }

    /**
     * Get Slug fragment shader — computes analytic coverage per quadratic
     * bezier (Dobbie / Lengyel). Each curve-ray crossing contributes
     * fractional winding scaled by the pixel footprint, summed over X and Y
     * rays, so glyphs antialias on edges and don't moire when minified — all
     * in a single sample with no supersampling.
     * @private
     */
    _getFragmentShader() {
        return `
            precision highp float;
            precision highp int;

            // Upper bound on quadratic beziers per glyph (loop cap).
            #define MAX_CURVES 256

            uniform highp usampler2D curveTexture;

            flat in int vCurveStart;
            flat in int vCurveCount;
            in vec2 vGlyphUV;
            in vec3 vColor;
            in float vGroupAlpha;
            in vec3 vAddedColor;

            out vec4 fragColor;

            // Unpack uint16 to [0,1] normalized float
            float unpackCoord(uint bits) {
                return float(bits) / 65535.0;
            }

            // Analytic coverage contribution of one quadratic Bezier for a ray
            // cast in the +X direction. Endpoints are pre-translated so the
            // sample point sits at the origin (i.e. curve.p - samplePoint), so
            // the ray is the line y == 0. invDiameter = 1 / (pixel footprint in
            // glyph-UV units along the ray axis) — fractional crossings inside
            // that footprint give sub-pixel coverage. (Dobbie / Lengyel "Slug".)
            float computeCoverage(float invDiameter, vec2 p0, vec2 p1, vec2 p2) {
                // Cheap reject: curve entirely on one side of the ray.
                if (p0.y > 0.0 && p1.y > 0.0 && p2.y > 0.0) return 0.0;
                if (p0.y < 0.0 && p1.y < 0.0 && p2.y < 0.0) return 0.0;

                // Q(t).y = 0 → a.y t^2 - 2 b.y t + c.y = 0 (factor of -2 in b).
                vec2 a = p0 - 2.0 * p1 + p2;
                vec2 b = p0 - p1;
                vec2 c = p0;

                float t0, t1;
                if (abs(a.y) >= 1e-5) {
                    // Quadratic: two roots — t0 always exits, t1 always enters.
                    float radicand = b.y * b.y - a.y * c.y;
                    if (radicand <= 0.0) return 0.0;
                    float s = sqrt(radicand);
                    t0 = (b.y - s) / a.y;
                    t1 = (b.y + s) / a.y;
                } else {
                    // Degenerate quadratic = line segment; one root. Assign it to
                    // exit (t0) or entry (t1) by segment direction.
                    float t = p0.y / (p0.y - p2.y);
                    if (p0.y < p2.y) { t0 = -1.0; t1 = t; }
                    else             { t0 = t;    t1 = -1.0; }
                }

                float alpha = 0.0;
                if (t0 >= 0.0 && t0 < 1.0) {
                    float x = (a.x * t0 - 2.0 * b.x) * t0 + c.x;
                    alpha += clamp(x * invDiameter + 0.5, 0.0, 1.0);
                }
                if (t1 >= 0.0 && t1 < 1.0) {
                    float x = (a.x * t1 - 2.0 * b.x) * t1 + c.x;
                    alpha -= clamp(x * invDiameter + 0.5, 0.0, 1.0);
                }
                return alpha;
            }

            // Rotate 90° so the +X ray becomes a +Y ray in the rotated frame.
            vec2 rot90(vec2 v) { return vec2(v.y, -v.x); }

            void main() {
                // Empty glyph shortcut: 0 curves = space/notdef, discard immediately
                if (vCurveCount == 0) discard;

                // Inverse pixel footprint in glyph-UV space (per axis). fwidth is
                // the screen-space derivative magnitude, so this is automatically
                // resolution-independent: tight when magnified, wide when minified.
                vec2 invDiameter = 1.0 / fwidth(vGlyphUV);

                // Accumulate fractional winding over every curve in the glyph,
                // along an X ray and a Y ray (2D anti-aliasing). The per-curve
                // y-reject above makes iterating all curves cheap, so no band
                // acceleration structure is needed.
                float coverage = 0.0;
                for (int i = 0; i < MAX_CURVES; i++) {
                    if (i >= vCurveCount) break;

                    // 2 texels per curve: [P0.xy, P1.xy] then [P2.xy, _, _].
                    int ci = (vCurveStart + i) * 2;
                    uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
                    uvec4 t1 = texelFetch(curveTexture, ivec2((ci + 1) % 1024, (ci + 1) / 1024), 0);

                    vec2 p0 = vec2(unpackCoord(t0.x), unpackCoord(t0.y)) - vGlyphUV;
                    vec2 p1 = vec2(unpackCoord(t0.z), unpackCoord(t0.w)) - vGlyphUV;
                    vec2 p2 = vec2(unpackCoord(t1.x), unpackCoord(t1.y)) - vGlyphUV;

                    coverage += computeCoverage(invDiameter.x, p0, p1, p2);
                    coverage += computeCoverage(invDiameter.y, rot90(p0), rot90(p1), rot90(p2));
                }

                // Average the two rays. Fills accumulate positive coverage under
                // our y-up normalization (t0=exit/t1=entry convention).
                coverage = clamp(coverage * 0.5, 0.0, 1.0);

                if (coverage < 0.01) discard;

                vec3 finalColor = clamp(vColor * coverage + vAddedColor, 0.0, 1.0);
                fragColor = vec4(finalColor, coverage * vGroupAlpha);
                if (fragColor.a < 0.01) discard;
            }
        `;
    }

    // ============ Public API with Better Structure ============

    /**
     * Get text object by ID for manipulation
     * @param {number} id - Text ID
     * @returns {Object|null} Text entry with methods
     */
    getText(id) {
        const entry = this.renderedTexts.get(id);
        if (!entry) return null;

        const renderer = this;
        return {
            id,
            glyphCount: entry.glyphCount,
            bufferStartIndex: entry.bufferStartIndex,
            // Lazy accessor: reads glyph data from typed arrays on demand.
            // Returns an array-like with .length, indexed access [i], and Symbol.iterator.
            // Avoids allocating per-glyph objects unless explicitly accessed.
            get glyphs() { return renderer._lazyGlyphs(entry); },
            getGlyphAt: (i) => ({
                position: renderer._readGlyphPosition(entry.bufferStartIndex + i),
                size: renderer._readGlyphSize(entry.bufferStartIndex + i),
            }),
            updatePosition: (newPos) => renderer.updatePosition(id, newPos),
            updateColor: (newColor) => renderer.updateColor(id, newColor),
            remove: () => renderer.remove(id),
            getBounds: () => renderer._getTextBounds(entry)
        };
    }

    /**
     * Lazy glyph accessor backed by typed arrays. Returns an array-like with
     * .length and index access that reads from GPU buffers on demand.
     * Avoids allocating 6.1M per-glyph objects up front.
     * @private
     * @param {Object} entry - renderedTexts entry with bufferStartIndex and glyphCount
     * @returns {Proxy} Array-like object
     */
    _lazyGlyphs(entry) {
        const geom = this.instanceMesh.geometry;
        const positions = geom.attributes.instancePosition.array;
        const sizes = geom.attributes.instanceSize.array;
        const colors = geom.attributes.instanceColor.array;
        const glyphIds = geom.attributes.instanceGlyphId.array;
        const groupIds = geom.attributes.instanceGroupId.array;
        const start = entry.bufferStartIndex;
        const count = entry.glyphCount;

        function readGlyph(i) {
            const buf = start + i;
            return {
                position: {
                    x: positions[buf * 3],
                    y: positions[buf * 3 + 1],
                    z: positions[buf * 3 + 2]
                },
                size: {
                    width: sizes[buf * 2],
                    height: sizes[buf * 2 + 1]
                },
                color: {
                    r: colors[buf * 3],
                    g: colors[buf * 3 + 1],
                    b: colors[buf * 3 + 2]
                },
                charCode: glyphIds ? glyphIds[buf] : 0,
                char: '',
                groupId: groupIds ? groupIds[buf] : 0
            };
        }

        return new Proxy([], {
            get(target, prop) {
                if (prop === 'length') return count;
                if (prop === Symbol.iterator) {
                    return function* () {
                        for (let i = 0; i < count; i++) {
                            yield readGlyph(i);
                        }
                    };
                }
                const idx = Number(prop);
                if (Number.isInteger(idx) && idx >= 0 && idx < count) {
                    return readGlyph(idx);
                }
                return Array.prototype[prop];
            }
        });
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
     * Read the position of the glyph at an absolute buffer index from the typed array.
     * @private
     * @param {number} bufferIndex - Absolute glyph slot index
     * @returns {{x: number, y: number, z: number}}
     */
    _readGlyphPosition(bufferIndex) {
        const positions = this.instanceMesh.geometry.attributes.instancePosition.array;
        const i = bufferIndex * 3;
        return { x: positions[i], y: positions[i + 1], z: positions[i + 2] };
    }

    /**
     * Read the size of the glyph at an absolute buffer index from the typed array.
     * @private
     * @param {number} bufferIndex - Absolute glyph slot index
     * @returns {{width: number, height: number}}
     */
    _readGlyphSize(bufferIndex) {
        const sizes = this.instanceMesh.geometry.attributes.instanceSize.array;
        const i = bufferIndex * 2;
        return { width: sizes[i], height: sizes[i + 1] };
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

        const geometry = this.instanceMesh.geometry;
        const positions = geometry.attributes.instancePosition.array;
        const startIdx = entry.bufferStartIndex;

        // Read first glyph's current position from typed array to compute delta
        const base = startIdx * 3;
        const dx = newPosition.x - positions[base];
        const dy = newPosition.y - positions[base + 1];
        const dz = newPosition.z - positions[base + 2];

        // Apply delta directly to the typed array — no JS object mutations
        for (let i = 0; i < entry.glyphCount; i++) {
            const bufIdx = (startIdx + i) * 3;
            positions[bufIdx]     += dx;
            positions[bufIdx + 1] += dy;
            positions[bufIdx + 2] += dz;
        }

        // Partial GPU upload — only the changed range
        const posAttr = geometry.attributes.instancePosition;
        posAttr.addUpdateRange(startIdx * 3, entry.glyphCount * 3);
        posAttr.needsUpdate = true;
    }

    /**
     * Update text color - DIRECT BUFFER WRITE (no rebuild!)
     * @param {number} id - Text ID
     * @param {Object} newColor - New color {r, g, b}
     */
    updateColor(id, newColor) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;

        const geometry = this.instanceMesh.geometry;
        const colors = geometry.attributes.instanceColor.array;
        const startIdx = entry.bufferStartIndex;

        // Write directly to the typed array — no JS object mutations
        for (let i = 0; i < entry.glyphCount; i++) {
            const bufIdx = (startIdx + i) * 3;
            colors[bufIdx]     = newColor.r;
            colors[bufIdx + 1] = newColor.g;
            colors[bufIdx + 2] = newColor.b;
        }

        const colorAttr = geometry.attributes.instanceColor;
        colorAttr.addUpdateRange(startIdx * 3, entry.glyphCount * 3);
        colorAttr.needsUpdate = true;
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
        if (!this._highlightTexture) return;
        const data = this._highlightTexture.image.data;
        const startIdx = entry.bufferStartIndex;
        const r = addedColor ? (addedColor.r * 255 + 0.5) | 0 : 0;
        const g = addedColor ? (addedColor.g * 255 + 0.5) | 0 : 0;
        const b = addedColor ? (addedColor.b * 255 + 0.5) | 0 : 0;
        const w = this._highlightTexWidth;
        for (let i = 0; i < entry.glyphCount; i++) {
            const slot = startIdx + i;
            const bufIdx = slot * 4; // flat index into RGBA8 data (row-major, width=w)
            data[bufIdx]     = r;
            data[bufIdx + 1] = g;
            data[bufIdx + 2] = b;
            data[bufIdx + 3] = 0;
        }
        this._highlightTexture.needsUpdate = true;
    }

    /**
     * Set additive highlight color on a single glyph by absolute buffer slot index.
     * Used for token-level highlighting within a text entry.
     * @param {number} bufferSlotIndex - Absolute glyph index into highlight texture
     * @param {{r: number, g: number, b: number}|null} color - null clears
     */
    setGlyphHighlight(bufferSlotIndex, color) {
        if (!this._highlightTexture) return;
        const data = this._highlightTexture.image.data;
        const i = bufferSlotIndex * 4; // flat index — row-major 2D is sequential
        data[i]     = color ? (color.r * 255 + 0.5) | 0 : 0;
        data[i + 1] = color ? (color.g * 255 + 0.5) | 0 : 0;
        data[i + 2] = color ? (color.b * 255 + 0.5) | 0 : 0;
        data[i + 3] = 0; // reserved (blend mode / opacity)
        this._highlightTexture.needsUpdate = true;
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
        let rangeMin = Infinity, rangeMax = 0;

        for (let u = 0; u < updates.length; u++) {
            const { id, position: newPosition } = updates[u];
            const entry = this.renderedTexts.get(id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const startIdx = entry.bufferStartIndex;
            const endIdx = startIdx + entry.glyphCount;
            rangeMin = Math.min(rangeMin, startIdx);
            rangeMax = Math.max(rangeMax, endIdx);

            // Read current first-glyph position from typed array for delta
            const base = startIdx * 3;
            const dx = newPosition.x - positions[base];
            const dy = newPosition.y - positions[base + 1];
            const dz = newPosition.z - positions[base + 2];

            for (let i = 0; i < entry.glyphCount; i++) {
                const bufIdx = (startIdx + i) * 3;
                positions[bufIdx]     += dx;
                positions[bufIdx + 1] += dy;
                positions[bufIdx + 2] += dz;
            }
        }

        if (rangeMin === Infinity) return;
        const posAttr = geometry.attributes.instancePosition;
        posAttr.addUpdateRange(rangeMin * 3, (rangeMax - rangeMin) * 3);
        posAttr.needsUpdate = true;
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
        let rangeMin = Infinity, rangeMax = 0;

        for (let u = 0; u < updates.length; u++) {
            const { id, color: newColor } = updates[u];
            const entry = this.renderedTexts.get(id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const startIdx = entry.bufferStartIndex;
            const endIdx = startIdx + entry.glyphCount;
            rangeMin = Math.min(rangeMin, startIdx);
            rangeMax = Math.max(rangeMax, endIdx);

            for (let i = 0; i < entry.glyphCount; i++) {
                const bufIdx = (startIdx + i) * 3;
                colors[bufIdx]     = newColor.r;
                colors[bufIdx + 1] = newColor.g;
                colors[bufIdx + 2] = newColor.b;
            }
        }

        if (rangeMin === Infinity) return;
        const colorAttr = geometry.attributes.instanceColor;
        colorAttr.addUpdateRange(rangeMin * 3, (rangeMax - rangeMin) * 3);
        colorAttr.needsUpdate = true;
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
        let posRangeMin = Infinity, posRangeMax = 0;
        let colRangeMin = Infinity, colRangeMax = 0;

        for (let u = 0; u < updates.length; u++) {
            const update = updates[u];
            const entry = this.renderedTexts.get(update.id);
            if (!entry || entry.bufferStartIndex === undefined) continue;

            const startIdx = entry.bufferStartIndex;
            const endIdx = startIdx + entry.glyphCount;

            if (update.position) {
                posRangeMin = Math.min(posRangeMin, startIdx);
                posRangeMax = Math.max(posRangeMax, endIdx);

                // Read current first-glyph position from typed array for delta
                const base = startIdx * 3;
                const dx = update.position.x - positions[base];
                const dy = update.position.y - positions[base + 1];
                const dz = update.position.z - positions[base + 2];

                for (let i = 0; i < entry.glyphCount; i++) {
                    const bufIdx = (startIdx + i) * 3;
                    positions[bufIdx]     += dx;
                    positions[bufIdx + 1] += dy;
                    positions[bufIdx + 2] += dz;
                }
            }

            if (update.color) {
                colRangeMin = Math.min(colRangeMin, startIdx);
                colRangeMax = Math.max(colRangeMax, endIdx);

                for (let i = 0; i < entry.glyphCount; i++) {
                    const bufIdx = (startIdx + i) * 3;
                    colors[bufIdx]     = update.color.r;
                    colors[bufIdx + 1] = update.color.g;
                    colors[bufIdx + 2] = update.color.b;
                }
            }
        }

        if (posRangeMin !== Infinity) {
            const posAttr = geometry.attributes.instancePosition;
            posAttr.addUpdateRange(posRangeMin * 3, (posRangeMax - posRangeMin) * 3);
            posAttr.needsUpdate = true;
        }
        if (colRangeMin !== Infinity) {
            const colAttr = geometry.attributes.instanceColor;
            colAttr.addUpdateRange(colRangeMin * 3, (colRangeMax - colRangeMin) * 3);
            colAttr.needsUpdate = true;
        }
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
            highlightTextureBytes: this._highlightSize * 4, // RGBA8
            totalBytes: allocatedBytes + groupBytes * 2 + this._highlightSize * 4,
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
        const entry = this.renderedTexts.get(id);
        if (entry) {
            this._cachedGlyphCount -= entry.glyphCount;
            this.renderedTexts.delete(id);
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
            const entry = this.renderedTexts.get(id);
            if (entry) {
                this._cachedGlyphCount -= entry.glyphCount;
                this.renderedTexts.delete(id);
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
        this._cachedGlyphCount = 0;
        this.instanceMesh.geometry.instanceCount = 0;
    }

    // ============ Internal Methods ============

    // _syncAtlasMapDimensions — removed (Slug textures are static after build)
    // _ensureGlyphsInAtlas — removed (HarfBuzz shaping handles all glyph IDs)

    /**
     * Compute the world-space bounds for a text entry by reading from the typed arrays.
     * @private
     * @param {Object} entry - renderedTexts entry with bufferStartIndex and glyphCount
     * @returns {Object|null} {min, max, width, height, depth} or null if empty
     */
    _getTextBounds(entry) {
        if (!entry || entry.glyphCount === 0 || !this.instanceMesh) return null;

        const geom = this.instanceMesh.geometry;
        const positions = geom.attributes.instancePosition.array;
        const sizes = geom.attributes.instanceSize.array;
        const start = entry.bufferStartIndex;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < entry.glyphCount; i++) {
            const buf = start + i;
            const px = positions[buf * 3];
            const py = positions[buf * 3 + 1];
            const pz = positions[buf * 3 + 2];
            const sw = sizes[buf * 2];
            const sh = sizes[buf * 2 + 1];

            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (pz < minZ) minZ = pz;
            if (px + sw > maxX) maxX = px + sw;
            if (py + sh > maxY) maxY = py + sh;
            if (pz > maxZ) maxZ = pz;
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
     * Compact instance data after removals: shift surviving entries forward to
     * fill the gaps left by remove(). Content is built once via the one builder
     * (applyPrebuiltBuffers); this only ever rearranges existing typed-array
     * data. writeIdx <= readIdx always because deletions only create forward gaps.
     * @private
     */
    _rebuildAllInstances() {
        const geom = this.instanceMesh.geometry;
        const oldPos = geom.attributes.instancePosition.array;
        const oldSiz = geom.attributes.instanceSize.array;
        const oldGid = geom.attributes.instanceGlyphId.array;
        const oldCol = geom.attributes.instanceColor.array;
        const oldGrp = geom.attributes.instanceGroupId.array;

        let total = 0;
        for (const entry of this.renderedTexts.values()) {
            total += entry.glyphCount;
        }

        let writeIdx = 0;
        for (const entry of this.renderedTexts.values()) {
            const readIdx = entry.bufferStartIndex;
            const count = entry.glyphCount;
            entry.bufferStartIndex = writeIdx;

            if (readIdx !== writeIdx && count > 0) {
                // Shift data forward in-place (source and dest may overlap;
                // copyWithin handles overlapping regions correctly)
                oldPos.copyWithin(writeIdx * 3, readIdx * 3, (readIdx + count) * 3);
                oldSiz.copyWithin(writeIdx * 2, readIdx * 2, (readIdx + count) * 2);
                oldGid.copyWithin(writeIdx,     readIdx,     readIdx + count);
                oldCol.copyWithin(writeIdx * 3, readIdx * 3, (readIdx + count) * 3);
                oldGrp.copyWithin(writeIdx,     readIdx,     readIdx + count);
            }
            writeIdx += count;
        }

        // Mark all attributes dirty and update instance count
        for (const name of Object.keys(geom.attributes)) {
            geom.attributes[name].needsUpdate = true;
        }
        this._ensureHighlightTexture(total);
        geom.instanceCount = total;
    }

    /**
     * Apply pre-built buffers directly to GPU.
     *
     * Used by the worker pipeline to skip main-thread computation.
     * Buffers come from WorkerBridge.buildBuffers() or buildBatchBuffers().
     *
     * When itemMeta and items are provided, reconstructs renderedTexts entries
     * from the buffer data so that updatePosition(), updateColor(), getText(),
     * and other per-text operations work after the worker path.
     *
     * @param {import('./core/types.js').GlyphBufferSet} buffers - Pre-computed buffer data from
     *   buildBatchBuffers(). The arrays are swapped in directly — no copying occurs.
     * @param {Array} [items] - Original items array (text, position, options), parallel to
     *   buffers.itemMeta. Required for renderedTexts reconstruction.
     * @returns {Array<number>|null} Array of renderer IDs (one per item) if itemMeta provided,
     *   null otherwise.
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, colors, groupIds, count } = buffers;
        // Accept both 'glyphIds' (new) and 'codepoints' (legacy) field names
        const glyphIds = buffers.glyphIds || buffers.codepoints;
        const { itemMeta } = buffers;
        const geometry = this.instanceMesh.geometry;

        // Swap in worker's arrays directly - no copying!
        // Create new BufferAttributes with the pre-built arrays
        geometry.setAttribute('instancePosition',
            new THREE.InstancedBufferAttribute(positions, 3));
        geometry.setAttribute('instanceSize',
            new THREE.InstancedBufferAttribute(sizes, 2));
        geometry.setAttribute('instanceGlyphId',
            new THREE.InstancedBufferAttribute(glyphIds || new Float32Array(count), 1));
        geometry.setAttribute('instanceColor',
            new THREE.InstancedBufferAttribute(colors, 3));
        geometry.setAttribute('instanceGroupId',
            new THREE.InstancedBufferAttribute(groupIds || new Float32Array(count), 1));
        // Highlight via RGBA8 DataTexture (replaces instanceAddedColor attribute)
        this._ensureHighlightTexture(count);
        // instancePickingId removed — derived as uBasePickingId + gl_InstanceID in picking shader

        // Set instance count
        geometry.instanceCount = count;

        // Update max instances to reflect actual capacity
        this.config.maxInstances = Math.max(this.config.maxInstances, count);

        // Store lightweight metadata entries — no per-glyph JS objects.
        // All update/query methods read position/color/size directly from typed arrays.
        // Reset cached count — applyPrebuiltBuffers replaces all content.
        this.renderedTexts.clear();
        this._cachedGlyphCount = 0;

        let rendererIds = null;
        if (itemMeta && items) {
            rendererIds = [];
            for (let i = 0; i < itemMeta.length; i++) {
                const meta = itemMeta[i];
                const id = this.nextId++;

                this.renderedTexts.set(id, {
                    id,
                    bufferStartIndex: meta.bufferStartIndex,
                    glyphCount: meta.glyphCount,
                    lineSlotOffsets: meta.lineSlotOffsets || null,
                    wrapColsPerLine:  meta.wrapColsPerLine  || null,
                });

                this._cachedGlyphCount += meta.glyphCount;
                rendererIds.push(id);
            }
        }

        logger.debug('[Slug] Applied pre-built buffers', {
            count,
            hasGlyphIds: !!glyphIds && glyphIds.length > 0,
            entries: rendererIds ? rendererIds.length : 0,
        });

        return rendererIds;
    }

    // ============ WebGL Context Loss ============

    /**
     * Attach webglcontextlost / webglcontextrestored handlers to the given canvas.
     *
     * Call this once during application setup, passing the Three.js renderer's
     * domElement (i.e. the WebGL canvas). When the context is lost, rendering
     * is suspended; when it is restored, all GPU-side resources are re-uploaded
     * from the in-memory typed arrays and canvases that survive context loss.
     *
     * Alternatively, pass `options.canvas` to the constructor and this is called
     * automatically.
     *
     * @param {HTMLCanvasElement} canvas - The WebGL canvas element
     */
    _setupContextLossHandlers(canvas) {
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // signal the browser to allow context restoration
            this._contextLost = true;
            logger.warn('WebGL context lost — rendering suspended');
        });

        canvas.addEventListener('webglcontextrestored', () => {
            this._contextLost = false;
            logger.info('WebGL context restored — re-uploading GPU resources');
            this._rebuildGPUState();
        });
    }

    /**
     * Re-upload all GPU-side resources after a WebGL context restore.
     *
     * All typed arrays, the atlas canvas, and the highlight data survive context
     * loss in CPU memory. This method sets `needsUpdate = true` on every resource
     * so Three.js re-uploads them to the new GL context on the next render frame.
     * Nothing is recomputed — this is a pure re-upload pass.
     *
     * @private
     */
    _rebuildGPUState() {
        // Re-upload Slug textures (static DataTextures that survived context loss in CPU memory)
        if (this._slugData && this.instanceMesh) {
            const u = this.instanceMesh.material.uniforms;
            if (u.curveTexture.value) u.curveTexture.value.needsUpdate = true;
            if (u.glyphMapTexture.value) u.glyphMapTexture.value.needsUpdate = true;
        }

        // Re-upload the group DataTexture (owned by this renderer, backed by this._groupData)
        if (this._groupTexture) {
            this._groupTexture.needsUpdate = true;
        }

        // Re-upload the highlight DataTexture (backed by Uint8Array that survived context loss)
        if (this._highlightTexture) {
            this._highlightTexture.needsUpdate = true;
        }

        // Mark all instance buffer attributes for full re-upload
        if (this.instanceMesh) {
            const geom = this.instanceMesh.geometry;
            for (const name of Object.keys(geom.attributes)) {
                geom.attributes[name].needsUpdate = true;
            }
        }
    }

    /**
     * Get total glyph count. O(1) — uses a cached counter maintained by all
     * add/remove/clear/applyPrebuiltBuffers paths.
     * @returns {number}
     */
    getGlyphCount() {
        return this._cachedGlyphCount;
    }

    /**
     * Get renderer statistics. Glyph count is O(1) via cached counter.
     * @returns {Object}
     */
    getStats() {
        const totalGlyphs = this._cachedGlyphCount;
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
            this.instanceMesh = null;
        }

        // Don't dispose Slug textures — they're shared across all renderers
        this._slugData = null;

        // Dispose group DataTexture (owned by this renderer)
        if (this._groupTexture) {
            this._groupTexture.dispose();
            this._groupTexture = null;
        }

        // Dispose highlight DataTexture
        if (this._highlightTexture) {
            this._highlightTexture.dispose();
            this._highlightTexture = null;
            this._highlightSize = 0;
        }

        logger.trace('Disposed');
    }
}

export default GlyphRendererV15;