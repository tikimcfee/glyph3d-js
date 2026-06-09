/**
 * SyntaxColorizer.js — the parallel, post-layout coloring pass.
 *
 * Decoupled from the build/layout pipeline: CodeGrid fires colorizeGrid() (fire
 * and forget) after each layout. It parses the grid's source off the critical
 * path, then paints the result into the BASE instanceColor attribute via
 * GlyphField.setGlyphColorRange — no extra GPU memory, no shader change. A
 * generation token aborts a stale pass if the grid relayouts before parsing
 * finishes (edits relayout often).
 *
 * Index model: a glyph's buffer slot == its codepoint index within the line
 * (spaces/tabs slotted, newlines not), and slots run contiguously in source
 * order. tree-sitter reports {row, column} in UTF-16 code units; we convert to
 * codepoint columns (identity for BMP text, i.e. ≈ all code) and map a capture's
 * per-line span to one contiguous slot range.
 */

import { detectLanguage } from './languageRegistry.js';
import { highlight } from './TreeSitterEngine.js';
import { resolveScopeColor, FOREGROUND } from './syntaxTheme.js';

// Colorizing is for READING; past these bounds the content is a built artifact
// (minified bundle, data dump) where token colors are noise and the parse +
// per-capture conversion costs explode — a 3MB single-line bundle once cost 51s
// of pure column conversion. Skip the pass entirely.
const MAX_COLORIZE_CHARS = 1_000_000;
const MAX_COLORIZE_LINE_CHARS = 10_000;

const SURROGATE_RE = /[\uD800-\uDFFF]/;

/**
 * UTF-16 column → codepoint column within a single line. O(column) — the slow
 * path, used only for lines that actually contain surrogate pairs; see
 * makeColConverter for the no-scan fast path the capture loop uses.
 * @param {string} lineText
 * @param {number} utf16Col
 * @returns {number}
 */
function utf16ToCodepointCol(lineText, utf16Col) {
    if (!lineText || utf16Col <= 0) return utf16Col > 0 ? utf16Col : 0;
    const n = Math.min(utf16Col, lineText.length);
    let cp = 0;
    for (let i = 0; i < n;) {
        const c = lineText.codePointAt(i);
        i += c > 0xFFFF ? 2 : 1;
        cp++;
    }
    return cp;
}

/**
 * Per-pass column converter. A line without surrogates maps identically
 * (every non-surrogate UTF-16 unit is one codepoint), so the common case is a
 * clamp, not a scan; each line is regex-tested for surrogates at most once per
 * pass. Without this, conversion cost is captures × column — quadratic on
 * long-line files (the 51s bulk-load regression).
 * @param {string[]} lines
 * @returns {(row: number, lineText: string, utf16Col: number) => number}
 */
function makeColConverter(lines) {
    const hasSurrogates = new Array(lines.length); // lazily: undefined → boolean
    return (row, lineText, utf16Col) => {
        if (utf16Col <= 0) return utf16Col > 0 ? utf16Col : 0;
        let dirty = hasSurrogates[row];
        if (dirty === undefined) dirty = hasSurrogates[row] = SURROGATE_RE.test(lineText);
        return dirty ? utf16ToCodepointCol(lineText, utf16Col) : Math.min(utf16Col, lineText.length);
    };
}

/**
 * Parse the grid's source and paint syntax colors onto its glyphs. No-op for
 * unsupported file types or when the renderer/layout isn't ready. Safe to call
 * fire-and-forget; never throws.
 * @param {import('../collections/CodeGrid.js').default} grid
 */
export async function colorizeGrid(grid) {
    try {
        const filename = grid.filename || grid.userData?.sourcePath || '';
        const descriptor = detectLanguage(filename);
        if (!descriptor) return;

        const renderer = grid.getRenderer?.();
        if (!renderer || typeof renderer.setGlyphColorRange !== 'function') return;
        if (!grid._layout) return;

        // TODO(load+normalize): captures index into this raw text. If content has \r\n, the
        // 3D builder's split('\n') leaves \r in lines and CM strips it in 2D — both drift.
        // Normalizing line endings at load (CodeGrid.loadText) fixes both paths at once.
        const text = grid.content ?? (grid.lines ? grid.lines.join('\n') : '');
        if (!text) return;
        if (text.length > MAX_COLORIZE_CHARS) return;

        const lines = (grid.lines && grid.lines.length) ? grid.lines : text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > MAX_COLORIZE_LINE_CHARS) return;
        }

        const gen = grid._colorizeGen;                 // snapshot before the async parse
        const captures = await highlight(text, descriptor);
        if (grid._colorizeGen !== gen) return;          // superseded by a newer layout — abort

        // Stash the captures on the grid as render-neutral highlight state, so a 2D
        // companion view consumes the SAME single parse (via getHighlights()) instead of
        // re-parsing — one parse, many views. _setHighlights also notifies subscribers
        // (the 2D editor panel) so they refresh on each (re)parse. The 3D apply below
        // reads the same array.
        const hl = { gen, lang: descriptor.key, captures };
        if (typeof grid._setHighlights === 'function') grid._setHighlights(hl);
        else grid._highlights = hl;

        // Cohesive base: paint every glyph FOREGROUND first so the builder's
        // default color doesn't show through between tokens.
        const total = renderer.getGlyphCount?.() ?? 0;
        if (total > 0) renderer.setGlyphColorRange(0, total, FOREGROUND);

        const toCp = makeColConverter(lines);

        for (let k = 0; k < captures.length; k++) {
            const cap = captures[k];
            const color = resolveScopeColor(cap.scope);
            if (!color) continue;
            for (let row = cap.startRow; row <= cap.endRow; row++) {
                const lineText = lines[row] ?? '';
                const u0 = (row === cap.startRow) ? cap.startCol : 0;
                const u1 = (row === cap.endRow) ? cap.endCol : lineText.length;
                const c0 = toCp(row, lineText, u0);
                const c1 = toCp(row, lineText, u1);
                if (c1 <= c0) continue;
                const startSlot = grid.getSlotForChar(row, c0);
                if (startSlot < 0) continue;
                renderer.setGlyphColorRange(startSlot, c1 - c0, color);
            }
        }
    } catch (e) {
        console.warn('[tree-sitter] colorizeGrid failed:', e?.message ?? e);
    }
}
