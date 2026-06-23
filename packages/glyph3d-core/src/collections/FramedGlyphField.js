import ScaleModel from './ScaleModel.js';
import BoundedObject3D from './BoundedObject3D.js';

/**
 * FramedGlyphField — the shared surface for the glyph-field window types
 * (CodeGrid, TerminalGrid, FrameGrid).
 *
 * It sits between {@link BoundedObject3D} (which owns the on-demand world-bounds
 * contract) and the concrete grids, lifting the parts that were triplicated verbatim
 * across all three:
 *
 *     THREE.Object3D → BoundedObject3D (bounds) → FramedGlyphField (this) → {Code,Terminal,Frame}Grid
 *
 * This first slice owns the SCALE surface: the {@link ScaleModel} (the single authority
 * for this.scale — placement · user) and the setScale / setZoom / zoom API. Later slices
 * will lift the renderer slot + accessor, picking registration, and panel styling.
 *
 * Scale lifecycle — why the model is built per-subclass but the methods live here:
 *   - The MODEL's home `placement` comes from a subclass-specific source (CodeGrid
 *     config.gridScale, TerminalGrid _gridScale, FrameGrid options.gridScale) and must be
 *     set at the point in the subclass constructor where the transform basis is ready. So
 *     the subclass calls {@link FramedGlyphField#_initScale} there rather than the base
 *     constructing it blindly — the base owns the "construct + initial resolve" invariant,
 *     the subclass owns the placement value and the timing.
 *   - The METHODS are identical across the three, so they live here. setScale's common core
 *     is placement+resolve; a subclass that ALSO mirrors the value into its own home-scale
 *     field (CodeGrid config.gridScale, TerminalGrid _gridScale) overrides setScale to stash
 *     then call super. FrameGrid (no mirror) uses this base setScale as-is.
 *
 * @abstract getLocalBounds — inherited contract from BoundedObject3D (subclasses implement it).
 */
export default class FramedGlyphField extends BoundedObject3D {
    constructor() {
        super();
        /**
         * The GlyphField renderer. The SLOT lives here (the base owns getRenderer); each
         * subclass CONSTRUCTS it — lazily in CodeGrid (created on first flush), eagerly in
         * TerminalGrid/FrameGrid (a fixed-size buffer in their constructor).
         * @type {import('../GlyphField.js').default|null}
         */
        this._renderer = null;
        /**
         * The PickingSystem, wired post-construction via setPickingSystem(). Null until then.
         * @type {import('../picking/PickingSystem.js').PickingSystem|null}
         */
        this._pickingSystem = null;
        /**
         * The background panel mesh — the 'grid' pick target + in-shader border carrier. The SLOT
         * lives here; each subclass BUILDS it (and its own sizing) in its _initBackground.
         * @type {import('three').Mesh|null}
         */
        this._background = null;
        /**
         * The panel-material handle (fill + in-shader border) backing _background. Subclass-built.
         * @type {object|null}
         */
        this._panel = null;
        /**
         * Size-change subscribers (lazily created on first onResize). Taps fire AFTER a resize with
         * the new (cols, rows) — the 3D grid OWNS its size; a 2D companion view / the dock tracks it.
         * @type {Set<(cols:number, rows:number)=>void>|null}
         */
        this._resizeListeners = null;
    }

    /**
     * Build the ScaleModel with the given home/context placement and resolve it onto
     * this.scale immediately (the initial transform write). A subclass calls this from its
     * constructor once its transform basis is set up, passing its own placement source.
     * Captures the "construct + initial resolve" invariant in one place.
     * @param {number} [placement=1] initial context scale (the subclass's home gridScale)
     */
    _initScale(placement = 1) {
        /** @type {ScaleModel} single authority for this.scale (placement · user) */
        this.scaleModel = new ScaleModel(placement);
        this.scaleModel.resolve(this);
    }

    /**
     * Set the PLACEMENT scale (the window's natural home size). The dock overrides this
     * while docked; composed through ScaleModel so any active zoom is preserved. A subclass
     * that mirrors the value into its own home-scale field overrides this and calls super.
     * @param {number} factor
     */
    setScale(factor) {
        this.scaleModel.placement = factor;
        this.scaleModel.resolve(this);
    }

