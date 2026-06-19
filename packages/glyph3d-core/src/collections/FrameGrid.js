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
import ScaleModel from './ScaleModel.js';
import { createPanelMaterial } from './panelMaterial.js';
import { RENDER_ORDER } from '../core/renderOrder.js';

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
        // The file:// uri this frame was loaded from, when it backs an image file (set by the
        // image-open path). null for a live capture. Lets the registry index it by sourcePath
        // (dedup / refresh), same as CodeGrid — a frame from a file is a first-class file entity.
        this.sourcePath = options.sourcePath || null;

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

        // Picking — wired via setPickingSystem(); re-registered whenever _build re-dices the cells.
        this._pickingSystem = null;
        // Size-change taps (the dock auto-reflows a docked tile via this); fired on setAspect.
        this._resizeListeners = null;

        this._build();

        // Backing panel: a TRANSPARENT plane that is the flat 'grid'-channel PICK target (a capture
        // has no glyph panel, so this is how a click resolves to the whole tile) AND the carrier of
        // the in-shader identity/hover/dock border. The fill is invisible (opacity 0) — the video
        // cells ARE the content, so the panel must not darken or occlude them; only the border rim
        // shows, and only when a state flag is set. Picking reads the ID pass, not the visible
        // material, so a transparent panel is still fully clickable.
        this._panel = null;
        this._background = null;
        this._bgColor   = options.backgroundColor   ?? 0x0a0a1e;
        this._bgOpacity = options.backgroundOpacity ?? 0; // transparent fill; border rim still shows
        this._initBackground();

        // Reparent the renderer mesh under this Object3D so this.position/scale apply.
        this.add(this._renderer.instanceMesh);

        // ScaleModel is the single authority for this.scale: placement (natural size at home, the
        // dock's tile-fit when docked) · user (persisted zoom). resolve() is the only writer — the
        // dock + setScale/setZoom feed it, never this.scale directly. Mirrors CodeGrid/TerminalGrid.
        this.scaleModel = new ScaleModel(options.gridScale ?? 1);
        this.scaleModel.resolve(this);
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
        this._updateBackground();   // aspect changed → panel height changed
        this._reregisterPicking();  // _build re-diced → glyph-channel id block changed
        this._fireResize();         // a docked tile re-fits
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
        this._reregisterPicking();                           // re-dice changed the cell count → glyph channel
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

    /** @returns {string|null} the file:// uri this frame was loaded from, if any. Mirrors CodeGrid. */
    getSourcePath() {
        return this.sourcePath || this.userData?.sourcePath || null;
    }

    /** @param {string} path - file:// uri the registry indexes this frame under. */
    setSourcePath(path) {
        this.sourcePath = path;
    }

    // ── Content-grid duck-typed surface ──────────────────────────────────────────────
    // When a FrameGrid backs an image FILE it registers as a 'grid' (a first-class file
    // entity), so the generic grid consumers (grid.list, the file.open summary) call the
    // same methods they call on a CodeGrid. A frame is a texture, not text, so these report
    // name / zero — enough to coexist without a special case. (A shared Surface protocol is
    // the eventual home for this contract; duck-typing is the deliberate stop-gap.)

    /** @returns {string|null} display name. Mirrors CodeGrid.getFilename(). */
    getFilename() {
        return this.name || null;
    }

    /** @returns {number} 0 — a frame has no text lines. Mirrors CodeGrid.getLineCount(). */
    getLineCount() {
        return 0;
    }

    /** @returns {number} 0 — a frame samples a texture; it has no glyphs. Mirrors CodeGrid.getGlyphCount(). */
    getGlyphCount() {
        return 0;
    }

    // ── Interactive-window interface — position / scale / zoom / border / picking, mirroring
    //    CodeGrid / TerminalGrid so a capture drags, docks, and scales like any other window.
    //    Duck-typed across the collections; the shared base is the deferred unification work.

    /** Move the capture in 3D. The ObjectDragger (Ctrl-drag) calls this on the picked grid. */
    setWorldPosition(pos) {
        this.position.set(pos.x, pos.y, pos.z);
    }

    /** Set the PLACEMENT scale (natural home size; the dock overrides it while docked). */
    setScale(factor) {
        this.scaleModel.placement = factor;
        this.scaleModel.resolve(this);
    }

    /** Set the user ZOOM — readability scale, composed onto this.scale via ScaleModel. The dock
     *  reads it back for tile-fit; window.scale calls dock.reflowTile after. */
    setZoom(factor) {
        this.scaleModel.setZoom(factor);
        this.scaleModel.resolve(this);
    }

    /** Current uniform zoom magnitude (the persisted readability scale). @returns {number} */
    get zoom() { return this.scaleModel.zoomScalar; }

    /** Subscribe to size changes (the dock auto-reflows a docked tile via this). Returns unsubscribe. */
    onResize(cb) {
        if (!this._resizeListeners) this._resizeListeners = new Set();
        this._resizeListeners.add(cb);
        return () => { this._resizeListeners?.delete(cb); };
    }

    /** @private */
    _fireResize() {
        if (!this._resizeListeners) return;
        for (const cb of this._resizeListeners) { try { cb(this.cols, this.rows); } catch { /* ignore tap errors */ } }
    }

    /** Set the in-shader identity border (the dock's ghost hue); WHAT shows is driven by setBorderFlag. */
    setBorder(style = {}) { this._panel?.setBorder(style); }

    /** Flip BORDER_FLAGS bits (DOCKED / HOVERED / FOCUSED / INPUT) on the border. */
    setBorderFlag(mask, present) { this._panel?.setBorderFlag(mask, present); }

    /** Restyle the focus/hover/input border state colors (shared interaction vocabulary). */
    setStateColors(colors = {}) { this._panel?.setStateColors(colors); }

    /** Live-restyle the backing panel (color / opacity). */
    setBackgroundStyle({ color, opacity } = {}) {
        if (color != null) this._bgColor = color;
        if (opacity != null) this._bgOpacity = opacity;
        this._panel?.setFill(this._bgColor, this._bgOpacity);
    }

    /** @private The flat 'grid'-channel pick target + border carrier, sized to the frame. */
    _initBackground() {
        const geometry = new THREE.PlaneGeometry(1, 1);
        // depthWrite FALSE: a transparent overlay must not occlude the video cells (or anything
        // behind), regardless of which face of the capture the viewer sees. (TerminalGrid writes
        // depth because its panel IS a solid backing; a capture's content is the cells.)
        this._panel = createPanelMaterial({ color: this._bgColor, opacity: this._bgOpacity, side: THREE.DoubleSide, depthWrite: false });
        this._background = new THREE.Mesh(geometry, this._panel.material);
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        this._background.userData.entityType = 'frame'; // gesture dispatch resolves background → capture id
        this.add(this._background);
        this._updateBackground();
    }

    /** @private Size + place the backing panel to the frame (centered, just behind the cells). */
    _updateBackground() {
        if (!this._background) return;
        const totalH = this.width / this.aspect;
        this._background.scale.set(this.width, totalH, 1);
        this._background.position.set(0, 0, -0.05);
    }

    /**
     * Wire the picking system: the cell renderer on the 'glyph' channel (per-cell picks) + the
     * backing panel on the 'grid' channel (one flat quad → resolves a click to this capture, for
     * hover / select / Ctrl-drag). Mirrors TerminalGrid.setPickingSystem.
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._renderer)   pickingSystem.register('glyph', this._renderer, this._renderer);
        if (this._background) pickingSystem.register('grid', this._background, this);
    }

    /** @private Re-register the glyph channel after a re-dice changed the cell count. */
    _reregisterPicking() {
        if (this._pickingSystem && this._renderer) this._pickingSystem.register('glyph', this._renderer, this._renderer);
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
        // Unregister from picking BEFORE the renderer is torn down (the 'glyph' target is the
        // renderer; the 'grid' target is the backing panel).
        if (this._pickingSystem) {
            if (this._renderer)   this._pickingSystem.unregister('glyph', this._renderer);
            if (this._background) this._pickingSystem.unregister('grid', this._background);
        }
        if (this._background) {
            this._background.geometry.dispose();
            this._background.material.dispose();
            this.remove(this._background);
            this._background = null;
            this._panel = null;
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
