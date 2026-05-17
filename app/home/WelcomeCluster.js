/**
 * WelcomeCluster — visitor introspection rendered as 3D glyphs.
 *
 * Takes the structured output of VisitorIntrospect and lays it out as a
 * single CodeGrid block with per-category color accents on the values.
 * The point is to show off the engine immediately: real text, real
 * highlights, real depth — not a static welcome message.
 *
 * The cluster is its own positionable Object3D (the underlying CodeGrid
 * extends THREE.Object3D), so HomeShell can move it freely. NOTE: CodeGrid
 * does NOT add itself to the scene — the caller (us) does. Its constructor
 * briefly adds an inner _rendererGroup to scene then re-parents it to the
 * CodeGrid Object3D, so without an explicit scene.add(grid) the whole
 * subtree is orphaned and renders as black pixels.
 *
 * Public API:
 *   const cluster = new WelcomeCluster({ scene, atlas, facts })
 *   cluster.grid                  → the CodeGrid (Object3D)
 *   cluster.dispose()             → tear down
 */

import CodeGrid from '../../src/collections/CodeGrid.js';

// Palette — values get categorical color tints; labels stay neutral.
// Additive highlights mean these read as a wash over the base text
// color, so they should be confident but not saturated.
const COLORS = {
    browser:  { r: 0.30, g: 0.85, b: 1.00 },  // cyan — the user's tool
    os:       { r: 0.30, g: 0.85, b: 1.00 },
    display:  { r: 0.55, g: 1.00, b: 0.55 },  // green — what they see
    gpu:      { r: 0.55, g: 1.00, b: 0.55 },
    hardware: { r: 1.00, g: 0.80, b: 0.35 },  // amber — silicon
    locale:   { r: 0.85, g: 0.65, b: 1.00 },  // soft purple — place + time
    network:  { r: 1.00, g: 0.55, b: 0.45 },  // warm — pipe
    page:     { r: 0.70, g: 0.70, b: 0.85 },  // dim — the boring bits
};

// Width of the label column. Keep all values left-aligned at the same
// column so the eye reads top-to-bottom cleanly.
const LABEL_COL = 12;

/**
 * Format a single fact row. Returns either null (to skip) or
 * { line, valueStart, valueEnd, color }.
 */
function row(label, value, color) {
    if (value == null || value === '' || value === 'unknown') return null;
    const padded = '  ' + label.padEnd(LABEL_COL - 2, ' ');
    const line = padded + value;
    return {
        line,
        valueStart: padded.length,
        valueEnd: line.length,
        color,
    };
}

/**
 * Translate the structured facts into renderable rows. Each rendered row
 * carries the column range to highlight in its value color.
 *
 * @param {import('./VisitorIntrospect.js').VisitorFacts} facts
 * @returns {{ header: string[], rows: Array<{line,valueStart,valueEnd,color}>, footer: string[] }}
 */
