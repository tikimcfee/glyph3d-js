/**
 * SourceStream
 *
 * The browser-side half of the relay's sensor plane: one object that knows which
 * capture devices are attached, what each one is streaming, and what its frames
 * mean. Devices connect to the relay with a `SOURCE <kind>` handshake; the relay
 * stamps provenance and forwards `{event:'source.frame', source, kind, data}` on
 * the display's existing socket.
 *
 * Three responsibilities, deliberately kept together because they're the same
 * question asked at different rates:
 *
 *   - **Presence** — which devices are attached right now (`source_connected` /
 *     `source_disconnected`, plus the replay of already-attached devices when a
 *     reloaded page re-registers).
 *   - **Decode** — turn an opaque payload into canonical HandFrames. The relay is
 *     schema-blind by design, so this is the first place a `handFrame` means
 *     anything. Decoding is delegated to pure functions in HandData.
 *   - **Liveness** — per-device frame counts and observed rate, so "is the phone
 *     actually sending?" is answerable without a packet capture. This is the
 *     question you always ask first when nothing renders.
 *
 * What it deliberately does NOT do: own a socket (the bridge does), interpret
 * gestures (that's the interaction layer), or render (that's HandRenderer). It
 * is the seam between "bytes arrived" and "a hand exists at these coordinates".
 *
 * Frames are read by pull, not push, on the render path: a device streams at its
 * own rate and the renderer samples the latest pose per frame. Pushing straight
 * into the scene graph would tie render work to network timing and do redundant
 * work whenever the device outruns the display.
 */

import { decodeHandFrame, decodeCameraFrame } from '../../hand/HandData.js';

/** Rate is averaged over this window — long enough to be steady, short enough to react. */
const RATE_WINDOW_MS = 2000;

/**
 * Publish a provisional rate once this much of the window has elapsed. Without it
 * a freshly attached device reads 0fps until its first full window closes — two
 * seconds of looking broken at precisely the moment someone is watching to see
 * whether it works.
 */
const RATE_MIN_SAMPLE_MS = 400;

/**
 * A device is considered stalled if nothing has arrived for this long. Generous
 * relative to 30fps: hand tracking legitimately goes quiet when no hand is in
 * frame, and that is not a fault.
 */
const STALL_TIMEOUT_MS = 2000;

/**
 * @typedef {Object} SourceState
 * @property {string} id - Relay-assigned id, e.g. 'src-hand-0'
 * @property {string} kind - Device class: 'hand', 'camera', …
 * @property {number} frames - Frames received since attach
 * @property {number} lastFrameAt - performance.now() of the most recent frame
 * @property {number} fps - Observed rate over the trailing window
 * @property {import('../../hand/HandData.js').HandFrame[]} hands - Latest decoded pose
 * @property {Object|null} scene - Last-known ARKit scene context
 * @property {Object|null} camera - Latest camera preview frame
 */

class SourceStream {
    /**
     * @param {Object} options
     * @param {Object} options.bridge - WebSocketBridge to subscribe to
     */
    constructor({ bridge } = {}) {
        if (!bridge) throw new Error('SourceStream requires a bridge');
        this.bridge = bridge;

        /** @type {Map<string, SourceState>} */
        this.sources = new Map();

        this._presenceListeners = new Set();
        this._frameListeners = new Set();

        this._unsubscribe = bridge.onSourceEvent((envelope) => this._handle(envelope));
    }

    // ── Presence ─────────────────────────────────────────────────────────────

    /**
     * Subscribe to device attach/detach.
     * @param {(event: 'attached'|'detached', state: SourceState) => void} fn
     * @returns {() => void} unsubscribe
     */
    onPresence(fn) {
        this._presenceListeners.add(fn);
        // Fire for devices already attached, so a late subscriber doesn't have to
        // special-case the "subscribed after the phone connected" race.
        for (const state of this.sources.values()) {
            try { fn('attached', state); } catch (e) { console.error('[source] presence listener threw:', e); }
        }
        return () => this._presenceListeners.delete(fn);
    }

