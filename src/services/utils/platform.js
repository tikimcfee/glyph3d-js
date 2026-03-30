/**
 * Platform detection & modifier-key helpers.
 *
 * On macOS, Meta (⌘) is the primary modifier and Alt (⌥) is safe for
 * secondary actions (zoom-scroll, etc.).
 *
 * On Linux, Alt often triggers the window-manager menu bar, so we
 * fall back to Shift for the secondary modifier role.
 *
 * Windows follows the Linux mapping (Alt can activate the menu bar
 * in some apps).
 */

const ua = globalThis.navigator?.userAgent ?? '';

export const isMac   = /Macintosh|Mac OS X/i.test(ua);
export const isLinux = /Linux/i.test(ua) && !/(Android)/i.test(ua);

/**
 * True when the "primary" modifier is held (⌘ on Mac, Ctrl elsewhere).
 * @param {KeyboardEvent|MouseEvent|WheelEvent} e
 */
export function primaryMod(e) {
    return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * True when the "secondary" modifier is held.
 * Alt/Option on Mac (safe there), Shift on Linux/Windows (Alt triggers WM menus).
 * @param {KeyboardEvent|MouseEvent|WheelEvent} e
 */
export function secondaryMod(e) {
    return isMac ? e.altKey : e.shiftKey;
}
