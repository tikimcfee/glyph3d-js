/**
 * WallMouse — the pointer for a program that hears the mouse. The FOCUSED terminal's program, once
 * it turned mouse reporting on (DECSET 9 / 1000 / 1002 / 1003: `TerminalGrid.mouseTracking`), gets
 * the presses, releases and moves on its body, as a terminal gives them; termd encodes each in the
 * program's live modes (`TerminalGrid.sendMouse` → `terminal.mouse` → the adapter → termd `mouse`)
 * and drops what they don't report. WallPointer asks here first.
 *
 *   what                               goes to the program when
 *   a press (left, middle, right,      on the focused terminal's body, its program reporting, with
 *     back, forward)                   neither Shift (the wall's: lasso, ⇧-click, later selection —
 *                                      Ghostty's `mouse-shift-capture` default) nor, for the left
 *                                      button, Alt (the wall's ⌥-drag move) held
 *   the gesture that press starts      every press and release of another button while it lasts,
 *                                      a move with a button held (button-event / any-event
 *                                      tracking), once per cell — off the terminal too, clamped to
 *                                      its edge, until the last button is let go; the release
 *   a move with no button              any-event tracking (1003), over the focused body, once per cell
 *
 * An unfocused terminal's press focuses it and nothing more: a program gets the mouse only once its
 * terminal has the keys. The title bar, the border and its grip stay the wall's. The wheel is
 * WallPointer's (`terminal.scroll`, with the pointer's cell: an alternate-screen program gets it as
 * wheel reports or cursor keys). A right-click the program gets is prevented as a menu by WallMenu
 * (contextMenu.js's `program` verdict, the same rule as here).
 */

/** DOM `button` → the program's button: 0 left, 1 middle, 2 right, 3 back (X11's 8), 4 forward (9). */
const BUTTONS = /** @type {const} */ (['left', 'middle', 'right', 8, 9]);
/** DOM `buttons` bit for each DOM `button` (left 1, right 2, middle 4, back 8, forward 16). */
const BITS = [1, 4, 2, 8, 16];

/**
 * The program's name for a DOM button, or null for one it has none for.
 * @param {number} b - MouseEvent.button
 */
export function buttonOf(b) { return BUTTONS[b] ?? null; }

/**
 * The modifiers held, as W3C names (termd's `mouse` mods).
 * @param {{ shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean }} e
 * @returns {string[]}
 */
export function modsOf(e) {
    const m = [];
    if (e.shiftKey) m.push('Shift');
    if (e.ctrlKey) m.push('Control');
    if (e.altKey) m.push('Alt');
    if (e.metaKey) m.push('Meta');
    return m;
}

/**
 * Whether a press goes to the program: on the focused terminal's body, its program reporting, no
 * Shift (the wall's), no Alt on the left button (the wall's ⌥-drag move).
 * @param {{ button: number, shiftKey: boolean, altKey: boolean }} e
 * @param {{ part: string, focused: boolean, tracking: string }} at
 */
export function programGets(e, at) {
    return at.part === 'body' && at.focused && at.tracking !== 'none' && buttonOf(e.button) !== null
        && !e.shiftKey && !(e.altKey && e.button === 0);
}

/**
 * The button a move reports while `held` (a DOM `buttons` mask): left, else middle, else right, else
 * back, else forward — xterm's order; 'none' with none held.
 * @param {number} held
 */
export function heldButton(held) {
    for (const b of [0, 1, 2, 3, 4]) if (held & BITS[b]) return BUTTONS[b];
    return 'none';
}

export default class WallMouse {
    /**
     * @param {import('./TerminalWall.js').default} wall
     * @param {import('./WallCamera.js').default} camera
     */
    constructor(wall, camera) {
        this.wall = wall;
        this.camera = camera;
        /** The gesture in hand: its terminal, the DOM buttons it holds, the cell last reported. */
        this._g = null;
        /** Any-event hover: the cell last reported, as `col,row` (null: none yet, or off the body). */
        this._hoverCell = null;
    }

    /** A gesture is the program's. */
    get busy() { return !!this._g; }

    /**
     * What the program of terminal `id` hears now: its tracking when it is the focused one, else 'none'.
     * @param {string} id
     */
    _tracking(id) {
        return id && id === this.wall.focusedId ? this.wall.terminal(id)?.mouseTracking ?? 'none' : 'none';
    }