    /**
     * Subscribe to decoded frames. Prefer `latestHands()` on the render path —
     * this exists for consumers that must see every frame (recording, gesture
     * detection with its own history).
     * @param {(state: SourceState) => void} fn
     * @returns {() => void} unsubscribe
     */
    onFrame(fn) {
        this._frameListeners.add(fn);
        return () => this._frameListeners.delete(fn);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /** @returns {SourceState[]} every attached device, id-sorted for stable display */
    list() {
        return [...this.sources.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    /** @returns {SourceState|null} */
    get(id) { return this.sources.get(id) || null; }

    /**
     * The latest hand pose to render. With no id, picks the most recently active
     * hand device — the common single-phone case shouldn't require naming it.
     * Returns an empty array rather than null so callers can iterate unguarded.
     * @param {string} [id]
     * @returns {import('../../hand/HandData.js').HandFrame[]}
     */
    latestHands(id = null) {
        if (id) return this.sources.get(id)?.hands || [];
        let best = null;
        for (const s of this.sources.values()) {
            if (s.kind !== 'hand') continue;
            if (!best || s.lastFrameAt > best.lastFrameAt) best = s;
        }
        return best?.hands || [];
    }

    /**
     * Last-known ARKit scene context (intrinsics, camera transform, viewport).
     * Non-consuming: it persists between frames because a device may send it once.
     * @param {string} [id]
     * @returns {Object|null}
     */
    latestScene(id = null) {
        if (id) return this.sources.get(id)?.scene || null;
        for (const s of this.list()) if (s.scene) return s.scene;
        return null;
    }

    /**
     * True if a device is attached but has gone quiet. Distinct from detached:
     * a stalled device is still connected, which is the interesting failure —
     * the socket is fine and the capture side isn't producing.
     * @param {string} id
     * @param {number} [now]
     */
    isStalled(id, now = performance.now()) {
        const s = this.sources.get(id);
        if (!s) return false;
        return s.frames > 0 && now - s.lastFrameAt > STALL_TIMEOUT_MS;
    }

    // ── Local sources ────────────────────────────────────────────────────────

    /**
     * Attach a source that produces frames in-process rather than over the relay —
     * a simulator, a webcam adapter. Downstream consumers can't tell the
     * difference, which is the point: it exercises decode, presence, and rendering
     * with the network removed, so a failure bisects to one side or the other.
     * @param {string} id
     * @param {string} [kind]
     */
    attachLocal(id, kind = 'hand') { this._attach(id, kind); }

    /** Detach a local source. @param {string} id */
    detachLocal(id) { this._detach(id); }

    /**
     * Feed one frame as if it had arrived from the relay.
     * @param {string} id - Must already be attached
     * @param {Object} payload - Device-shaped payload, e.g. a `handFrame`
     */
    injectFrame(id, payload) {
        const state = this.sources.get(id);
        this._frame({ source: id, kind: state?.kind || 'hand', data: payload });
    }

    // ── Ingest ───────────────────────────────────────────────────────────────

    /** @private */
    _handle(envelope) {
        switch (envelope.event) {
            case 'source_connected':
                this._attach(envelope.sourceId, envelope.kind);
                break;
            case 'source_disconnected':
                this._detach(envelope.sourceId);
                break;
            case 'source.frame':
                this._frame(envelope);
                break;
        }
    }

    /** @private */
    _attach(id, kind) {
        if (!id || this.sources.has(id)) return;
        const state = {
            id,
            kind: kind || 'hand',
            frames: 0,
            lastFrameAt: 0,
            fps: 0,
            hands: [],
            scene: null,
            camera: null,
            _windowStart: performance.now(),
            _windowCount: 0,
        };
        this.sources.set(id, state);
        console.log(`[source] attached ${id} (kind=${state.kind})`);
        this._emitPresence('attached', state);
    }

    /** @private */
    _detach(id) {
        const state = this.sources.get(id);
        if (!state) return;
        this.sources.delete(id);
        console.log(`[source] detached ${id} after ${state.frames} frames`);
        this._emitPresence('detached', state);
    }

    /** @private */
    _frame(envelope) {
        const id = envelope.source;
        if (!id) return;
        // A frame can beat its own source_connected only if the relay reordered
        // planes; attach defensively so the first frame is never dropped.
        if (!this.sources.has(id)) this._attach(id, envelope.kind);
        const state = this.sources.get(id);

        const now = performance.now();
        state.frames++;
        state.lastFrameAt = now;

        // Trailing-window rate. Reset rather than decay: a device that stops and
        // restarts should read its true current rate, not a blend with the past.
        state._windowCount++;
        const elapsed = now - state._windowStart;
        if (elapsed >= RATE_WINDOW_MS) {
            state.fps = (state._windowCount * 1000) / elapsed;
            state._windowStart = now;
            state._windowCount = 0;
        } else if (elapsed >= RATE_MIN_SAMPLE_MS && state._windowCount > 1) {
            // Provisional reading from a partial window — refines as the window
            // fills, rather than reporting nothing until it closes.
            state.fps = (state._windowCount * 1000) / elapsed;
        }

        const payload = envelope.data;
        const hand = decodeHandFrame(payload, state.scene);
        if (hand) {
            state.hands = hand.frames;
            state.scene = hand.scene;
        } else {
            const cam = decodeCameraFrame(payload);
            if (cam) state.camera = cam;
        }

        for (const fn of this._frameListeners) {
            try { fn(state); } catch (e) { console.error('[source] frame listener threw:', e); }
        }
    }

    /** @private */
    _emitPresence(event, state) {
        for (const fn of this._presenceListeners) {
            try { fn(event, state); } catch (e) { console.error('[source] presence listener threw:', e); }
        }
    }

    dispose() {
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        this.sources.clear();
        this._presenceListeners.clear();
        this._frameListeners.clear();
    }
}

export default SourceStream;
