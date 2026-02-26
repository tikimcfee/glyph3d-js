/**
 * CodeView - Renders source code in 3D with line-level hover detection
 *
 * The code IS the scene. This class:
 *   - Renders source code text using GlyphRenderer
 *   - Tracks line positions for spatial queries
 *   - Detects which line(s) the mouse is over
 *   - Extracts context windows around the hover point
 *   - Highlights hovered/analyzed regions
 */

import * as THREE from 'three';
import GlyphRenderer from '../../src/GlyphRenderer.js';

const DEFAULT_CONFIG = {
    // Layout
    lineHeight: 1.4,        // Vertical spacing multiplier
    maxLineLength: 200,      // Truncate lines longer than this
    tabWidth: 4,             // Spaces per tab

    // Context window (how many lines to analyze around hover)
    contextRadius: 10,       // Lines above and below hover point
    contextFade: true,       // Fade out lines at edge of context

    // Colors
    dimColor: { r: 0.35, g: 0.38, b: 0.42 },
    hoverColor: { r: 0.6, g: 0.7, b: 0.85 },
    contextColor: { r: 0.45, g: 0.5, b: 0.55 },
    highlightColor: { r: 0.3, g: 1.0, b: 0.6 },    // For matched tokens

    // Visual
    syntaxHinting: true,     // Slightly color comments/strings differently
    commentColor: { r: 0.3, g: 0.45, b: 0.3 },
    stringColor: { r: 0.5, g: 0.4, b: 0.3 },
};

export class CodeView {
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;
        this.config = { ...DEFAULT_CONFIG, ...options };

        // Container
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Renderer
        this.renderer = null;

        // Source data
        this.sourceText = '';
        this.lines = [];            // Array of { text, textId, y, lineNumber }
        this.lineTextIds = [];      // textId per line for color/position updates
        this.fileName = '';

        // Metrics
        this._charWidth = 0;
        this._charHeight = 0;
        this._lineSpacing = 0;

        // Hover state
        this._hoveredLine = -1;
        this._contextStart = -1;
        this._contextEnd = -1;

