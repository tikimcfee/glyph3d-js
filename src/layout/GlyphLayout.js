/**
 * GlyphLayout - Handles text layout and positioning
 *
 * Converts text strings into positioned glyphs with proper
 * spacing, alignment, and flow control.
 *
 * Uses standardized dimensions from the renderer's metrics
 * which come from RenderingConstants.js
 */

class GlyphLayout {
    /**
     * Create a layout manager
     * @param {Object} metrics - Font metrics from renderer (via RenderingConstants)
     */
    constructor(metrics) {
        this.metrics = metrics;

        // Layout grid for terminal-style positioning
        this.grid = {
            columns: 80,  // Default terminal width
            rows: 24,     // Default terminal height
            origin: { x: 0, y: 0, z: 0 }
        };

        // Current cursor for streaming text
        this.cursor = {
            x: 0,
            y: 0,
            z: 0,
            column: 0,
            row: 0
        };
    }

    /**
     * Layout text with automatic positioning
     * @param {string} text - Text to layout
     * @param {Object} startPosition - Starting position {x, y, z}
     * @param {string} alignment - Text alignment: 'left', 'center', 'right'
     * @returns {Array} Array of positions for each character
     */
    layoutText(text, startPosition, alignment = 'left') {
        const positions = [];
        const lineWidth = this._measureLineWidth(text);

        // Calculate alignment offset
        let alignOffset = 0;
        if (alignment === 'center') {
            alignOffset = -lineWidth / 2;
        } else if (alignment === 'right') {
            alignOffset = -lineWidth;
        }

        let x = startPosition.x + alignOffset;
        let y = startPosition.y;
        const z = startPosition.z;

        // Process each character
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Handle newlines
            if (char === '\n') {
                x = startPosition.x + alignOffset;
                y -= this.metrics.lineSpacing;
                continue;
            }

            // Add position for this character
            positions.push({
                x: x,
                y: y,
                z: z
            });

            // Advance cursor
            x += this.metrics.charWidth + this.metrics.letterSpacing;
        }

