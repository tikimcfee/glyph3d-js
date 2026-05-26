/**
 * TerminalCapture — browser-side ANSI terminal output parser.
 *
 * Pure functions, no DOM, no Three.js. Safe to run in Worker context.
 *
 * Two exports:
 *   parseCapturePanePlain(raw, cols, rows) — Tier 1: strip ANSI, default color
 *   parseCapturePaneAnsi(raw, cols, rows)  — Tier 2: parse SGR sequences for per-cell color
 *
 * ScreenBuffer contract:
 *   { cols: number, rows: number, cells: TerminalCell[][] }
 *
 * TerminalCell contract:
 *   { codepoint: number, fg: { r: number, g: number, b: number }, bold: boolean }
 */

/** Default foreground color: bright-green terminal aesthetic. */
const DEFAULT_FG = { r: 0.0, g: 1.0, b: 0.0 };

/** Default color for reset state — light grey, readable on black. */
const RESET_FG = { r: 0.8, g: 0.8, b: 0.8 };

/**
 * ANSI 16-color palette (standard + bright variants).
 * Indices 0-7: standard, 8-15: bright.
 * Values are [r, g, b] in 0-1 range, tuned for readability.
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
 * Map an index from the ANSI 16-color table to an RGB object.
 * @param {number} idx - 0..15
 * @returns {{ r: number, g: number, b: number }}
 */
function ansi16toRGB(idx) {
    const c = ANSI_16[idx & 15] || [0.8, 0.8, 0.8];
    return { r: c[0], g: c[1], b: c[2] };
}

/**
 * Map an index in the 256-color palette to RGB.
 * 0-15  : standard ANSI 16 palette
 * 16-231: 6×6×6 color cube
 * 232-255: grayscale ramp
 * @param {number} idx - 0..255
 * @returns {{ r: number, g: number, b: number }}
 */
function ansi256toRGB(idx) {
    if (idx < 16) return ansi16toRGB(idx);
    if (idx >= 232) {
        const v = (idx - 232) / 23;
        return { r: v, g: v, b: v };
    }
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    // cube levels: 0,95,135,175,215,255 → 0, 0.373, 0.529, 0.686, 0.843, 1.0
    const CUBE = [0.0, 0.373, 0.529, 0.686, 0.843, 1.0];
    return { r: CUBE[r], g: CUBE[g], b: CUBE[b] };
}

/**
 * Apply a list of SGR parameter values to a mutable SGR state object.
 * Returns nothing — mutates `state` in place.
 *
 * @param {number[]} params - parsed SGR parameter values
 * @param {{ fg: {r,g,b}, bold: boolean }} state - current color/attribute state
 */
function applySGR(params, state) {
    let i = 0;
    while (i < params.length) {
        const p = params[i];

        if (p === 0 || p === undefined) {
            // Reset
            state.fg = { ...RESET_FG };
            state.bold = false;
        } else if (p === 1) {
            state.bold = true;
        } else if (p === 2 || p === 22) {
            // Dim / normal intensity
            state.bold = false;
        } else if (p >= 30 && p <= 37) {
            // Standard foreground: 30=black, 37=white
            state.fg = ansi16toRGB(p - 30);
        } else if (p === 38) {
            // Extended foreground color
            const sub = params[i + 1];
            if (sub === 2) {
                // 24-bit truecolor: 38;2;R;G;B
                state.fg = {
                    r: (params[i + 2] || 0) / 255,
                    g: (params[i + 3] || 0) / 255,
                    b: (params[i + 4] || 0) / 255,
                };
                i += 4;
            } else if (sub === 5) {
                // 256-color: 38;5;N
                state.fg = ansi256toRGB(params[i + 2] || 0);
                i += 2;
            }
        } else if (p === 39) {
            // Default foreground
            state.fg = { ...RESET_FG };
        } else if (p >= 40 && p <= 47) {
            // Background colors — ignored for phase 1 (no instanceBgColor attribute yet)
        } else if (p === 49) {
            // Default background — ignored
        } else if (p >= 90 && p <= 97) {
            // Bright foreground: 90=bright black, 97=bright white
            state.fg = ansi16toRGB(p - 90 + 8);
        }
        // Unknown params: skip silently (correct behavior per CSI scan spec)

        i++;
    }
}

/**
 * Allocate a fresh ScreenBuffer filled with spaces at the reset foreground color.
 * @param {number} cols
 * @param {number} rows
 * @param {{ r, g, b }} defaultFg
 * @returns {{ cols: number, rows: number, cells: Array<Array<{codepoint:number,fg:{r,g,b},bold:boolean}>> }}
 */
