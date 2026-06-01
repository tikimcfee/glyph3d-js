/**
 * Terminal color palette — ANSI 16 + 256-color → RGB (0..1), tuned for readability.
 *
 * Lifted out of the retired TerminalCapture SGR snapshot parser: the palette is the
 * part that survives the move to a real headless VT emulator. Consumed by
 * TerminalEmulator's IBufferCell → ScreenBuffer adapter (xterm gives us a color MODE
 * + value; this maps palette/256 indices to RGB).
 */

/** Default foreground (reset / "default fg" state) — light grey, readable on dark. */
export const RESET_FG = { r: 0.8, g: 0.8, b: 0.8 };

/**
 * ANSI 16-color palette (0-7 standard, 8-15 bright). [r, g, b] in 0-1, tuned for
 * readability on a dark panel rather than physically accurate.
 */
const ANSI_16 = [
    // Standard colors (0-7)
    [0.0,  0.0,  0.0 ],  // 0: black
    [0.7,  0.1,  0.1 ],  // 1: red
    [0.1,  0.7,  0.1 ],  // 2: green
    [0.7,  0.7,  0.1 ],  // 3: yellow
    [0.1,  0.1,  0.9 ],  // 4: blue
    [0.7,  0.1,  0.7 ],  // 5: magenta
    [0.1,  0.7,  0.7 ],  // 6: cyan
    [0.75, 0.75, 0.75],  // 7: white (light grey)
    // Bright colors (8-15)
    [0.4,  0.4,  0.4 ],  // 8: bright black (dark grey)
    [1.0,  0.3,  0.3 ],  // 9: bright red
    [0.3,  1.0,  0.3 ],  // 10: bright green
    [1.0,  1.0,  0.3 ],  // 11: bright yellow
    [0.4,  0.4,  1.0 ],  // 12: bright blue
    [1.0,  0.3,  1.0 ],  // 13: bright magenta
    [0.3,  1.0,  1.0 ],  // 14: bright cyan
    [1.0,  1.0,  1.0 ],  // 15: bright white
];

/**
 * Map a 0..15 ANSI index to an RGB object.
 * @param {number} idx
 * @returns {{ r: number, g: number, b: number }}
 */
export function ansi16toRGB(idx) {
    const c = ANSI_16[idx & 15] || [0.8, 0.8, 0.8];
    return { r: c[0], g: c[1], b: c[2] };
}

/**
 * Map a 0..255 palette index to RGB.
 * 0-15: ANSI 16 · 16-231: 6×6×6 cube · 232-255: grayscale ramp.
 * @param {number} idx
 * @returns {{ r: number, g: number, b: number }}
 */
export function ansi256toRGB(idx) {
    if (idx < 16) return ansi16toRGB(idx);
    if (idx >= 232) {
        const v = (idx - 232) / 23;
        return { r: v, g: v, b: v };
    }
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    // cube levels: 0,95,135,175,215,255 → normalized
    const CUBE = [0.0, 0.373, 0.529, 0.686, 0.843, 1.0];
    return { r: CUBE[r], g: CUBE[g], b: CUBE[b] };
}