    /**
     * Whether this press (on `hit`, WallPointer's hit test) goes to the program; if so it is sent and
     * the gesture starts.
     * @param {PointerEvent} e
     * @param {{ id?: string, part?: string }|null} hit
     */
    down(e, hit) {
        if (!hit?.id || !programGets(e, { part: hit.part, focused: hit.id === this.wall.focusedId, tracking: this._tracking(hit.id) })) return false;
        this._g = { id: hit.id, held: 0, cell: null };
        this._buttons(e, BITS[e.button]);
        return true;
    }

    /**
     * A move in the gesture: buttons pressed or let go since (a chord changes `buttons` on a move), then
     * the move itself with the button held, once per cell.
     * @param {PointerEvent} e
     */
    move(e) {
        const g = this._g;
        if (!g) return;
        if (!this.wall.terminal(g.id)) { this._g = null; return; }   // its terminal went away
        this._buttons(e, e.buttons);
        if (!g.held) return;
        const tracking = this.wall.terminal(g.id).mouseTracking;
        if (tracking !== 'button' && tracking !== 'any') return;
        const at = this.cellOf(g.id, e);
        const key = `${at.col},${at.row}`;
        if (key === g.cell) return;
        g.cell = key;
        this._send(g.id, 'move', heldButton(g.held), at, e);
    }

    /**
     * The last button let go (pointerup): its release ends the gesture.
     * @param {PointerEvent} e
     */
    up(e) {
        const g = this._g;
        if (!g) return;
        if (this.wall.terminal(g.id)) this._buttons(e, e.buttons);
        this._g = null;
    }

    /** The browser took the pointer away: every button still held is released where it was last seen. */
    cancel() {
        const g = this._g;
        this._g = null;
        if (!g || !this.wall.terminal(g.id) || !g.last) return;
        for (let b = 0; b < BITS.length; b++) if (g.held & BITS[b]) this._send(g.id, 'release', BUTTONS[b], g.last.at, g.last.e);
    }

    /**
     * A move with no gesture in hand: any-event tracking hears it over the focused body, once per cell.
     * @param {PointerEvent} e
     * @param {{ id?: string, part?: string }|null} hit
     */
    hover(e, hit) {
        const id = hit?.part === 'body' ? hit.id : null;
        if (!id || this._tracking(id) !== 'any' || e.shiftKey) { this._hoverCell = null; return; }
        const at = this.cellOf(id, e);
        const key = `${id}:${at.col},${at.row}`;
        if (key === this._hoverCell) return;
        this._hoverCell = key;
        this._send(id, 'move', 'none', at, e);
    }

    /**
     * Whether a press here would go to the program (a double-click on it is the program's too).
     * @param {MouseEvent} e
     * @param {{ id?: string, part?: string }|null} hit
     */
    claims(e, hit) {
        return !!hit?.id && programGets(e, { part: hit.part, focused: hit.id === this.wall.focusedId, tracking: this._tracking(hit.id) });
    }

    /**
     * The pointer over terminal `id`, in its cells (clamped to them): from the grid's own geometry,
     * the world point taken into its frame by its pose (a wall terminal sits under the scene, unrotated).
     * @param {string} id
     * @param {{ clientX: number, clientY: number }} e
     */
    cellOf(id, e) {
        const grid = this.wall.terminal(id);
        const p = this.camera.toWorld(e.clientX, e.clientY);
        return grid.cellAt((p.x - grid.position.x) / grid.scale.x, (p.y - grid.position.y) / grid.scale.y);
    }

    /**
     * Presses and releases for the buttons that changed from the gesture's `held` to `now`.
     * @param {PointerEvent} e @param {number} now - a DOM `buttons` mask
     */
    _buttons(e, now) {
        const g = this._g;
        if (now === g.held) return;
        const at = this.cellOf(g.id, e);
        for (let b = 0; b < BITS.length; b++) {
            const bit = BITS[b];
            if ((now & bit) === (g.held & bit)) continue;
            this._send(g.id, now & bit ? 'press' : 'release', BUTTONS[b], at, e);
        }
        g.held = now;
        g.cell = `${at.col},${at.row}`;   // where the program last heard the pointer
        g.last = { at, e: { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey } };
    }

    /**
     * @param {string} id
     * @param {'press'|'release'|'move'} action
     * @param {import('@glyph3d/core/collections/TerminalGrid.js').TerminalMouseEvent['button']} button
     * @param {{ x: number, y: number }} at
     * @param {{ shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean }} e
     */
    _send(id, action, button, at, e) {
        const mods = modsOf(e);
        this.wall.terminal(id)?.sendMouse({ action, button, col: at.x, row: at.y, ...(mods.length ? { mods } : {}) });
    }
}
