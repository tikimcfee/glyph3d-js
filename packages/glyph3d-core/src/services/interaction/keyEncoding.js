/**
 * keyEncoding — translate a browser KeyboardEvent into the byte sequence a terminal
 * (PTY) expects. The discrete-keystroke encoder for the keyboard responder chain's
 * terminal-typing tier (app/client/keyboardRouter.js).
 *
 * Pure and framework-agnostic: a KeyboardEvent in, a string of bytes out (or null to
 * ignore the key). No DOM beyond reading the event, no attention/registry — the chain
 * decides WHEN a terminal should receive a key; this decides WHAT bytes.
 *
 * Modifier-aware: Alt/Ctrl/Shift + cursor & nav keys become the xterm CSI sequences a
 * shell reads as word-motion etc. (Alt+← = back a word), and Alt+<printable> becomes the
 * meta ESC-prefix (Alt+f = forward a word). Plain unmodified keys, Ctrl+<letter> control
 * bytes, and anything with the Meta/OS key are byte-identical to a bare terminal.
 */

// xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). 1 means "no modifiers", and
// the encoders below emit the PLAIN sequence in that case (so unmodified keys are unchanged).
function modParam(e) {
    return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

/**
 * The chords that mean "paste", which a terminal must NOT encode to bytes.
 *
 *   Cmd+V         — the macOS clipboard chord.
 *   Ctrl+Shift+V  — the terminal-emulator convention everywhere else, and the reason it isn't
 *                   plain Ctrl+V: that one is a real terminal byte (\x16, readline's
 *                   quoted-insert) and stays one.
 *
 * Exported because it names a policy, not a detail — a keybindings UI should be able to read
 * and rebind it rather than rediscover the literal.
 */
export function isPasteChord(e) {
    if (e.key !== 'v' && e.key !== 'V') return false;
    if (e.metaKey && !e.ctrlKey && !e.altKey) return true;         // Cmd+V
    return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;     // Ctrl+Shift+V
}

/** Cursor/edit key (final letter A/B/C/D/H/F): `ESC [ 1 ; <mod> <L>` when modified, else `ESC [ <L>`. */
function csiCursor(mod, finalChar) {
    return mod > 1 ? `\x1b[1;${mod}${finalChar}` : `\x1b[${finalChar}`;
}

/** Tilde key (Delete=3, PageUp=5, …): `ESC [ <num> ; <mod> ~` when modified, else `ESC [ <num> ~`. */
function csiTilde(mod, num) {
    return mod > 1 ? `\x1b[${num};${mod}~` : `\x1b[${num}~`;
}

/**
 * Translate a KeyboardEvent into the byte sequence a terminal expects, or null to ignore
 * the key entirely (the chain then lets a lower tier — Esc-pop, nav, camera — have it).
 *
 * @param {KeyboardEvent} e
 * @param {Object} [opts]
 * @param {boolean} [opts.captureEscape=false] - when true, Escape encodes to ESC (\x1b) so a
 *   captured terminal can drive vim/readline; when false it returns null so the host's
 *   Esc-LIFO releases focus (the soft-focus default). This is the ONE key capture changes.
 * @returns {string|null}
 */
export function keyToTerminalBytes(e, { captureEscape = false } = {}) {
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return null;

    // A paste chord means NO BYTES. Returning null is what makes paste work at all: the
    // responder chain only suppresses an event a tier CLAIMED, so declining here lets the
    // keystroke reach the browser, which then fires the native `paste` event carrying the
    // clipboard (see the paste tier in keyboardRouter.js). Claiming it instead — which is
    // what the catch-all below would do — both eats the clipboard and types a literal 'v'.
    if (isPasteChord(e)) return null;

    // Ctrl+<letter> → C0 control byte (Ctrl+A..Z → 1..26). Bare ctrl+letter only; ctrl+arrow
    // and friends fall to the modifier-encoded switch below.
    if (e.ctrlKey && !e.altKey && !e.metaKey && k.length === 1) {
        const c = k.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    }

    const mod = modParam(e);
    switch (k) {
        case 'Enter':     return '\r';
        case 'Tab':       return '\t';
        case 'Escape':    return captureEscape ? '\x1b' : null;

        // Backspace is word-aware like the cursor keys. Alt+BS → meta-DEL (readline/zsh/fish bind it
        // to backward-kill-word by default); Ctrl+BS → C-w (unix-word-rubout, also a default bind —
        // and it recovers the Ctrl+W the browser steals for "close tab"). Plain/Shift → DEL.
        case 'Backspace':
            if (e.altKey && !e.ctrlKey && !e.metaKey) return '\x1b\x7f';
            if (e.ctrlKey && !e.altKey && !e.metaKey) return '\x17';
            return '\x7f';

        case 'ArrowUp':    return csiCursor(mod, 'A');
        case 'ArrowDown':  return csiCursor(mod, 'B');
        case 'ArrowRight': return csiCursor(mod, 'C');
        case 'ArrowLeft':  return csiCursor(mod, 'D');
        case 'Home':       return csiCursor(mod, 'H');
        case 'End':        return csiCursor(mod, 'F');

        case 'Insert':     return csiTilde(mod, 2);
        case 'Delete':     return csiTilde(mod, 3);
        case 'PageUp':     return csiTilde(mod, 5);
        case 'PageDown':   return csiTilde(mod, 6);

        // Function keys. F1-F4 are SS3 (ESC O P..S) unmodified, CSI when modified; F5+ are tilde keys.
        case 'F1':  return mod > 1 ? `\x1b[1;${mod}P` : '\x1bOP';
        case 'F2':  return mod > 1 ? `\x1b[1;${mod}Q` : '\x1bOQ';
        case 'F3':  return mod > 1 ? `\x1b[1;${mod}R` : '\x1bOR';
        case 'F4':  return mod > 1 ? `\x1b[1;${mod}S` : '\x1bOS';
        case 'F5':  return csiTilde(mod, 15);
        case 'F6':  return csiTilde(mod, 17);
        case 'F7':  return csiTilde(mod, 18);
        case 'F8':  return csiTilde(mod, 19);
        case 'F9':  return csiTilde(mod, 20);
        case 'F10': return csiTilde(mod, 21);
        case 'F11': return csiTilde(mod, 23);
        case 'F12': return csiTilde(mod, 24);
    }

    // Alt+<printable> → the meta ESC-prefix (Alt+f = forward word, Alt+b = back word, …). Not
    // when Ctrl/Meta is also held — those are app/OS combos, left to the catch-all / the chain.
    if (e.altKey && !e.ctrlKey && !e.metaKey && k.length === 1) return '\x1b' + k;

    // Plain printable. Identical to a bare terminal — including Meta/OS combos, which fall here
    // and send the base char exactly as before (the chain/browser owns whether they arrive).
    if (k.length === 1) return k;

    return null;
}