function buildRows(facts) {
    const header = [
        '// hello there.',
        "// here's what your browser told us when it asked for this page.",
        "// nothing below is logged, nothing leaves this tab.",
        '',
    ];

    const rows = [];

    // Browser + OS
    if (facts.browser?.name) {
        const v = [facts.browser.name, facts.browser.version].filter(Boolean).join(' ');
        rows.push(row('browser', v, COLORS.browser));
    }
    if (facts.os?.name) {
        const v = [facts.os.name, facts.os.version].filter(Boolean).join(' ');
        rows.push(row('os', v, COLORS.os));
    }

    // Display
    const d = facts.display;
    if (d) {
        const bits = [];
        bits.push(`${d.viewport.w}×${d.viewport.h}`);
        if (d.dpr && d.dpr !== 1) bits.push(`@${d.dpr}x`);
        if (d.colorScheme) bits.push(d.colorScheme);
        if (d.reducedMotion) bits.push('reduced-motion');
        rows.push(row('display', bits.join('  '), COLORS.display));
    }

    // GPU
    if (facts.gpu?.renderer) {
        // The renderer string is sometimes long ("ANGLE (Apple, Apple M2 Max,
        // OpenGL 4.1)"). Trim parenthesized noise for the headline; full
        // string can still be seen by typing `status` once that exists.
        let r = facts.gpu.renderer.replace(/^ANGLE \(/, '').replace(/\).*$/, '');
        if (r.length > 50) r = r.slice(0, 47) + '...';
        rows.push(row('gpu', r, COLORS.gpu));
    }

    // Hardware
    const h = facts.hardware;
    if (h) {
        const bits = [];
        if (h.cores) bits.push(`${h.cores} cores`);
        if (h.memoryGB) bits.push(`${h.memoryGB} GB`);
        if (h.touchPoints > 0) bits.push(`${h.touchPoints}-touch`);
        if (bits.length) rows.push(row('hardware', bits.join('  '), COLORS.hardware));
    }

    // Locale
    const L = facts.locale;
    if (L) {
        const bits = [L.language];
        if (L.timezone) bits.push(L.timezone);
        bits.push(L.now);
        rows.push(row('locale', bits.join('  '), COLORS.locale));
    }

    // Network
    if (facts.network?.effectiveType) {
        rows.push(row('network', facts.network.effectiveType, COLORS.network));
    }

    // Page
    const p = facts.page;
    if (p?.loadMs != null) {
        rows.push(row('load', `${p.loadMs} ms`, COLORS.page));
    }
    if (p?.referrer) {
        // Strip protocol for visual cleanliness.
        const r = p.referrer.replace(/^https?:\/\//, '');
        rows.push(row('referrer', r, COLORS.page));
    }

    const footer = [
        '',
        '// type a command below, or try one of the shortcuts to the side.',
    ];

    return { header, rows: rows.filter(Boolean), footer };
}

export default class WelcomeCluster {
    /**
     * @param {Object} deps
     * @param {THREE.Scene} deps.scene  passed to CodeGrid for renderer setup
     * @param {Object} deps.atlas       GlyphAtlas (with _shaper + _slugData attached)
     * @param {import('./VisitorIntrospect.js').VisitorFacts} deps.facts
     */
    constructor({ scene, atlas, facts }) {
        this._scene = scene;

        const { header, rows, footer } = buildRows(facts);
        const lines = [
            ...header,
            ...rows.map(r => r.line),
            ...footer,
        ];
        const text = lines.join('\n');

        this.grid = new CodeGrid(scene, atlas, {
            name: 'welcome-visitor-facts',
            showBackground: false,
            showFilename: false,
            // Dim base so the additive highlight colors actually show as
            // colors rather than washing to white. Labels stay at this
            // base tone; values get their categorical accent on top.
            textColor: { r: 0.28, g: 0.28, b: 0.34 },
            gridScale: 1.0,
            worldScale: 0.10,
        });

        this.grid.loadText(text);

        // Position + scene attachment is the layout kit's job now. The
        // caller composes this.grid into a layout tree (HStack, VStack,
        // Center, etc.) which sets position and adds the root to scene.

        // Stash the per-value highlight plan so it can be re-applied after
        // demos (which may clear all highlights as part of their effect).
        const headerOffset = header.length;
        this._highlightPlan = [];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!r) continue;
            this._highlightPlan.push({
                line: headerOffset + i,
                start: r.valueStart,
                end: r.valueEnd,
                color: r.color,
            });
        }
        this.applyHighlights();
    }

    /**
     * Re-apply this cluster's per-value highlights. Call after anything
     * that touches the underlying grid's highlight texture (e.g. a demo
     * that clears highlights during cleanup).
     */
    applyHighlights() {
        for (const h of this._highlightPlan) {
            this.grid.highlightRange(h.line, h.start, h.line, h.end, h.color);
        }
    }

    /** Clear-then-re-apply, for a clean redraw after external mutation. */
    redraw() {
        this.grid.clearAllHighlights?.();
        this.applyHighlights();
    }

    dispose() {
        if (this.grid && typeof this.grid.dispose === 'function') {
            this.grid.dispose();
        }
        if (this.grid?.parent) {
            this.grid.parent.remove(this.grid);
        }
    }
}
