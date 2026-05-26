/**
 * Glyph-level highlight commands: highlight individual characters, ranges,
 * lines, or text patterns within loaded code grids.
 *
 * All coordinates are 0-based. Colors are additive (written to instanceAddedColor).
 * Grids are resolved by index or path suffix (same as other commands).
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

/** Named color presets for quick CLI use */
const COLOR_PRESETS = {
    blue:    { r: 0.3, g: 0.8, b: 1.0 },
    green:   { r: 0.2, g: 1.0, b: 0.4 },
    red:     { r: 1.0, g: 0.3, b: 0.3 },
    yellow:  { r: 1.0, g: 0.9, b: 0.2 },
    orange:  { r: 1.0, g: 0.6, b: 0.1 },
    purple:  { r: 0.7, g: 0.3, b: 1.0 },
    cyan:    { r: 0.2, g: 1.0, b: 1.0 },
    white:   { r: 0.6, g: 0.6, b: 0.6 },
};

const DEFAULT_COLOR = COLOR_PRESETS.blue;

/**
 * Parse color from args — supports named presets or r g b floats.
 * Returns [color, argsConsumed].
 */
function parseColor(args, startIdx) {
    if (startIdx >= args.length) return [DEFAULT_COLOR, 0];

    // Named preset?
    const name = args[startIdx].toLowerCase();
    if (COLOR_PRESETS[name]) return [COLOR_PRESETS[name], 1];

    // RGB floats?
    if (startIdx + 2 < args.length) {
        const r = parseFloat(args[startIdx]);
        const g = parseFloat(args[startIdx + 1]);
        const b = parseFloat(args[startIdx + 2]);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
            return [{ r, g, b }, 3];
        }
    }

    return [DEFAULT_COLOR, 0];
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerHighlightCommands(router) {

    // ================================================================
    //  highlight.glyph <grid> <line> <col> [color]
    // ================================================================

    router.register('highlight.glyph', (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: highlight.glyph <grid> <line> <col> [color]', data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };

        const line = parseInt(args[1]);
        const col = parseInt(args[2]);
        if (isNaN(line) || isNaN(col)) {
            return { text: 'ERR: line and col must be numbers', data: null };
        }

        const [color] = parseColor(args, 3);
        const { grid } = resolved;

        const slot = grid.getSlotForChar(line, col);
        if (slot < 0) {
            return { text: `ERR: (${line}, ${col}) out of range`, data: null };
        }

        grid.highlightRange(line, col, line, col + 1, color);

        return {
            text: `OK: highlighted glyph at ${grid.userData?.sourcePath || resolved.idx}:${line}:${col}`,
            data: { line, col, slot, color }
        };
    }, {
        description: 'Highlight a single character',
        usage: '<grid> <line> <col> [color]'
    });

    // ================================================================
    //  highlight.range <grid> <line> <colStart> <colEnd> [color]
    // ================================================================

    router.register('highlight.range', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: highlight.range <grid> <line> <colStart> <colEnd> [color]', data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };

        const line = parseInt(args[1]);
        const colStart = parseInt(args[2]);
        const colEnd = parseInt(args[3]);
        if ([line, colStart, colEnd].some(isNaN)) {
            return { text: 'ERR: line, colStart, colEnd must be numbers', data: null };
        }

        const [color] = parseColor(args, 4);
        const { grid } = resolved;

        grid.highlightRange(line, colStart, line, colEnd, color);

        const count = colEnd - colStart;
        return {
            text: `OK: highlighted ${count} chars at ${grid.userData?.sourcePath || resolved.idx}:${line}:${colStart}-${colEnd}`,
            data: { line, colStart, colEnd, count, color }
        };
    }, {
        description: 'Highlight a character range on one line',
        usage: '<grid> <line> <colStart> <colEnd> [color]'
    });

    // ================================================================
    //  highlight.lines <grid> <startLine> [endLine] [color]
    // ================================================================

    router.register('highlight.lines', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: highlight.lines <grid> <startLine> [endLine] [color]', data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };

        const startLine = parseInt(args[1]);
        if (isNaN(startLine)) {
            return { text: 'ERR: startLine must be a number', data: null };
        }

        // endLine is optional — could be a number or the start of color args
        let endLine = startLine;
        let colorArgStart = 2;

        if (args.length > 2) {
            const maybeEnd = parseInt(args[2]);
            if (!isNaN(maybeEnd) && maybeEnd >= startLine) {
                endLine = maybeEnd;
                colorArgStart = 3;
            }
        }

        const [color] = parseColor(args, colorArgStart);
        const { grid } = resolved;

        // Highlight full lines
        for (let line = startLine; line <= endLine; line++) {
            const slotCount = grid.getLineSlotCount(line);
            if (slotCount > 0) {
                grid.highlightRange(line, 0, line, slotCount, color);
            }
        }

        const lineCount = endLine - startLine + 1;
        return {
            text: `OK: highlighted ${lineCount} line(s) at ${grid.userData?.sourcePath || resolved.idx}:${startLine}-${endLine}`,
            data: { startLine, endLine, lineCount, color }
        };
    }, {
        description: 'Highlight one or more full lines',
        usage: '<grid> <startLine> [endLine] [color]'
    });

    // ================================================================
    //  highlight.token <grid> <text> [color]
    // ================================================================

    router.register('highlight.token', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: highlight.token <grid> <text> [color]', data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };

        const pattern = args[1];
        const [color] = parseColor(args, 2);
        const { grid } = resolved;

        if (!grid.lines || grid.lines.length === 0) {
            return { text: 'ERR: grid has no content', data: null };
        }

        // Search all lines for the pattern, highlight each occurrence
        const matches = [];
        for (let lineIdx = 0; lineIdx < grid.lines.length; lineIdx++) {
            const lineText = grid.lines[lineIdx];
            let searchStart = 0;
            while (true) {
                const pos = lineText.indexOf(pattern, searchStart);
                if (pos === -1) break;

                // The buffer slots every codepoint, so the highlight column is
                // simply the codepoint index — count codepoints before the match
                // (spreading by codepoint handles surrogate pairs correctly).
                const col = [...lineText.slice(0, pos)].length;
                const len = [...pattern].length;

                if (len > 0) {
                    grid.highlightRange(lineIdx, col, lineIdx, col + len, color);
                    matches.push({ line: lineIdx, col, len });
                }

                searchStart = pos + pattern.length;
            }
        }

        return {
            text: `OK: highlighted ${matches.length} occurrence(s) of "${pattern}"`,
            data: { pattern, matches, count: matches.length, color }
        };
    }, {
        description: 'Highlight all occurrences of a text pattern',
        usage: '<grid> <text> [color]'
    });

    // ================================================================
    //  highlight.clear [grid] [line]
    // ================================================================

    router.register('highlight.clear', (args, ctx) => {
        // No args: clear ALL highlights on ALL grids
        if (args.length === 0) {
            const grids = ctx.getGrids();
            let count = 0;
            for (const grid of grids) {
                if (grid.clearAllHighlights) {
                    grid.clearAllHighlights();
                    count++;
                }
            }
            return {
                text: `OK: cleared highlights on ${count} grid(s)`,
                data: { cleared: count, scope: 'all' }
            };
        }

        // One arg: clear all highlights on one grid
        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };
        const { grid } = resolved;

        if (args.length === 1) {
            grid.clearAllHighlights();
            return {
                text: `OK: cleared all highlights on ${grid.userData?.sourcePath || resolved.idx}`,
                data: { scope: 'grid' }
            };
        }

        // Two args: clear highlights on one line
        const line = parseInt(args[1]);
        if (isNaN(line)) {
            return { text: 'ERR: line must be a number', data: null };
        }
        grid.clearLineHighlight(line);
        return {
            text: `OK: cleared highlights on line ${line}`,
            data: { scope: 'line', line }
        };
    }, {
        description: 'Clear glyph highlights',
        usage: '[grid] [line]'
    });
}
