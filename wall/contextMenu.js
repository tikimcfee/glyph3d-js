/**
 * contextMenu — the wall's right-click menu, decided here with no DOM: who a contextmenu event
 * belongs to (contextPolicy), what the menu lists for what's under the pointer (menuItems), and
 * where it sits on screen (placeMenu). WallMenu routes the events through these, the wall holds
 * the open menu (TerminalWall.menu, opened and closed by `wall.menu`), and ContextMenu.jsx draws
 * it. Every item runs a wall verb: the menu holds no behaviour of its own.
 *
 * The event policy — a good citizen: the browser's and the OS's own menu is never taken away.
 *
 *   right-click on …                              goes to
 *   a text input, an editable field, the DOM      the browser's menu (copy / paste in a rename box)
 *     chrome (sidebar, palette, status window)
 *   anything, while OUR menu is open              the browser's menu, and ours closes (YouTube's
 *                                                 pattern: right-click twice for the native menu)
 *   anything, with Shift                          the browser's menu (Firefox's rule, kept everywhere)
 *   the FOCUSED terminal's body, its program      the program; with Shift, our menu (Ghostty's rule:
 *     having turned mouse reporting on              Shift bypasses mouse capture). Only the terminal
 *     (DECSET 9/1000/1002/1003)                     the keys go to (TerminalWall.focusedId) hands its
 *                                                   clicks to its program: a merely hovered one's
 *                                                   right-click is the wall's
 *   a terminal, a group's header, empty canvas    our menu
 *
 * The keyboard way in (the ContextMenu key, Shift+F10) opens ours on the focused terminal; the
 * contextmenu event that key also raises is ours (WallMenu marks it), whatever its Shift.
 */

import { COPY_LABEL, PASTE_LABEL, chordLabel } from './chord.js';
import { AGENT_SIDES } from './wallAgentView.js';

/** @typedef {'ours'|'native'|'program'} Verdict */

/**
 * What's under the pointer, as the menu reads it.
 * @typedef {{ kind: 'terminal', id: string, part: 'body'|'title'|'edge' }
 *         | { kind: 'group', id: string }
 *         | { kind: 'canvas' }} MenuTarget
 */

/**
 * Who a contextmenu event belongs to. `editable`: its target is a text input, a textarea, a select
 * or contenteditable. `chrome`: its target is DOM chrome, not the wall's surface (the canvas, a
 * title bar's buttons, a map label). `keyboard`: raised by the menu key (or Shift+F10) the wall
 * already answered. `target`: what's under the pointer (null off the wall's surface).
 * `mouseReporting`: the target terminal's program asked for mouse reports. `focused`: the target
 * terminal is the focused one (the keys go to it).
 * @param {{ shiftKey: boolean, editable: boolean, chrome: boolean, menuOpen: boolean, keyboard: boolean,
 *   target: MenuTarget|null, mouseReporting: boolean, focused: boolean }} e
 * @returns {{ verdict: Verdict, why: string }}
 */
export function contextPolicy(e) {
    if (e.keyboard) return { verdict: 'ours', why: 'the menu key opened ours' };
    if (e.editable) return { verdict: 'native', why: 'a text field keeps its own menu' };
    if (e.menuOpen) return { verdict: 'native', why: 'right-click again: the browser menu' };
    if (e.chrome || !e.target) return { verdict: 'native', why: 'DOM chrome keeps its own menu' };
    const reported = e.target.kind === 'terminal' && e.target.part === 'body' && e.mouseReporting && e.focused;
    if (reported) return e.shiftKey ? { verdict: 'ours', why: 'Shift bypasses the program\'s mouse capture' } : { verdict: 'program', why: 'the program reports the mouse' };
    if (e.shiftKey) return { verdict: 'native', why: 'Shift+right-click is the browser menu' };
    return { verdict: 'ours', why: `over ${e.target.kind}` };
}

/**
 * A press that is the secondary click: the right button, or Ctrl+click on macOS (which the OS turns
 * into a contextmenu). Such a press never closes an open menu — the contextmenu that follows does
 * (it is the "again" in right-click again).
 * @param {{ button: number, ctrlKey: boolean }} e @param {boolean} isMac
 */
export function isSecondaryPress(e, isMac) {
    return e.button === 2 || (isMac && e.button === 0 && e.ctrlKey);
}

/** The most columns or rows a terminal can have: termd's wire carries a size as u16 (g3d-wire msg.rs). */
export const MAX_CELLS = 65535;

