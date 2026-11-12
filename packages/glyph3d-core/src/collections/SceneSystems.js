import SceneTransforms from './SceneTransforms.js';
import GlyphFarLod from './GlyphFarLod.js';
import PanelBatch from './PanelBatch.js';
import GlyphBatch from './GlyphBatch.js';
import FlatRenderRoot from './FlatRenderRoot.js';

/**
 * SceneSystems — the renderer's per-scene systems, installed in the order they depend on and torn
 * down in reverse. Every application that renders glyph fields installs this one set (the IDE's
 * CommandProvider and the wall's TerminalWall each hold one), so the order lives in one place:
 *
 *   transforms   world matrices recomputed only where something moved; the batches and the flat
 *                root read its marks ("in this scene, and shown?"), so it goes first and leaves last
 *   flatRoot     the view renders a flat list of the drawables it sees, not the scene tree: three's
 *                walk visits what draws, not every container. The seam is the renderer — every
 *                render of this scene goes through it (the app's frame, a screenshot); a camera off
 *                layer 0 (a pick pass) gets the scene itself. `flatRoot.enabled` toggles it.
 *   farLod       a field too small to read draws one backdrop quad instead of its glyphs
 *   panelBatch   flat panels, box fills and outlines draw as instances (scene.onBeforeRender)
 *   glyphBatch   labels draw from one arena field; its onBeforeRender hook chains after the panel
 *                batch's, so it unhooks first
 *
 * Run `update(camera, viewportHeightPx)` once a frame before the render (far-LOD's decision); the
 * batches refresh themselves from the scene's onBeforeRender.
 */
export default class SceneSystems {
    /**
     * @param {import('three').Scene} scene
     * @param {Object} atlas - the GlyphAtlas the label arena renders from
     * @param {import('three').WebGLRenderer} renderer - the renderer this scene draws through (the
     *   flat root's seam: its render() is wrapped until dispose)
     */
    constructor(scene, atlas, renderer) {
        if (!scene?.isScene) throw new Error(`[SceneSystems] needs a THREE.Scene, got ${scene?.type ?? scene}`);
        if (!atlas) throw new Error('[SceneSystems] needs the glyph atlas (the label batch renders from it)');
        if (typeof renderer?.render !== 'function') throw new Error('[SceneSystems] needs the renderer (the flat root wraps its render())');
        this.transforms = new SceneTransforms(scene);
        this.flatRoot = new FlatRenderRoot(scene);
        const flatRoot = this.flatRoot;
        this._renderer = renderer;
        this._baseRender = renderer.render;
        const baseRender = this._baseRender;
        renderer.render = function (s, c) { return baseRender.call(this, s === scene ? flatRoot.target(c) : s, c); };
        this.farLod = new GlyphFarLod(scene);
        this.panelBatch = new PanelBatch(scene);
        this.glyphBatch = new GlyphBatch(scene, atlas);
    }

    /**
     * Per frame, before the render.
     * @param {import('three').Camera} camera - the view camera
     * @param {number} viewportHeightPx - the canvas's CSS height
     */
    update(camera, viewportHeightPx) {
        this.farLod.update(camera, viewportHeightPx);
    }

    /** Reverse order: hands the renderer's render(), scene.onBeforeRender and scene.updateMatrixWorld back to three. */
    dispose() {
        this.glyphBatch.dispose();
        this.panelBatch.dispose();
        this.farLod.dispose();
        this._renderer.render = this._baseRender;
        this.transforms.dispose();
    }
}
