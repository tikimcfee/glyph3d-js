import { keyEventFor } from '@glyph3d/core/services/interaction/keyEncoding.js';
import { isChord, IS_MAC, CHORD_KEYS, isCopyChord, focusHistoryDir, groupCycleDir } from './chord.js';
import { chordFor } from './wallKeymap.js';

/**
 * Alt pressed and released on its own opens Firefox's menu bar (and Windows browsers' menus) unless
 * the page cancels it: the wall is the whole window, so it does. Alt still rides other keys (Alt+F).
 * @param {KeyboardEvent} e
 */
function noMenuBar(e) { if (e.key === 'Alt') e.preventDefault(); }

/** Cancel a browser shortcut and stop any later window or document listener from seeing it. @param {KeyboardEvent} e */
function claim(e) {
    e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else e.stopPropagation();
}

/** Chords that have no meaning in a text field (so a docked panel's search input never leaks them to the browser). */
const GLOBAL_NAV_CODES = new Set(['BracketLeft', 'BracketRight']);

/**
 * WallKeys — the keyboard. Wall chords take the platform's chord modifier (chord.js: ⌘ on macOS,
 * Ctrl+Alt elsewhere) and are matched on e.code (the physical key) so layouts never rewrite them;
 * which chord does what is wallKeymap.KEYMAP — the table the help panel lists too (X is HELD to
 * close: the bar's close ring fills over closeHoldMs; let go early and it's kept; K belongs to the
 * DOM palette). Each runs a wall verb.
 * Everything else goes to the focused terminal as key events (keyEncoding.keyEventFor) that termd
 * encodes in the program's own keyboard modes, so Shift+Enter reaches a Kitty-keyboard program as
 * Shift+Enter — Esc included (vim and readline need it), Ctrl alone too (it's the shell's), and the
 * key's release goes to the terminal its press went to (Kitty's event reporting reads it); click
 * empty canvas to drop focus. With nothing focused, Esc clears the selection. On macOS any other ⌘
 * key stays with the browser (⌘C, ⌘V); elsewhere any other Ctrl+Alt key is the shell's. A focused
 * DOM input (the palette) keeps its own keys. Paste goes to the focused terminal as a paste, which
 * termd brackets when the program asked for bracketed paste. Each key carries the `optionAsAlt` knob
 * (wall.config), read as it is sent. The menu key (and Shift+F10) opens the right-click menu on the
 * focused terminal (else on the canvas), as native apps do; while that menu is open it has the keys.
 * The copy chord (chord.js isCopyChord: ⌘C, Ctrl+Shift+C elsewhere) copies the focused terminal's
 * selected text (`wall.copy`) when it has some, and is a key like any other when it has none (Ctrl+C
 * is always the program's); a key typed into a terminal drops its selection while
 * `selectionClearOnTyping` is on (Ghostty's `selection-clear-on-typing`).
 */