function makeEmptyBuffer(cols, rows, defaultFg) {
    const cells = [];
    for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
            row.push({ codepoint: 32, fg: { ...defaultFg }, bold: false });
        }
        cells.push(row);
    }
    return { cols, rows, cells };
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse raw terminal output (possibly containing ANSI SGR sequences) into a
 * structured ScreenBuffer with per-cell codepoint and foreground color.
 *
 * Handles:
 *   - \x1b[...m  (CSI SGR: colors, bold, reset)
 *   - \x1b[...X  (any other CSI sequence: scanned past without crashing)
 *   - \n         (newline — advance to next row)
 *   - \r         (carriage return — reset column)
 *   - Multibyte Unicode via codePointAt()
 *
 * tmux capture-pane -p -e emits the final screen state with SGR sequences and
 * no cursor-motion CSI codes, so this parser only needs to handle SGR. All
 * other CSI sequences are scanned past gracefully.
 *
 * Pure function — no DOM, no Three.js. Safe for Worker context.
 *
 * @param {string} raw   - Raw terminal output (from capture-pane -p -e)
 * @param {number} cols  - Terminal column count
 * @param {number} rows  - Terminal row count
 * @returns {{ cols: number, rows: number, cells: Array<Array<{codepoint:number,fg:{r,g,b},bold:boolean}>> }}
 */
export function parseCapturePaneAnsi(raw, cols, rows) {
    const buf = makeEmptyBuffer(cols, rows, RESET_FG);

    // SGR state: current foreground color and bold flag
    const state = { fg: { ...RESET_FG }, bold: false };

    let row = 0;
    let col = 0;
    let i = 0;
    const len = raw.length;

    while (i < len) {
        const ch = raw[i];

        if (ch === '\x1b' && raw[i + 1] === '[') {
            // CSI sequence: \x1b[ <param bytes 0x30-0x3F> <intermediate bytes 0x20-0x2F> <final byte 0x40-0x7E>
            // Scan for the final byte in range 0x40–0x7E.
            i += 2; // skip ESC [
            const paramStart = i;
            while (i < len) {
                const code = raw.charCodeAt(i);
                if (code >= 0x40 && code <= 0x7e) {
                    // This is the final byte
                    const finalByte = raw[i];
                    if (finalByte === 'm') {
                        // SGR: parse params between paramStart and i
                        const paramStr = raw.slice(paramStart, i);
                        const params = paramStr.length === 0
                            ? [0]
                            : paramStr.split(';').map(s => s === '' ? 0 : parseInt(s, 10));
                        applySGR(params, state);
                    }
                    // Any other final byte: skip the sequence silently
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (ch === '\x1b') {
            // Non-CSI escape sequence (e.g., \x1b= or \x1b7): skip next char
            i += 2;
            continue;
        }

        if (ch === '\n') {
            row++;
            col = 0;
            i++;
            continue;
        }

        if (ch === '\r') {
            col = 0;
            i++;
            continue;
        }

        // Visible character
        if (row < rows && col < cols) {
            // Handle supplementary plane characters (emoji, etc.)
            const codepoint = raw.codePointAt(i) || 32;
            const cell = buf.cells[row][col];
            cell.codepoint = codepoint;
            cell.fg = { r: state.fg.r, g: state.fg.g, b: state.fg.b };
            cell.bold = state.bold;
            col++;
        }

        // Advance past this code point (may be a surrogate pair = 2 chars in JS string)
        const codepoint = raw.codePointAt(i);
        i += (codepoint > 0xFFFF) ? 2 : 1;
    }

    return buf;
}

/**
 * Parse plain terminal output (no ANSI, already stripped) into a ScreenBuffer
 * with the default foreground color on every cell.
 *
 * Use this for Tier 1 bridges that send `capture-pane -p` output (no -e flag).
 * If the input accidentally contains ANSI sequences they are silently skipped.
 *
 * Pure function — no DOM, no Three.js.
 *
 * @param {string} raw   - Plain text terminal output
 * @param {number} cols  - Terminal column count
 * @param {number} rows  - Terminal row count
 * @returns {{ cols: number, rows: number, cells: Array<Array<{codepoint:number,fg:{r,g,b},bold:boolean}>> }}
 */
export function parseCapturePanePlain(raw, cols, rows) {
    const buf = makeEmptyBuffer(cols, rows, DEFAULT_FG);

    let row = 0;
    let col = 0;
    let i = 0;
    const len = raw.length;

    while (i < len) {
        const ch = raw[i];

        if (ch === '\x1b') {
            // Skip any escape sequence: scan to first byte in 0x40-0x7E after [, or just skip 2
            if (raw[i + 1] === '[') {
                i += 2;
                while (i < len) {
                    const code = raw.charCodeAt(i);
                    i++;
                    if (code >= 0x40 && code <= 0x7e) break;
                }
            } else {
                i += 2;
            }
            continue;
        }

        if (ch === '\n') {
            row++;
            col = 0;
            i++;
            continue;
        }

        if (ch === '\r') {
            col = 0;
            i++;
            continue;
        }

        if (row < rows && col < cols) {
            const codepoint = raw.codePointAt(i) || 32;
            buf.cells[row][col].codepoint = codepoint;
            col++;
        }

        const codepoint = raw.codePointAt(i);
        i += (codepoint > 0xFFFF) ? 2 : 1;
    }

    return buf;
}
