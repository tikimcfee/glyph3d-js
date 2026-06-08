/**
 * SceneContext — shared reference bag for subsystems
 *
 * Lightweight container passed to CameraController, CodeColorManager,
 * HeatmapProvider, etc. Holds references to shared Three.js objects
 * without owning their lifecycle. GitHubRepoViewer maintains ownership.
 *
 * Grids are accessed via getGrids() (backed by a closure) rather than
 * a cached array ref, because clearGrids() replaces the array object.
 */

export class SceneContext {
    /**
     * @param {Object} refs
     * @param {Object} refs.THREE - Three.js module
     * @param {THREE.Scene} refs.scene
     * @param {THREE.PerspectiveCamera} refs.camera
     * @param {THREE.WebGLRenderer} refs.renderer
     * @param {HTMLCanvasElement} refs.canvas
     * @param {GlyphAtlas} refs.atlas
     * @param {Function} refs.getGrids - () => CodeGrid[], returns live grids array
     * @param {Function} [refs.getSurfaces] - () => Object[], every framed surface (grids +
     *   terminals). Optional; falls back to getGrids when absent.
     */
    constructor(refs) {
        this.THREE = refs.THREE;
        this.scene = refs.scene;
        this.camera = refs.camera;
        this.renderer = refs.renderer;
        this.canvas = refs.canvas;
        this.atlas = refs.atlas;
        this._getGrids = refs.getGrids;
        this._getSurfaces = refs.getSurfaces || null;

        // Updated after loadRepository creates these
        this.hierarchicalManager = null;
        this.layoutManager = null;
    }

    /** @returns {CodeGrid[]} Current live grids array */
    getGrids() {
        return this._getGrids();
    }

    /**
     * Every framed surface that occupies 3D space — code grids AND terminals. The camera's
     * dynamic-speed sampling + fit-all want all bounds-bearing windows, not just grids.
     * Falls back to getGrids() when no surface accessor was supplied.
     * @returns {Object[]}
     */
    getSurfaces() {
        return this._getSurfaces ? this._getSurfaces() : this._getGrids();
    }
}

export default SceneContext;