/**
 * Check a custom size as typed: two whole numbers from 1 to MAX_CELLS. Throws a short reason (shown
 * under the menu's size row) for anything else.
 * @param {string} cols @param {string} rows @returns {{ cols: number, rows: number }}
 */
export function checkSize(cols, rows) {
    const one = (s, what) => {
        const t = String(s).trim();
        if (!t) throw new Error(`${what}: a whole number, please`);
        if (!/^\d+$/.test(t)) throw new Error(`${what}: '${t}' isn't a whole number`);
        const n = Number(t);
        if (n < 1) throw new Error(`${what}: at least 1`);
        if (n > MAX_CELLS) throw new Error(`${what}: at most ${MAX_CELLS} (termd's limit)`);
        return n;
    };
    return { cols: one(cols, 'cols'), rows: one(rows, 'rows') };
}

/** What `wall.config optionAsAlt` takes, in the order the menu offers them. */
const OPTION_AS_ALT = [['auto', 'auto'], ['true', 'on'], ['false', 'off']];

/**
 * Parse the `menuSizes` knob: sizes as `COLSxROWS`, space-separated.
 * @param {string} s @returns {{ cols: number, rows: number }[]}
 */
export function parseSizes(s) {
    const out = [];
    for (const tok of String(s).trim().split(/\s+/).filter(Boolean)) {
        const m = /^(\d+)[x×](\d+)$/.exec(tok);
        if (!m || +m[1] < 1 || +m[2] < 1) throw new Error(`sizes are COLSxROWS, space-separated (like "80x24 120x36"), not '${tok}'`);
        out.push({ cols: +m[1], rows: +m[2] });
    }
    return out;
}

/**
 * One row of the menu.
 *   action   runs `verb`
 *   hold     runs `verb` only when held for closeHoldMs (the ring fills; let go early and nothing happens)
 *   rename   becomes a text box; Enter runs `verb` + the text (empty gives back the default name)
 *   choice   a row of options, each with its own verb; `on` marks the current one. An option marked
 *            `custom` has no verb: choosing it turns the row into the fields its `edit` names
 *            (the size row's cols × rows), and Enter runs `edit.verb` + what was typed
 *   sep      a quiet rule between sections
 * @typedef {{ kind: 'action', id: string, label: string, verb: string[], detail?: string }
 *         | { kind: 'hold', id: string, label: string, verb: string[], detail?: string }
 *         | { kind: 'rename', id: string, label: string, verb: string[], value: string, placeholder: string }
 *         | { kind: 'choice', id: string, label: string, detail?: string, options: { id: string, label: string, verb?: string[], on?: boolean, custom?: boolean }[],
 *             edit?: { verb: string[], cols: number, rows: number } }
 *         | { kind: 'sep', id: string }} MenuItem
 */

/**
 * The menu for a target, from the wall's snapshot: a terminal's (copy — with text selected in it —,
 * paste, frame, focus, rename, selection,
 * group, split right / down, size — not for a split's pane, whose split owns it —, redraw, Option as
 * Alt, hide, hold-to-close), a group header's (frame, rename, layout, columns, a split's title bars,
 * select its members, hide them all, ungroup) or the canvas's (a new terminal at
 * the point, fit all, select all, snap and the grid on or off, the sidebar, the status window, the
 * settings). Empty when the target is gone.
 * @param {MenuTarget & { world?: { x: number, y: number } }} target
 * @param {ReturnType<import('./TerminalWall.js').default['snapshot']>} state
 * @param {{ optionAsAlt: string, menuSizes: string }} config
 * @returns {MenuItem[]}
 */
export function menuItems(target, state, config) {
    if (target.kind === 'terminal') return terminalItems(target.id, state, config);
    if (target.kind === 'group') return groupItems(target.id, state);
    return canvasItems(target.world ?? { x: 0, y: 0 }, state);
}

const q = (s) => `“${s}”`;

