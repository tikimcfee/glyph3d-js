import { keyToTerminalBytes } from '@glyph3d/core/services/interaction/keyEncoding.js';

/**
 * WallKeys — the keyboard. Wall chords are ⌘+<key>, matched on e.code (the physical key) so
 * layouts and ⌥ never rewrite them: ⌘[ ⌘] cycle focus, ⌘↵ frame the focused terminal or return to
 * the overview, ⌘⇧↵ new terminal, ⌘0 fit all (⌘K belongs to the DOM palette). Everything else goes
 * to the focused terminal as terminal bytes — Esc included (vim and readline need it); click empty
 * canvas to drop focus. A focused DOM input (the palette) keeps its own keys. Paste goes to the
 * focused terminal as one bracketed burst.
 */
export default class WallKeys {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
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
        if (e.metaKey) {
            const claim = () => { e.preventDefault(); e.stopPropagation(); };
            switch (e.code) {
                case 'BracketRight': claim(); wall.cycleFocus(+1); return;
                case 'BracketLeft': claim(); wall.cycleFocus(-1); return;
                case 'Enter': claim(); if (e.shiftKey) wall.spawn(); else wall.toggleFrame(); return;
                case 'Digit0': claim(); wall.fitAll(); return;
                default: return;   // ⌘C/V/K/… stay with the browser and the DOM chrome
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
