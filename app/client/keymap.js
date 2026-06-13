/**
 * keymap — the navigation binding table, as DATA: a chord maps to a command
 * line, nothing more. The dispatcher (resolveKeyBinding) turns a KeyboardEvent
 * into the bound verb-line; CanvasInteraction fires it through the bus. So a
 * key-nav is just another way to drive the same verbs the palette / CLI / canvas
 * use — every press lands as a `command`-scope trace in the log store.
 *
 * MODAL by phase, not by flag: the listener runs in the document BUBBLE phase,
 * and EntityKeystrokeRouter consumes edit/terminal keys in the CAPTURE phase
 * (stopImmediatePropagation). So these bindings only ever fire in NAV mode —
 * no grid in edit, no terminal holding the keyboard. That's vim's normal-vs-
 * insert split falling out of the existing plumbing, with no mode variable.
 *
 * The table is exported so a which-key / `?` overlay can render it 1:1 — the
 * bindings ARE the documentation. Add a row, the overlay grows; no second list.
 *
 * Keys the camera owns (W/A/S/D flight, Q/E, Space) are deliberately avoided.
 *
 * @typedef {{ key: string, command: string[], label: string }} Binding
 *   key     — KeyboardEvent.key to match (bare; no modifier in this layer yet)
 *   command — token array for router.execute (array form survives spaces)
 *   label   — human description, for the future which-key overlay
 */

/** @type {Binding[]} The nav layer: hjkl move focus between neighbor grids. */
export const NAV_BINDINGS = [
    { key: 'h', command: ['focus.neighbor', 'left'],  label: 'focus file left' },
    { key: 'j', command: ['focus.neighbor', 'down'],  label: 'focus file down' },
    { key: 'k', command: ['focus.neighbor', 'up'],    label: 'focus file up' },
    { key: 'l', command: ['focus.neighbor', 'right'], label: 'focus file right' },
];

/**
 * Resolve a KeyboardEvent to its bound command line, or null if unbound.
 * This layer matches a single bare key (no Ctrl/Alt/Meta) — modified chords and
 * prefix layers (the z-layer) land here next, as more data.
 * @param {KeyboardEvent} e
 * @param {Binding[]} [bindings]
 * @returns {string[]|null} the command token array, or null
 */
export function resolveKeyBinding(e, bindings = NAV_BINDINGS) {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    const b = bindings.find((b) => b.key === e.key);
    return b ? b.command : null;
}
