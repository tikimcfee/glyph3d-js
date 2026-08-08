/**
 * syntaxPaletteJob — the pure colorize job: (text, descriptor) → per-byte
 * palette indices + packed captures. ONE function, run identically inside a
 * SyntaxParseWorker (production — the ~1.4s/1500-file main-thread tree-sitter
 * block moves off-thread) or on the main thread (the no-Worker fallback:
 * tests, headless). Worker-safe by construction: tree-sitter wasm + TextEncoder
 * + typed arrays, no DOM, no three.
 *
 * The palette speaks SOURCE BYTES — slot == byte offset is the pipeline's
 * canonical ruler, so `palette[i]` colors the glyph at byte i directly. Index 0
 * is FOREGROUND (the base coat comes free: the one palette write covers every
 * staged byte). Captures also return PACKED (7 × u32 per capture + a scope
 * table) so the 2D editor's consumer decodes lazily on the main thread instead
 * of paying a structured clone of thousands of little objects per file.
 */

import { parseDocument } from './TreeSitterEngine.js';
import { DEFAULT_SYNTAX_THEME, FOREGROUND, resolveScopeColor } from './syntaxTheme.js';

const _enc = new TextEncoder();

/**
 * The palette table: index 0 = FOREGROUND, then one slot per theme scope in a
 * STABLE order (sorted keys — theme insertion order is not a contract).
 * Main thread and worker derive the identical table from the identical theme.
 */
export const PALETTE_SCOPES = Object.freeze([...Object.keys(DEFAULT_SYNTAX_THEME)].sort());

const _scopeIndex = new Map(PALETTE_SCOPES.map((s, i) => [s, i + 1]));

/** Longest-dotted-prefix scope → palette index (0 = no color = FOREGROUND). */
export function paletteIndexOf(scope) {
    let s = scope || '';
    while (s) {
        const i = _scopeIndex.get(s);
        if (i !== undefined) return i;
        const dot = s.lastIndexOf('.');
        if (dot < 0) return 0;
        s = s.slice(0, dot);
    }
    return 0;
}

/**
 * Palette index → {r,g,b} lookup as a flat Float32Array [(N+1)×3], row 0 =
 * FOREGROUND. Built once per theme object (WeakMap-cached).
 */
const _lutCache = new WeakMap();
export function paletteLUT(theme = DEFAULT_SYNTAX_THEME) {
    let lut = _lutCache.get(theme);
    if (lut) return lut;
    lut = new Float32Array((PALETTE_SCOPES.length + 1) * 3);
    lut[0] = FOREGROUND.r; lut[1] = FOREGROUND.g; lut[2] = FOREGROUND.b;
    for (let i = 0; i < PALETTE_SCOPES.length; i++) {
        const c = resolveScopeColor(PALETTE_SCOPES[i], theme) || FOREGROUND;
        const o = (i + 1) * 3;
        lut[o] = c.r; lut[o + 1] = c.g; lut[o + 2] = c.b;
    }
    _lutCache.set(theme, lut);
    return lut;
}

/** Packed capture layout: 7 × u32 per capture. */
export const CAP_STRIDE = 7;
export const CAP_SCOPE = 0, CAP_SROW = 1, CAP_SCOL = 2, CAP_EROW = 3, CAP_ECOL = 4, CAP_SIDX = 5, CAP_EIDX = 6;

/**
 * Decode packed captures back to the classic Capture objects (the 2D editor's
 * shape). Main-thread, one file at a time, on demand.
 * @param {Uint32Array} packed
 * @returns {Array<{scope:string,startRow:number,startCol:number,endRow:number,endCol:number,startIndex:number,endIndex:number}>}
 */
export function decodePackedCaptures(packed) {
    const n = (packed.length / CAP_STRIDE) | 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * CAP_STRIDE;
        out[i] = {
            scope: PALETTE_SCOPES[packed[o + CAP_SCOPE] - 1] ?? '',
            startRow: packed[o + CAP_SROW], startCol: packed[o + CAP_SCOL],
            endRow: packed[o + CAP_EROW], endCol: packed[o + CAP_ECOL],
            startIndex: packed[o + CAP_SIDX], endIndex: packed[o + CAP_EIDX],
        };
    }
    return out;
}