        // Bounds
        this._bounds = null;
    }

    /**
     * Load and render source code
     * @param {string} text - The source code to display
     * @param {string} fileName - Optional filename for display
     */
    async loadCode(text, fileName = '') {
        this.sourceText = text;
        this.fileName = fileName;
        this.lines = [];
        this.lineTextIds = [];

        // Split into lines and preprocess
        const rawLines = text.split('\n');
        const processedLines = rawLines.map((line, i) => ({
            text: this._expandTabs(line).slice(0, this.config.maxLineLength),
            lineNumber: i,
            original: line,
        }));

        // Estimate total glyphs
        let totalGlyphs = 0;
        for (const line of processedLines) {
            totalGlyphs += line.text.length || 1; // at least 1 for empty lines
        }

        // Create renderer (dispose old one if exists)
        if (this.renderer) {
            this.renderer.dispose();
        }

        this.renderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(totalGlyphs * 1.1) + 100,
            defaultColor: this.config.dimColor,
        });

        // Get metrics
        const metrics = this.renderer.metrics;
        this._charWidth = metrics.charWidth;
        this._charHeight = metrics.charHeight;
        this._lineSpacing = this._charHeight * this.config.lineHeight;

        // Build batch items
        const batchItems = [];

        for (let i = 0; i < processedLines.length; i++) {
            const line = processedLines[i];
            const y = -i * this._lineSpacing;
            const displayText = line.text || ' '; // ensure at least one glyph for empty lines

            // Determine base color (simple syntax hinting)
            let color = this.config.dimColor;
            if (this.config.syntaxHinting) {
                const trimmed = line.text.trimStart();
                if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
                    color = this.config.commentColor;
                }
            }

            batchItems.push({
                text: displayText,
                position: { x: 0, y, z: 0 },
                options: { color },
            });

            this.lines.push({
                text: line.text,
                original: line.original,
                lineNumber: i,
                y,
                color, // original color for reset
            });
        }

        // Render all lines
        const textIds = this.renderer.renderBatch(batchItems);
        this.lineTextIds = textIds;

        // Store IDs in line data
        for (let i = 0; i < this.lines.length; i++) {
            this.lines[i].textId = textIds[i];
        }

        // Calculate bounds
        const maxLineLen = Math.max(...processedLines.map(l => l.text.length), 1);
        const totalWidth = maxLineLen * this._charWidth;
        const totalHeight = processedLines.length * this._lineSpacing;

        this._bounds = {
            min: { x: -2, y: -totalHeight - 2, z: -1 },
            max: { x: totalWidth + 2, y: 2, z: 2 },
            width: totalWidth + 4,
            height: totalHeight + 4,
            center: { x: totalWidth / 2, y: -totalHeight / 2, z: 0 },
        };

        console.log(`CodeView: Rendered ${processedLines.length} lines, ${totalGlyphs} glyphs`);
        return this;
    }

    /**
     * Update hover state from a world-space Y coordinate
     * Returns the context window of lines around the hover point
     *
     * @param {number} worldY - Y coordinate in world space
     * @returns {{ hoveredLine: number, contextLines: Array, contextText: string } | null}
     */
    updateHover(worldY) {
        if (this.lines.length === 0) return null;

        // Convert world Y to line number
        const lineIndex = Math.round(-worldY / this._lineSpacing);
        const clampedLine = Math.max(0, Math.min(this.lines.length - 1, lineIndex));

        // Skip if nothing changed
        if (clampedLine === this._hoveredLine) return null;

        // Reset previous highlight
        this._resetHighlight();

        // Update state
        this._hoveredLine = clampedLine;
        const radius = this.config.contextRadius;
        this._contextStart = Math.max(0, clampedLine - radius);
        this._contextEnd = Math.min(this.lines.length - 1, clampedLine + radius);

        // Highlight context window
        this.renderer.beginBatchUpdate();

        for (let i = this._contextStart; i <= this._contextEnd; i++) {
            const line = this.lines[i];
            const distFromCenter = Math.abs(i - clampedLine);
            const t = distFromCenter / (radius + 1);

            let color;
            if (i === clampedLine) {
                color = this.config.hoverColor;
            } else if (this.config.contextFade) {
                // Interpolate from contextColor toward dimColor
                const fade = t * t; // quadratic falloff
                color = {
                    r: this.config.contextColor.r * (1 - fade) + line.color.r * fade,
                    g: this.config.contextColor.g * (1 - fade) + line.color.g * fade,
                    b: this.config.contextColor.b * (1 - fade) + line.color.b * fade,
                };
            } else {
                color = this.config.contextColor;
            }

            this.renderer.updateColor(line.textId, color);
        }

        this.renderer.endBatchUpdate();

        // Extract context text
        const contextLines = this.lines.slice(this._contextStart, this._contextEnd + 1);
        const contextText = contextLines.map(l => l.original).join('\n');

        return {
            hoveredLine: clampedLine,
            contextStart: this._contextStart,
            contextEnd: this._contextEnd,
            lineCount: this._contextEnd - this._contextStart + 1,
            contextLines,
            contextText,
            hoveredText: this.lines[clampedLine]?.original || '',
        };
    }

    /**
     * Clear hover and reset to default colors
     */
    clearHover() {
        this._resetHighlight();
        this._hoveredLine = -1;
        this._contextStart = -1;
        this._contextEnd = -1;
    }

    /**
     * Highlight specific tokens on specific lines
     * Used to show which tokens matched taxonomy triggers
     *
     * @param {Array<{lineNumber: number, token: string}>} matches
     */
    highlightMatches(matches) {
        // For now, highlight entire lines that have matches
        // (Per-token highlighting would need character-level glyph tracking)
        const matchedLines = new Set(matches.map(m => m.lineNumber));

        this.renderer.beginBatchUpdate();
        for (const lineNum of matchedLines) {
            if (lineNum >= 0 && lineNum < this.lines.length) {
                this.renderer.updateColor(
                    this.lines[lineNum].textId,
                    this.config.highlightColor
                );
            }
        }
        this.renderer.endBatchUpdate();
    }

    /**
     * Get the line at a given ray intersection
     */
    getLineAtRay(ray) {
        // Intersect with Z=0 plane
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersection = new THREE.Vector3();
        if (!ray.intersectPlane(plane, intersection)) return null;

        return {
            worldX: intersection.x,
            worldY: intersection.y,
            lineIndex: Math.round(-intersection.y / this._lineSpacing),
        };
    }

    // ─── Internal ──────────────────────────────────────────────────

    _resetHighlight() {
        if (this._contextStart < 0 || this._contextEnd < 0) return;

        this.renderer.beginBatchUpdate();
        for (let i = this._contextStart; i <= this._contextEnd; i++) {
            if (i >= 0 && i < this.lines.length) {
                const line = this.lines[i];
                this.renderer.updateColor(line.textId, line.color);
            }
        }
        this.renderer.endBatchUpdate();
    }

    _expandTabs(line) {
        const tabWidth = this.config.tabWidth;
        let result = '';
        for (const char of line) {
            if (char === '\t') {
                const spaces = tabWidth - (result.length % tabWidth);
                result += ' '.repeat(spaces);
            } else {
                result += char;
            }
        }
        return result;
    }

    // ─── Public API ────────────────────────────────────────────────

    getBounds() { return this._bounds; }
    getGroup() { return this.group; }
    setScale(s) { this.group.scale.setScalar(s); }
    setPosition(pos) { this.group.position.set(pos.x || 0, pos.y || 0, pos.z || 0); }
    getLineCount() { return this.lines.length; }
    getHoveredLine() { return this._hoveredLine; }
    getSourceText() { return this.sourceText; }
    getCharWidth() { return this._charWidth; }
    getLineSpacing() { return this._lineSpacing; }

    dispose() {
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        this.scene.remove(this.group);
        this.lines = [];
        this.lineTextIds = [];
    }
}

export default CodeView;
