/**
 * keyboardRouter — the keyboard responder chain: which one consumer does this keystroke
 * go to right now?
 *
 * The keyboard twin of gestureResolver. Where that resolves a POINTER gesture against the
 * context nodes, this resolves a KEYSTROKE against an ordered list of handler tiers. ONE
 * capture-phase listener owns the decision; the first tier to CLAIM a key wins, and the
 * router then suppresses the event (preventDefault + stopImmediatePropagation) so nothing
 * downstream — not a sibling listener, not the camera's bubble-phase WASD drain — ever
 * sees it. A key nobody claims is left untouched and bubbles on to the camera, which is the
 * implicit final tier (its continuous held-key model lives in ViewerCameraController, gated
 * on the same key slot this chain reads).
 *
 * This is one ordered dispatch in place of what were three scattered, racing keydown listeners
 * (entity typing in capture phase + an Esc/nav handler in bubble phase, coordinating only through
 * phase order and stopPropagation). The win is a single, composable precedence list — push or
 * reorder a tier and the priority shifts, so new controls (capture/greedy passthrough, app
 * shortcuts, macro layers, a vim mode) drop in as one more handler, not a competing listener.
 *
 * A handler is a plain function `(e, env) → claimed?`:
 *   env = {
 *     am,             AttentionManager — read the 'key' slot + capture state
 *     exec,           (cmd) => router.execute(cmd) — fire a verb (toggle / nav tiers)
 *     gestureEnv,     the env resolveGesture wants (Esc pops the context chain)
 *     captureToggle,  optional chord override for the settle/unsettle key (default CAPTURE_TOGGLE)
 *   }
 *
 * PASTE rides alongside as a second listener on the same env: the browser's native `paste` event
 * dispatched through PASTE_HANDLERS, the entity table's clipboard twin. It is a separate event
 * rather than a tier because the clipboard is only readable from inside a real paste event — the
 * keydown chain's job there is the opposite of claiming: keyEncoding declines the paste chord so
 * the keystroke survives to become one.
 *
 * Tiers (top = highest priority): captureToggle → entityTyping → contextEsc → navKeymap, then the
 * camera (WASD, in VCC) as the implicit fallthrough. The DOM-input guard sits above all of them:
 * when a real <input>/<textarea>/<select>/contenteditable holds focus the whole chain yields, so
 * the command bar and panels keep their own keys (this runs in capture phase, BEFORE the input's
 * own handler, so the guard is what stops us preventing-default on its keystroke).
 *
 * CAPTURE: when the key entity is "settled" (AttentionManager.isCaptured()), entity typing goes
 * greedy — Esc encodes to bytes too, so vim/readline get it — and the reserved captureToggle chord
 * is the one key it won't see. Soft focus (not captured) keeps Esc for the host's context pop.
 */

import { keyToTerminalBytes } from '@glyph3d/core/services/interaction/keyEncoding.js';
import { resolveGesture } from './gestureResolver.js';
import { resolveKeyBinding } from './keymap.js';

// ---- Capture-toggle tier: the reserved settle/unsettle chord ----

/**
 * The chord that settles/unsettles greedy capture — the ONE key a captured terminal never
 * receives, which is why it's checked ABOVE entity typing. Born configurable: a plain data record
 * (key + required modifiers), overridable via installKeyboardRouter({ captureToggle }). A future
 * keybindings UI drives this same shape; for now it's the single named default, not a buried literal.
 */
export const CAPTURE_TOGGLE = Object.freeze({ key: 'Enter', ctrl: true, shift: true, alt: false, meta: false });

/** Exact chord match — every modifier must agree (so Ctrl+Shift+Enter ≠ Ctrl+Enter). */
function matchesChord(e, c) {
    return e.key === c.key
        && e.ctrlKey === !!c.ctrl && e.shiftKey === !!c.shift
        && e.altKey === !!c.alt && e.metaKey === !!c.meta;
}