const SURROGATE_RE = /[\uD800-\uDFFF]/;

/**
 * The job. Parses `text`, fills a per-byte palette from the captures (applied
 * in capture order — last write wins per byte, the colorizer's contract), and
 * packs the captures.
 *
 * Byte mapping mirrors the byte pipeline's ruler exactly: per line, tree-sitter
 * UTF-16 cols → codepoint cols (identity for surrogate-free lines) → a byte
 * walk over the line's UTF-8 (leader bytes advance the codepoint count;
 * continuation bytes inherit the codepoint's color, so multibyte glyphs paint
 * whole).
 *
 * @param {string} text
 * @param {{ key:string, grammarUrl:string, query:string }} descriptor
 * @returns {Promise<{ palette: Uint8Array, packed: Uint32Array, parseMs: number }>}
 */
export async function runSyntaxPaletteJob(text, descriptor) {
    const t0 = performance.now();
    const { captures } = await parseDocument(text, descriptor);

    const bytes = _enc.encode(text);
    const palette = new Uint8Array(bytes.length);   // 0 = FOREGROUND everywhere

    // Line index over the bytes: line -> first byte offset (the job's own tiny
    // buildByteLineIndex — no core imports beyond parsing/).
    let lines = 1;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A) lines++;
    const lineByteStart = new Int32Array(lines);
    {
        let line = 0;
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0x0A) { line++; lineByteStart[line] = i + 1; }
        }
    }
    const lineEnd = (line) => (line + 1 < lines ? lineByteStart[line + 1] - 1 : bytes.length);

    // Per-line UTF-16→codepoint col conversion, surrogate-tested once per line
    // (the colorizer's makeColConverter discipline — without it, conversion is
    // captures × column, quadratic on long-line files).
    const textLines = text.split('\n');
    const hasSurrogates = new Array(lines);
    const toCp = (row, u16col) => {
        if (u16col <= 0) return 0;
        const lt = textLines[row] ?? '';
        let dirty = hasSurrogates[row];
        if (dirty === undefined) dirty = hasSurrogates[row] = SURROGATE_RE.test(lt);
        if (!dirty) return Math.min(u16col, lt.length);
        let cp = 0;
        for (let u = 0; u < u16col && u < lt.length; cp++) u += lt.codePointAt(u) > 0xFFFF ? 2 : 1;
        return cp;
    };

    // (line, cpCol) → byte offset: walk the line's leaders. O(col) per lookup at
    // capture rate — same cost shape byteOffsetOf has on the main thread today.
    const byteAt = (row, cpCol) => {
        let i = lineByteStart[row];
        const end = lineEnd(row);
        for (let k = 0; k < cpCol && i < end; k++) {
            const b = bytes[i];
            i += (b & 0x80) === 0 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
        }
        return i;
    };

    const packed = new Uint32Array(captures.length * CAP_STRIDE);
    for (let k = 0; k < captures.length; k++) {
        const cap = captures[k];
        const idx = paletteIndexOf(cap.scope);
        const o = k * CAP_STRIDE;
        packed[o + CAP_SCOPE] = idx;
        packed[o + CAP_SROW] = cap.startRow; packed[o + CAP_SCOL] = cap.startCol;
        packed[o + CAP_EROW] = cap.endRow; packed[o + CAP_ECOL] = cap.endCol;
        packed[o + CAP_SIDX] = cap.startIndex; packed[o + CAP_EIDX] = cap.endIndex;
        if (idx === 0) continue;
        const lastRow = Math.min(cap.endRow, lines - 1);
        for (let row = cap.startRow; row <= lastRow; row++) {
            const from = row === cap.startRow ? byteAt(row, toCp(row, cap.startCol)) : lineByteStart[row];
            const to = row === cap.endRow ? byteAt(row, toCp(row, cap.endCol)) : lineEnd(row);
            if (to > from) palette.fill(idx, from, to);
        }
    }

    return { palette, packed, parseMs: performance.now() - t0 };
}
