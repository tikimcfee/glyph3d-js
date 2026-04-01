/**
 * AgentGrid — thin wrapper around CodeGrid for agent activity windows.
 *
 * Provides identity (id, title), append-mode I/O, ANSI stripping,
 * and dirty-flag render coalescing. No fixed dimensions, no scroll
 * viewport, no cursor — content grows freely in 3D space.
 */

import CodeGrid from './CodeGrid.js';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export default class AgentGrid {
    /**
     * @param {string} id - Stable identifier for command routing
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} [options]
     * @param {string} [options.title]
     * @param {Object} [options.color] - {r,g,b} text color
     * @param {number} [options.scale] - grid scale (default 2.0)
     * @param {Object} [options.position] - {x,y,z}
     */
    constructor(id, scene, atlas, options = {}) {
        this.id = id;
        this.scene = scene;
        this.title = options.title || id;

        this._lines = [];
        this._dirty = false;
        this._rendering = false;
        this._lastRenderedContent = '';

        this.grid = new CodeGrid(scene, atlas, {
            name: `agent-${id}`,
            showFilename: true,
            filenameColor: { r: 0.8, g: 0.8, b: 0.2 },
            textColor: options.color || { r: 0, g: 1, b: 0 },
            gridScale: options.scale || 2.0,
        });

        if (options.position) {
            this.grid.position.set(
                options.position.x || 0,
                options.position.y || 0,
                options.position.z || 0,
            );
        }

        scene.add(this.grid);
    }

    /** Replace all content. */
    write(text) {
        this._lines = text.replace(ANSI_RE, '').split('\n');
        this._markDirty();
    }

    /** Append one line (primary I/O for streaming agent output). */
    appendLine(text) {
        this._lines.push(text.replace(ANSI_RE, ''));
        this._markDirty();
    }

    /** Clear all content. */
    clear() {
        this._lines = [];
        this._markDirty();
    }

    /** @returns {number} */
    get historyLength() { return this._lines.length; }

    // -- Spatial --

    setPosition(x, y, z) { this.grid.position.set(x, y, z); }

    getPosition() {
        const p = this.grid.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Proxy for raycasting -- HitDispatcher accesses entry.grid._background */
    get _background() { return this.grid?._background ?? null; }

    /** Proxy for bounds queries -- overlap detection, layout, etc. */
    getBounds() { return this.grid?.getBounds() ?? null; }

    setScale(s) { this.grid.scale.setScalar(s); }

    // -- Lifecycle --

    dispose() {
        this.scene.remove(this.grid);
        this.grid.dispose();
        this.grid = null;
    }

    // -- Internal --

    /** @private */
    _markDirty() {
        if (this._dirty) return;
        this._dirty = true;
        requestAnimationFrame(() => this._render());
    }

    /** @private */
    async _render() {
        this._dirty = false;
        if (this._rendering) return; // previous loadFileAsync still in flight
        const content = this._lines.join('\n');
        if (content === this._lastRenderedContent) return;
        this._lastRenderedContent = content;
        this._rendering = true;
        try {
            await this.grid.loadFileAsync(`[${this.title}]`, content);
        } finally {
            this._rendering = false;
            // If new content arrived while we were rendering, schedule another pass
            if (this._lines.join('\n') !== this._lastRenderedContent) {
                this._markDirty();
            }
        }
    }
}
