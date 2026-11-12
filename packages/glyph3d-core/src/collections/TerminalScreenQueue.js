/**
 * TerminalScreenQueue — the terminals of one scene whose screens changed since the last frame,
 * applied once per frame BEFORE that frame's render.
 *
 * A terminal's bytes are parsed off the frame (xterm parses asynchronously); the parse only marks
 * the screen dirty and queues its grid here. SceneSystems.update — which every app calls once a
 * frame, before it renders — flushes the queue first, so each changed terminal reads its screen
 * once and writes what changed, and the render that follows draws it: output parsed before a frame
 * is drawn BY that frame, however many writes it took. Pick passes and screenshots render the scene
 * outside update(), so they never apply a screen.
 *
 * One queue per scene (SceneSystems owns it); a grid finds its scene's with `TerminalScreenQueue.of`.
 */

/** @type {WeakMap<import('three').Scene, TerminalScreenQueue>} */
const _queues = new WeakMap();

/**
 * What the queue applies: anything with applyPendingScreen() (TerminalGrid).
 * @typedef {{ applyPendingScreen(): void, terminalId?: string|null }} PendingScreen
 */

export default class TerminalScreenQueue {
    /**
     * The queue that applies `scene`'s terminal screens, or null when no SceneSystems runs it.
     * @param {import('three').Scene} scene
     * @returns {TerminalScreenQueue|null}
     */
    static of(scene) {
        return (scene && _queues.get(scene)) || null;
    }

    /** @param {import('three').Scene} scene */
    constructor(scene) {
        if (!scene?.isScene) throw new Error(`[TerminalScreenQueue] needs a THREE.Scene, got ${scene?.type ?? scene}`);
        if (_queues.has(scene)) throw new Error('[TerminalScreenQueue] this scene already has one (one SceneSystems per scene)');
        this.scene = scene;
        /** @type {Set<PendingScreen>} */
        this._pending = new Set();
        _queues.set(scene, this);
    }

    /** Queue a terminal whose screen changed. @param {PendingScreen} grid */
    add(grid) {
        this._pending.add(grid);
    }

    /** Drop a terminal (it is being disposed). @param {PendingScreen} grid */
    delete(grid) {
        this._pending.delete(grid);
    }

    /** How many terminals wait for the next flush. */
    get size() {
        return this._pending.size;
    }

    /**
     * Apply every queued terminal's screen, then empty the queue. One terminal throwing doesn't
     * stop the others (or the frame): it is reported with its id.
     * @returns {number} terminals applied
     */
    flush() {
        const pending = this._pending;
        if (pending.size === 0) return 0;
        let n = 0;
        for (const grid of pending) {
            try { grid.applyPendingScreen(); n++; } catch (e) {
                console.error(`[TerminalScreenQueue] terminal ${grid.terminalId ?? '?'} failed to apply its screen (the others still did):`, e);
            }
        }
        pending.clear();
        return n;
    }

    dispose() {
        this._pending.clear();
        if (_queues.get(this.scene) === this) _queues.delete(this.scene);
    }
}
