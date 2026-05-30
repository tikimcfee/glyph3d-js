/**
 * EntityKeystrokeRouter — delivers keyboard input to whichever entity holds the
 * AttentionManager 'key' slot. One capture-phase document listener, dispatched
 * by entity type.
 *
 * Lifted verbatim from the vanilla command center (app/commands/index.js) so the
 * r3f client and the legacy bootstrapper share ONE implementation — no second
 * copy to drift. Two entity types are handled:
 *
 *   - terminal — KeyboardEvent → ANSI bytes → grid.onInput. onInput is the
 *     controller hook wired at terminal.create time, which pushes the bytes back
 *     to the owning adapter (→ relay → tmux send-keys). This is the canvas→shell
 *     leg of the terminal loop.
 *   - grid     — printable / navigation / editing keys → CodeGrid L2 edit ops
 *     (only while the grid is in edit mode, i.e. has a _cursor).
 *
 * Camera nav doesn't fight typing on two fronts: (1) when a handler consumes the
 * key we preventDefault + stopImmediatePropagation, so the camera's keydown
 * (bubble phase) never sees it; (2) ViewerCameraController's own keydown gate
 * bails whenever the key slot is held — provided it shares this AttentionManager.
 *
 * Construct with the canonical AttentionManager and call start(); dispose() to
 * unbind. Handlers are extensible via registerHandler(type, fn).
 */

/**
 * Translate a KeyboardEvent into the byte sequence a terminal expects (single
 * chars, ANSI escape sequences for arrows / function keys, control bytes for
 * Ctrl+letter). Returns null when the key should be ignored entirely.
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

/**
 * Terminal-entity key handler. Forwards via grid.onInput (the terminal
 * controller hook). Returns true if the event was consumed.
 */
function terminalKeyHandler(e, entity, slot) {
    const grid = entity.grid;
    if (!grid || typeof grid.onInput !== 'function') return false;
    const bytes = keyToTerminalBytes(e);
    if (bytes == null) return false;
    grid.onInput(bytes, slot.id);
    return true;
}

/**
 * Grid-entity key handler. Maps printable / navigation / editing keys to the
 * CodeGrid edit ops (L2 M1). Bails on Ctrl/Alt/Meta combos (reserved for
 * app-level shortcuts and future copy/paste/undo). Ignores Escape so the host's
 * Esc-LIFO can clear attention.key first; the change:key listener then calls
 * exitEdit. Returns true if the event was consumed.
 */
function gridKeyHandler(e, entity) {
    const grid = entity.grid;
    if (!grid || typeof grid.editInsert !== 'function') return false;
    if (!grid._cursor) return false;  // not in edit mode (defensive)

    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return false;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;  // reserved combos
    if (e.key === 'Escape') return false;

    switch (e.key) {
        case 'ArrowLeft':  grid.editMoveCursor(-1, 0); return true;
        case 'ArrowRight': grid.editMoveCursor( 1, 0); return true;
        case 'ArrowUp':    grid.editMoveCursor( 0, -1); return true;
        case 'ArrowDown':  grid.editMoveCursor( 0,  1); return true;
        case 'Home':       grid.editHome(); return true;
        case 'End':        grid.editEnd(); return true;
        case 'Enter':      grid.editSplitLine(); return true;
        case 'Backspace':  grid.editDeleteBackward(); return true;
        case 'Delete':     grid.editDeleteForward(); return true;
        case 'Tab':        grid.editInsert('\t'); return true;
    }

    if (e.key.length === 1) {
        grid.editInsert(e.key);
        return true;
    }
    return false;
}

export default class EntityKeystrokeRouter {
    /**
     * @param {import('./AttentionManager.js').default} attentionManager
     * @param {Object} [options]
     * @param {Document} [options.document] - injectable for tests; defaults to global
     */
    constructor(attentionManager, options = {}) {
        this._am = attentionManager;
        this._doc = options.document ?? (typeof document !== 'undefined' ? document : null);
        this._handlers = new Map([
            ['terminal', terminalKeyHandler],
            ['grid', gridKeyHandler],
        ]);
        this._onKeyDown = null;
        this._offChangeKey = null;
        this._started = false;
    }

    /** Register/override the handler for an entity type. Chainable. */
    registerHandler(type, fn) {
        this._handlers.set(type, fn);
        return this;
    }

    /** Bind the document keydown listener + the change:key exit hook. */
    start() {
        if (this._started || !this._am || !this._doc) return this;
        this._started = true;

        this._onKeyDown = (e) => {
            const slot = this._am.get('key');
            if (!slot || !slot.entity) return;
            const handler = this._handlers.get(slot.entity.type);
            if (!handler) return;

            // Guard against DOM input elements — if the user is typing in a real
            // <input> (command bar, etc.), never also forward to the entity.
            const tag = this._doc.activeElement?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

            let consumed = false;
            try {
                consumed = handler(e, slot.entity, slot);
            } catch (err) {
                console.error(`[entity-keystroke] ${slot.entity.type} handler threw:`, err);
            }
            if (consumed) {
                // Suppress the browser default (Tab focus, Backspace nav, arrow
                // scroll) AND stop the camera's bubble-phase keydown from firing.
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        this._doc.addEventListener('keydown', this._onKeyDown, { capture: true });

        // When the key slot leaves a grid (Esc-LIFO clear, edit.stop, or
        // attention moved elsewhere), tell the prior grid to exit edit mode so
        // the caret hides and the cursor model is forgotten.
        this._offChangeKey = this._am.on('change:key', (newSlot, prevSlot) => {
            const prev = prevSlot?.entity;
            if (!prev || prev.type !== 'grid') return;
            if (newSlot?.entity?.grid === prev.grid) return;  // same grid; no-op
            const prevGrid = prev.grid;
            if (prevGrid && typeof prevGrid.exitEdit === 'function') {
                prevGrid.exitEdit();
            }
        });

        return this;
    }

    /** Remove listeners. Safe to call multiple times. */
    dispose() {
        if (this._onKeyDown && this._doc) {
            this._doc.removeEventListener('keydown', this._onKeyDown, { capture: true });
        }
        if (typeof this._offChangeKey === 'function') this._offChangeKey();
        this._onKeyDown = null;
        this._offChangeKey = null;
        this._started = false;
    }
}
