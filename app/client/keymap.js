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

/**
 * @type {Binding[]} The nav layer — all movement SCOPED to the current directory:
 *   h / j / k / l  — nearest sibling left / down / up / right (spatial direction,
 *                    but candidates are tree-siblings only, so it never crosses a
 *                    directory boundary — moves match the eye, stay in scope).
 *   i / o          — change scope: up to the parent directory / down into the first
 *                    child. Changing directory is ONLY this (or the palette).
 * Directories are first-class focus targets — i/o land focus on a directory itself.
 */
export const NAV_BINDINGS = [
    { key: 'h', command: ['focus.neighbor', 'left'],  label: 'sibling left' },
    { key: 'j', command: ['focus.neighbor', 'down'],  label: 'sibling down' },
    { key: 'k', command: ['focus.neighbor', 'up'],    label: 'sibling up' },
    { key: 'l', command: ['focus.neighbor', 'right'], label: 'sibling right' },
    { key: 'i', command: ['focus.parent'],            label: 'up to parent directory' },
    { key: 'o', command: ['focus.child'],             label: 'into first child' },
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