/** Tier 0 — the reserved capture toggle. Claims only when a key entity exists to settle/unsettle
 *  (else it passes through), so it never swallows the chord when there's nothing to capture. */
function captureToggle(e, env) {
    if (!matchesChord(e, env.captureToggle ?? CAPTURE_TOGGLE)) return false;
    if (!env.am?.get?.('key')) return false;
    env.exec('attention.capture toggle');
    return true;
}

// ---- Entity-typing tier: deliver to whatever holds the 'key' slot ----

/** Terminal: KeyboardEvent → ANSI bytes → grid.sendInput (the canvas→shell leg). When `captured`,
 *  the encoder also sends Esc (otherwise Esc returns null here and falls to the context tier). */
function terminalKeyHandler(e, grid, captured) {
    if (!grid || typeof grid.sendInput !== 'function') return false;
    const bytes = keyToTerminalBytes(e, { captureEscape: captured });
    if (bytes == null) return false;
    return grid.sendInput(bytes);
}

/** Grid in edit mode: printable / navigation / editing keys → CodeGrid L2 edit ops. Bails on
 *  Ctrl/Alt/Meta combos (reserved) and Escape (the host's Esc-LIFO clears the key slot, which
 *  fires exitEdit) — so they fall through this typing tier to the context/nav tiers. */
function gridKeyHandler(e, grid) {
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

// One entry per keystroke-target entity type. Adding a type is a one-liner here — the chain
// above is unchanged. (Composable like gestureResolver's POLICIES.)
const ENTITY_HANDLERS = {
    terminal: (e, entity, slot, captured) => terminalKeyHandler(e, entity.grid, captured),
    grid:     (e, entity)                 => gridKeyHandler(e, entity.grid),
};

/**
 * PASTE delivery, the same dispatch shape one tier up: clipboard TEXT → whichever entity holds
 * the 'key' slot. Each entry hands the text to the entity and lets IT decide the encoding — the
 * terminal frames a bracketed-paste burst, the grid runs edit ops. This chain never speaks VT.
 */
const PASTE_HANDLERS = {
    terminal: (text, entity) => entity.grid?.paste?.(text) === true,
    grid:     (text, entity) => gridPasteHandler(text, entity.grid),
};

/** Grid in edit mode: insert pasted text as ONE edit — lines split at newlines, so a multi-line
 *  paste lands as multi-line source rather than a literal \n glyph. */
function gridPasteHandler(text, grid) {
    if (!grid || typeof grid.editInsert !== 'function' || !grid._cursor) return false;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
        if (i > 0) grid.editSplitLine();
        if (line) grid.editInsert(line);
    });
    return true;
}

/** Tier 1 — deliver the key to whichever entity holds the 'key' slot (greedily when captured). */
function entityTyping(e, env) {
    const slot = env.am?.get?.('key');
    const entity = slot?.entity;
    if (!entity) return false;
    const handler = ENTITY_HANDLERS[entity.type];
    if (!handler) return false;
    const captured = env.am.isCaptured?.() === true;
    try {
        return handler(e, entity, slot, captured);
    } catch (err) {
        console.error(`[keyboard] ${entity.type} typing handler threw:`, err);
        return false;
    }
}

/** Tier 2 — Escape pops the innermost context node (leave edit / release the keyboard hold),
 *  resolved through the same responder chain a click uses. Claims only when something popped. */
function contextEsc(e, env) {
    if (e.key !== 'Escape') return false;
    return !!resolveGesture({ type: 'esc', target: null }, env.gestureEnv);
}

/** Tier 3 — NAV mode: a bare key (hjkl / ui) maps to a focus verb. Holding a key doesn't sweep
 *  the field, so auto-repeats are ignored — one press = one jump. */
function navKeymap(e, env) {
    if (e.repeat) return false;
    const cmd = resolveKeyBinding(e);
    if (!cmd) return false;
    env.exec(cmd);
    return true;
}