export default class WallKeys {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** The chord's modifiers as Playwright key names — the e2e presses the platform's chord. */
        this.chordKeys = CHORD_KEYS;
        this._onKey = (e) => this._key(e);
        this._onKeyPress = (e) => this._keyPress(e);
        this._onKeyUp = (e) => this._keyUp(e);
        this._onPaste = (e) => this._paste(e);
        /** Physical keys whose press went to a terminal → that terminal: where the release goes. */
        this._down = new Map();
    }

    install() {
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('keypress', this._onKeyPress, true);
        window.addEventListener('keyup', this._onKeyUp, true);
        document.addEventListener('paste', this._onPaste);
    }

    uninstall() {
        window.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('keypress', this._onKeyPress, true);
        window.removeEventListener('keyup', this._onKeyUp, true);
        document.removeEventListener('paste', this._onPaste);
    }

    /** True when `e` matches an active wall chord with its own handler, a focus-history key, or Ctrl+Shift+[ / ]. */
    _claimsShortcut(e) {
        if (this.wall.menu) return false;
        if (focusHistoryDir(e) || groupCycleDir(e)) return true;
        if (!isChord(e)) return false;
        const chord = chordFor(e, this.wall.fullscreen?.id ? 'fullscreen' : 'canvas');
        return !!chord?.run;
    }

    /** Cancel `keypress` on claimed chords too (Firefox's non-reserved XUL bindings listen on keypress). */
    _keyPress(e) {
        if (this._claimsShortcut(e)) claim(e);
    }

    /** The held close chord ends when X or the chord comes up (or the window loses the keys). A
     *  key whose press a terminal got sends that terminal its release; a claimed chord cancels keyup too. */
    _keyUp(e) {
        noMenuBar(e);
        if (e.code === 'KeyX' || !isChord(e)) this.wall.barButtons?.releaseKey();
        if (this._claimsShortcut(e)) { claim(e); return; }
        const id = this._down.get(e.code);
        if (id === undefined) return;
        this._down.delete(e.code);
        const key = keyEventFor(e, { captureEscape: true, optionAsAlt: this.wall.config.optionAsAlt });
        if (key) this.wall.terminal(id)?.sendKey(key);
    }

    _key(e) {
        noMenuBar(e);
        const wall = this.wall;
        if (wall.menu) return;   // the open right-click menu has the keys (ContextMenu.jsx)
        const t = e.target;
        const inField = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
        if (inField) {
            // Bracket navigation chords have no meaning inside a panel's search or select control:
            // intercept them here too so a focused panel input never leaks them to the window.
            const gDir = groupCycleDir(e);
            if (gDir) {
                claim(e);
                if (t.closest?.('[data-help], [data-settings]')) t.blur?.();
                wall.cycleGroupFocus?.(gDir);
                return;
            }
            if (isChord(e) && GLOBAL_NAV_CODES.has(e.code)) {
                const chord = chordFor(e, wall.fullscreen?.id ? 'fullscreen' : 'canvas');
                if (chord?.run) {
                    claim(e);
                    if (t.closest?.('[data-help], [data-settings]')) t.blur?.();
                    chord.run(wall, e);
                }
            }
            return;
        }
        const histDir = focusHistoryDir(e);
        if (histDir) {
            claim(e);
            wall.stepFocusHistory?.(histDir);
            return;
        }
        const groupDir = groupCycleDir(e);
        if (groupDir) {
            claim(e);
            wall.cycleGroupFocus?.(groupDir);
            return;
        }
        if (isCopyChord(e) && wall.focusedId && wall.terminal(wall.focusedId)?.hasSelection) {
            claim(e);
            if (!e.repeat) wall.run(['wall.copy', wall.focusedId]);
            return;
        }
        if (!isChord(e) && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) {
            claim(e);
            wall.menuInput.openByKey();
            return;
        }
        if (isChord(e)) {
            const chord = chordFor(e, wall.fullscreen?.id ? 'fullscreen' : 'canvas');
            if (chord) {
                if (chord.run) { claim(e); chord.run(wall, e); }
                return;   // a chord with no run is another part's (K: the palette, main.jsx)
            }
            if (IS_MAC) return;   // ⌘C/V/… stay with the browser and the DOM chrome
        }
        const grid = wall.focusedId ? wall.terminal(wall.focusedId) : null;
        if (!grid) {
            if (e.key === 'Escape' && wall.selection.size) { e.preventDefault(); wall.run(['wall.select', 'none']); }
            return;
        }
        const key = keyEventFor(e, { captureEscape: true, optionAsAlt: wall.config.optionAsAlt });
        if (!key) return;
        e.preventDefault();
        e.stopPropagation();
        wall.pointer?.cancelScroll?.();
        if (grid.sendKey(key) && key.code) this._down.set(key.code, wall.focusedId);
        if (wall.config.selectionClearOnTyping) grid.clearSelection();
    }

    _paste(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const grid = this.wall.focusedId ? this.wall.terminal(this.wall.focusedId) : null;
        const text = e.clipboardData?.getData('text/plain');
        if (grid && text) { e.preventDefault(); grid.paste(text); }
    }
}
