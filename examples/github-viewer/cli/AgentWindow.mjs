/**
 * AgentWindow — a single agent's 3D text panel in the viewer.
 *
 * Wraps a remote CodeGrid managed via WebSocket commands.
 * Created by AgentWindowManager; do not instantiate directly.
 */

export default class AgentWindow {
    /**
     * @param {Object} options
     * @param {string} options.label - agent identifier (e.g. "protocol")
     * @param {number} options.gridIndex - assigned grid index in the viewer
     * @param {Function} options.sendCommand - async (cmd) => result, provided by manager
     * @param {Function} options.onClose - callback to notify manager of removal
     */
    constructor({ label, gridIndex, sendCommand, onClose }) {
        this.label = label;
        this.gridIndex = gridIndex;
        this._send = sendCommand;
        this._onClose = onClose;
        this._closed = false;
        this._lines = [];
        this._maxLines = 80;
    }

    /**
     * Replace the grid's entire text content.
     * @param {string} text - raw text (will be base64-encoded for transport)
     * @returns {Promise<{text: string, data: any}>}
     */
    async write(text) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        const b64 = Buffer.from(text).toString('base64');
        return this._send(`grid.text ${this.gridIndex} ${b64}`);
    }

    /**
     * Append text to the window, keeping only the last maxLines lines.
     * This is the primary method for streaming agent output.
     * @param {string} text - text to append (can be multi-line)
     * @param {Object} [options]
     * @param {number} [options.maxLines=80] - max lines to retain
     * @returns {Promise<{text: string, data: any}>}
     */
    async append(text, { maxLines } = {}) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        const limit = maxLines || this._maxLines;
        const newLines = text.split('\n');
        this._lines.push(...newLines);
        if (this._lines.length > limit) {
            this._lines = this._lines.slice(-limit);
        }
        return this.write(this._lines.join('\n'));
    }

    /**
     * Clear all content from the window.
     * @returns {Promise<{text: string, data: any}>}
     */
    async clear() {
        this._lines = [];
        return this.write('');
    }

    /**
     * Set the window's visible title line.
     * Updates the first line of content with a formatted header.
     * Note: the grid's filename label is set at creation time via
     * AgentWindowManager.createWindow() and cannot be changed after.
     * @param {string} name
     * @returns {Promise<{text: string, data: any}>}
     */
    async setTitle(name) {
        if (this._lines.length > 0 && this._lines[0].startsWith('=== ')) {
            this._lines[0] = `=== ${name} ===`;
        } else {
            this._lines.unshift(`=== ${name} ===`);
        }
        return this.write(this._lines.join('\n'));
    }

    /**
     * Set the grid's text color.
     * @param {number} r - red (0-1)
     * @param {number} g - green (0-1)
     * @param {number} b - blue (0-1)
     * @returns {Promise<{text: string, data: any}>}
     */
    async setColor(r, g, b) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.color ${this.gridIndex} ${r} ${g} ${b}`);
    }

    /**
     * Set the grid's world position.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Promise<{text: string, data: any}>}
     */
    async setPosition(x, y, z) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.position ${this.gridIndex} ${x} ${y} ${z}`);
    }

    /**
     * Set the grid's uniform scale.
     * @param {number} factor
     * @returns {Promise<{text: string, data: any}>}
     */
    async setScale(factor) {
        if (this._closed) throw new Error(`AgentWindow "${this.label}" is closed`);
        return this._send(`grid.scale ${this.gridIndex} ${factor}`);
    }

    /**
     * Remove this grid from the viewer and mark the window as closed.
     * @returns {Promise<{text: string, data: any}>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        const result = await this._send(`grid.remove ${this.gridIndex}`);
        this._onClose(this.label);
        return result;
    }

    /** @returns {boolean} */
    get isClosed() {
        return this._closed;
    }
}