    /**
     * Set the user ZOOM — readability scale, independent of layout and of the dock's
     * tile-fit. Number = uniform (glyph aspect preserved); {x,y,z} = deliberate stretch.
     * @param {number|{x?:number,y?:number,z?:number}} factor
     */
    setZoom(factor) {
        this.scaleModel.setZoom(factor);
        this.scaleModel.resolve(this);
    }

    /** Current uniform zoom magnitude (the persisted readability scale). @returns {number} */
    get zoom() { return this.scaleModel.zoomScalar; }

    /**
     * The underlying GlyphField renderer, so canvas picking can map a resolved pick (the
     * renderer is the 'glyph'-channel token) back to this entity. Null if a lazy subclass
     * has not created it yet.
     * @returns {import('../GlyphField.js').default|null}
     */
    getRenderer() {
        return this._renderer;
    }

    /**
     * Wire a PickingSystem and register this field's two stable channels:
     *   - 'glyph' (token = renderer) — per-character / per-cell picks. A subclass whose
     *     instanceCount changes re-registers it after a rebuild (flush / resize / re-dice).
     *   - 'grid'  (token = this)     — the whole-panel background pickable.
     * A subclass with an extra pickable (e.g. TerminalGrid's resize grip) overrides this,
     * calls super(), then registers its own channel.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._renderer)   pickingSystem.register('glyph', this._renderer, this._renderer);
        if (this._background) pickingSystem.register('grid', this._background, this);
    }

    /**
     * Set this window's in-shader border identity: color (the dock's ghost hue), width (screen
     * pixels), intensity. WHAT shows is driven by the border flags (setBorderFlag) — each subsystem
     * owns its own bits and the shader decodes them. No-op until the panel exists.
     * @param {{ color?: number|string, width?: number, intensity?: number }} style
     */
    setBorder(style = {}) {
        this._panel?.setBorder(style);
    }

    /**
     * Restyle this window's focus/hover/input border state colors (the shared interaction
     * vocabulary, configured in Settings ▸ Appearance). WHICH one shows is driven by the flags.
     * @param {{ hover?: number|string, focus?: number|string, input?: number|string }} colors
     */
    setStateColors(colors = {}) {
        this._panel?.setStateColors(colors);
    }

    /**
     * Flip one or more BORDER_FLAGS bits on this window's border (DOCKED / HOVERED / FOCUSED /
     * INPUT). The dock owns DOCKED; the attention-driven border controller owns the rest.
     * @param {number} mask @param {boolean} present
     */
    setBorderFlag(mask, present) {
        this._panel?.setBorderFlag(mask, present);
    }

    /**
     * Subscribe to size changes. The tap fires AFTER a resize with the new (cols, rows) — the 3D
     * grid OWNS its size; a 2D companion view or the dock tracks it. Returns an unsubscribe fn.
     * @param {(cols:number, rows:number)=>void} cb
     * @returns {() => void} unsubscribe
     */
    onResize(cb) {
        if (!this._resizeListeners) this._resizeListeners = new Set();
        this._resizeListeners.add(cb);
        return () => { this._resizeListeners?.delete(cb); };
    }

    /**
     * Fire the size-change taps with the new (cols, rows). A throwing tap is isolated so one bad
     * subscriber can't break the others or the resize itself. No-op when there are no subscribers.
     * @param {number} cols @param {number} rows
     * @protected
     */
    _emitResize(cols, rows) {
        if (!this._resizeListeners) return;
        for (const cb of this._resizeListeners) {
            try { cb(cols, rows); } catch { /* ignore tap errors */ }
        }
    }

    /**
     * Tear down the background panel: free its GPU geometry + material, detach the mesh from this
     * Object3D, and clear both slots. Idempotent (no-op once disposed). A subclass calls this from
     * its own dispose() AFTER unregistering picking (the 'grid' channel's token is the background)
     * and alongside its own renderer / PTY / capture teardown.
     */
    _disposePanel() {
        if (!this._background) return;
        this._background.geometry.dispose();
        this._background.material.dispose();
        this.remove(this._background);
        this._background = null;
        this._panel = null;
    }
}
