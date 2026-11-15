/**
 * inputTrace — with the `traceInput` knob on, every wheel, key and pointer press the wall's page
 * receives is logged as one `[input]` line. It listens on the window in the capture phase, so it
 * sees each event before anything acts on it, whatever element it lands on (named as `on=`). The
 * wall forwards its console to its relay, so the lines land in the relay's log store
 * (`./glyph3d-cli --port <relay> log.search '[input]'`): what a remote-desktop client, a trackpad or
 * a keyboard layout actually delivers, read from the other machine.
 */

/** @param {UIEvent & { ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean, getModifierState?: (k: string) => boolean }} e
 *  @returns {string} the modifiers held, as `ctrl+alt`, or `-` */
function mods(e) {
    const held = [];
    if (e.ctrlKey) held.push('ctrl');
    if (e.altKey) held.push('alt');
    if (e.shiftKey) held.push('shift');
    if (e.metaKey) held.push('meta');
    if (e.getModifierState?.('AltGraph')) held.push('altgr');
    return held.join('+') || '-';
}

/** @param {EventTarget|null} t @returns {string} the element an event landed on, as `tag.class` */
function on(t) {
    if (!(t instanceof Element)) return String(t?.constructor?.name ?? t);
    const cls = typeof t.className === 'string' && t.className.trim() ? '.' + t.className.trim().split(/\s+/)[0] : '';
    return t.tagName.toLowerCase() + cls;
}

/** @param {Event} e @returns {string} */
function line(e) {
    if (e.type === 'wheel') {
        const w = /** @type {WheelEvent} */ (e);
        // deltaMode is read after the deltas: Firefox reports lines only to a listener that reads the mode first.
        const dx = w.deltaX, dy = w.deltaY, dz = w.deltaZ;
        return `wheel dx=${dx} dy=${dy} dz=${dz} mode=${w.deltaMode} mods=${mods(w)} at=${w.clientX},${w.clientY}`;
    }
    if (e.type === 'pointerdown') {
        const p = /** @type {PointerEvent} */ (e);
        return `pointerdown ${p.pointerType} button=${p.button} mods=${mods(p)} at=${p.clientX},${p.clientY}`;
    }
    const k = /** @type {KeyboardEvent} */ (e);
    return `${k.type} key=${JSON.stringify(k.key)} code=${k.code} mods=${mods(k)}${k.repeat ? ' repeat' : ''}`;
}

const TYPES = ['wheel', 'keydown', 'keyup', 'pointerdown'];

/**
 * Listen for the wall's input trace. Each event is logged only while the knob is on.
 * @param {{ config: { traceInput: boolean } }} wall
 * @returns {() => void} removes the listeners
 */
export function installInputTrace(wall) {
    const trace = (e) => { if (wall.config.traceInput) console.debug(`[input] ${line(e)} on=${on(e.target)}`); };
    for (const type of TYPES) window.addEventListener(type, trace, { capture: true, passive: true });
    return () => { for (const type of TYPES) window.removeEventListener(type, trace, { capture: true }); };
}