function terminalItems(id, state, config) {
    const t = state.terminals.find((x) => x.id === id);
    if (!t || t.hidden) return [];
    const g = t.group ? state.groups.find((x) => x.id === t.group) : null;
    const selected = state.selection.includes(id);
    const others = state.selection.filter((x) => x !== id);
    const agentSide = t.agentView?.open ? t.agentView.side : 'off';
    /** @type {MenuItem[]} */
    const items = [
        t.selected && { kind: 'action', id: 'copy', label: 'copy', detail: COPY_LABEL, verb: ['wall.copy', id] },
        { kind: 'action', id: 'paste', label: 'paste', detail: PASTE_LABEL, verb: ['wall.paste', id] },
        { kind: 'sep', id: 's0' },
        { kind: 'action', id: 'frame', label: 'frame', verb: ['wall.reveal', id] },
        state.focusedId !== id && { kind: 'action', id: 'focus', label: 'focus', verb: ['terminal.focus', id] },
        { kind: 'rename', id: 'rename', label: 'rename…', verb: ['wall.rename', id], value: t.named ? t.name : '', placeholder: t.name },
        {
            kind: 'choice', id: 'agent-view', label: 'agent view',
            options: [
                { id: 'off', label: 'off', verb: ['wall.agent', id, 'close'], on: agentSide === 'off' },
                ...AGENT_SIDES.map((s) => ({ id: s, label: s, verb: ['wall.agent.side', id, s], on: agentSide === s })),
            ],
        },
        { kind: 'sep', id: 's1' },
        { kind: 'action', id: 'select', label: selected ? 'take out of the selection' : 'add to the selection', verb: ['wall.select.toggle', id] },
        g && { kind: 'action', id: 'leave', label: `take out of ${q(g.name)}`, verb: ['wall.group.remove', id] },
        !g && (others.length
            ? { kind: 'action', id: 'group', label: `group with the selection (${others.length + 1})`, verb: ['wall.group', ...new Set([...others, id])] }
            : { kind: 'action', id: 'group', label: 'new group', verb: ['wall.group', id] }),
        !g && state.groups.length > 0 && {
            kind: 'choice', id: 'add-to', label: 'add to',
            options: state.groups.map((x) => ({ id: x.id, label: x.name, verb: ['wall.group.add', x.id, id] })),
        },
        { kind: 'sep', id: 's2' },
        { kind: 'action', id: 'split-right', label: 'split right', detail: chordLabel(['D']), verb: ['wall.split', 'right', id] },
        { kind: 'action', id: 'split-down', label: 'split down', detail: chordLabel(['D'], { shift: true }), verb: ['wall.split', 'down', id] },
    ];
    if (g?.layout === 'split') { items.push(...tail(id, config)); return items.filter(Boolean); }
    const sizes = parseSizes(config.menuSizes).map((z) => ({
        id: `${z.cols}x${z.rows}`, label: `${z.cols}×${z.rows}`, verb: ['terminal.resize', id, String(z.cols), String(z.rows)], on: z.cols === t.cols && z.rows === t.rows,
    }));
    // The offers, then any size at all: `custom…` opens cols × rows fields on the terminal's own size.
    items.push({
        kind: 'choice', id: 'size', label: 'size',
        options: [...sizes, { id: 'custom', label: 'custom…', custom: true }],
        edit: { verb: ['terminal.resize', id], cols: t.cols, rows: t.rows },
        ...(sizes.some((o) => o.on) ? {} : { detail: `${t.cols}×${t.rows}` }),   // its own size, when no offer is it
    });
    items.push(...tail(id, config));
    return items.filter(Boolean);
}

/** A terminal menu's last items: redraw, Option as Alt, hide, close. */
function tail(id, config) {
    return [
        { kind: 'action', id: 'redraw', label: 'redraw', verb: ['terminal.refresh', id] },
        {
            kind: 'choice', id: 'option-as-alt', label: 'Option as Alt', detail: 'every terminal',
            options: OPTION_AS_ALT.map(([v, label]) => ({ id: v, label, verb: ['wall.config', 'optionAsAlt', v], on: String(config.optionAsAlt) === v })),
        },
        { kind: 'sep', id: 's3' },
        { kind: 'action', id: 'hide', label: 'hide', detail: 'keeps running', verb: ['wall.hide', id] },
        { kind: 'hold', id: 'close', label: 'close', detail: 'hold · kills the shell', verb: ['wall.close', id] },
    ];
}

