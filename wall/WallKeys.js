import { keyToTerminalBytes } from '@glyph3d/core/services/interaction/keyEncoding.js';
import { isChord, IS_MAC, CHORD_KEYS } from './chord.js';

/**
 * WallKeys — the keyboard. Wall chords take the platform's chord modifier (chord.js: ⌘ on macOS,
 * Ctrl+Alt elsewhere) and are matched on e.code (the physical key) so layouts never rewrite them:
 * [ ] cycle focus, ↵ frames the focused terminal or returns to the overview, Shift+↵ opens a new
 * terminal, 0 fits all, S opens or closes the termd status window (K belongs to the DOM palette).
 * Everything else goes to the focused terminal as terminal bytes — Esc included (vim and readline
 * need it), Ctrl alone too (it's the shell's);
 * click empty canvas to drop focus. On macOS any other ⌘ key stays with the browser (⌘C, ⌘V);
 * elsewhere any other Ctrl+Alt key is the shell's. A focused DOM input (the palette) keeps its own
 * keys. Paste goes to the focused terminal as one bracketed burst.
 */
export default class WallKeys {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** The chord's modifiers as Playwright key names — the e2e presses the platform's chord. */
        this.chordKeys = CHORD_KEYS;
        this._onKey = (e) => this._key(e);
        this._onPaste = (e) => this._paste(e);
    }

    install() {
        window.addEventListener('keydown', this._onKey, true);
        document.addEventListener('paste', this._onPaste);
    }

    uninstall() {
        window.removeEventListener('keydown', this._onKey, true);
        document.removeEventListener('paste', this._onPaste);
    }

    _key(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const wall = this.wall;
        if (isChord(e)) {
            const claim = () => { e.preventDefault(); e.stopPropagation(); };
            switch (e.code) {
                case 'BracketRight': claim(); wall.cycleFocus(+1); return;
                case 'BracketLeft': claim(); wall.cycleFocus(-1); return;
                case 'Enter': claim(); if (e.shiftKey) wall.spawn(); else wall.toggleFrame(); return;
                case 'Digit0': claim(); wall.fitAll(); return;
                case 'KeyS': claim(); wall.run(['wall.status', 'toggle']); return;
                case 'KeyK': return;   // the palette's (main.jsx)
                default: if (IS_MAC) return;   // ⌘C/V/… stay with the browser and the DOM chrome
            }
        }
        const grid = wall.focusedId ? wall.terminal(wall.focusedId) : null;
        if (!grid) return;
        const bytes = keyToTerminalBytes(e, { captureEscape: true });
        if (bytes == null) return;
        e.preventDefault();
        e.stopPropagation();
        grid.sendInput(bytes);
    }

    _paste(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const grid = this.wall.focusedId ? this.wall.terminal(this.wall.focusedId) : null;
        const text = e.clipboardData?.getData('text/plain');
        if (grid && text) { e.preventDefault(); grid.paste(text); }
    }
}
