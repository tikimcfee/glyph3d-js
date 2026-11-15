/**
 * chord — the wall's chord modifier, decided once, here: ⌘ on macOS, Ctrl+Alt everywhere else.
 * Ctrl alone belongs to the shell (^C, ^R, ^[…) and Alt alone is readline's Meta, so off macOS a
 * wall chord takes both. AltGr — which Linux and Windows report as Ctrl+Alt, and which many
 * layouts type [ ] { } 0 with — is never a chord. WallKeys and the palette's chord (main.jsx) both
 * ask isChord; the hint line and the palette label chords with chordLabel. The snap and zoom
 * modifiers (invertsSnap, zoomsWheel), the copy chord (isCopyChord) and the block-selection modifiers
 * (blockSelects) are decided here too.
 */

const platform = (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || '';

/** macOS (and iPadOS with a keyboard): ⌘ chords. */
export const IS_MAC = /mac|iphone|ipad|ipod/i.test(platform);

/** The chord's modifiers as Playwright key names — what a test presses. */
export const CHORD_KEYS = IS_MAC ? ['Meta'] : ['Control', 'Alt'];

/** What the drag-to-move modifier (e.altKey) is called on this platform. */
export const ALT_LABEL = IS_MAC ? '⌥' : 'Alt';

/**
 * The snap modifier: Ctrl (⌃ on macOS), held DURING a move, resize or group drag, inverts snapping for
 * as long as it's held (Blender's way). Not Alt (drag-to-move), not Shift (the lasso and ⇧-click), not
 * the chord: Ctrl alone is none of them. (On macOS ⌃ held at the press is a right-click — so it's
 * read as the drag goes, not at the press.)
 * @param {{ ctrlKey: boolean }} e - a pointer or key event
 */
export function invertsSnap(e) { return !!e.ctrlKey; }

/** What the snap modifier is called on this platform. */
export const SNAP_INVERT_LABEL = IS_MAC ? '⌃' : 'Ctrl';

/** The modifiers a zoom wheel may carry (the `zoomKeys` knob names them), and the event flag each is. */
const ZOOM_FLAG = { ctrl: 'ctrlKey', alt: 'altKey', meta: 'metaKey', shift: 'shiftKey' };
/** What each zoom modifier is called on this platform. */
const ZOOM_LABEL = IS_MAC ? { ctrl: '⌃', alt: '⌥', meta: '⌘', shift: '⇧' } : { ctrl: 'Ctrl', alt: 'Alt', meta: 'Super', shift: 'Shift' };

/**
 * The `zoomKeys` knob's words, checked: any of ctrl, alt, meta, shift, separated by spaces (empty: none).
 * @param {string} s @returns {string[]}
 */
export function parseZoomKeys(s) {
    const keys = String(s).trim().split(/\s+/).filter(Boolean);
    for (const k of keys) if (!(k in ZOOM_FLAG)) throw new Error(`"${k}" is not a modifier (ctrl, alt, meta, shift)`);
    return keys;
}

let _zoomKeysText = null, _zoomKeys = [];
/**
 * The zoom modifiers: a wheel carrying any of them zooms the canvas; without one it pans
 * (WallPointer). Ctrl must stay among them for a trackpad pinch to zoom: the browser sends a pinch
 * as Ctrl+wheel. Alt is there for a Mac reaching the wall through a remote desktop (Moonlight),
 * where macOS's screen zoom can take Ctrl+scroll first and Option arrives as Alt.
 * @param {{ ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean }} e - a wheel event
 * @param {string} zoomKeys - the `zoomKeys` knob
 */
export function zoomsWheel(e, zoomKeys) {
    if (zoomKeys !== _zoomKeysText) { _zoomKeys = parseZoomKeys(zoomKeys); _zoomKeysText = zoomKeys; }
    for (const k of _zoomKeys) if (e[ZOOM_FLAG[k]]) return true;
    return false;
}

/** The zoom modifiers as the hint names them (`Ctrl/Alt/Super`, `⌃/⌥/⌘`). @param {string} zoomKeys */
export function zoomWheelLabel(zoomKeys) {
    return parseZoomKeys(zoomKeys).map((k) => ZOOM_LABEL[k]).join('/') || 'no key';
}

/**
 * The copy chord: ⌘C on macOS, Ctrl+Shift+C elsewhere (Ghostty's, kitty's and GNOME Terminal's) — the
 * twin of the paste chord (keyEncoding.isPasteChord: ⌘V, Ctrl+Shift+V). Never Ctrl+C: that is the
 * program's (SIGINT). It copies only with a selection to copy (WallKeys); with none it is a key like
 * any other, as Ghostty's performable copy is.
 * @param {KeyboardEvent} e
 */
export function isCopyChord(e) {
    if (e.key !== 'c' && e.key !== 'C') return false;
    if (IS_MAC) return e.metaKey && !e.ctrlKey && !e.altKey;
    return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/** The copy and paste chords as the hint and the menu name them. */
export const COPY_LABEL = IS_MAC ? '⌘C' : 'Ctrl+Shift+C';
export const PASTE_LABEL = IS_MAC ? '⌘V' : 'Ctrl+Shift+V';

/**
 * The block-selection modifiers, held at a press on a terminal's body: the drag selects a rectangle of
 * columns. Ghostty's rule off macOS (Ctrl or Super, with Alt — kitty's Ctrl+Alt too); on macOS ⌘⌥,
 * since ⌥ alone is the wall's drag-to-move (Ghostty's macOS ⌥-drag) and ⌃ at a press is the secondary click.
 * @param {{ altKey: boolean, ctrlKey: boolean, metaKey: boolean }} e - a pointer event
 */
export function blockSelects(e) {
    return !!e.altKey && (IS_MAC ? !!e.metaKey : !!(e.ctrlKey || e.metaKey));
}

/** What the block-selection modifiers are called on this platform. */
export const BLOCK_SELECT_LABEL = IS_MAC ? '⌘⌥' : 'Ctrl+Alt';

/** @param {KeyboardEvent} e @returns {boolean} true when `e` carries the wall's chord (Shift may ride along) */
export function isChord(e) {
    if (IS_MAC) return e.metaKey;
    return e.ctrlKey && e.altKey && !e.metaKey && !e.getModifierState?.('AltGraph');
}

/**
 * A chord's label for the hint and the palette: `⌘]` / `Ctrl+Alt+]`; several keys share one
 * modifier (`⌘[ ⌘]` / `Ctrl+Alt+[ ]`).
 * @param {string[]} keys - the key glyphs (`[`, `↵`, `0`, `K`)
 * @param {{ shift?: boolean }} [o]
 */
export function chordLabel(keys, { shift = false } = {}) {
    if (IS_MAC) return keys.map((k) => `⌘${shift ? '⇧' : ''}${k}`).join(' ');
    return `Ctrl+Alt+${shift ? 'Shift+' : ''}${keys.join(' ')}`;
}
