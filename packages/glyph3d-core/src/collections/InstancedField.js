/**
 * InstancedField — WebGL2 Instanced Glyph Field Renderer.
 *
 * Implements the 32-byte RenderSlot architecture proven in glyph3d-rs/crates/glyph-field-instanced.
 * Uses standard Three.js InstancedBufferGeometry and GLSL 3.00 ES ShaderMaterial for
 * universal compatibility across WebGL2 and WebGPU without monolithic compute pipelines.
 */

import * as THREE from 'three';
import { InstancedSlotBuffer, packRgba8 } from '../core/InstancedSlotBuffer.js';
import { createGlyphMaterial, GROUP_STRIDE } from '../core/glyphMaterial.js';
import { generateLayout } from '../core/LayoutGenerator.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { PERF_THRESHOLDS } from '../core/constants.js';

export default class InstancedField {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [atlas] - GlyphAtlas (contains _slugData, _shaper, getCharSize)
     * @param {Object} [options]
     * @param {number} [options.maxInstances]
     * @param {number} [options.maxGroups=64]
     * @param {Object} [options.slugData]
     * @param {Object} [options.shaper]
     * @param {number} [options.worldScale=0.025]
     * @param {Object} [options.defaultColor]
     * @param {boolean} [options.frustumCulled=true]
     */
    constructor(scene, atlas = null, options = {}) {
        this.scene = scene;
        this.atlas = atlas;

        this._slugData = options.slugData || (atlas && atlas._slugData) || null;
        this._shaper   = options.shaper   || (atlas && (atlas._shapeCache || atlas._shaper)) || null;

        this.worldScale = options.worldScale || 0.025;
        this.maxInstances = options.maxInstances || PERF_THRESHOLDS.maxInstancesPerMesh || 50000;
        this.maxGroups = Math.max(1, options.maxGroups || 64);
        this._defaultColor = options.defaultColor || { r: 0.0, g: 1.0, b: 0.0 };

        this._cachedGlyphCount = 0;
        this.sourceBase = 0;
        this._groupCount = 1;
        this._freeGroups = [];
        this.renderedTexts = new Map();
        this.nextId = 1;
        this._cachedMetrics = null;

        // Slot buffer (32-byte RenderSlot records)
        this.slotBuffer = new InstancedSlotBuffer(Math.max(this.maxInstances, 256));

        // Group transform table: 6 columns x maxGroups rows (Float DataTexture)
        // col 0: offset.xyz (w free)
        // col 1: rotation quaternion xyzw (identity 0,0,0,1)
        // col 2: color.rgb + alpha (default 1,1,1,1)
        // col 3: scale.xyz + colorBlend (default 1,1,1,0)
        // col 4: clipTop, clipBottom, clipEnabled (default 0,0,0)
        // col 5: bg_color.rgba (default 0,0,0,0)
        this._groupData = new Float32Array(this.maxGroups * GROUP_STRIDE * 4);
        this._initGroupDefaults();
        this._groupTexture = new THREE.DataTexture(
            this._groupData,
            GROUP_STRIDE,
            this.maxGroups,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this._groupTexture.minFilter = THREE.NearestFilter;
        this._groupTexture.magFilter = THREE.NearestFilter;
        this._groupTexture.generateMipmaps = false;
        this._groupTexture.needsUpdate = true;

        // Highlight texture (RGBA8 DataTexture, 1024 wide, wrapped)
        this._highlightTexture = null;
        this._highlightSize = 0;
        this._highlightTexWidth = 1024;

        // Create Three.js geometry and mesh
        this.geometry = this._createGeometry();
        this.material = this._createMaterial();

        this.instanceMesh = new THREE.Mesh(this.geometry, this.material);
        this.instanceMesh.userData.glyphField = this;
        this.instanceMesh.frustumCulled = options.frustumCulled === true;

        if (this.scene) {
            this.scene.add(this.instanceMesh);
        }

        if (this.atlas?._live && typeof this.atlas._live.registerField === 'function') {
            this.atlas._live.registerField(this);
        }
        if (!this._slugData && this.atlas?._slugData) {
            this.setSlugData(this.atlas._slugData, this._shaper);
        }
    }

    /** @private */
    _initGroupDefaults() {
        for (let g = 0; g < this.maxGroups; g++) {
            this._resetGroupRow(g);
        }
    }

    /** @private */
    _resetGroupRow(g) {
        if (g < 0 || g >= this.maxGroups) return;
        const base = g * GROUP_STRIDE * 4;
        this._groupData.fill(0, base, base + GROUP_STRIDE * 4);
        // col 1: quaternion xyzw (0, 0, 0, 1)
        this._groupData[base + 4 + 3]  = 1.0;
        // col 2: color rgba (1, 1, 1, 1)
        this._groupData[base + 8]      = 1.0;
        this._groupData[base + 8 + 1]  = 1.0;
        this._groupData[base + 8 + 2]  = 1.0;
        this._groupData[base + 8 + 3]  = 1.0;
        // col 3: scale xyz + colorBlend (1, 1, 1, 0)
        this._groupData[base + 12]     = 1.0;
        this._groupData[base + 12 + 1] = 1.0;
        this._groupData[base + 12 + 2] = 1.0;
        this._groupData[base + 12 + 3] = 0.0;
        // col 4: clip (0, 0, 0, 0)
        // col 5: bg_color (0, 0, 0, 0)
        this._touchGroup(g);
    }

    /** @private */
    _createGeometry() {
        const geometry = new THREE.InstancedBufferGeometry();

        // Unit quad indexed: [0, 1, 2, 0, 2, 3]
        // Corners: (0,0), (1,0), (1,1), (0,1)
        const quadPositions = new Float32Array([
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 1.0, 0.0,
        ]);
        const quadUVs = new Float32Array([
            0.0, 0.0,
            1.0, 0.0,
            1.0, 1.0,
            0.0, 1.0,
        ]);
        const quadIndices = [0, 1, 2, 0, 2, 3];

        geometry.setIndex(quadIndices);
        geometry.setAttribute('position', new THREE.BufferAttribute(quadPositions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(quadUVs, 2));

        // Interleaved 32-byte slot buffer attribute bindings
        this._interleavedBuffer = this.slotBuffer.createInterleavedBuffer();
        InstancedSlotBuffer.bindGeometryAttributes(geometry, this._interleavedBuffer);
        geometry.instanceCount = 0;

        return geometry;
    }

    get emojiAtlas() {
        return this.atlas?._emojiAtlas || this.atlas?._shaper?._emojiAtlas || this._shaper?._emojiAtlas || null;
    }

    /** @private */
    _createMaterial() {
        const ea = this.emojiAtlas;
        return createGlyphMaterial({
            curveTexture: this._slugData?.curveTexture,
            glyphMapTexture: this._slugData?.glyphMapTexture,
            groupTexture: this._groupTexture,
            maxGroups: this.maxGroups,
            emojiTexture: ea?.getTexture?.(THREE) || null,
            emojiCols: ea?.cols || 16,
            emojiRows: ea?.rows || 16,
        });
    }

    /**
     * Hot-swap or update Slug textures.
     * @param {Object} slugData - { curveTexture, glyphMapTexture }
     * @param {Object} [shaper]
     */
    setSlugData(slugData, shaper) {
        if (shaper) this._shaper = shaper;
        if (!slugData) return;
        this._slugData = slugData;

        if (this.material && this.material.uniforms) {
            if (slugData.curveTexture) {
                this.material.uniforms.curveTexture.value = slugData.curveTexture;
            }
            if (slugData.glyphMapTexture) {
                this.material.uniforms.glyphMapTexture.value = slugData.glyphMapTexture;
                this.material.uniforms.glyphMapWidth.value = slugData.glyphMapTexture.image?.width || 1024;
            }
            const ea = this.emojiAtlas;
            const tex = ea?.getTexture?.(THREE);
            if (tex && this.material.uniforms.emojiTexture) {
                this.material.uniforms.emojiTexture.value = tex;
                this.material.uniforms.emojiCols.value = ea.cols || 16;
                this.material.uniforms.emojiRows.value = ea.rows || 16;
            }
            this.material.needsUpdate = true;
        }
    }

    /**
     * Refresh the emoji atlas texture and grid dimensions after new emoji cells were drawn.
     * Called by LiveSlugAtlas._refreshEmojiTextures on registered fields.
     */
    setEmojiTexture() {
        const ea = this.emojiAtlas;
        if (!ea) return;
        const tex = ea.getTexture?.(THREE);
        if (tex) {
            tex.needsUpdate = true;
            if (this.material?.uniforms?.emojiTexture) {
                this.material.uniforms.emojiTexture.value = tex;
                this.material.uniforms.emojiCols.value = ea.cols || 16;
                this.material.uniforms.emojiRows.value = ea.rows || 16;
                this.material.needsUpdate = true;
            }
        }
    }

    /**
     * Upload an array or buffer of slots directly into the geometry.
     * @param {InstancedSlotBuffer} slotBuffer
     * @param {number} count
     */
    setSlots(slotBuffer, count) {
        this.slotBuffer = slotBuffer;
        this.slotBuffer.count = count;
        this._cachedGlyphCount = count;

        const neededCapacity = Math.max(count, 1);
        if (!this._interleavedBuffer || this._interleavedBuffer.array.buffer !== slotBuffer.buffer || this._interleavedBuffer.count < neededCapacity) {
            this._interleavedBuffer = slotBuffer.createInterleavedBuffer();
            InstancedSlotBuffer.bindGeometryAttributes(this.geometry, this._interleavedBuffer);
        }

        this._interleavedBuffer.needsUpdate = true;
        this.geometry.instanceCount = count;
    }

    /**
     * Load text directly through LayoutGenerator and upload to GPU.
     * @param {string|string[]} text
     * @param {Object} [options]
     * @returns {{ bounds: Object, totalRows: number, glyphCount: number }}
     */
    loadText(text, options = {}) {
        const live = this.atlas?._live;
        const shaper = this.atlas?._shapeCache || this._shaper;
        if (live && shaper && text) {
            const str = Array.isArray(text) ? text.join('\n') : String(text);
            if (!this.atlas._seenCodepoints) this.atlas._seenCodepoints = new Set();
            const seen = this.atlas._seenCodepoints;
            let fresh = null;
            for (let i = 0; i < str.length;) {
                const cp = str.codePointAt(i);
                i += cp > 0xFFFF ? 2 : 1;
                if (cp > 32 && !seen.has(cp)) {
                    seen.add(cp);
                    (fresh ?? (fresh = [])).push(cp);
                }
            }
            if (fresh && fresh.length > 0) {
                live.ensureCodepoints(fresh, shaper);
            }
        }

        const opts = {
            shaper: this._shaper,
            worldScale: this.worldScale,
            color: options.color || this._defaultColor,
            targetBuffer: this.slotBuffer,
            ...options,
        };

        const result = generateLayout(text, opts);
        this.setSlots(result.buffer, result.glyphCount);
        this.setLayoutExtent(result.bounds);
        return result;
    }

    /**
     * Update geometry bounding box & sphere for Three.js frustum culling.
     * @param {{ min: {x:number, y:number, z:number}, max: {x:number, y:number, z:number} }} bounds
     */
    setLayoutExtent(bounds) {
        if (!bounds) return;
        if (!this.geometry.boundingBox) this.geometry.boundingBox = new THREE.Box3();
        this.geometry.boundingBox.min.set(bounds.min.x, bounds.min.y, bounds.min.z);
        this.geometry.boundingBox.max.set(bounds.max.x, bounds.max.y, bounds.max.z);

        if (!this.geometry.boundingSphere) this.geometry.boundingSphere = new THREE.Sphere();
        this.geometry.boundingBox.getBoundingSphere(this.geometry.boundingSphere);
    }

    /** Number of active rendered glyphs */
    getGlyphCount() {
        return this._cachedGlyphCount;
    }

    get glyphMapTexture() {
        return this._slugData?.glyphMapTexture || this.material?.uniforms?.glyphMapTexture?.value || null;
    }

    get glyphMapWidth() {
        return this.material?.uniforms?.glyphMapWidth?.value || this.glyphMapTexture?.image?.width || 1024;
    }

    get groupTexture() {
        return this._groupTexture;
    }

    get widthCompress() {
        return this.material?.uniforms?.uWidthCompress?.value || 1.0;
    }

    /** Clear all glyphs */
    clear() {
        this._cachedGlyphCount = 0;
        this.geometry.instanceCount = 0;
        this.slotBuffer.clear();
        if (this._interleavedBuffer) {
            this._interleavedBuffer.needsUpdate = true;
        }
    }

    // ── Group Transform API ──────────────────────────────────────────────────

    /** @private Mark group texture dirty */
    _touchGroup(groupId) {
        if (this._groupTexture) {
            this._groupTexture.needsUpdate = true;
        }
    }

    /**
     * Claim a group row. Released IDs are reused.
     * @returns {number} groupId
     */
    createGroup() {
        const reused = this._freeGroups.pop();
        if (reused !== undefined) {
            this._resetGroupRow(reused);
            return reused;
        }
        const id = this._groupCount++;
        if (id >= this.maxGroups) {
            if (!this._groupExhaustionNoted) {
                this._groupExhaustionNoted = true;
                console.error(`InstancedField: group table EXHAUSTED (${this.maxGroups} live groups) — new content renders INVISIBLE (dead group 0). This is a leak or a churn storm: something creates groups without releasing them.`);
            }
            this._groupCount = this.maxGroups;
            return 0;
        }
        this._resetGroupRow(id);
        return id;
    }

    /**
     * Release a group row back to the free list.
     * Goes dark (alpha 0) while free. Group 0 is never releasable.
     * @param {number} groupId
     */
    releaseGroup(groupId) {
        if (!(groupId > 0) || groupId >= this.maxGroups) return;
        if (this._freeGroups.includes(groupId)) return;
        const base = groupId * GROUP_STRIDE * 4;
        this._groupData.fill(0, base, base + GROUP_STRIDE * 4);
        this._groupData[base + 4 + 3] = 1.0;
        this._touchGroup(groupId);
        this._freeGroups.push(groupId);
    }

    /** Set group offset (position) */
    setGroupOffset(groupId, offset) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = g * GROUP_STRIDE * 4;
        this._groupData[b + 0] = offset.x ?? offset[0] ?? 0;
        this._groupData[b + 1] = offset.y ?? offset[1] ?? 0;
        this._groupData[b + 2] = offset.z ?? offset[2] ?? 0;
        this._touchGroup(g);
    }

    /** Set group rotation quaternion (xyzw) */
    setGroupQuaternion(groupId, quat) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 1) * 4;
        this._groupData[b + 0] = quat.x ?? quat[0] ?? 0;
        this._groupData[b + 1] = quat.y ?? quat[1] ?? 0;
        this._groupData[b + 2] = quat.z ?? quat[2] ?? 0;
        this._groupData[b + 3] = quat.w ?? quat[3] ?? 1;
        this._touchGroup(g);
    }

    /** Set group color multiplier and alpha */
    setGroupColor(groupId, color, alpha = 1.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 2) * 4;
        this._groupData[b + 0] = color.r ?? color[0] ?? 1.0;
        this._groupData[b + 1] = color.g ?? color[1] ?? 1.0;
        this._groupData[b + 2] = color.b ?? color[2] ?? 1.0;
        this._groupData[b + 3] = alpha ?? color.a ?? 1.0;
        this._touchGroup(g);
    }

    /** Set group alpha only */
    setGroupAlpha(groupId, alpha) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 2) * 4 + 3;
        this._groupData[b] = alpha;
        this._touchGroup(g);
    }

    /** Set group scale (xyz) and color blend mode */
    setGroupScale(groupId, scale, colorBlend = 0.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 3) * 4;
        this._groupData[b + 0] = typeof scale === 'number' ? scale : (scale.x ?? 1.0);
        this._groupData[b + 1] = typeof scale === 'number' ? scale : (scale.y ?? 1.0);
        this._groupData[b + 2] = typeof scale === 'number' ? scale : (scale.z ?? 1.0);
        this._groupData[b + 3] = colorBlend;
        this._touchGroup(g);
    }

    /** Set group vertical clip window */
    setGroupClip(groupId, clipTop, clipBottom, clipEnabled = true) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 4) * 4;
        this._groupData[b + 0] = clipTop ?? 0;
        this._groupData[b + 1] = clipBottom ?? 0;
        this._groupData[b + 2] = clipEnabled ? 1.0 : 0.0;
        this._touchGroup(g);
    }

    /** Set group background color */
    setGroupBgColor(groupId, color, alpha = 0.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 5) * 4;
        this._groupData[b + 0] = color.r ?? color[0] ?? 0;
        this._groupData[b + 1] = color.g ?? color[1] ?? 0;
        this._groupData[b + 2] = color.b ?? color[2] ?? 0;
        this._groupData[b + 3] = alpha;
        this._touchGroup(g);
    }

    /**
     * Facade for CodeGrid: set vertical clip range on group 0.
     * @param {number|null} top
     * @param {number|null} bottom
     */
    setClipYRange(top, bottom) {
        if (top == null || bottom == null) {
            this.setGroupClip(0, 0, 0, false);
        } else {
            this.setGroupClip(0, top, bottom, true);
        }
    }

    // ── Highlight API ────────────────────────────────────────────────────────

    /** @private */
    _ensureHighlightTexture(instanceCount) {
        if (this._highlightTexture && this._highlightSize >= instanceCount) return;

        const W = this._highlightTexWidth;
        const count = Math.max(instanceCount, 1);
        const height = Math.ceil(count / W);
        const data = new Uint8Array(W * height * 4);

        if (this._highlightTexture) {
            const old = this._highlightTexture.image.data;
            data.set(old.subarray(0, Math.min(old.length, data.length)));
            this._highlightTexture.dispose();
        }

        const tex = new THREE.DataTexture(data, W, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        this._highlightTexture = tex;
        this._highlightSize = count;

        if (this.material && this.material.uniforms) {
            this.material.uniforms.highlightTexture.value = tex;
        }
    }

    /**
     * Set highlight color and fill opacity for a specific slot.
     * @param {number} slotIndex
     * @param {{r:number, g:number, b:number}|null} color
     * @param {number} [fillOpacity=0]
     */
    setGlyphHighlight(slotIndex, color, fillOpacity = 0.0) {
        if (slotIndex < 0) return;
        this._ensureHighlightTexture(slotIndex + 1);
        const data = this._highlightTexture.image.data;
        const base = slotIndex * 4;
        if (color) {
            data[base + 0] = Math.round((color.r ?? 0) * 255);
            data[base + 1] = Math.round((color.g ?? 0) * 255);
            data[base + 2] = Math.round((color.b ?? 0) * 255);
            data[base + 3] = Math.round(fillOpacity * 255);
        } else {
            data[base + 0] = 0;
            data[base + 1] = 0;
            data[base + 2] = 0;
            data[base + 3] = 0;
        }
        this._highlightTexture.needsUpdate = true;
        if (this.material && this.material.uniforms) {
            this.material.uniforms.hasHighlight.value = 1;
        }
    }

    // ── Per-Slot Editing / Transcoding API ───────────────────────────────────

    /** Write slot color */
    writeColor(slotIndex, packedColor) {
        this.slotBuffer.setColor(slotIndex, packedColor);
        if (this._interleavedBuffer) this._interleavedBuffer.needsUpdate = true;
    }

    /** Write multiple slot colors */
    writeColors(firstSlot, packedColors) {
        for (let i = 0; i < packedColors.length; i++) {
            this.slotBuffer.setColor(firstSlot + i, packedColors[i]);
        }
        if (this._interleavedBuffer) this._interleavedBuffer.needsUpdate = true;
    }

    /** Write slot position */
    writePosition(slotIndex, x, y, z) {
        this.slotBuffer.setPosition(slotIndex, x, y, z);
        if (this._interleavedBuffer) this._interleavedBuffer.needsUpdate = true;
    }

    /** Set mesh visibility */
    setVisible(visible) {
        if (this.instanceMesh) {
            this.instanceMesh.visible = !!visible;
        }
    }

    /**
     * Color a range of glyphs using a color palette and LUT (for SyntaxColorizer).
     * When text/lines and lineStarts are provided, maps UTF-8 palette bytes to
     * 32-byte RenderSlots per line (properly skipping newlines, tabs, and handling
     * multibyte characters).
     *
     * @param {Uint8Array} palette - Per-byte palette index
     * @param {Float32Array} lut - Palette RGB lookup table (3 floats per entry)
     * @param {string|string[]} [textOrLines] - Optional text or array of lines
     * @param {Int32Array|number[]} [lineStarts] - Optional start slot index per line
     */
    setGlyphPaletteRange(palette, lut, textOrLines, lineStarts) {
        if (!palette || !lut || !this.slotBuffer) return;

        // Build pre-packed uint32 colors for all palette indices
        const lutCount = (lut.length / 3) | 0;
        const packedLUT = new Uint32Array(lutCount);
        for (let p = 0; p < lutCount; p++) {
            const r = (lut[p * 3] * 255 + 0.5) | 0;
            const g = (lut[p * 3 + 1] * 255 + 0.5) | 0;
            const b = (lut[p * 3 + 2] * 255 + 0.5) | 0;
            packedLUT[p] = (r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16);
        }

        const lines = Array.isArray(textOrLines)
            ? textOrLines
            : (typeof textOrLines === 'string' ? textOrLines.split('\n') : null);

        if (lines && lineStarts && lineStarts.length >= lines.length) {
            // Line-aware mapping: properly bridges UTF-8 byte ruler with RenderSlots
            let byteOffset = 0;
            const paletteLen = palette.length;
            const lineCount = lines.length;

            for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
                const line = lines[lineIdx];
                const lineLen = line.length;
                const slotBase = lineStarts[lineIdx];
                let slotOffset = 0;

                for (let i = 0; i < lineLen;) {
                    const cp = line.codePointAt(i);
                    i += cp > 0xFFFF ? 2 : 1;

                    if (cp === 9) {
                        // Tab: 1 byte in UTF-8, no slot in slotBuffer
                        byteOffset++;
                        continue;
                    }
                    if (cp === 13) {
                        // CR: 1 byte in UTF-8, no slot in slotBuffer
                        byteOffset++;
                        continue;
                    }

                    // Codepoint byte length in UTF-8
                    const byteLen = (cp <= 0x7F) ? 1 : (cp <= 0x7FF) ? 2 : (cp <= 0xFFFF) ? 3 : 4;

                    if (byteOffset < paletteLen) {
                        const palIdx = palette[byteOffset];
                        const packed = packedLUT[palIdx] !== undefined ? packedLUT[palIdx] : packedLUT[0];
                        this.slotBuffer.setColor(slotBase + slotOffset, packed);
                    }

                    slotOffset++;
                    byteOffset += byteLen;
                }

                // Skip newline byte between lines
                if (byteOffset < paletteLen) {
                    if (palette[byteOffset] === 0x0D && byteOffset + 1 < paletteLen && palette[byteOffset + 1] === 0x0A) {
                        byteOffset += 2;
                    } else {
                        byteOffset++;
                    }
                }
            }
        } else {
            // Fallback sequential mapping
            const base = this.sourceBase || 0;
            const count = Math.min(this._cachedGlyphCount, palette.length - base);
            if (count <= 0) return;
            const start = base | 0;
            for (let i = 0; i < count; i++) {
                const palIdx = palette[start + i];
                const packed = packedLUT[palIdx] !== undefined ? packedLUT[palIdx] : packedLUT[0];
                this.slotBuffer.setColor(i, packed);
            }
        }

        if (this._interleavedBuffer) {
            this._interleavedBuffer.needsUpdate = true;
        }
    }

    /**
     * Set a range of glyphs to a uniform color.
     * @param {number} start
     * @param {number} count
     * @param {{r:number, g:number, b:number, a?:number}} color
     */
    setGlyphColorRange(start, count, color) {
        const packed = packRgba8(color.r, color.g, color.b, color.a ?? 1.0);
        const end = Math.min(this._cachedGlyphCount, start + count);
        for (let i = start; i < end; i++) {
            this.slotBuffer.setColor(i, packed);
        }
        if (this._interleavedBuffer) {
            this._interleavedBuffer.needsUpdate = true;
        }
    }

    /**
     * Set a single glyph color.
     * @param {number} slotIndex
     * @param {{r:number, g:number, b:number, a?:number}} color
     */
    setGlyphColor(slotIndex, color) {
        const packed = packRgba8(color.r, color.g, color.b, color.a ?? 1.0);
        this.slotBuffer.setColor(slotIndex, packed);
        if (this._interleavedBuffer) {
            this._interleavedBuffer.needsUpdate = true;
        }
    }

    /**
     * Copy glyph lanes (color + highlight) from srcSlot to dstSlot.
     * @param {number} srcSlot
     * @param {number} dstSlot
     * @param {number} count
     */
    copyGlyphLanes(srcSlot, dstSlot, count) {
        if (!(count > 0) || srcSlot === dstSlot) return;
        const f32 = this.slotBuffer.float32;
        for (let i = 0; i < count; i++) {
            f32[(dstSlot + i) * 8 + 4] = f32[(srcSlot + i) * 8 + 4];
        }
        if (this._interleavedBuffer) this._interleavedBuffer.needsUpdate = true;
        if (this._highlightTexture) {
            const hl = this._highlightTexture.image.data;
            hl.copyWithin(dstSlot * 4, srcSlot * 4, (srcSlot + count) * 4);
            this._highlightTexture.needsUpdate = true;
        }
    }

    /** Cell metrics computed from atlas char size and worldScale */
    get metrics() {
        if (!this._cachedMetrics) {
            const charSize = this.atlas?.getCharSize?.() || { width: 9.6, height: 18 };
            this._cachedMetrics = computeCellMetrics(charSize, this.worldScale);
        }
        return this._cachedMetrics;
    }

    get glyphMapTexture() {
        return this._slugData?.glyphMapTexture || null;
    }

    get glyphMapWidth() {
        return this._slugData?.glyphMapTexture?.image?.width || 1024;
    }

    get widthCompress() {
        return this.material?.uniforms?.uWidthCompress?.value || 1.0;
    }

    static encodeHighlightAlpha(fillOpacity) {
        return fillOpacity > 0 ? Math.min(255, Math.max(1, (fillOpacity * 255 + 0.5) | 0)) : 0;
    }

    highlightBuffer(count) {
        this._ensureHighlightTexture(count);
        return this._highlightTexture ? this._highlightTexture.image.data : null;
    }

    markHighlightDirty() {
        if (this._highlightTexture) {
            this._highlightTexture.needsUpdate = true;
            if (this.material && this.material.uniforms) {
                this.material.uniforms.hasHighlight.value = 1;
            }
        }
    }

    setFrameTexture(tex, cols, rows) {
        this._frameTexture = tex || null;
        this._frameCols = Math.max(1, Math.floor(cols) || 1);
        this._frameRows = Math.max(1, Math.floor(rows) || 1);
    }

    /**
     * Adopt prebuilt buffer arrays (positions, sizes, colors, glyphIds, groupIds).
     * @param {Object} buffers
     * @param {Array} [items]
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, colors, groupIds, count } = buffers;
        const glyphIds = buffers.glyphIds || buffers.codepoints;
        const itemMeta = buffers.itemMeta;

        this.slotBuffer.ensureCapacity(count);
        const f32 = this.slotBuffer.float32;
        const u32 = this.slotBuffer.uint32;

        for (let i = 0; i < count; i++) {
            const b = i * 8;
            f32[b + 0] = positions ? positions[i * 3 + 0] : 0;
            f32[b + 1] = positions ? positions[i * 3 + 1] : 0;
            f32[b + 2] = positions ? positions[i * 3 + 2] : 0;
            const gid = glyphIds ? glyphIds[i] : 0;
            u32[b + 3] = gid >>> 0;
            const cr = colors ? (colors[i * 3 + 0] * 255 + 0.5) | 0 : 255;
            const cg = colors ? (colors[i * 3 + 1] * 255 + 0.5) | 0 : 255;
            const cb = colors ? (colors[i * 3 + 2] * 255 + 0.5) | 0 : 255;
            u32[b + 4] = (cr & 0xff) | ((cg & 0xff) << 8) | ((cb & 0xff) << 16) | 0xff000000;
            const grp = groupIds ? groupIds[i] : 0;
            u32[b + 5] = grp >>> 0;
            f32[b + 6] = sizes ? sizes[i * 2 + 0] : 1.0;
            f32[b + 7] = sizes ? sizes[i * 2 + 1] : 1.0;
        }

        this.setSlots(this.slotBuffer, count);
        this.maxInstances = Math.max(this.maxInstances, count);

        let ids = null;
        if (itemMeta && items) {
            ids = [];
            this.renderedTexts.clear();
            for (let i = 0; i < itemMeta.length; i++) {
                const meta = itemMeta[i];
                const id = this.nextId++;
                this.renderedTexts.set(id, {
                    id,
                    bufferStartIndex: meta.bufferStartIndex,
                    glyphCount: meta.glyphCount,
                    lineSlotOffsets: meta.lineSlotOffsets || null,
                });
                ids.push(id);
            }
        }
        return ids;
    }

    /** @private */
    _blankGlyphId() {
        if (this._blankGid === undefined) {
            let gid = 0;
            if (this._shaper) {
                if (typeof this._shaper.lookup === 'function') {
                    const entry = this._shaper.lookup(32);
                    if (entry) gid = entry.g;
                } else if (typeof this._shaper.shape === 'function') {
                    const shaped = this._shaper.shape(' ');
                    if (shaped && shaped.length) gid = shaped[0].g;
                }
            }
            this._blankGid = gid;
        }
        return this._blankGid;
    }

    /**
     * Render single text item.
     * @param {string} text
     * @param {{x:number, y:number, z:number}} [position]
     * @param {Object} [options]
     * @returns {number} textId
     */
    render(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        return this.renderBatch([{ text, position, options }])[0];
    }

    /**
     * Batch render text items and backplate quads into group rows.
     * @param {Array<{text?:string, quad?:{w:number, h:number, fill?:{color:{r:number,g:number,b:number}, opacity:number}}, position?:{x:number,y:number,z:number}, options?:Object}>} items
     * @returns {number[]} textIds
     */
    renderBatch(items) {
        if (!items || !items.length) return [];
        let totalGlyphs = 0;
        for (const item of items) {
            if (item.quad) {
                totalGlyphs += 1;
            } else if (item.text) {
                totalGlyphs += [...item.text].length;
            }
        }

        const newCount = this._cachedGlyphCount + totalGlyphs;
        this.slotBuffer.ensureCapacity(newCount);

        const ids = [];
        let slot = this._cachedGlyphCount;
        const charMetrics = this.metrics;
        const defaultCharW = charMetrics.charWidth;
        const defaultRowH = charMetrics.charHeight;

        for (const item of items) {
            const options = item.options || {};
            const pos = item.position || { x: 0, y: 0, z: 0 };
            const groupId = options.groupId ?? 0;
            const startSlot = slot;

            if (item.quad) {
                const w = item.quad.w || defaultCharW;
                const h = item.quad.h || defaultRowH;
                const fill = item.quad.fill;
                const col = fill?.color || options.color || this._defaultColor;
                const opacity = fill?.opacity ?? (col.a ?? 1.0);
                const packedCol = packRgba8(col.r ?? 1, col.g ?? 1, col.b ?? 1, opacity);

                const blankGid = this._blankGlyphId();
                this.slotBuffer.writeSlot(slot, {
                    x: pos.x,
                    y: pos.y,
                    z: pos.z,
                    glyphId: blankGid,
                    color: packedCol,
                    groupId: groupId,
                    advance: w,
                    height: h,
                });
                if (fill) {
                    this.setGlyphHighlight(slot, col, opacity);
                }
                slot++;
            } else if (item.text) {
                const text = item.text;
                const col = options.color || this._defaultColor;
                const packedCol = packRgba8(col.r ?? 1, col.g ?? 1, col.b ?? 1, col.a ?? 1.0);
                const scale = options.scale ?? 1.0;
                const charW = defaultCharW * scale;
                const rowH = defaultRowH * scale;

                let penX = pos.x;
                const penY = pos.y;
                const penZ = pos.z;

                for (let i = 0; i < text.length;) {
                    const cp = text.codePointAt(i);
                    i += cp > 0xffff ? 2 : 1;
                    if (cp === 10) {
                        continue;
                    }
                    let gid = 0;
                    if (this._shaper) {
                        if (typeof this._shaper.lookup === 'function') {
                            const entry = this._shaper.lookup(cp);
                            if (entry) gid = entry.g;
                        } else if (typeof this._shaper.shape === 'function') {
                            const shaped = this._shaper.shape(String.fromCodePoint(cp));
                            if (shaped && shaped.length) gid = shaped[0].g;
                        }
                    } else {
                        gid = cp;
                    }

                    this.slotBuffer.writeSlot(slot, {
                        x: penX,
                        y: penY,
                        z: penZ,
                        glyphId: gid,
                        color: packedCol,
                        groupId: groupId,
                        advance: charW,
                        height: rowH,
                    });
                    penX += charW;
                    slot++;
                }
            }
            const id = this.nextId++;
            this.renderedTexts.set(id, { id, bufferStartIndex: startSlot, glyphCount: slot - startSlot });
            ids.push(id);
        }

        this.setSlots(this.slotBuffer, slot);
        return ids;
    }

    /** Dispose GPU and buffer resources */
    dispose() {
        if (this.atlas?._live && typeof this.atlas._live.unregisterField === 'function') {
            this.atlas._live.unregisterField(this);
        }
        if (this.instanceMesh?.parent) {
            this.instanceMesh.parent.remove(this.instanceMesh);
        } else if (this.instanceMesh && this.scene) {
            this.scene.remove(this.instanceMesh);
        }
        this.geometry?.dispose();
        this.material?.dispose();
        this._groupTexture?.dispose();
        this._highlightTexture?.dispose();
    }
}
