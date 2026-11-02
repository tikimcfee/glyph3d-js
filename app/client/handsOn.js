/**
 * handsOn — is a hand device attached (a phone streaming hands, or the simulator)? The hand surfaces
 * that cost something every frame or tick run only while one is: the hand cloud's picture-in-picture
 * (HandCloud.renderPip — with no hand it would be an empty box) and the Hand panel's `calib.status`
 * poll (pollWhileHands).
 */

/** @typedef {import('@glyph3d/core/services/orchestration/SourceStream.js').default} SourceStream */

/** True while a hand device is attached. @param {SourceStream|null|undefined} stream */
export function handsOn(stream) {
    if (!stream) return false;
    for (const s of stream.sources.values()) if (s.kind === 'hand') return true;
    return false;
}

/**
 * Call `tick` every `ms` while a hand device is attached — and once now, and once whenever a device
 * attaches or detaches (so a board shows the change, then rests). With no stream, `tick` runs once.
 * @param {SourceStream|null|undefined} stream @param {() => void} tick @param {number} ms
 * @returns {() => void} stop
 */
export function pollWhileHands(stream, tick, ms) {
    if (!(ms > 0)) throw new Error(`pollWhileHands: ms must be > 0 (got ${ms})`);
    let timer = null, subscribed = false;
    const sync = () => {
        const on = handsOn(stream);
        if (on && !timer) timer = setInterval(tick, ms);
        else if (!on && timer) { clearInterval(timer); timer = null; }
        tick();
    };
    // onPresence replays the devices already attached as it subscribes; the one sync below covers them.
    const off = stream?.onPresence?.(() => { if (subscribed) sync(); });
    subscribed = true;
    sync();
    return () => {
        off?.();
        if (timer) clearInterval(timer);
        timer = null;
    };
}
