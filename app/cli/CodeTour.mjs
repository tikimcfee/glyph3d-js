/**
 * CodeTour -- fluent API for building and playing camera tours via WebSocket.
 *
 * Usage:
 *   import CodeTour from './CodeTour.mjs';
 *   const tour = new CodeTour(conn, 'worker-pipeline');
 *   tour.addStop(111, 'WorkerBridge manages the pool', 4000);
 *   tour.addStop(113, 'Builders convert text to buffers');
 *   tour.addStop(72,  'GlyphAtlas provides the font texture');
 *   await tour.play();
 *
 * Requires a connected CliConnection instance.
 */

export default class CodeTour {
    /**
     * @param {import('./CliConnection.mjs').default} conn - connected CliConnection
     * @param {string} name - human-readable tour name
     */
    constructor(conn, name) {
        this.conn = conn;
        this.name = name;
        this._stops = [];
        this._created = false;
    }

    /**
     * Add a stop to the tour.
     * @param {number} gridIndex - index of the grid to focus on
     * @param {string} [annotation] - text annotation to display at the stop
     * @param {number} [durationMs=3000] - time in ms to hold at this stop
     * @returns {this} for chaining
     */
    addStop(gridIndex, annotation = null, durationMs = 3000) {
        this._stops.push({ gridIndex, annotation, durationMs });
        return this;
    }

    /**
     * Create the tour on the viewer, add all stops, and play it.
     * @param {Object} [options]
     * @param {number} [options.timeout=60000] - total timeout for tour playback
     * @returns {Promise<{text: string, data: any}>} result of tour.play
     */
    async play(options = {}) {
        const timeout = options.timeout || 60000;
        const nameB64 = Buffer.from(this.name).toString('base64');

        // 1. Create the tour
        const createResult = await this.conn.send(`tour.create ${nameB64}`);
        if (createResult.text.startsWith('ERR:')) {
            throw new Error(`Failed to create tour: ${createResult.text}`);
        }
        this._created = true;

        // 2. Add each stop
        for (const stop of this._stops) {
            const annotB64 = stop.annotation
                ? Buffer.from(stop.annotation).toString('base64')
                : '-';
            const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${annotB64} ${stop.durationMs}`;
            const result = await this.conn.send(cmd);
            if (result.text.startsWith('ERR:')) {
                throw new Error(`Failed to add stop: ${result.text}`);
            }
        }

        // 3. Play (this blocks until the tour completes on the viewer side)
        const totalDuration = this._stops.reduce((sum, s) => sum + s.durationMs, 0);
        const playTimeout = Math.max(timeout, totalDuration + 10000);

        const playResult = await this.conn.send(`tour.play ${nameB64}`, playTimeout);
        return playResult;
    }

    /**
     * Create the tour and add stops without playing.
     * Useful for building a tour that will be played later via tour.play command.
     * @returns {Promise<void>}
     */
    async build() {
        const nameB64 = Buffer.from(this.name).toString('base64');

        const createResult = await this.conn.send(`tour.create ${nameB64}`);
        if (createResult.text.startsWith('ERR:')) {
            throw new Error(`Failed to create tour: ${createResult.text}`);
        }
        this._created = true;

        for (const stop of this._stops) {
            const annotB64 = stop.annotation
                ? Buffer.from(stop.annotation).toString('base64')
                : '-';
            const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${annotB64} ${stop.durationMs}`;
            const result = await this.conn.send(cmd);
            if (result.text.startsWith('ERR:')) {
                throw new Error(`Failed to add stop: ${result.text}`);
            }
        }
    }

    /**
     * Clear all tours from the viewer.
     * Note: tour.clear removes ALL tours, not just this one.
     * @returns {Promise<{text: string, data: any}>}
     */
    async clear() {
        return this.conn.send('tour.clear');
    }

    /**
     * Frame specific grids without a full tour (convenience static method).
     * @param {import('./CliConnection.mjs').default} conn
     * @param {number[]} indices - grid indices to frame together
     * @param {number} [padding=2] - padding in world units
     * @returns {Promise<{text: string, data: any}>}
     */
    static async frame(conn, indices, padding = 2) {
        const cmd = `camera.frame ${indices.join(' ')} --padding ${padding}`;
        return conn.send(cmd);
    }

    /**
     * Frame an arbitrary bounding box (convenience static method).
     * @param {import('./CliConnection.mjs').default} conn
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} [padding=2]
     * @returns {Promise<{text: string, data: any}>}
     */
    static async frameBounds(conn, minX, minY, maxX, maxY, padding = 2) {
        const cmd = `camera.frame.bounds ${minX} ${minY} ${maxX} ${maxY} --padding ${padding}`;
        return conn.send(cmd);
    }
}
