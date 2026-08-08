/**
 * SyntaxColorizer.js — the parallel, post-layout analysis pass, split in two by
 * cost profile:
 *
 *   analyzeGrid(grid)        EAGER (every layout, fire-and-forget) — parses for
 *                            highlight captures and paints base glyph colors.
 *                            This runs for every visible file, so it stays lean.
 *   buildGridSemantics(grid) LAZY (on demand, cached by CodeGrid) — a dedicated
 *                            structure-only parse → the grid's SemanticModel. Kept
 *                            OFF the bulk path: a 305-file load colorizes every
 *                            file but walks the AST only for the handful actually
 *                            interrogated. The full-AST walk is the cost we don't
 *                            want to pay ×N on render.
 *
 * The two were one parse; the walk's per-file cost on bulk render is why structure
 * went lazy. A generation token (color) / content identity (structure) aborts or
 * invalidates a stale result.
 *
 * Index model: a glyph's buffer slot == its codepoint index within the line
 * (spaces/tabs slotted, newlines not), and slots run contiguously in source
 * order. tree-sitter reports {row, column} in UTF-16 code units; we convert to
 * codepoint columns (identity for BMP text, i.e. ≈ all code) — for captures, to
 * map a per-line span to one contiguous slot range; for structure, to make the
 * model's columns share the glyph-slot coordinate space.
 */

import { detectLanguage } from './languageRegistry.js';
import { parseDocument, parseStructureSync } from './TreeSitterEngine.js';
import { FOREGROUND } from './syntaxTheme.js';
import { getSyntaxParsePool } from './SyntaxParsePool.js';
import { paletteLUT, decodePackedCaptures } from './syntaxPaletteJob.js';
import { structureSpecFor } from './semanticKinds.js';

/**
 * The analyzer's OWN scheduling policy: rapid repeat generations for one grid
 * (typing — every fold announces one) coalesce into a leading pass plus ONE
 * trailing pass. Layout announces; the analyzer decides when parsing is due —
 * the coalesce window is a parsing concern and lives here, not on the grid.
 * Settings ▸ Code grids dials it through setAnalyzeDebounce. 0 = parse every call.
 */
let _analyzeDebounceMs = 180;
export function setAnalyzeDebounce(ms) { _analyzeDebounceMs = Math.max(0, Number(ms) || 0); }

/** grid → { last, timer } — per-grid coalesce state, GC'd with the grid. */
const _analyzeClock = new WeakMap();
import SemanticModel from './SemanticModel.js';
import { unreadableReason } from '../core/readability.js';
import { loadStats } from '../core/loadStats.js';

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
 * Shared front-half: resolve the grid's language + readable source lines, or null
 * when there's nothing to analyze — an unsupported file type, empty content, or an
 * unreadable artifact we refuse to parse at the 51s column-conversion price.
 * @param {import('../collections/CodeGrid.js').default} grid
 * @returns {{ descriptor: any, text: string, lines: string[] } | null}
 */
function readableSource(grid) {
    const filename = grid.filename || grid.userData?.sourcePath || '';
    const descriptor = detectLanguage(filename);
    if (!descriptor) return null;
    // TODO(load+normalize): captures index into this raw text. If content has \r\n, the
    // 3D builder's split('\n') leaves \r in lines and CM strips it in 2D — both drift.
    // Normalizing line endings at load (CodeGrid.loadText) fixes both paths at once.
    const text = grid.content ?? (grid.lines ? grid.lines.join('\n') : '');
    if (!text || unreadableReason(text)) return null;
    const lines = (grid.lines && grid.lines.length) ? grid.lines : text.split('\n');
    return { descriptor, text, lines };
}

/**
 * Parse the grid's source for highlight captures and paint syntax colors onto its
 * glyphs. No structure here — that's the lazy buildGridSemantics. No-op for
 * unsupported file types or when the renderer/layout isn't ready. Safe to call
 * fire-and-forget; never throws.
 * @param {import('../collections/CodeGrid.js').default} grid
 */
export function analyzeGrid(grid) {
    const wait = _analyzeDebounceMs;
    const st = _analyzeClock.get(grid) || {};
    const now = performance.now();
    if (!wait || !st.last || now - st.last > wait) {
        st.last = now;                                // leading edge: a load parses NOW
        _analyzeClock.set(grid, st);
        return runAnalyze(grid);
    }
    if (!st.timer) {                                  // trailing: one pass when typing pauses
        st.timer = setTimeout(() => {
            st.timer = null;
            st.last = performance.now();
            runAnalyze(grid);                         // reads the CURRENT gen — never stale
        }, wait);
        _analyzeClock.set(grid, st);
    }
}

