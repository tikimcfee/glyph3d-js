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
     */
    constructor(refs) {
        this.THREE = refs.THREE;
        this.scene = refs.scene;
        this.camera = refs.camera;
        this.renderer = refs.renderer;
        this.canvas = refs.canvas;
        this.atlas = refs.atlas;
        this._getGrids = refs.getGrids;

        // Updated after loadRepository creates these
        this.hierarchicalManager = null;
        this.layoutManager = null;
    }

    /** @returns {CodeGrid[]} Current live grids array */
    getGrids() {
        return this._getGrids();
    }
}

export default SceneContext;
