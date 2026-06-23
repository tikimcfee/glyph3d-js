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
}
