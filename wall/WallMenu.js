import { contextPolicy, isSecondaryPress } from './contextMenu.js';
import { IS_MAC } from './chord.js';

/** Where the menu key opens the menu on a terminal: this far into its body from the top-left, CSS px. */
const KEY_INSET_PX = 12;

/**
 * WallMenu — the events around the wall's right-click menu (contextMenu.js decides them; the wall
 * holds the open menu, `wall.menu` opens and closes it; ContextMenu.jsx draws it):
 *
 *   contextmenu (window, capture)    contextPolicy: ours → `wall.menu <target> x y` (default
 *                                    prevented); native → nothing prevented, ours closes; program →
 *                                    the program's click (see _toProgram) — only on the focused
 *                                    terminal
 *   pointerdown outside the menu     closes it — but not a secondary press (right button, or
 *                                    Ctrl+click on macOS): its contextmenu is the "again"
 *   wheel (zoom / scroll)            closes it, as a pan's press does
 *   the menu key / Shift+F10         WallKeys → openByKey: ours on the focused terminal (else the
 *                                    canvas at the view's centre); the contextmenu that key raises
 *                                    is ours too, not a second right-click
 *
 * Closing on Esc, on a choice and when the target goes away are the menu's and the wall's own.
 */
export default class WallMenu {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** The menu key was pressed: the contextmenu it raises is ours. Cleared by any press. */
        this._keyArmed = false;
        this._h = {
            context: (e) => this._onContext(e),
            down: (e) => this._onDown(e),
            wheel: () => { if (this.wall.menu) this.wall.run(['wall.menu', 'close']); },
        };
    }

    install() {
        window.addEventListener('contextmenu', this._h.context, true);
        window.addEventListener('pointerdown', this._h.down, true);
        this.wall.viewport.canvas.addEventListener('wheel', this._h.wheel, { passive: true });
    }

    uninstall() {
        window.removeEventListener('contextmenu', this._h.context, true);
        window.removeEventListener('pointerdown', this._h.down, true);
        this.wall.viewport.canvas.removeEventListener('wheel', this._h.wheel);
    }

    /**
     * What a DOM event's target is on the wall: the canvas (then whatever the wall's hit test finds
     * under the point), a map label or a title bar's buttons (their terminal's title), or neither
     * (chrome — the sidebar, the palette, the status window, the topbar — or the menu itself).
     * @param {MouseEvent} e
     * @returns {{ chrome: boolean, target: import('./contextMenu.js').MenuTarget|null }}
     */
    targetOf(e) {
        const el = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
        const wall = this.wall;
        if (el === wall.viewport.canvas) {
            const hit = wall.hit(wall.viewport.toWorld(e.clientX, e.clientY));
            if (!hit) return { chrome: false, target: { kind: 'canvas' } };
            if ('group' in hit) return { chrome: false, target: { kind: 'group', id: hit.group } };
            return { chrome: false, target: { kind: 'terminal', id: hit.id, part: hit.part } };
        }
        const label = el?.closest('[data-map-label]');
        if (label) return { chrome: false, target: { kind: 'terminal', id: /** @type {HTMLElement} */ (label).dataset.mapLabel, part: 'title' } };
        const bar = el?.closest('[data-bar-buttons]');
        if (bar && /** @type {HTMLElement} */ (bar).dataset.id) return { chrome: false, target: { kind: 'terminal', id: /** @type {HTMLElement} */ (bar).dataset.id, part: 'title' } };
        return { chrome: true, target: null };
    }

    /** @param {MouseEvent} e */
    _onContext(e) {
        const keyboard = this._keyArmed;
        this._keyArmed = false;
        if (keyboard) { e.preventDefault(); return; }   // the menu key's own event: WallKeys already opened ours
        const wall = this.wall;
        const el = e.target instanceof Element ? e.target : null;
        const editable = !!el && (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') != null);
        const { chrome, target } = editable ? { chrome: true, target: null } : this.targetOf(e);
        const id = target?.kind === 'terminal' ? target.id : null;
        const { verdict } = contextPolicy({
            shiftKey: e.shiftKey, editable, chrome, menuOpen: !!wall.menu, keyboard: false, target,
            mouseReporting: !!id && wall.mouseReporting(id), focused: !!id && id === wall.focusedId,
        });
        if (verdict === 'native') {
            if (wall.menu) wall.run(['wall.menu', 'close']);
            return;   // never prevented: the browser's (and the OS's) own menu
        }
        e.preventDefault();
        if (verdict === 'program') { this._toProgram(id, e); return; }
        const at = this._canvasPoint(e);
        wall.run(['wall.menu', target.kind, ...(target.kind === 'canvas' ? [] : [target.id]), String(at.x), String(at.y)]);
    }

    /**
     * The program in `id` reports the mouse, and this right-click is its. The wall forwards no
     * mouse clicks to programs yet (only the wheel, as terminal.scroll, which the relay turns into
     * SGR wheel reports for an alt-screen program — cli/attach_unix.go wheelBytes): when it does,
     * the right button's press and release reports go from here. Until then the click is the
     * program's and nothing else's — neither our menu nor the browser's covers its screen.
     * @param {string} id @param {MouseEvent} e
     */
    _toProgram(id, e) {
        void id; void e;
    }

    /** @param {PointerEvent} e */
    _onDown(e) {
        this._keyArmed = false;
        const wall = this.wall;
        if (!wall.menu || isSecondaryPress(e, IS_MAC)) return;
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest('[data-wall-menu]')) return;
        wall.run(['wall.menu', 'close']);
    }

    /** The menu key (or Shift+F10): ours, on the focused terminal, else on the canvas at the view's centre. */
    openByKey() {
        const wall = this.wall;
        this._keyArmed = true;
        const id = wall.focusedId && wall.isShown(wall.focusedId) ? wall.focusedId : null;
        if (id) {
            const b = wall.viewport.toScreenBox(wall.terminalRect(id));
            return wall.run(['wall.menu', 'terminal', id, String(Math.round(b.left + KEY_INSET_PX)), String(Math.round(b.top + KEY_INSET_PX))]);
        }
        const v = wall.viewport.view;
        return wall.run(['wall.menu', 'canvas', String(Math.round(v.w / 2)), String(Math.round(v.h / 2))]);
    }

    /** A page point → canvas-relative CSS px (what `wall.menu` takes). @param {MouseEvent} e */
    _canvasPoint(e) {
        const r = this.wall.viewport.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };   // unrounded: "new terminal here" lands exactly at the point
    }
}
