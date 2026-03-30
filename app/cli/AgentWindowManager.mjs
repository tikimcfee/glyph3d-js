/**
 * AgentWindowManager — manages multiple AgentWindows over a single CliConnection.
 *
 * Handles:
 * - Connection lifecycle (connect once, share across all windows)
 * - Command serialization (CliConnection supports one in-flight command)
 * - Grid index tracking (indices shift on removal)
 * - Layout methods (absorbs former AgentLayoutHelper)
 *
 * Windows are created at origin. Use arrangeAgents() or setPhaseLayout()
 * to position them after creation.
 *
 * Usage:
 *   const mgr = new AgentWindowManager('ws://localhost:8765');
 *   await mgr.connect();
 *   const win = await mgr.createWindow('protocol');
 *   await win.write('Hello from protocol agent');
 *   await mgr.arrangeAgents('row');
 *   await mgr.closeAll();
 */

import CliConnection from './CliConnection.mjs';
import AgentWindow from './AgentWindow.mjs';

// Phase-specific colors (cross-ref semantics, local to this module)
const PHASE_COLORS = {
    PHASE_0:       { r: 0.0, g: 1.0,  b: 0.0 },   // bright green
    PHASE_1:       { r: 0.2, g: 1.0,  b: 0.4 },   // reviewer green
    PHASE_1_DIM:   { r: 0.0, g: 0.6,  b: 0.2 },   // target dim green
    PHASE_2:       { r: 0.4, g: 0.8,  b: 1.0 },   // reviewer blue
    PHASE_2_DIM:   { r: 0.1, g: 0.4,  b: 0.6 },   // target dim blue
    PHASE_3:       { r: 1.0, g: 0.85, b: 0.3 },   // gold convergence
};

export default class AgentWindowManager {
    /**
     * @param {string} [url='ws://localhost:8765'] - WebSocket relay URL
     */
    constructor(url = 'ws://localhost:8765') {
        this._url = url;
        this._conn = new CliConnection(url);
        this._connected = false;

        /** @type {Map<string, AgentWindow>} label -> AgentWindow */
        this._windows = new Map();

        /** @type {Map<string, number>} label -> grid index */
        this._indexMap = new Map();

        // Command queue for serialization
        this._queue = [];
        this._processing = false;
    }

    /**
     * Connect to the relay server.
     * @returns {Promise<string>} registration ack
     */
    async connect() {
        if (this._connected) return 'already connected';
        const ack = await this._conn.connect();
        this._connected = true;
        return ack;
    }

