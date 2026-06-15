/**
 * FrameGrid — an external image/video frame rendered in 3D as an NxM grid of
 * instanced quads, each quad sampling one cell of the source texture.
 *
 * This is the "the frame buffer IS the atlas" path: instead of GlyphField
 * sampling glyph curves, the field runs in RENDER_MODE.FRAME (see GlyphField),
 * where every instance samples a cell of one shared texture. The cell index is
 * the per-instance glyphId (row-major: cell = row * cols + col), so the same
 * instanced draw call that renders thousands of glyphs reassembles a screen
 * capture / video / image in space.
 *
 * Because each cell is just an independently-positioned quad pointing at a cell
 * index, the addressable-grid tricks fall out for free: scatter the positions,
 * drop or remap cells, or fade/scatter the whole field via its group transform.
 *
 * FrameGrid is render-only. The capture/connection lifecycle (getDisplayMedia,
 * the <video> element, the MediaStream) lives in the caller (the frame.capture
 * handler); pass the resulting texture via setFrameTexture(), and optionally the
 * stream/video via setFrameSource() so dispose() can tear the capture down (and
 * clear the OS "sharing" indicator) when the grid is removed.
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> FrameGrid -> GlyphField (RENDER_MODE.FRAME)
 */

import * as THREE from 'three';
import GlyphField from '../GlyphField.js';

class FrameGrid extends THREE.Object3D {
    /**
     * Choose a cell grid (cols × rows) for a source frame of srcW × srcH: matches the
     * source aspect (so cells stay ~square) while keeping cols × rows within `budget`.
     *
     * Cell count is the SCATTER / effect granularity, not image detail — the texture
     * carries full detail no matter how coarsely it's diced (a 1×1 grid still shows the
     * whole frame). So `budget` is a perf/taste ceiling on independently-movable pieces,
     * not a fidelity floor; the math guarantees cols × rows ≤ budget for any aspect, so
     * the single instanced buffer is always within one allocation (no split needed).
     *
     * @param {number} srcW - source width in pixels
     * @param {number} srcH - source height in pixels
     * @param {Object} [opts]
     * @param {number} [opts.budget=4096] - upper bound on cell count (cols × rows)
     * @returns {{cols:number, rows:number, aspect:number}}
     */
    static deriveGrid(srcW, srcH, { budget = 4096 } = {}) {
        const aspect = (srcW > 0 && srcH > 0) ? srcW / srcH : (16 / 9);
        const b = Math.max(1, Math.floor(budget));
        // Square cells ⇒ cols = aspect·rows. Bound cols·rows ≤ b ⇒ rows ≤ √(b/aspect);
        // the floors only shrink the product, so the bound holds for every aspect.
        const rows = Math.max(1, Math.floor(Math.sqrt(b / aspect)));
        const cols = Math.max(1, Math.floor(rows * aspect));
        return { cols, rows, aspect };
    }

    /**
     * @param {THREE.Scene} scene - Three.js scene (renderer mesh is reparented under this Object3D)
     * @param {GlyphAtlas} atlas - shared atlas (only used for GlyphField construction; no glyphs are shaped)
     * @param {Object} [options]
     * @param {number} [options.cols=16] - cells across the source frame
     * @param {number} [options.rows=9]  - cells down the source frame
     * @param {number} [options.width=24] - total grid width in world units
     * @param {number} [options.aspect=16/9] - source frame aspect (w/h); sets total height = width/aspect
     * @param {string} [options.name='FrameGrid']
     */
    constructor(scene, atlas, options = {}) {
        super();

        this.scene = scene;
        this.atlas = atlas;
        this.name  = options.name || 'FrameGrid';

        this.cols   = Math.max(1, Math.floor(options.cols ?? 16));
        this.rows   = Math.max(1, Math.floor(options.rows ?? 9));
        this.width  = options.width  ?? 24;
        this.aspect = options.aspect ?? (16 / 9);

        this._cellCount = this.cols * this.rows;

        // One renderer, sized to the cell count, kept in frame mode. defaultColor is
        // white so the frame shows its true color (the shader multiplies the sampled
        // texel by the per-instance color — white = passthrough, see GlyphField).
        this._renderer = new GlyphField(scene, atlas, {
            maxInstances: this._cellCount,
            defaultColor: { r: 1, g: 1, b: 1 },
        });

        // A dedicated group (identity by default) so the whole field can be faded /
        // offset / scaled in one O(1) write later (setGroupOffset/Color/Alpha).
        this._groupId = this._renderer.createGroup();

        // Capture lifecycle handles (owned by the caller, torn down here on dispose).
        this._texture = null;
        this._stream  = null;
        this._video   = null;

        this._build();

        // Reparent the renderer mesh under this Object3D so this.position/scale apply.
        this.add(this._renderer.instanceMesh);
    }

