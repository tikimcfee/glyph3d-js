/**
 * wallKeymap — the wall's chords and gestures, as data: WallKeys dispatches the chords from KEYMAP,
 * and the help panel (HelpPanel.jsx) lists KEYMAP, PLAIN_KEYS and gestures(), so what the help says
 * is what the keys do. The chord's modifier is chord.js's (⌘ on macOS, Ctrl+Alt elsewhere).
 */
import { ALT_LABEL, SNAP_INVERT_LABEL, COPY_LABEL, BLOCK_SELECT_LABEL, FOCUS_HISTORY_LABEL, GROUP_CYCLE_LABEL, chordLabel, zoomWheelLabel } from './chord.js';

/**
 * One chord: the physical key (`code`, so layouts never rewrite it), whether Shift must be held
 * (true), must not be (false) or doesn't matter (absent), when it applies — while a terminal is
 * fullscreen, on the canvas otherwise, or always (absent) — the key as the help shows it, what it
 * does, and how: `run` null for a chord another part of the wall answers (the palette's, main.jsx).
 * @typedef {{ code: string, shift?: boolean, mode?: 'fullscreen'|'canvas', key: string, does: string,
 *             section: string, run: ((wall: any, e: KeyboardEvent) => void)|null }} WallChord
 */

/** @type {readonly WallChord[]} */
export const KEYMAP = Object.freeze([
    { section: 'terminals', code: 'BracketRight', shift: false, key: ']', does: 'focus the next pane (reading order)', run: (w) => w.cycleFocus(+1) },
    { section: 'terminals', code: 'BracketLeft', shift: false, key: '[', does: 'focus the previous pane (reading order)', run: (w) => w.cycleFocus(-1) },
    {
        section: 'fullscreen', code: 'Enter', shift: false, key: '↵', does: 'fullscreen the focused terminal (it re-wraps to fill the canvas); again: back to the canvas',
        run: (w) => { if (w.fullscreen.id || w.focusedId) w.run(['wall.fullscreen', 'toggle']); else w.fitAll(); },
    },
    { section: 'fullscreen', mode: 'fullscreen', code: 'Equal', key: '=', does: 'bigger text (re-wraps; remembered for this terminal)', run: (w) => w.run(['wall.fullscreen.text', 'bigger']) },
    { section: 'fullscreen', mode: 'fullscreen', code: 'Minus', key: '-', does: 'smaller text', run: (w) => w.run(['wall.fullscreen.text', 'smaller']) },
    { section: 'fullscreen', mode: 'fullscreen', code: 'Digit0', key: '0', does: "text back to the size it had on the canvas", run: (w) => w.run(['wall.fullscreen.text', 'reset']) },
    { section: 'terminals', code: 'Enter', shift: true, key: '↵', does: 'open a new terminal', run: (w) => w.spawn() },
    { section: 'terminals', mode: 'canvas', code: 'KeyA', key: 'A', does: 'toggle the focused terminal\'s Agent View (live transcript events)', run: (w) => { if (w.focusedId) w.run(['wall.agent', w.focusedId, 'toggle']); } },
    { section: 'terminals', mode: 'canvas', code: 'Minus', key: '-', does: 'hide the focused terminal (it keeps running)', run: (w) => { if (w.focusedId) w.run(['wall.hide', w.focusedId]); } },
    { section: 'terminals', code: 'KeyX', key: 'X', does: 'hold: close the focused terminal (ends it)', run: (w, e) => { if (!e.repeat && w.focusedId) w.barButtons.holdKey(w.focusedId); } },
    { section: 'terminals', code: 'KeyK', key: 'K', does: 'find a terminal by name, or run a verb', run: null },
    { section: 'splits', code: 'KeyD', shift: false, key: 'D', does: 'split the focused terminal: a new one to its right', run: (w) => w.run(['wall.split', 'right']) },
    { section: 'splits', code: 'KeyD', shift: true, key: 'D', does: 'split the focused terminal: a new one below it', run: (w) => w.run(['wall.split', 'down']) },
    { section: 'splits', code: 'ArrowLeft', key: '←', does: 'focus the pane (or window) to the left', run: (w) => w.run(['wall.pane', 'left']) },
    { section: 'splits', code: 'ArrowRight', key: '→', does: 'focus the pane (or window) to the right', run: (w) => w.run(['wall.pane', 'right']) },
    { section: 'splits', code: 'ArrowUp', key: '↑', does: 'focus the pane (or window) above', run: (w) => w.run(['wall.pane', 'up']) },
    { section: 'splits', code: 'ArrowDown', key: '↓', does: 'focus the pane (or window) below', run: (w) => w.run(['wall.pane', 'down']) },
    { section: 'groups', code: 'KeyG', shift: false, key: 'G', does: 'group the selection (or the focused terminal)', run: (w) => w.run(w.selection.size || !w.focusedId ? ['wall.group'] : ['wall.group', w.focusedId]) },
    {
        section: 'groups', code: 'KeyG', shift: true, key: 'G', does: "ungroup the focused terminal's group",
        run: (w) => { const gid = w.focusedId && w.groups.groupOf(w.focusedId); if (gid) w.run(['wall.ungroup', gid]); },
    },
    { section: 'canvas', mode: 'canvas', code: 'Digit0', key: '0', does: 'fit every terminal in view', run: (w) => w.fitAll() },
    { section: 'canvas', code: 'Quote', shift: false, key: "'", does: 'snap moves and resizes to the grid, or not', run: (w) => w.run(['wall.snap', 'toggle']) },
    { section: 'canvas', code: 'Quote', shift: true, key: "'", does: 'show or hide the drafting grid', run: (w) => w.run(['wall.grid', 'toggle']) },
    { section: 'panels', code: 'KeyB', key: 'B', does: 'the sidebar: every terminal and group', run: (w) => w.run(['wall.sidebar', 'toggle']) },
    { section: 'panels', code: 'KeyS', key: 'S', does: "termd's status window", run: (w) => w.run(['wall.status', 'toggle']) },
    { section: 'panels', code: 'Comma', key: ',', does: 'settings: every knob, searchable', run: (w) => w.run(['wall.settings', 'toggle']) },
    { section: 'panels', code: 'Slash', key: '/', does: 'this help', run: (w) => w.run(['wall.help', 'toggle']) },
]);

