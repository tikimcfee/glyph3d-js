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

/**
 * UTF-16 column → codepoint column within a single line. O(column); lines are
 * short and only captured spans are converted, so there's no whole-file scan.
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

        const text = grid.content ?? (grid.lines ? grid.lines.join('\n') : '');
        if (!text) return;

        const gen = grid._colorizeGen;                 // snapshot before the async parse
        const captures = await highlight(text, descriptor);
        if (grid._colorizeGen !== gen) return;          // superseded by a newer layout — abort

        // Cohesive base: paint every glyph FOREGROUND first so the builder's
        // default color doesn't show through between tokens.
        const total = renderer.getGlyphCount?.() ?? 0;
        if (total > 0) renderer.setGlyphColorRange(0, total, FOREGROUND);

        const lines = (grid.lines && grid.lines.length) ? grid.lines : text.split('\n');

        for (let k = 0; k < captures.length; k++) {
            const cap = captures[k];
            const color = resolveScopeColor(cap.scope);
            if (!color) continue;
            for (let row = cap.startRow; row <= cap.endRow; row++) {
                const lineText = lines[row] ?? '';
                const u0 = (row === cap.startRow) ? cap.startCol : 0;
                const u1 = (row === cap.endRow) ? cap.endCol : lineText.length;
                const c0 = utf16ToCodepointCol(lineText, u0);
                const c1 = utf16ToCodepointCol(lineText, u1);
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