    /**
     * Create a new agent window in the viewer.
     * Window is created at origin. Call arrangeAgents() or setPosition() to position.
     * @param {string} label - unique agent identifier
     * @param {Object} [options]
     * @param {string} [options.initialText=''] - text to show on creation
     * @param {{r: number, g: number, b: number}} [options.color] - initial color
     * @returns {Promise<AgentWindow>}
     */
    async createWindow(label, options = {}) {
        if (this._windows.has(label)) {
            return this._windows.get(label);
        }

        const initialText = options.initialText || `[${label}] ready`;
        const b64 = Buffer.from(initialText).toString('base64');
        const gridName = `agent:${label}`;

        // Create the grid in the viewer
        const result = await this._enqueue(`grid.create ${b64} ${gridName}`);
        const match = result.text.match(/grid #(\d+)/);
        if (!match) {
            throw new Error(`Failed to create grid for "${label}": ${result.text}`);
        }
        const gridIndex = parseInt(match[1]);

        this._indexMap.set(label, gridIndex);

        const window = new AgentWindow({
            label,
            gridIndex,
            sendCommand: (cmd) => this._enqueue(cmd),
            onClose: (lbl) => this._handleWindowClose(lbl),
        });
        this._windows.set(label, window);

        // Set initial color if provided
        if (options.color) {
            await window.setColor(options.color.r, options.color.g, options.color.b);
        }

        return window;
    }

    /**
     * Get an existing window by label.
     * @param {string} label
     * @returns {AgentWindow|null}
     */
    getWindow(label) {
        return this._windows.get(label) || null;
    }

    /**
     * Get the current grid index for a label.
     * @param {string} label
     * @returns {number|undefined}
     */
    getIndex(label) {
        return this._indexMap.get(label);
    }

    /**
     * Get or create a window. Queries the viewer first to find existing grids
     * from prior hook invocations (handles stateless reconnection).
     * @param {string} label
     * @param {Object} [options] - same as createWindow options
     * @returns {Promise<AgentWindow>}
     */
    async ensureWindow(label, options = {}) {
        // Check in-memory cache first
        if (this._windows.has(label)) {
            return this._windows.get(label);
        }

        // Query the viewer for an existing grid with this agent label
        const gridName = `agent:${label}`;
        const listResult = await this._enqueue('grid.list');
        if (listResult.data && listResult.data.grids) {
            for (const grid of listResult.data.grids) {
                const name = grid.filename || grid.sourcePath || '';
                if (name === gridName) {
                    // Found existing grid -- wrap it in an AgentWindow
                    const window = new AgentWindow({
                        label,
                        gridIndex: grid.index,
                        sendCommand: (cmd) => this._enqueue(cmd),
                        onClose: (lbl) => this._handleWindowClose(lbl),
                    });
                    this._windows.set(label, window);
                    this._indexMap.set(label, grid.index);
                    return window;
                }
            }
        }

        // No existing grid -- create a new one
        return this.createWindow(label, options);
    }

    /**
     * Close and remove all agent windows from the viewer.
     * Removes in reverse index order to avoid index shifting issues.
     */
    async closeAll() {
        // Refresh indices first to get current state
        await this._refreshIndices();

        // Collect labels sorted by descending index (remove highest first)
        const entries = [...this._indexMap.entries()]
            .sort((a, b) => b[1] - a[1]);

        for (const [label] of entries) {
            const win = this._windows.get(label);
            if (win && !win.isClosed) {
                // Re-resolve current index (may have shifted from prior removals)
                await this._refreshIndices();
                const currentIdx = this._indexMap.get(label);
                if (currentIdx !== undefined) {
                    win.gridIndex = currentIdx;
                    await win.close();
                }
            }
        }

        this._windows.clear();
        this._indexMap.clear();
    }

    /**
     * Disconnect from the relay. Optionally close all windows first.
     * @param {Object} [options]
     * @param {boolean} [options.cleanup=true] - remove grids before disconnecting
     */
    async disconnect({ cleanup = true } = {}) {
        if (cleanup && this._windows.size > 0) {
            await this.closeAll();
        }
        this._conn.close();
        this._connected = false;
    }

    /** @returns {number} number of active windows */
    get count() {
        return this._windows.size;
    }

    /** @returns {string[]} labels of all active windows */
    get labels() {
        return [...this._windows.keys()];
    }

    // ============ Layout Methods (absorbed from AgentLayoutHelper) ============

    /**
     * Arrange all agent windows using a named layout style (browser-side).
     * @param {'row'|'column'|'grid'|'radial'} style
     * @returns {Promise<{text: string, data: any}>}
     */
    async arrangeAgents(style = 'row') {
        return this._enqueue(`layout.agents ${style}`);
    }

    /**
     * Focus camera on a specific agent window, dimming others.
     * @param {string} label - Agent label
     * @returns {Promise<{text: string, data: any}>}
     */
    async focusAgent(label) {
        return this._enqueue(`layout.focus ${label}`);
    }

    /**
     * Correlate two agent windows side by side with camera framing.
     * @param {string} label1
     * @param {string} label2
     * @returns {Promise<{text: string, data: any}>}
     */
    async correlateAgents(label1, label2) {
        return this._enqueue(`layout.correlate ${label1} ${label2}`);
    }

    /**
     * Restore all agent windows to their pre-focus/highlight state.
     * @returns {Promise<{text: string, data: any}>}
     */
    async undimAll() {
        return this._enqueue('layout.undim');
    }

    /**
     * Fit all grids in camera view.
     * @returns {Promise<{text: string, data: any}>}
     */
    async fitAll() {
        return this._enqueue('camera.fitall');
    }

    /**
     * Apply a cross-ref phase layout to the current agent windows.
     *
     * Phase 0: Row layout -- agents side by side, all equal prominence.
     * Phase 1: Forward pairs -- each reviewer next to its first review target.
     * Phase 2: Inverse pairs -- reversed pairings with blue color scheme.
     * Phase 3: Convergence cluster -- tight radial arrangement, gold color.
     *
     * @param {number} phase - Phase number (0-3)
     * @param {string[]} agentLabels - Ordered list of agent labels
     * @param {Object} [options]
     * @param {number} [options.windowWidth=120] - Estimated window width in world units
     * @param {number} [options.windowHeight=80] - Estimated window height in world units
     * @param {number} [options.gap=15] - Gap between windows
     * @returns {Promise<{text: string, data: any}>}
     */
    async setPhaseLayout(phase, agentLabels, options = {}) {
        const W = options.windowWidth || 120;
        const H = options.windowHeight || 80;
        const gap = options.gap || 15;

        switch (phase) {
            case 0: return this._layoutPhase0(agentLabels, W, gap);
            case 1: return this._layoutPhase1(agentLabels, W, H, gap);
            case 2: return this._layoutPhase2(agentLabels, W, H, gap);
            case 3: return this._layoutPhase3(agentLabels, W, H);
            default: throw new Error(`Unknown phase: ${phase}`);
        }
    }

    // ============ Phase Layout Internals ============

    /**
     * Phase 0: Simple row layout. Uniform green color.
     * @private
     */
    async _layoutPhase0(labels, W, gap) {
        for (let i = 0; i < labels.length; i++) {
            const x = i * (W + gap);
            await this._positionByLabel(labels[i], x, 0, 0);
        }
        for (const label of labels) {
            await this._colorByLabel(label, PHASE_COLORS.PHASE_0);
        }
        await this.fitAll();
        return {
            text: `OK: phase 0 layout -- ${labels.length} agents in row`,
            data: { phase: 0, layout: 'row', agents: labels }
        };
    }

    /**
     * Phase 1: Forward cross-reference pairs.
     * @private
     */
    async _layoutPhase1(labels, W, H, gap) {
        const pairs = this._computeForwardPairs(labels);
        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));
            await this._positionByLabel(reviewer, 0, y, 0);
            await this._colorByLabel(reviewer, PHASE_COLORS.PHASE_1);
            await this._positionByLabel(target, W + gap, y, 0);
            await this._colorByLabel(target, PHASE_COLORS.PHASE_1_DIM);
        }
        await this.fitAll();
        return {
            text: `OK: phase 1 layout -- ${pairs.length} reviewer pairs`,
            data: { phase: 1, layout: 'pairs', pairs }
        };
    }

    /**
     * Phase 2: Inverse cross-reference pairs with blue scheme.
     * @private
     */
    async _layoutPhase2(labels, W, H, gap) {
        const pairs = this._computeInversePairs(labels);
        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));
            await this._positionByLabel(reviewer, W + gap, y, 0);
            await this._colorByLabel(reviewer, PHASE_COLORS.PHASE_2);
            await this._positionByLabel(target, 0, y, 0);
            await this._colorByLabel(target, PHASE_COLORS.PHASE_2_DIM);
        }
        await this.fitAll();
        return {
            text: `OK: phase 2 layout -- ${pairs.length} inverse pairs`,
            data: { phase: 2, layout: 'inverse-pairs', pairs }
        };
    }

    /**
     * Phase 3: Convergence cluster. Gold/amber color.
     * @private
     */
    async _layoutPhase3(labels, W, H) {
        const n = labels.length;
        const radius = Math.max(W, H) * 0.8;
        for (let i = 0; i < n; i++) {
            const angle = (Math.PI / 2) + (2 * Math.PI * i / n);
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            await this._positionByLabel(labels[i], x, y, 0);
            await this._colorByLabel(labels[i], PHASE_COLORS.PHASE_3);
        }
        await this.fitAll();
        return {
            text: `OK: phase 3 layout -- ${n} agents in convergence cluster`,
            data: { phase: 3, layout: 'radial-cluster', agents: labels }
        };
    }

    // ============ Pairing Logic ============

    /**
     * Forward review pairs: agent i reviews agent (i+1) % n.
     * @private
     */
    _computeForwardPairs(labels) {
        const pairs = [];
        for (let i = 0; i < labels.length; i++) {
            const others = labels.filter((_, j) => j !== i);
            if (others.length > 0) {
                pairs.push({ reviewer: labels[i], target: others[0] });
            }
        }
        return pairs;
    }

    /**
     * Inverse review pairs: agent i reviews agent (i-1+n) % n.
     * @private
     */
    _computeInversePairs(labels) {
        const pairs = [];
        for (let i = 0; i < labels.length; i++) {
            const others = labels.filter((_, j) => j !== i).reverse();
            if (others.length > 0) {
                pairs.push({ reviewer: labels[i], target: others[0] });
            }
        }
        return pairs;
    }

    // ============ Internal Helpers ============

    /**
     * Position a window by label using grid.position command.
     * @private
     */
    async _positionByLabel(label, x, y, z) {
        const index = this._indexMap.get(label);
        if (index === undefined) return;
        return this._enqueue(`grid.position ${index} ${x} ${y} ${z}`);
    }

    /**
     * Set color for a window by label using grid.color command.
     * @private
     */
    async _colorByLabel(label, { r, g, b }) {
        const index = this._indexMap.get(label);
        if (index === undefined) return;
        return this._enqueue(`grid.color ${index} ${r} ${g} ${b}`);
    }

    /**
     * Enqueue a command for serialized sending.
     * CliConnection supports only one pending response at a time,
     * so we queue commands and process them sequentially.
     * @param {string} cmd
     * @returns {Promise<{text: string, data: any}>}
     * @private
     */
    _enqueue(cmd) {
        return new Promise((resolve, reject) => {
            this._queue.push({ cmd, resolve, reject });
            this._processQueue();
        });
    }

    /** @private */
    async _processQueue() {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            const { cmd, resolve, reject } = this._queue.shift();
            try {
                const result = await this._conn.send(cmd);
                resolve(result);
            } catch (err) {
                reject(err);
            }
        }

        this._processing = false;
    }

    /**
     * Refresh grid index map by querying the viewer.
     * Necessary after removals since indices shift.
     * @private
     */
    async _refreshIndices() {
        const result = await this._enqueue('grid.list');
        if (!result.data || !result.data.grids) return;

        this._indexMap.clear();
        for (const grid of result.data.grids) {
            const name = grid.filename || grid.sourcePath || '';
            if (name.startsWith('agent:')) {
                const label = name.slice(6);
                this._indexMap.set(label, grid.index);
                const win = this._windows.get(label);
                if (win) win.gridIndex = grid.index;
            }
        }
    }

    /**
     * Handle a window closing: remove from maps.
     * @param {string} label
     * @private
     */
    _handleWindowClose(label) {
        this._windows.delete(label);
        this._indexMap.delete(label);
    }
}
