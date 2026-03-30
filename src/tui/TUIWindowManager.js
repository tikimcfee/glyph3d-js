/**
 * TUIWindowManager -- lifecycle manager for TUI windows.
 * Creates, tracks, auto-positions, and exposes window operations
 * for the command system.
 */

import TUIWindow from './TUIWindow.js';

export default class TUIWindowManager {
    /**
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     */
    constructor(scene, atlas) {
        this.scene = scene;
        this.atlas = atlas;

        /** @type {Map<string, TUIWindow>} */
        this.windows = new Map();

        // Auto-position: stack vertically, wrap to next column
        this._nextY = 50;
        this._nextX = -100;
        this._stackSpacing = 30;
    }

    /**
     * Create a new window.
     * @param {string} id
     * @param {Object} [options]
     * @returns {TUIWindow}
     */
    create(id, options = {}) {
        if (this.windows.has(id)) {
            throw new Error(`window '${id}' already exists`);
        }

        if (!options.position) {
            options.position = { x: this._nextX, y: this._nextY, z: 0 };
            this._nextY -= this._stackSpacing;
            if (this._nextY < -150) {
                this._nextY = 50;
                this._nextX += 80;
            }
        }

        const win = new TUIWindow(id, this.scene, this.atlas, options);
        this.windows.set(id, win);
        return win;
    }

    /** @returns {TUIWindow|undefined} */
    get(id) { return this.windows.get(id); }

    /**
     * Remove and dispose a window.
     * @param {string} id
     * @returns {boolean}
     */
    remove(id) {
        const win = this.windows.get(id);
        if (!win) return false;
        win.dispose();
        this.windows.delete(id);
        return true;
    }

    /**
     * List all windows with metadata.
     * @returns {Array<Object>}
     */
    list() {
        return [...this.windows.entries()].map(([id, win]) => ({
            id,
            cols: win.cols,
            rows: win.rows,
            position: win.getPosition(),
            title: win.title,
            historyLines: win.historyLength,
            visibleNonEmpty: win.getVisibleLines().filter(l => l.length > 0).length,
        }));
    }

    /** Remove all windows. */
    clearAll() {
        for (const [id] of this.windows) this.remove(id);
    }

    /** @returns {number} */
    get count() { return this.windows.size; }
}
