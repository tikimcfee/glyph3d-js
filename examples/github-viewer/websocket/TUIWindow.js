/**
 * TUIWindow -- browser-side terminal pane backed by a CodeGrid.
 *
 * Buffer model: unbounded _history array + scrollOffset viewport.
 * Supports write (replace all), appendLine (scroll), clear, resize,
 * character-level editing, cursor tracking, scroll offset,
 * and dirty-flag rendering to avoid redundant GPU uploads.
 *
 * ANSI escape sequences are stripped on ingest (regex removal, no color parsing).
 */

import CodeGrid from '../../../src/collections/CodeGrid.js';

/** Strip ANSI escape sequences (CSI sequences like \x1b[31m, etc.) */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export default class TUIWindow {
    /**
     * @param {string} id - unique window identifier
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} [options]
     * @param {number} [options.cols=80]
     * @param {number} [options.rows=24]
     * @param {Object} [options.position]
     * @param {Object} [options.color]
     * @param {string} [options.title]
     */
    constructor(id, scene, atlas, options = {}) {
        this.id = id;
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this.scene = scene;
        this.atlas = atlas;
        this.title = options.title || id;

        // -- Line buffer (visible window is the last `rows` lines offset by scrollOffset)
        /** @type {string[]} full history buffer */
        this._history = [];
        /** @type {number} lines scrolled back from bottom (0 = latest) */
        this.scrollOffset = 0;

        // -- Cursor (row/col relative to visible window, single source of truth)
        this.cursorRow = 0;
        this.cursorCol = 0;

        // -- Dirty tracking
        this._dirty = true;
        this._lastRenderedContent = '';
        this._rafPending = false;

        // -- CodeGrid
        this.grid = new CodeGrid(scene, atlas, {
            name: `tui-${id}`,
            showFilename: true,
            filenameColor: { r: 0.8, g: 0.8, b: 0.2 },
            textColor: options.color || { r: 0, g: 1, b: 0 },
            backgroundColor: 0x0a0a1e,
            backgroundOpacity: 0.92,
        });

        if (options.position) {
            this.grid.position.set(
                options.position.x || 0,
                options.position.y || 0,
                options.position.z || 0,
            );
        }

        scene.add(this.grid);
        this._pushBlankLines(this.rows);
        this._render();
    }

    // ============ Buffer Writes ============

    /**
     * Replace full content. Long lines are wrapped to cols.
     * @param {string} text
     */
    write(text) {
        this._history = [];
        const rawLines = text.split('\n');
        for (const line of rawLines) {
            this._pushWrapped(line);
        }
        this._padToRows();
        this.scrollOffset = 0;
        this.cursorRow = Math.min(this._history.length, this.rows) - 1;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    /**
     * Append a line (or multi-line text), scrolling if buffer exceeds rows.
     * @param {string} text
     */
    appendLine(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            this._pushWrapped(line);
        }
        // Auto-scroll to bottom when appending
        this.scrollOffset = 0;
        this.cursorRow = this.rows - 1;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    /** Clear all content. */
    clear() {
        this._history = [];
        this._pushBlankLines(this.rows);
        this.scrollOffset = 0;
        this.cursorRow = 0;
        this.cursorCol = 0;
        this._dirty = true;
        this._render();
    }

    // ============ Geometry ============

    /**
     * Resize the visible window.
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        // Re-wrap entire history at new col width
        const oldText = this._history.join('\n');
        this._history = [];
        for (const line of oldText.split('\n')) {
            this._pushWrapped(line);
        }
        this._padToRows();
        this.scrollOffset = 0;
        this._dirty = true;
        this._render();
    }

    /**
     * Set 3D position.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setPosition(x, y, z) {
        this.grid.position.set(x, y, z);
    }

    /** @returns {{x:number, y:number, z:number}} */
    getPosition() {
        const p = this.grid.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Set title (re-renders). */
    setTitle(title) {
        this.title = title;
        this._dirty = true;
        this._render();
    }

    // ============ Scroll ============

    /** Scroll up by n lines (into history). */
    scrollUp(n = 1) {
        const maxOffset = Math.max(0, this._history.length - this.rows);
        this.scrollOffset = Math.min(this.scrollOffset + n, maxOffset);
        this._dirty = true;
        this._render();
    }

    /** Scroll down by n lines (toward latest). */
    scrollDown(n = 1) {
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
        this._dirty = true;
        this._render();
    }

    /** Scroll to bottom (latest output). */
    scrollToBottom() {
        this.scrollOffset = 0;
        this._dirty = true;
        this._render();
    }

    // ============ Cursor Contract (single source of truth) ============

    /**
     * Set cursor position (clamped to valid range).
     * @param {number} row - Row relative to visible window (0 to rows-1)
     * @param {number} col - Column (0 to cols)
     */
    setCursor(row, col) {
        this.cursorRow = Math.max(0, Math.min(row, this.rows - 1));
        this.cursorCol = Math.max(0, Math.min(col, this.cols));
    }

    /** @returns {{ row: number, col: number }} */
    getCursor() {
        return { row: this.cursorRow, col: this.cursorCol };
    }

    // ============ Character-Level Editing API ============
    // All row indices are relative to the visible window.

    /**
     * Return a single visible line (read-only copy).
     * @param {number} row - visible row index
     * @returns {string}
     */
    getLine(row) {
        const lines = this.getVisibleLines();
        if (row < 0 || row >= lines.length) return '';
        return lines[row];
    }

    /**
     * Overwrite an entire visible line.
     * @param {number} row - visible row index
     * @param {string} text
     */
    setLine(row, text) {
        const absRow = this._toAbsoluteRow(row);
        if (absRow < 0 || absRow >= this._history.length) return;
        this._history[absRow] = text.slice(0, this.cols);
        this._dirty = true;
    }

    /**
     * Insert a character at (row, col) in the visible window.
     * Advances cursor by one column.
     * @param {number} row
     * @param {number} col
     * @param {string} char
     */
    insertChar(row, col, char) {
        const line = this.getLine(row);
        const newLine = line.slice(0, col) + char + line.slice(col);
        this.setLine(row, newLine.slice(0, this.cols));
        this.setCursor(row, Math.min(col + 1, this.cols));
    }

    /**
     * Delete the character before (row, col).
     * Handles line merging when col === 0 and row > 0.
     * @param {number} row
     * @param {number} col
     * @returns {boolean} true if a line merge occurred
     */
    deleteChar(row, col) {
        if (col > 0) {
            const line = this.getLine(row);
            this.setLine(row, line.slice(0, col - 1) + line.slice(col));
            this.setCursor(row, col - 1);
            return false;
        }
        // col === 0: merge with previous line
        if (row > 0) {
            const prev = this.getLine(row - 1);
            const curr = this.getLine(row);
            this.setLine(row - 1, (prev + curr).slice(0, this.cols));
            this._removeVisibleLine(row);
            this.setCursor(row - 1, prev.length);
            return true;
        }
        return false;
    }

    /**
     * Split line at (row, col) -- handles Enter key.
     * @param {number} row
     * @param {number} col
     */
    splitLine(row, col) {
        const line = this.getLine(row);
        this.setLine(row, line.slice(0, col));
        this._insertVisibleLine(row + 1, line.slice(col));
        this.setCursor(row + 1, 0);
    }

    // ============ Public Render Trigger ============

    /**
     * Request a render on the next animation frame.
     * Replaces direct _render() calls from outside the class.
     * Coalesces multiple calls into a single render per frame.
     */
    markDirty() {
        this._dirty = true;
        if (!this._rafPending) {
            this._rafPending = true;
            requestAnimationFrame(() => {
                this._rafPending = false;
                this._render();
            });
        }
    }

    // ============ Queries ============

    /** @returns {number} total history lines */
    get historyLength() { return this._history.length; }

    /**
     * @returns {string[]} currently visible lines (read-only slice)
     */
    getVisibleLines() {
        const end = this._history.length - this.scrollOffset;
        const start = Math.max(0, end - this.rows);
        return this._history.slice(start, end);
    }

    // ============ Private ============

    /**
     * Map a visible row index to an absolute _history index.
     * @param {number} visibleRow
     * @returns {number}
     */
    _toAbsoluteRow(visibleRow) {
        const end = this._history.length - this.scrollOffset;
        const start = Math.max(0, end - this.rows);
        return start + visibleRow;
    }

    /**
     * Remove a visible line from history.
     * @param {number} visibleRow
     */
    _removeVisibleLine(visibleRow) {
        const absRow = this._toAbsoluteRow(visibleRow);
        if (absRow >= 0 && absRow < this._history.length) {
            this._history.splice(absRow, 1);
            this._dirty = true;
        }
    }

    /**
     * Insert a line at a visible row position in history.
     * @param {number} visibleRow
     * @param {string} text
     */
    _insertVisibleLine(visibleRow, text) {
        const absRow = this._toAbsoluteRow(visibleRow);
        this._history.splice(absRow, 0, text.slice(0, this.cols));
        this._dirty = true;
    }

    /**
     * Wrap a single line to cols and push to history.
     * Strips ANSI escape sequences before storing.
     * @param {string} line
     */
    _pushWrapped(line) {
        // Strip ANSI escape sequences
        const clean = line.replace(ANSI_RE, '');
        if (clean.length <= this.cols) {
            this._history.push(clean);
        } else {
            for (let i = 0; i < clean.length; i += this.cols) {
                this._history.push(clean.slice(i, i + this.cols));
            }
        }
    }

    /** Pad history so it has at least this.rows entries. */
    _padToRows() {
        while (this._history.length < this.rows) {
            this._history.push('');
        }
    }

    /** Push n blank lines. */
    _pushBlankLines(n) {
        for (let i = 0; i < n; i++) this._history.push('');
    }

    /** Render visible slice to CodeGrid (skips if not dirty). */
    _render() {
        if (!this._dirty) return;
        const content = this.getVisibleLines().join('\n');
        if (content === this._lastRenderedContent) {
            this._dirty = false;
            return;
        }
        this.grid.loadFile(`[${this.title}]`, content);
        this._lastRenderedContent = content;
        this._dirty = false;
    }

    /** Dispose grid and remove from scene. */
    dispose() {
        this.scene.remove(this.grid);
        this.grid.dispose();
        this.grid = null;
    }
}