function groupItems(gid, state) {
    const g = state.groups.find((x) => x.id === gid);
    if (!g) return [];
    const shown = g.members.filter((id) => state.terminals.find((t) => t.id === id && !t.hidden));
    const tile = g.layout === 'tile', split = g.layout === 'split';
    /** @type {MenuItem[]} */
    const items = [
        { kind: 'action', id: 'frame', label: 'frame', verb: ['wall.group.frame', gid] },
        { kind: 'rename', id: 'rename', label: 'rename…', verb: ['wall.group.rename', gid], value: g.named ? g.name : '', placeholder: g.name },
        { kind: 'sep', id: 's1' },
        {
            kind: 'choice', id: 'layout', label: 'layout',
            options: [
                { id: 'tile', label: 'tile', verb: ['wall.group.layout', gid, 'tile'], on: tile },
                { id: 'freeform', label: 'freeform', verb: ['wall.group.layout', gid, 'freeform'], on: g.layout === 'freeform' },
                { id: 'split', label: 'split', verb: ['wall.group.layout', gid, 'split'], on: split },
            ],
        },
        split && {
            kind: 'choice', id: 'bars', label: 'title bars',
            options: [
                { id: 'on', label: 'shown', verb: ['wall.group.bars', gid, 'on'], on: !!g.bars },
                { id: 'off', label: 'hidden', verb: ['wall.group.bars', gid, 'off'], on: !g.bars },
            ],
        },
        tile && {
            kind: 'choice', id: 'columns', label: 'columns', detail: String(g.columns),
            options: [
                { id: 'fewer', label: '−', verb: ['wall.group.columns', gid, '-1'] },
                { id: 'more', label: '+', verb: ['wall.group.columns', gid, '+1'] },
            ],
        },
        { kind: 'sep', id: 's2' },
        shown.length > 0 && { kind: 'action', id: 'select', label: 'select its terminals', verb: ['wall.select', ...shown] },
        shown.length > 0 && { kind: 'action', id: 'hide-all', label: 'hide all', detail: 'they keep running', verb: ['wall.hide', ...shown] },
        { kind: 'action', id: 'ungroup', label: 'ungroup', detail: 'members stay put', verb: ['wall.ungroup', gid] },
    ];
    return items.filter(Boolean);
}

function canvasItems(world, state) {
    const any = state.terminals.some((t) => !t.hidden);
    /** @type {MenuItem[]} */
    const items = [
        { kind: 'action', id: 'spawn', label: 'new terminal here', verb: ['wall.spawn', String(round(world.x)), String(round(world.y))] },
        any && { kind: 'action', id: 'fit', label: 'fit all', verb: ['wall.fit'] },
        any && { kind: 'action', id: 'select-all', label: 'select all', verb: ['wall.select', 'all'] },
        { kind: 'sep', id: 's1' },
        {
            kind: 'choice', id: 'snap', label: 'snap to grid',
            options: [
                { id: 'on', label: 'on', verb: ['wall.snap', 'on'], on: state.config.snap === true },
                { id: 'off', label: 'off', verb: ['wall.snap', 'off'], on: state.config.snap === false },
            ],
        },
        {
            kind: 'choice', id: 'grid', label: 'grid',
            options: [
                { id: 'show', label: 'show', verb: ['wall.grid', 'on'], on: state.config.gridShow === true },
                { id: 'hide', label: 'hide', verb: ['wall.grid', 'off'], on: state.config.gridShow === false },
            ],
        },
        { kind: 'sep', id: 's2' },
        { kind: 'action', id: 'sidebar', label: state.sidebar.open ? 'close the sidebar' : 'open the sidebar', verb: ['wall.sidebar', state.sidebar.open ? 'close' : 'open'] },
        { kind: 'action', id: 'status', label: state.statusWindow.open ? 'close the status window' : 'open the status window', verb: ['wall.status', state.statusWindow.open ? 'close' : 'open'] },
        { kind: 'action', id: 'settings', label: state.settingsPanel.open ? 'close the settings' : 'settings…', verb: ['wall.settings', state.settingsPanel.open ? 'close' : 'open'] },
    ];
    return items.filter(Boolean);
}

/** A world coordinate as a verb argument: to the hundredth (a point the person clicked, not a measure). */
const round = (v) => Math.round(v * 100) / 100;

/**
 * Where the menu sits: its top-left at the point, flipped to the point's other side where it would
 * cross the view's right or bottom edge, and — when neither side has the room — kept inside the view
 * (a menu taller or wider than the view sits at its top / left edge).
 * @param {{ x: number, y: number }} at - canvas-relative CSS px
 * @param {{ w: number, h: number }} size - the menu's box
 * @param {{ w: number, h: number }} view - the canvas's viewport (WallCamera.view)
 * @param {number} [margin] - kept clear of the view's edges, CSS px
 * @returns {{ x: number, y: number }}
 */
export function placeMenu(at, size, view, margin = 4) {
    const axis = (p, s, v) => {
        if (p + s <= v - margin) return p;           // fits after the point
        if (p - s >= margin) return p - s;             // flipped: fits before it
        return Math.max(margin, v - margin - s);       // neither: against the far edge, or the near one
    };
    return { x: axis(at.x, size.w, view.w), y: axis(at.y, size.h, view.h) };
}
