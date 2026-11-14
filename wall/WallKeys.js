import { keyEventFor } from '@glyph3d/core/services/interaction/keyEncoding.js';
import { isChord, IS_MAC, CHORD_KEYS } from './chord.js';

/**
 * WallKeys — the keyboard. Wall chords take the platform's chord modifier (chord.js: ⌘ on macOS,
 * Ctrl+Alt elsewhere) and are matched on e.code (the physical key) so layouts never rewrite them:
 * [ ] cycle focus, ↵ frames the focused terminal or returns to the overview, Shift+↵ opens a new
 * terminal, 0 fits all, - hides the focused terminal, X HELD closes it (the bar's close ring fills
 * over closeHoldMs; let go early and it's kept), G gathers the selection (or the focused terminal)
 * into a group, Shift+G dissolves the focused terminal's group, B opens or closes the sidebar, S
 * opens or closes the termd status window, ' turns snapping to the grid on or off and Shift+' the
 * grid itself, `,` opens or closes the settings panel (K belongs to the DOM palette). Each runs a
 * wall verb.
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
 */
export default class WallKeys {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** The chord's modifiers as Playwright key names — the e2e presses the platform's chord. */
        this.chordKeys = CHORD_KEYS;
        this._onKey = (e) => this._key(e);
        this._onKeyUp = (e) => this._keyUp(e);
        this._onPaste = (e) => this._paste(e);
        /** Physical keys whose press went to a terminal → that terminal: where the release goes. */
        this._down = new Map();
    }

    install() {
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('keyup', this._onKeyUp, true);
        document.addEventListener('paste', this._onPaste);
    }

    uninstall() {
        window.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('keyup', this._onKeyUp, true);
        document.removeEventListener('paste', this._onPaste);
    }

    /** The held close chord ends when X or the chord comes up (or the window loses the keys). A
     *  key whose press a terminal got sends that terminal its release. */
    _keyUp(e) {
        if (e.code === 'KeyX' || !isChord(e)) this.wall.barButtons?.releaseKey();
        const id = this._down.get(e.code);
        if (id === undefined) return;
        this._down.delete(e.code);
        const key = keyEventFor(e, { captureEscape: true, optionAsAlt: this.wall.config.optionAsAlt });
        if (key) this.wall.terminal(id)?.sendKey(key);
    }

    _key(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const wall = this.wall;
        if (wall.menu) return;   // the open right-click menu has the keys (ContextMenu.jsx)
        if (!isChord(e) && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) {
            e.preventDefault(); e.stopPropagation();
            wall.menuInput.openByKey();
            return;
        }
        if (isChord(e)) {
            const claim = () => { e.preventDefault(); e.stopPropagation(); };
            switch (e.code) {
                case 'BracketRight': claim(); wall.cycleFocus(+1); return;
                case 'BracketLeft': claim(); wall.cycleFocus(-1); return;
                case 'Enter': claim(); if (e.shiftKey) wall.spawn(); else wall.toggleFrame(); return;
                case 'Digit0': claim(); wall.fitAll(); return;
                case 'Minus': claim(); if (wall.focusedId) wall.run(['wall.hide', wall.focusedId]); return;
                case 'KeyX': claim(); if (!e.repeat && wall.focusedId) wall.barButtons.holdKey(wall.focusedId); return;
                case 'KeyG': {
                    claim();
                    const f = wall.focusedId;
                    if (e.shiftKey) { const gid = f && wall.groups.groupOf(f); if (gid) wall.run(['wall.ungroup', gid]); }
                    else wall.run(wall.selection.size || !f ? ['wall.group'] : ['wall.group', f]);
                    return;
                }
                case 'KeyB': claim(); wall.run(['wall.sidebar', 'toggle']); return;
                case 'KeyS': claim(); wall.run(['wall.status', 'toggle']); return;
                case 'Quote': claim(); wall.run([e.shiftKey ? 'wall.grid' : 'wall.snap', 'toggle']); return;
                case 'Comma': claim(); wall.run(['wall.settings', 'toggle']); return;
                case 'KeyK': return;   // the palette's (main.jsx)
                default: if (IS_MAC) return;   // ⌘C/V/… stay with the browser and the DOM chrome
            }
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
        if (grid.sendKey(key) && key.code) this._down.set(key.code, wall.focusedId);
    }

    _paste(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const grid = this.wall.focusedId ? this.wall.terminal(this.wall.focusedId) : null;
        const text = e.clipboardData?.getData('text/plain');
        if (grid && text) { e.preventDefault(); grid.paste(text); }
    }
}
