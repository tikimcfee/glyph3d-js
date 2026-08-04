// src/services/tour/TourAnnotator.js

import CodeGrid from '../../collections/CodeGrid.js';

/** Named color presets for tour annotations */
const COLOR_PRESETS = {
    blue:   { r: 0.3, g: 0.8, b: 1.0 },
    green:  { r: 0.2, g: 1.0, b: 0.4 },
    red:    { r: 1.0, g: 0.3, b: 0.3 },
    yellow: { r: 1.0, g: 0.9, b: 0.2 },
    purple: { r: 0.7, g: 0.3, b: 1.0 },
};

/**
 * Manages glyph highlights and floating labels for tour steps.
 * Uses 0-based coordinates from the resolver (no further conversion needed).
 * Tracks highlighted lines per step so teardown can clear exactly what was applied.
 */
export default class TourAnnotator {
    constructor(ctx) {
        this._ctx = ctx;

        /**
         * Per-step highlight tracking for teardown.
         * Maps stepId -> Array of { grid, startLine, endLine }
         * @type {Map<string, Array<{ grid: Object, startLine: number, endLine: number }>>}
         */
        this._stepHighlights = new Map();
    }

    /**
     * Apply highlights and labels for a tour step. Returns annotation IDs.
     * All coordinates in resolved refs are already 0-based (converted by TourResolver).
     * @param {import('./TourSequencer.js').TourStep} step
     * @returns {string[]} annotation IDs (label grid registry IDs)
     */
    apply(step) {
        const ids = [];
        const highlights = [];

        for (const resolved of step.refs) {
            if (!resolved.grid) continue;
            const ref = resolved.ref;
            // Color comes from the raw ref's color field (string preset name)
            const color = COLOR_PRESETS[ref.color] || COLOR_PRESETS.blue;

            // Highlight the referenced range — use 0-based coords from resolver
            if (resolved.line0 != null) {
                const startLine = resolved.line0;
                const endLine   = resolved.endLine0 ?? startLine;
                const startCol  = resolved.col0 ?? 0;
                const endCol    = resolved.endCol0 ??
                    (resolved.grid.getLineSlotCount?.(endLine) || 80);

                resolved.grid.highlightRange(startLine, startCol, endLine, endCol, color);
                highlights.push({ grid: resolved.grid, startLine, endLine });
            }

            // Token search highlight — track affected lines for teardown
            if (ref.token) {
                const tokenLines = this._highlightToken(resolved.grid, ref.token, color);
                for (const tl of tokenLines) {
                    highlights.push(tl);
                }
            }

            // Floating label
            if (ref.label) {
                const id = this._createLabel(resolved, ref.label, step.id);
                ids.push(id);
            }
        }

        this._stepHighlights.set(step.id, highlights);
        return ids;
    }

    /**
     * Remove annotation labels by ID.
     * @param {string[]} ids
     */
    remove(ids) {
        for (const id of ids) {
            const entry = this._ctx.registry.get(id);
            if (entry) {
                entry.grid.dispose?.();
                this._ctx.scene.remove(entry.grid);
                this._ctx.registry.unregister(id);
            }
        }
    }

    /**
     * Clear highlights applied during a step's apply() call.
     * Iterates all highlighted lines and calls clearLineHighlight per line.
     * @param {string} stepId
     */
    removeHighlights(stepId) {
        const highlights = this._stepHighlights.get(stepId);
        if (!highlights) return;
        for (const { grid, startLine, endLine } of highlights) {
            for (let line = startLine; line <= endLine; line++) {
                grid.clearLineHighlight(line);
            }
        }
        this._stepHighlights.delete(stepId);
    }

    /** @private */
    _createLabel(resolved, text, stepId) {
        const id = `tour-label-${stepId}-${Date.now().toString(36)}`;
        const grid = new CodeGrid(this._ctx.scene, this._ctx.atlas, {
            name: id,
            showBackground: true,
            showFilename: false,
            textColor: { r: 1.0, g: 0.9, b: 0.6 },
            backgroundColor: 0x1a1a2e,
            backgroundOpacity: 0.85,
            backgroundPadding: 1.0,
            gridScale: 0.8,
        });

        void grid.loadText(text);

        // Position label above the referenced grid
        const bounds = resolved.grid.getBounds?.();
        if (bounds) {
            grid.position.set(bounds.min.x, bounds.max.y + 2, bounds.min.z - 1);
        }

        this._ctx.scene.add(grid);
        this._ctx.registry.register(id, grid, { type: 'tour-annotation', stepId });

        return id;
    }

    /**
     * @private
     * @returns {Array<{ grid, startLine: number, endLine: number }>} affected lines for teardown
     */
    _highlightToken(grid, token, color) {
        const affected = [];
        if (!grid.lines?.length) return affected;
        for (let lineIdx = 0; lineIdx < grid.lines.length; lineIdx++) {
            const lineText = grid.lines[lineIdx];
            let searchStart = 0;
            while (true) {
                const pos = lineText.indexOf(token, searchStart);
                if (pos === -1) break;

                // The buffer slots every codepoint, so the highlight column is
                // the codepoint index — count codepoints before the match
                // (spreading by codepoint handles surrogate pairs correctly).
                const col = [...lineText.slice(0, pos)].length;
                const len = [...token].length;

                if (len > 0) {
                    grid.highlightRange(lineIdx, col, lineIdx, col + len, color);
                    affected.push({ grid, startLine: lineIdx, endLine: lineIdx });
                }
                searchStart = pos + token.length;
            }
        }
        return affected;
    }
}