/** The actual pass — parse OFF-THREAD (content-cached) + ONE palette write. @private */
async function runAnalyze(grid) {
    try {
        const renderer = grid.getRenderer?.();
        if (!renderer || typeof renderer.setGlyphColorRange !== 'function') return;
        const src = readableSource(grid);
        if (!src) return;
        const { descriptor, text } = src;

        const gen = grid._analyzeGen;                 // snapshot before the async parse
        const prev = grid._highlights;
        let palette, packed;
        if (prev?.palette && prev.lang === descriptor.key && prev.content === text) {
            // Same content, same language — a re-layout that didn't edit (a windowed
            // grid's margin crossing, a refold): the job would reproduce this palette
            // byte for byte. Repaint from it; never re-parse per scroll crossing.
            ({ palette, packed } = prev);
        } else {
            // The worker pool: parse + capture→palette run OFF the main thread (the
            // ~1.4s/1500-file wasm block the load profile measured); the main thread
            // gets palette bytes back by transfer. parseWorkerMs sums worker wall —
            // the main-thread cost of this pass is the LUT write below.
            const r = await getSyntaxParsePool().colorize(text, descriptor);
            ({ palette, packed } = r);
            loadStats.analyzeParses++;
            loadStats.parseWorkerMs += r.parseMs || 0;
            if (grid._analyzeGen !== gen) return;     // superseded by a newer layout — abort
        }

        // Stash render-neutral highlight state: the palette (3D repaints), the packed
        // captures (the 2D editor decodes LAZILY via the getter — one file at a time,
        // never a bulk-load's worth of little objects). _setHighlights notifies the
        // 2D subscribers on each (re)parse.
        const hl = { gen, lang: descriptor.key, content: text, palette, packed };
        Object.defineProperty(hl, 'captures', {
            configurable: true,
            get() { return this._caps || (this._caps = decodePackedCaptures(this.packed)); },
        });
        if (typeof grid._setHighlights === 'function') grid._setHighlights(hl);
        else grid._highlights = hl;

        // THE write: base coat + every capture in one pass (palette 0 = FOREGROUND),
        // one update range. The view clamps to its staged window internally.
        if (typeof renderer.setGlyphPaletteRange === 'function') {
            renderer.setGlyphPaletteRange(palette, paletteLUT());
        } else {
            // A non-view renderer (older field surface): base coat only.
            const total = renderer.getGlyphCount?.() ?? 0;
            if (total > 0) renderer.setGlyphColorRange(renderer.sourceBase || 0, total, FOREGROUND);
        }
    } catch (e) {
        console.warn('[tree-sitter] analyzeGrid failed:', e?.message ?? e);
    }
}

/**
 * Build the grid's SemanticModel — the lazy half of analysis. A dedicated
 * structure-only parse (no highlight query), deliberately off the bulk colorize
 * path. CodeGrid.ensureSemantics() owns the caching; this is the pure builder.
 * Returns the model, or null for unsupported/unreadable files. Never throws.
 * @param {import('../collections/CodeGrid.js').default} grid
 * @returns {Promise<SemanticModel|null>}
 */
export async function buildGridSemantics(grid) {
    try {
        const src = readableSource(grid);
        if (!src) return null;
        const { descriptor, text, lines } = src;

        const spec = structureSpecFor(descriptor.key);  // labels the full named-node tree
        const { structure } = await parseDocument(text, descriptor, spec, { captures: false });
        if (!structure) return null;
        return structureToModel(structure, lines);
    } catch (e) {
        console.warn('[tree-sitter] buildGridSemantics failed:', e?.message ?? e);
        return null;
    }
}

/**
 * Synchronous SemanticModel build — same product as buildGridSemantics, but only when
 * the tree-sitter engine + this grammar are already warm (parseStructureSync returns the
 * structure with no await; null when cold). Returns the model, or null to defer to the
 * async path. An arranged grid is always warm (structure.grid built the model), so an
 * edit re-derives its arrangement within the same fold — no stale-semantics flicker.
 * @param {import('../collections/CodeGrid.js').default} grid
 * @returns {SemanticModel|null}
 */
export function buildGridSemanticsSync(grid) {
    try {
        const src = readableSource(grid);
        if (!src) return null;
        const { descriptor, text, lines } = src;
        const spec = structureSpecFor(descriptor.key);
        const structure = parseStructureSync(text, descriptor, spec);
        if (!structure) return null;                     // cold engine/grammar → caller awaits
        return structureToModel(structure, lines);
    } catch (e) {
        console.warn('[tree-sitter] buildGridSemanticsSync failed:', e?.message ?? e);
        return null;
    }
}

/**
 * Shared post-processing for both semantic builders: convert the parse's UTF-16 columns
 * to codepoint columns (so the model shares the glyph-slot space — col == slot offset,
 * resolving to slots through the layout with no further conversion) and wrap into a
 * SemanticModel. Mutates `structure` in place.
 * @param {Array} structure raw structure roots (UTF-16 cols)
 * @param {string[]} lines source lines (for the column converter)
 * @returns {SemanticModel}
 * @private
 */
function structureToModel(structure, lines) {
    const toCp = makeColConverter(lines);
    const normalizeCols = (nodes) => {
        for (const node of nodes) {
            node.start.col = toCp(node.start.line, lines[node.start.line] ?? '', node.start.col);
            node.end.col = toCp(node.end.line, lines[node.end.line] ?? '', node.end.col);
            if (node.children.length) normalizeCols(node.children);
        }
    };
    normalizeCols(structure);
    return new SemanticModel(structure);
}