/** The ordered chain. Push or reorder to change precedence; the camera (WASD, in VCC) is the
 *  implicit final tier — it sees only keys NO tier here claimed. captureToggle sits ABOVE typing
 *  so the reserved chord releases capture even while the terminal is greedily eating keys. */
const HANDLERS = [captureToggle, entityTyping, contextEsc, navKeymap];

/** True while a real DOM input owns focus — the whole chain yields so it keeps its own keys. */
function domInputFocused(doc) {
    const el = doc.activeElement;
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === 'input' || tag === 'select' || tag === 'textarea' || el.isContentEditable === true;
}

/**
 * Install the keyboard responder chain: one capture-phase keydown listener that runs the
 * ordered tiers and, on the first claim, consumes the event so nothing downstream sees it.
 * Also wires the keyboard-target lifecycle hook (when the 'key' slot leaves a grid, exit its
 * edit mode so the caret hides) — the one bit of attention bookkeeping the old router owned.
 *
 * @param {Object} env
 * @param {import('@glyph3d/core/services/interaction').AttentionManager} env.am
 * @param {(cmd: string|string[]) => any} env.exec
 * @param {Object} env.gestureEnv  env for resolveGesture (Esc tier)
 * @param {{key:string,ctrl?:boolean,shift?:boolean,alt?:boolean,meta?:boolean}} [env.captureToggle]
 *   override the settle/unsettle chord (default CAPTURE_TOGGLE = Ctrl+Shift+Enter)
 * @param {Document} [env.document] injectable for tests; defaults to the global
 * @returns {() => void} uninstall
 */
export function installKeyboardRouter(env) {
    const doc = env.document ?? document;

    const onKeyDown = (e) => {
        if (domInputFocused(doc)) return;   // a focused <input> keeps its keys

        for (const handler of HANDLERS) {
            if (handler(e, env)) {
                // First tier to claim wins: suppress the browser default (Tab focus,
                // Backspace nav, space scroll) AND stop every downstream listener — the
                // camera's bubble-phase WASD drain included.
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
        }
        // Nobody claimed it: leave the event alone so it bubbles to the camera (WASD).
    };
    doc.addEventListener('keydown', onKeyDown, { capture: true });

    // PASTE: the browser's own clipboard event, which is why keyEncoding declines the paste
    // chord — a claimed keystroke is a suppressed one, and a suppressed one never becomes a
    // `paste`. Reading e.clipboardData inside the event needs no permission and no async
    // navigator.clipboard call, so the text is in hand synchronously. Same DOM-input guard as
    // the keydown chain: a focused <input> keeps its own paste.
    const onPaste = (e) => {
        if (domInputFocused(doc)) return;
        const entity = env.am?.get?.('key')?.entity;
        const handler = entity && PASTE_HANDLERS[entity.type];
        if (!handler) return;
        const text = e.clipboardData?.getData('text/plain');
        if (!text) return;
        try {
            if (handler(text, entity)) e.preventDefault();
        } catch (err) {
            console.error(`[keyboard] ${entity.type} paste handler threw:`, err);
        }
    };
    doc.addEventListener('paste', onPaste);

    // Keyboard-target lifecycle: when the key slot leaves a grid (Esc-LIFO clear, edit.stop,
    // or attention moved elsewhere), tell the prior grid to exit edit mode so the caret hides
    // and the cursor model is forgotten — the keyboard-target lifecycle hook.
    const offChangeKey = env.am?.on?.('change:key', (newSlot, prevSlot) => {
        const prev = prevSlot?.entity;
        if (!prev || prev.type !== 'grid') return;
        if (newSlot?.entity?.grid === prev.grid) return;  // same grid; no-op
        if (typeof prev.grid?.exitEdit === 'function') prev.grid.exitEdit();
    });

    return () => {
        doc.removeEventListener('keydown', onKeyDown, { capture: true });
        doc.removeEventListener('paste', onPaste);
        if (typeof offChangeKey === 'function') offChangeKey();
    };
}
