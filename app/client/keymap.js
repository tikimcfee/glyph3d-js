/**
 * keymap — the navigation binding table, as DATA: a chord maps to a command
 * line, nothing more. The dispatcher (resolveKeyBinding) turns a KeyboardEvent
 * into the bound verb-line; CanvasInteraction fires it through the bus. So a
 * key-nav is just another way to drive the same verbs the palette / CLI / canvas
 * use — every press lands as a `command`-scope trace in the log store.
 *
 * MODAL by tier, not by flag: this nav layer is a TIER in the keyboard responder
 * chain (keyboardRouter.js), below the entity-typing tier. Entity typing claims the
 * key first whenever a grid is in edit or a terminal holds the keyboard, so these
 * bindings only ever fire in NAV mode. That's vim's normal-vs-insert split falling
 * out of the chain order, with no mode variable.
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
 *   u / i          — change scope: OUT to the parent directory / IN to the first
 *                    child. They sit directly above j/k, so out/in reads straight up
 *                    from the vertical sibling keys. Changing directory is ONLY this
 *                    (or the palette).
 * Directories are first-class focus targets — u/i land focus on a directory itself.
 */
export const NAV_BINDINGS = [
    { key: 'h', command: ['focus.neighbor', 'left'],  label: 'sibling left' },
    { key: 'j', command: ['focus.neighbor', 'down'],  label: 'sibling down' },
    { key: 'k', command: ['focus.neighbor', 'up'],    label: 'sibling up' },
    { key: 'l', command: ['focus.neighbor', 'right'], label: 'sibling right' },
    { key: 'u', command: ['focus.parent'],            label: 'out to parent directory' },
    { key: 'i', command: ['focus.child'],             label: 'into child directory' },
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
