/**
 * keyEncoding — translate a browser KeyboardEvent into the byte sequence a terminal
 * (PTY) expects. The discrete-keystroke encoder for the keyboard responder chain's
 * terminal-typing layer (app/client/keyboardRouter.js).
 *
 * Pure and framework-agnostic: a KeyboardEvent in, a string of bytes out (or null to
 * ignore the key entirely). No DOM beyond reading the event, no attention/registry —
 * the chain decides WHEN a terminal should receive a key; this decides WHAT bytes.
 */

/**
 * Translate a KeyboardEvent into the byte sequence a terminal expects (single
 * chars, ANSI escape sequences for arrows / function keys, control bytes for
 * Ctrl+letter). Returns null when the key should be ignored entirely.
 *
 * @param {KeyboardEvent} e
 * @returns {string|null}
 */
export function keyToTerminalBytes(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;

    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const c = e.key.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    }

    switch (e.key) {
        case 'Enter':     return '\r';
        case 'Tab':       return '\t';
        case 'Backspace': return '\x7f';
        case 'Delete':    return '\x1b[3~';
        case 'Escape':    return null;
        case 'ArrowUp':    return '\x1b[A';
        case 'ArrowDown':  return '\x1b[B';
        case 'ArrowRight': return '\x1b[C';
        case 'ArrowLeft':  return '\x1b[D';
        case 'Home':       return '\x1b[H';
        case 'End':        return '\x1b[F';
        case 'PageUp':     return '\x1b[5~';
        case 'PageDown':   return '\x1b[6~';
    }

    if (e.key.length === 1) return e.key;
    return null;
}
