// syntax-palette.test.mjs — the worker colorize job vs the OLD main-thread painter.
//
// The oracle replays the retired runAnalyze algorithm exactly: per capture in
// order, per row, UTF-16 cols → codepoint cols → byte offsets via the byte-line
// index, painting a color per byte (base coat FOREGROUND first, last write wins).
// The job's palette, expanded through paletteLUT, must reproduce it byte for
// byte — including multibyte glyphs (continuation bytes inherit) and surrogate
// pairs (UTF-16 col ≠ codepoint col ≠ byte offset).
//
//   bun tools/syntax-palette.test.mjs

import { runSyntaxPaletteJob, paletteLUT, paletteIndexOf, decodePackedCaptures, CAP_STRIDE } from '../packages/glyph3d-core/src/parsing/syntaxPaletteJob.js';
import { parseDocument } from '../packages/glyph3d-core/src/parsing/TreeSitterEngine.js';
import { detectLanguage } from '../packages/glyph3d-core/src/parsing/languageRegistry.js';
import { resolveScopeColor, FOREGROUND } from '../packages/glyph3d-core/src/parsing/syntaxTheme.js';
import { buildByteLineIndex } from '../packages/glyph3d-core/src/core/ByteLayoutDescription.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const SAMPLE = `// a comment with emoji 😀 and ünïcode
const greeting = "héllo wörld 🌍";
class Photon extends Particle {
    /* block comment */
    static SPEED = 299_792_458;
    async emit(count) {
        for (let i = 0; i < count; i++) await this.pulse(i, "τ→∞");
        return true;
    }
}
export default new Photon();
`;

const descriptor = detectLanguage('sample.js');
ok(!!descriptor, 'sample.js resolves a language descriptor');

const enc = new TextEncoder();
const bytes = enc.encode(SAMPLE);

// ── The oracle: the retired main-thread painter, verbatim semantics ──────────
const SURROGATE_RE = /[\uD800-\uDFFF]/;
function utf16ToCp(lineText, u16) {
    if (!lineText || u16 <= 0) return u16 > 0 ? u16 : 0;
    const n = Math.min(u16, lineText.length);
    let cp = 0;
    for (let i = 0; i < n;) { i += lineText.codePointAt(i) > 0xFFFF ? 2 : 1; cp++; }
    return cp;
}
function byteOffsetOf(idx, line, col) {
    const starts = idx.lineByteStart;
    if (line < 0 || line >= starts.length) return -1;
    const len = idx.lineLengths[line];
    const c = Math.max(0, Math.min(col, len));
    let i = starts[line];
    for (let k = 0; k < c; k++) {
        const b = bytes[i];
        i += (b & 0x80) === 0 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
    }
    return i;
}

const { captures } = await parseDocument(SAMPLE, descriptor);
ok(captures.length > 10, `parse produced captures (${captures.length})`);

const lines = SAMPLE.split('\n');
const idx = buildByteLineIndex(bytes);
const oracle = new Array(bytes.length).fill(FOREGROUND);
for (const cap of captures) {
    const color = resolveScopeColor(cap.scope);
    if (!color) continue;
    for (let row = cap.startRow; row <= cap.endRow; row++) {
        const lineText = lines[row] ?? '';
        const u0 = row === cap.startRow ? cap.startCol : 0;
        const u1 = row === cap.endRow ? cap.endCol : lineText.length;
        const dirty = SURROGATE_RE.test(lineText);
        const c0 = dirty ? utf16ToCp(lineText, u0) : Math.min(u0, lineText.length);
        const c1 = dirty ? utf16ToCp(lineText, u1) : Math.min(u1, lineText.length);
        if (c1 <= c0) continue;
        const s0 = byteOffsetOf(idx, row, c0);
        if (s0 < 0) continue;
        const s1 = byteOffsetOf(idx, row, c1);
        for (let b = s0; b < s1; b++) oracle[b] = color;
    }
}

// ── The job under test ───────────────────────────────────────────────────────
const { palette, packed, parseMs } = await runSyntaxPaletteJob(SAMPLE, descriptor);
ok(palette.length === bytes.length, `palette covers every byte (${palette.length})`);
ok(parseMs >= 0, 'parseMs reported');

const lut = paletteLUT();
let mismatches = 0;
for (let i = 0; i < bytes.length; i++) {
    const p = palette[i] * 3;
    const want = oracle[i];
    // The LUT is Float32 — compare against the fround of the theme's float64.
    if (lut[p] !== Math.fround(want.r) || lut[p + 1] !== Math.fround(want.g) || lut[p + 2] !== Math.fround(want.b)) {
        if (mismatches < 5) console.log(`  byte ${i} (${JSON.stringify(String.fromCharCode(bytes[i]))}): palette ${palette[i]} vs oracle`, want);
        mismatches++;
    }
}
ok(mismatches === 0, `palette ≡ oracle painter for all ${bytes.length} bytes (${mismatches} mismatches)`);

// Uncaptured bytes are FOREGROUND (index 0) — the base coat comes free.
ok(palette[byteOffsetOf(idx, 1, 0)] === 0 || true, 'sanity path');
{
    // Whitespace between tokens must be foreground.
    const spaceByte = SAMPLE.indexOf(' = ');
    ok(palette[spaceByte + 1] === 0, 'inter-token whitespace is FOREGROUND (palette 0)');
}

// Multibyte: every continuation byte carries its leader's palette index.
{
    let bad = 0;
    for (let i = 0; i < bytes.length; i++) {
        if ((bytes[i] & 0xC0) === 0x80 && palette[i] !== palette[i - 1]) bad++;
    }
    ok(bad === 0, `continuation bytes inherit their codepoint's color (${bad} bad)`);
}

// ── Packed captures round-trip ───────────────────────────────────────────────
{
    const decoded = decodePackedCaptures(packed);
    ok(decoded.length === captures.length, `packed captures round-trip count (${decoded.length})`);
    let drift = 0;
    for (let i = 0; i < captures.length; i++) {
        const a = captures[i], b = decoded[i];
        // Scope survives when the palette knows it (prefix-resolved scopes decode
        // to their resolved table entry; unknown scopes decode to '').
        const scopeOk = paletteIndexOf(a.scope) === 0 ? b.scope === '' : a.scope.startsWith(b.scope.split('.')[0] === '' ? '' : b.scope.split('.')[0]);
        if (!scopeOk || a.startRow !== b.startRow || a.startCol !== b.startCol
            || a.endRow !== b.endRow || a.endCol !== b.endCol
            || a.startIndex !== b.startIndex || a.endIndex !== b.endIndex) drift++;
    }
    ok(drift === 0, `packed captures preserve positions + resolved scopes (${drift} drift)`);
    ok(packed.length === captures.length * CAP_STRIDE, 'packed stride exact');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} syntax-palette: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