/**
 * The chord a key event names in this mode, if any (the caller has checked it carries the chord).
 * @param {{ code: string, shiftKey: boolean }} e
 * @param {'fullscreen'|'canvas'} mode - whether a terminal is fullscreen
 * @returns {WallChord|null}
 */
export function chordFor(e, mode) {
    for (const c of KEYMAP) {
        if (c.code === e.code && (c.shift === undefined || c.shift === e.shiftKey) && (c.mode === undefined || c.mode === mode)) return c;
    }
    return null;
}

/** A chord as the help shows it. @param {WallChord} c */
export function chordText(c) { return chordLabel([c.key], { shift: !!c.shift }); }

/** Keys without the chord that the wall answers (WallKeys). */
export const PLAIN_KEYS = Object.freeze([
    { section: 'text', key: COPY_LABEL, does: "copy the focused terminal's selected text (Ctrl+C still reaches the program)" },
    { section: 'terminals', key: FOCUS_HISTORY_LABEL, does: 'back / forward through focused terminals' },
    { section: 'groups', key: GROUP_CYCLE_LABEL, does: 'focus the previous / next group or window' },
    { section: 'terminals', key: 'Esc', does: 'clear the selection (when no terminal has the keys)' },
    { section: 'terminals', key: 'Menu · ⇧F10', does: 'open the right-click menu from the keyboard' },
]);

/**
 * The pointer's gestures (WallPointer, WallMenu), named for this platform and the zoom keys set.
 * @param {{ zoomKeys: string }} config
 * @returns {{ section: string, how: string, does: string }[]}
 */
export function gestures(config) {
    return [
        { section: 'terminals', how: 'click', does: 'give a terminal the keys' },
        { section: 'text', how: 'drag a terminal\'s body', does: 'select its text (twice: a word, three times: a line)' },
        { section: 'text', how: `${BLOCK_SELECT_LABEL}+drag`, does: 'select a block of columns' },
        { section: 'text', how: '⇧-drag', does: 'select text over a program that hears the mouse' },
        { section: 'text', how: 'middle-click', does: "paste the wall's selection clipboard into a terminal" },
        { section: 'terminals', how: 'drag a title bar', does: `move a terminal (or ${ALT_LABEL}-drag anywhere on it)` },
        { section: 'terminals', how: 'drag a border', does: 'resize a terminal' },
        { section: 'terminals', how: 'drag an agent view\'s header', does: 'move it to right, left, top or bottom of its terminal' },
        { section: 'terminals', how: 'right-click', does: 'the menu for a terminal, a group or the canvas' },
        { section: 'groups', how: '⇧-drag empty canvas', does: 'lasso terminals into the selection (⇧-click toggles one)' },
        { section: 'groups', how: 'drag a group header', does: 'move every member' },
        { section: 'splits', how: 'drag the gap between panes', does: 'move the cut; both sides re-wrap' },
        { section: 'splits', how: "drag a split's outer border", does: 'resize the whole split; every pane re-wraps' },
        { section: 'splits', how: "drag a pane's title bar", does: 'move the whole split' },
        { section: 'canvas', how: 'drag empty canvas · wheel', does: 'pan (a wheel over the focused terminal scrolls its history)' },
        { section: 'canvas', how: `${zoomWheelLabel(config.zoomKeys)}+wheel · pinch`, does: 'zoom about the pointer' },
        { section: 'canvas', how: `hold ${SNAP_INVERT_LABEL} mid-drag`, does: 'move or resize free of the grid (or onto it, with snap off)' },
    ];
}

/** The help's sections, in order. */
export const HELP_SECTIONS = Object.freeze([
    { id: 'terminals', title: 'Terminals' },
    { id: 'fullscreen', title: 'Fullscreen' },
    { id: 'text', title: 'Text' },
    { id: 'splits', title: 'Splits' },
    { id: 'groups', title: 'Groups' },
    { id: 'canvas', title: 'Canvas' },
    { id: 'panels', title: 'Panels' },
]);