        return positions;
    }

    /**
     * Layout text in a grid (terminal-style)
     * @param {string} text - Text to layout
     * @param {number} row - Grid row (0-based)
     * @param {number} column - Grid column (0-based)
     * @returns {Array} Array of positions
     */
    layoutGrid(text, row, column) {
        const startX = this.grid.origin.x + column * (this.metrics.charWidth + this.metrics.letterSpacing);
        const startY = this.grid.origin.y - row * this.metrics.lineSpacing;

        return this.layoutText(text, {
            x: startX,
            y: startY,
            z: this.grid.origin.z
        }, 'left');
    }

    /**
     * Layout text with word wrapping
     * @param {string} text - Text to wrap
     * @param {number} maxWidth - Maximum line width in world units
     * @param {Object} startPosition - Starting position
     * @returns {Array} Array of positions
     */
    layoutWrapped(text, maxWidth, startPosition) {
        const words = text.split(' ');
        const positions = [];

        let x = startPosition.x;
        let y = startPosition.y;
        const z = startPosition.z;

        for (const word of words) {
            const wordWidth = this._measureWordWidth(word);

            // Check if word fits on current line
            if (x > startPosition.x && x + wordWidth > startPosition.x + maxWidth) {
                // Move to next line
                x = startPosition.x;
                y -= this.metrics.lineSpacing;
            }

            // Layout word characters
            for (const char of word) {
                positions.push({ x, y, z });
                x += this.metrics.charWidth + this.metrics.letterSpacing;
            }

            // Add space after word
            x += this.metrics.charWidth + this.metrics.letterSpacing;
        }

        return positions;
    }

    /**
     * Layout text in a circular pattern
     * @param {string} text - Text to layout
     * @param {Object} center - Center position
     * @param {number} radius - Circle radius
     * @param {number} startAngle - Starting angle in radians
     * @returns {Array} Array of positions
     */
    layoutCircular(text, center, radius, startAngle = 0) {
        const positions = [];
        const angleStep = (2 * Math.PI) / text.length;

        for (let i = 0; i < text.length; i++) {
            const angle = startAngle + i * angleStep;
            positions.push({
                x: center.x + radius * Math.cos(angle),
                y: center.y + radius * Math.sin(angle),
                z: center.z
            });
        }

        return positions;
    }

    /**
     * Layout text along a path
     * @param {string} text - Text to layout
     * @param {Array} pathPoints - Array of {x, y, z} points
     * @returns {Array} Array of positions
     */
    layoutPath(text, pathPoints) {
        if (pathPoints.length < 2) {
            return this.layoutText(text, pathPoints[0] || {x: 0, y: 0, z: 0});
        }

        const positions = [];
        const pathLength = this._calculatePathLength(pathPoints);
        const charSpacing = pathLength / text.length;

        let currentDistance = 0;
        let pathIndex = 0;

        for (let i = 0; i < text.length; i++) {
            const position = this._interpolatePathPosition(
                pathPoints,
                currentDistance,
                pathLength
            );
            positions.push(position);
            currentDistance += charSpacing;
        }

        return positions;
    }

    /**
     * Get character position in grid
     * @param {number} row - Row index
     * @param {number} col - Column index
     * @returns {Object} Position {x, y, z}
     */
    getCharPosition(row, col) {
        return {
            x: this.grid.origin.x + col * (this.metrics.charWidth + this.metrics.letterSpacing),
            y: this.grid.origin.y - row * this.metrics.lineSpacing,
            z: this.grid.origin.z
        };
    }

    /**
     * Set grid dimensions
     * @param {number} columns - Number of columns
     * @param {number} rows - Number of rows
     */
    setGridSize(columns, rows) {
        this.grid.columns = columns;
        this.grid.rows = rows;
    }

    /**
     * Set grid origin
     * @param {Object} origin - Origin position {x, y, z}
     */
    setGridOrigin(origin) {
        this.grid.origin = origin;
    }

    /**
     * Reset cursor to origin
     */
    resetCursor() {
        this.cursor = {
            x: this.grid.origin.x,
            y: this.grid.origin.y,
            z: this.grid.origin.z,
            column: 0,
            row: 0
        };
    }

    /**
     * Move cursor to specific position
     * @param {number} row - Target row
     * @param {number} column - Target column
     */
    moveCursor(row, column) {
        this.cursor.row = Math.max(0, Math.min(row, this.grid.rows - 1));
        this.cursor.column = Math.max(0, Math.min(column, this.grid.columns - 1));

        const pos = this.getCharPosition(this.cursor.row, this.cursor.column);
        this.cursor.x = pos.x;
        this.cursor.y = pos.y;
        this.cursor.z = pos.z;
    }

    /**
     * Advance cursor by one character
     */
    advanceCursor() {
        this.cursor.column++;
        if (this.cursor.column >= this.grid.columns) {
            this.cursor.column = 0;
            this.cursor.row++;
        }

        const pos = this.getCharPosition(this.cursor.row, this.cursor.column);
        this.cursor.x = pos.x;
        this.cursor.y = pos.y;
    }

    /**
     * Move cursor to next line
     */
    newLine() {
        this.cursor.column = 0;
        this.cursor.row++;

        const pos = this.getCharPosition(this.cursor.row, this.cursor.column);
        this.cursor.x = pos.x;
        this.cursor.y = pos.y;
    }

    // ============ Private Helpers ============

    /**
     * Measure line width
     * @private
     */
    _measureLineWidth(text) {
        const charCount = text.replace(/\n/g, '').length;
        return charCount * (this.metrics.charWidth + this.metrics.letterSpacing);
    }

    /**
     * Measure word width
     * @private
     */
    _measureWordWidth(word) {
        return word.length * (this.metrics.charWidth + this.metrics.letterSpacing);
    }

    /**
     * Calculate total path length
     * @private
     */
    _calculatePathLength(points) {
        let length = 0;
        for (let i = 1; i < points.length; i++) {
            const dx = points[i].x - points[i-1].x;
            const dy = points[i].y - points[i-1].y;
            const dz = points[i].z - points[i-1].z;
            length += Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
        return length;
    }

    /**
     * Interpolate position along path
     * @private
     */
    _interpolatePathPosition(points, distance, totalLength) {
        let accumulated = 0;

        for (let i = 1; i < points.length; i++) {
            const p1 = points[i-1];
            const p2 = points[i];

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dz = p2.z - p1.z;
            const segmentLength = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (accumulated + segmentLength >= distance) {
                const t = (distance - accumulated) / segmentLength;
                return {
                    x: p1.x + t * dx,
                    y: p1.y + t * dy,
                    z: p1.z + t * dz
                };
            }

            accumulated += segmentLength;
        }

        // Return last point if we've gone past the end
        return points[points.length - 1];
    }
}

export default GlyphLayout;