    /**
     * Cell width/height in world units, derived from width + aspect + cols/rows.
     * @private
     */
    _cellSize() {
        const cellW   = this.width / this.cols;
        const totalH  = this.width / this.aspect;
        const cellH   = totalH / this.rows;
        return { cellW, cellH };
    }

    /**
     * Build the per-instance buffers (positions / sizes / cell indices / colors /
     * groups) and push them to the renderer. The grid is centered on this Object3D's
     * local origin; row 0 is at the top so it lines up with the source frame's top
     * (the fragment frame branch maps cell row 0 → top of the texture).
     *
     * ── Frame cell mapping (the addressing contract) ──────────────────────────────
     * A cell is one instanced quad. Its identity is a single row-major index
     *   cell = row * cols + col        (0 = top-left, increasing left→right, top→bottom)
     * carried in the instanceGlyphId attribute. The shader frame branch turns that
     * back into a sub-rectangle of the source texture:
     *   col = cell % frameCols;  row = floor(cell / frameCols)
     *   uv  = ((col + quadUV.x) / frameCols, (row + 1 - quadUV.y) / frameRows)
     * Spatial position (this _build) and texture cell (the index) are independent —
     * that decoupling is the whole trick: move a quad anywhere while it keeps sampling
     * its cell, or repoint a quad at a different cell, and you get screen-in-place,
     * region slicing, or scatter, all from the same instanced draw.
     *
     * ── Performance trajectory: push per-cell manipulation across the GPU fence ────
     * Today this is CPU-side: we write the typed arrays here and hand them over once
     * via applyPrebuiltBuffers (one upload). That's perfect for a static grid, and
     * fine for occasional whole-rebuilds. Per-cell ANIMATION today would mean
     * rewriting these arrays on the CPU each frame and re-uploading — exactly the
     * CPU→GPU fence cost that glyph text alignment also pays (lay out on the CPU, copy
     * over the boundary).
     *
     * The eventual win is to keep the per-cell state GPU-side: a small data texture
     * (or a compute / GPGPU pass) holding per-cell offset / target-cell / tint,
     * sampled in the vertex stage by instanceIndex — the same group-DataTexture
     * pattern GlyphField already uses for group transforms, but at cell granularity.
     * Then scatter/particle effects animate without ever crossing the fence per frame.
     * See the Codrops GPGPU grid-displacement / particle recipes for the established
     * approach. (Not needed for the first pass — basic CPU writes are fine for now.)
     * @private
     */
    _build() {
        const { cols, rows } = this;
        const count = this._cellCount;
        const { cellW, cellH } = this._cellSize();
        const totalH = cellH * rows;

        const positions = new Float32Array(count * 3);
        const sizes     = new Float32Array(count * 2);
        const glyphIds  = new Float32Array(count);
        const colors    = new Float32Array(count * 3).fill(1); // white = true frame color
        const groupIds  = new Float32Array(count).fill(this._groupId);

        const halfW = this.width / 2;
        const halfH = totalH / 2;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const i = row * cols + col;
                // Anchor is the cell's LEFT-center; GlyphField shifts the quad center
                // right by iSize.x/2, landing the quad center at the cell center.
                positions[i * 3]     = -halfW + col * cellW;
                positions[i * 3 + 1] =  halfH - (row + 0.5) * cellH;
                positions[i * 3 + 2] =  0;

                sizes[i * 2]     = cellW;
                sizes[i * 2 + 1] = cellH;

                // Row-major cell index — matches the shader's
                // col = cell % frameCols, row = floor(cell / frameCols).
                glyphIds[i] = i;
            }
        }

        this._renderer.applyPrebuiltBuffers({
            positions, sizes, glyphIds, colors, groupIds, count,
        });
    }

    /**
     * Point the field at a source texture and switch it into frame mode. The grid
     * samples it as a cols × rows uniform grid. Pass null to return to glyph mode.
     * @param {THREE.Texture|null} texture - filterable RGBA texture (VideoTexture/CanvasTexture/DataTexture)
     */
    setFrameTexture(texture) {
        this._texture = texture || null;
        this._renderer.setFrameTexture(this._texture, this.cols, this.rows);
    }

    /**
     * Attach the full capture source so dispose() can stop it. The texture is applied
     * immediately; the stream/video are retained only for teardown.
     * @param {{texture: THREE.Texture, stream?: MediaStream, video?: HTMLVideoElement}} source
     */
    setFrameSource({ texture, stream = null, video = null }) {
        this._stream = stream;
        this._video  = video;
        this.setFrameTexture(texture);
    }

    /**
     * Update the source aspect (e.g. once the real video dimensions are known) and
     * rebuild the cell layout so the reassembled frame isn't distorted.
     * @param {number} aspect - width / height
     */
    setAspect(aspect) {
        if (!(aspect > 0) || aspect === this.aspect) return;
        this.aspect = aspect;
        this._build();
    }

    /**
     * Re-dice the frame into a new cols × rows cell grid live. Rebuilds the per-instance
     * quads (new sizes + cell indices) AND re-pushes the grid dims to the renderer so the
     * shader samples the matching sub-rectangles. The source texture is untouched — only
     * how finely it's cut into independently-addressable cells changes (the scatter
     * resolution). No-op if the dims are unchanged.
     * @param {number} cols - new cells across
     * @param {number} rows - new cells down
     */
    setGrid(cols, rows) {
        const c = Math.max(1, Math.floor(cols) || 1);
        const r = Math.max(1, Math.floor(rows) || 1);
        if (c === this.cols && r === this.rows) return;
        this.cols = c;
        this.rows = r;
        this._cellCount = c * r;
        this._build();                                       // rebuild quads at the new granularity
        this._renderer.setFrameTexture(this._texture, c, r); // re-push dims so frameCols/frameRows match
    }

    /** @returns {number} number of cells (cols × rows). */
    getCellCount() {
        return this._cellCount;
    }

    /** The dedicated group id for whole-field transforms (fade/offset/scatter). */
    getGroupId() {
        return this._groupId;
    }

    // ── Surface interface — graduates a capture into a first-class window, on par with
    //    CodeGrid / TerminalGrid (camera fit-all, dynamic-speed, picking, dock). These are
    //    duck-typed across the collections (no shared Surface base yet — that dedup is the
    //    glyph-field-unification work); mirror the existing contract here.

    /**
     * The grid's extent in its OWN local frame — width × (width/aspect), centered on the
     * origin (the build centers the cells there), with a thin Z so an edge-on pick ray
     * still hits the flat panel. Trivial to recompute, so derived each call (no cache).
     * @returns {THREE.Box3}
     */
    getLocalBounds() {
        const totalH = this.width / this.aspect;
        const hw = this.width / 2, hh = totalH / 2;
        return new THREE.Box3(
            new THREE.Vector3(-hw, -hh, -0.5),
            new THREE.Vector3( hw,  hh,  0.5),
        );
    }

    /**
     * World-space AABB, for canvas picking and camera framing (fit-all / dynamic-speed).
     * Re-derived each call from the current world matrix so it rides drag / scale / dock
     * rotation. Mirrors TerminalGrid.getBounds() (a THREE.Box3 in world space).
     * @returns {THREE.Box3}
     */
    getBounds() {
        this.updateWorldMatrix(true, false);
        return this.getLocalBounds().applyMatrix4(this.matrixWorld);
    }

    /**
     * The underlying GlyphField renderer, so canvas picking can map a resolved pick
     * (renderer) back to this capture entity. Mirrors CodeGrid / TerminalGrid.getRenderer().
     * @returns {import('../GlyphField.js').default|null}
     */
    getRenderer() {
        return this._renderer;
    }

    /**
     * Tear down: stop the capture (so the OS stops sharing), drop the texture, remove
     * the renderer mesh, and dispose the geometry. The field material is SHARED across
     * all fields, so it is intentionally NOT disposed here.
     */
    dispose() {
        if (this._stream) {
            for (const track of this._stream.getTracks()) track.stop();
            this._stream = null;
        }
        if (this._video) {
            this._video.pause?.();
            this._video.srcObject = null;
            this._video.remove?.();   // detach the offscreen <video> the handler appended
            this._video = null;
        }
        if (this._texture) {
            this._texture.dispose?.();
            this._texture = null;
        }
        const mesh = this._renderer?.instanceMesh;
        if (mesh) this.remove(mesh);   // mesh is parented here, not the renderer's scene
        // Full renderer teardown: unregisters from the live slug atlas (so no dangling
        // field reference / stray setSlugData pushes), disposes the geometry and the
        // group/highlight DataTextures. The field MATERIAL is shared across all fields
        // and is intentionally left untouched.
        this._renderer?.dispose?.();
        if (this.parent) this.parent.remove(this);
    }
}

export default FrameGrid;
