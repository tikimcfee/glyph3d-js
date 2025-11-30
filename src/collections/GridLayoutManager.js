/**
 * GridLayoutManager - Positions CodeGrids in 3D space
 *
 * Inspired by SwiftGlyph's WorldGridEditor, this class manages the spatial
 * arrangement of multiple CodeGrids with support for:
 * - Trailing (right of previous)
 * - Next row (below current row)
 * - Next plane (behind in Z)
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> GlyphCollection -> CodeGrid -> GridLayoutManager
 */

import * as THREE from 'three';

class GridLayoutManager {
    /**
     * Create a GridLayoutManager
     * @param {Object} options - Configuration options
     */
    constructor(options = {}) {
        // Layout spacing - sized for 3D code viewing with larger grids
        // With worldScale 0.1, chars are ~4.8 units, grids can be 200-500+ units
        this.spacing = {
            horizontal: options.horizontalSpacing || 10.0,   // Space between grids in a row
            vertical: options.verticalSpacing || 8.0,        // Space between rows
            plane: options.planeSpacing || 300.0             // Space between Z planes
        };

        // Grid tracking
        this.grids = [];
        this.lastGrid = null;

        // Row tracking for proper layout
        this.rows = [[]];       // Array of rows, each row is array of grids
        this.planes = [[[]]];   // Array of planes, each plane has rows

        // Current layout position
        this.currentPlane = 0;
        this.currentRow = 0;

        // Cached row bounds for O(1) addAuto() - updated incrementally
        this._rowBoundsCache = new Map();  // "plane:row" -> {minX, maxX, minY, maxY, width}

        // Grid relationship mapping (for navigation)
        this.relationships = new Map(); // grid -> { left, right, up, down, forward, backward }

        // Origin offset for the entire layout
        this.origin = new THREE.Vector3(
            options.originX || 0,
            options.originY || 0,
            options.originZ || 0
        );

        // Max row width for auto layout
        this.maxRowWidth = options.maxRowWidth || 1000;
    }

    // ============ Layout Methods ============

    /**
     * Add grid trailing (to the right of) the previous grid
     * @param {CodeGrid} grid - Grid to add
     * @returns {this} For chaining
     */
    addTrailing(grid) {
        if (this.lastGrid) {
            const lastBounds = this.lastGrid.getBounds();

            // Position to the right of the last grid
            grid.position.x = lastBounds.max.x + this.spacing.horizontal;
            grid.position.y = this.lastGrid.position.y;
            grid.position.z = this.lastGrid.position.z;

            // Set up relationships
            this._connectGrids(this.lastGrid, grid, 'right');
        } else {
            // First grid at origin
            grid.position.copy(this.origin);
        }

        this._addGridToCurrentRow(grid);
        this.lastGrid = grid;
        this.grids.push(grid);

        return this;
    }

    /**
     * Add grid in the next row (below current row)
     * @param {CodeGrid} grid - Grid to add
     * @returns {this} For chaining
     */
    addInNextRow(grid) {
        // Find the lowest point of the current row
        const rowBottom = this._getRowBottom(this.currentPlane, this.currentRow);

        // Move to next row
        this.currentRow++;
        this._ensureRowExists(this.currentPlane, this.currentRow);

        // Position below current row, at the start
        grid.position.x = this.origin.x;
        grid.position.y = rowBottom - this.spacing.vertical;
        grid.position.z = this._getPlaneZ(this.currentPlane);

        // Connect to grid above if one exists
        const gridsAbove = this._getGridsInRow(this.currentPlane, this.currentRow - 1);
        if (gridsAbove.length > 0) {
            this._connectGrids(gridsAbove[0], grid, 'down');
        }

        this._addGridToCurrentRow(grid);
        this.lastGrid = grid;
        this.grids.push(grid);

        return this;
    }

    /**
     * Add grid in the next plane (behind in Z)
     * @param {CodeGrid} grid - Grid to add
     * @returns {this} For chaining
     */
    addInNextPlane(grid) {
        // Move to next plane
        this.currentPlane++;
        this.currentRow = 0;
        this._ensurePlaneExists(this.currentPlane);

        // Position at origin of new plane
        grid.position.x = this.origin.x;
        grid.position.y = this.origin.y;
        grid.position.z = this._getPlaneZ(this.currentPlane);

        // Connect to grid in front if one exists
        const frontPlaneFirstGrid = this._getFirstGridInPlane(this.currentPlane - 1);
        if (frontPlaneFirstGrid) {
            this._connectGrids(frontPlaneFirstGrid, grid, 'backward');
        }

        this._addGridToCurrentRow(grid);
        this.lastGrid = grid;
        this.grids.push(grid);

        return this;
    }

    /**
     * Add grid at a specific position (bypass auto-layout)
     * @param {CodeGrid} grid - Grid to add
     * @param {THREE.Vector3} position - World position
     * @returns {this} For chaining
     */
    addAtPosition(grid, position) {
        grid.position.copy(position);
        this.grids.push(grid);
        this.lastGrid = grid;
        return this;
    }

    /**
     * Alias for addAtPosition
     * @param {CodeGrid} grid - Grid to add
     * @param {THREE.Vector3|{x, y, z}} position - World position
     * @returns {this} For chaining
     */
    addAt(grid, position) {
        return this.addAtPosition(grid, position);
    }

    /**
     * Auto-layout: chooses best position based on grid size
     * Wraps to next row if current row exceeds maxWidth
     * @param {CodeGrid} grid - Grid to add
     * @param {Object} options - Options
     * @param {number} options.maxRowWidth - Maximum row width before wrap (default: 1000)
     * @returns {this} For chaining
     */
    addAuto(grid, options = {}) {
        const maxRowWidth = options.maxRowWidth || this.maxRowWidth || 1000;

        // Check if adding to current row would exceed max width
        if (this.lastGrid) {
            const rowBounds = this._getCurrentRowBounds();
            const gridBounds = grid.getBounds();
            const gridWidth = gridBounds.max.x - gridBounds.min.x;

            const newRowWidth = rowBounds.width + this.spacing.horizontal + gridWidth;

            if (newRowWidth > maxRowWidth) {
                // Wrap to next row
                grid.userData = grid.userData || {};
                grid.userData.layoutHint = 'nextRow';
                return this.addInNextRow(grid);
            }
        }

        // Add trailing (same row)
        grid.userData = grid.userData || {};
        grid.userData.layoutHint = 'trailing';
        return this.addTrailing(grid);
    }

    // ============ Spacing Control ============

    /**
     * Set horizontal spacing between grids
     * @param {number} value - Spacing value
     */
    setHorizontalSpacing(value) {
        this.spacing.horizontal = value;
    }

    /**
     * Set vertical spacing between rows
     * @param {number} value - Spacing value
     */
    setVerticalSpacing(value) {
        this.spacing.vertical = value;
    }

    /**
     * Set plane spacing (Z depth)
     * @param {number} value - Spacing value
     */
    setPlaneSpacing(value) {
        this.spacing.plane = value;
    }

    /**
     * Set all spacing values at once
     * @param {number} horizontal - Horizontal spacing
     * @param {number} vertical - Vertical spacing
     * @param {number} plane - Plane spacing
     */
    setSpacing(horizontal, vertical, plane) {
        this.spacing.horizontal = horizontal;
        this.spacing.vertical = vertical;
        this.spacing.plane = plane;
    }

    // ============ Queries ============

    /**
     * Get all managed grids
     * @returns {CodeGrid[]} Array of grids
     */
    getGrids() {
        return [...this.grids];
    }

    /**
     * Get grid at a world position (raycasting)
     * @param {THREE.Vector3} position - World position to check
     * @returns {CodeGrid|null} Grid at position or null
     */
    getGridAt(position) {
        for (const grid of this.grids) {
            const bounds = grid.getBounds();
            if (bounds.containsPoint(position)) {
                return grid;
            }
        }
        return null;
    }

    /**
     * Get grid by name
     * @param {string} name - Grid name to find
     * @returns {CodeGrid|null} Grid with name or null
     */
    getGridByName(name) {
        return this.grids.find(g => g.name === name || g.filename === name) || null;
    }

    /**
     * Get grids in a specific row
     * @param {number} planeIndex - Plane index
     * @param {number} rowIndex - Row index
     * @returns {CodeGrid[]} Grids in the row
     */
    getGridsInRow(planeIndex = 0, rowIndex = 0) {
        return this._getGridsInRow(planeIndex, rowIndex);
    }

    /**
     * Get total bounding box of all grids
     * @returns {THREE.Box3} Combined bounds
     */
    getTotalBounds() {
        const box = new THREE.Box3();

        for (const grid of this.grids) {
            box.union(grid.getBounds());
        }

        return box;
    }

    /**
     * Get bounds of the current row
     * @returns {THREE.Box3} Current row bounds
     */
    getCurrentRowBounds() {
        const bounds = this._getCurrentRowBounds();
        const box = new THREE.Box3();
        box.min.set(bounds.minX, bounds.minY, this._getPlaneZ(this.currentPlane));
        box.max.set(bounds.maxX, bounds.maxY, this._getPlaneZ(this.currentPlane));
        return box;
    }

    /**
     * Get the center point of all grids
     * @returns {THREE.Vector3} Center point
     */
    getCenter() {
        const bounds = this.getTotalBounds();
        const center = new THREE.Vector3();
        bounds.getCenter(center);
        return center;
    }

    /**
     * Get neighbors of a grid
     * @param {CodeGrid} grid - Grid to query
     * @returns {Object} Object with left, right, up, down, forward, backward grids
     */
    getNeighbors(grid) {
        return this.relationships.get(grid) || {
            left: null, right: null,
            up: null, down: null,
            forward: null, backward: null
        };
    }

    /**
     * Get grid count
     * @returns {number} Number of grids
     */
    getGridCount() {
        return this.grids.length;
    }

    // ============ Layout Operations ============

    /**
     * Recalculate all grid positions
     * Useful after spacing changes or grid removal
     */
    reflow() {
        // Store grids in order
        const orderedGrids = [...this.grids];

        // Reset state
        this.grids = [];
        this.rows = [[]];
        this.planes = [[[]]];
        this.currentPlane = 0;
        this.currentRow = 0;
        this.lastGrid = null;
        this.relationships.clear();
        this._rowBoundsCache.clear();

        // Re-add grids with new layout
        // This preserves the original add order
        for (const grid of orderedGrids) {
            // Detect the original layout intent from metadata
            const layoutHint = grid.userData?.layoutHint || 'trailing';

            switch (layoutHint) {
                case 'nextRow':
                    this.addInNextRow(grid);
                    break;
                case 'nextPlane':
                    this.addInNextPlane(grid);
                    break;
                default:
                    this.addTrailing(grid);
            }
        }
    }

    /**
     * Remove a grid from the layout
     * @param {CodeGrid} grid - Grid to remove
     * @returns {boolean} True if removed
     */
    removeGrid(grid) {
        const index = this.grids.indexOf(grid);
        if (index === -1) return false;

        // Remove from grids array
        this.grids.splice(index, 1);

        // Remove from rows tracking
        for (const plane of this.planes) {
            for (const row of plane) {
                const rowIndex = row.indexOf(grid);
                if (rowIndex !== -1) {
                    row.splice(rowIndex, 1);
                }
            }
        }

        // Update relationships
        this._removeGridRelationships(grid);

        // Update lastGrid if needed
        if (this.lastGrid === grid) {
            this.lastGrid = this.grids[this.grids.length - 1] || null;
        }

        return true;
    }

    /**
     * Clear all grids
     */
    clear() {
        this.grids = [];
        this.rows = [[]];
        this.planes = [[[]]];
        this.currentPlane = 0;
        this.currentRow = 0;
        this.lastGrid = null;
        this.relationships.clear();
        this._rowBoundsCache.clear();
    }

    // ============ Navigation ============

    /**
     * Get grid to the left of the given grid
     * @param {CodeGrid} grid - Current grid
     * @returns {CodeGrid|null} Left neighbor
     */
    getLeft(grid) {
        const neighbors = this.relationships.get(grid);
        return neighbors?.left || null;
    }

    /**
     * Get grid to the right of the given grid
     * @param {CodeGrid} grid - Current grid
     * @returns {CodeGrid|null} Right neighbor
     */
    getRight(grid) {
        const neighbors = this.relationships.get(grid);
        return neighbors?.right || null;
    }

    /**
     * Get grid above the given grid
     * @param {CodeGrid} grid - Current grid
     * @returns {CodeGrid|null} Upper neighbor
     */
    getUp(grid) {
        const neighbors = this.relationships.get(grid);
        return neighbors?.up || null;
    }

    /**
     * Get grid below the given grid
     * @param {CodeGrid} grid - Current grid
     * @returns {CodeGrid|null} Lower neighbor
     */
    getDown(grid) {
        const neighbors = this.relationships.get(grid);
        return neighbors?.down || null;
    }

    // ============ Private Helpers ============

    /**
     * Add grid to current row tracking
     * @private
     */
    _addGridToCurrentRow(grid) {
        this._ensureRowExists(this.currentPlane, this.currentRow);
        this.planes[this.currentPlane][this.currentRow].push(grid);

        // Update row bounds cache with this grid's (worker-computed) bounds
        this._updateRowBoundsCache(grid);

        // Store layout hint for reflow
        if (!grid.userData) grid.userData = {};
    }

    /**
     * Ensure plane exists in tracking structure
     * @private
     */
    _ensurePlaneExists(planeIndex) {
        while (this.planes.length <= planeIndex) {
            this.planes.push([[]]);
        }
    }

    /**
     * Ensure row exists in tracking structure
     * @private
     */
    _ensureRowExists(planeIndex, rowIndex) {
        this._ensurePlaneExists(planeIndex);
        while (this.planes[planeIndex].length <= rowIndex) {
            this.planes[planeIndex].push([]);
        }
    }

    /**
     * Get grids in a specific row
     * @private
     */
    _getGridsInRow(planeIndex, rowIndex) {
        if (planeIndex >= this.planes.length) return [];
        if (rowIndex >= this.planes[planeIndex].length) return [];
        return [...this.planes[planeIndex][rowIndex]];
    }

    /**
     * Get the first grid in a plane
     * @private
     */
    _getFirstGridInPlane(planeIndex) {
        if (planeIndex >= this.planes.length) return null;
        const firstRow = this.planes[planeIndex][0];
        return firstRow && firstRow[0] ? firstRow[0] : null;
    }

    /**
     * Get the lowest Y position in a row (O(1) - uses cache)
     * @private
     */
    _getRowBottom(planeIndex, rowIndex) {
        const key = `${planeIndex}:${rowIndex}`;
        const cached = this._rowBoundsCache.get(key);
        if (cached) {
            return cached.minY;
        }
        return this.origin.y;
    }

    /**
     * Get bounds of current row (O(1) - uses incrementally updated cache)
     * @private
     */
    _getCurrentRowBounds() {
        const key = `${this.currentPlane}:${this.currentRow}`;
        const cached = this._rowBoundsCache.get(key);
        if (cached) {
            return cached;
        }
        return { width: 0, height: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }

    /**
     * Update row bounds cache with a new grid's bounds
     * Uses the grid's (worker-computed) bounds - no recomputation needed
     * @private
     */
    _updateRowBoundsCache(grid) {
        const key = `${this.currentPlane}:${this.currentRow}`;
        const gridBounds = grid.getBounds();  // Already computed by worker

        const existing = this._rowBoundsCache.get(key);
        if (!existing) {
            // First grid in this row
            this._rowBoundsCache.set(key, {
                minX: gridBounds.min.x,
                maxX: gridBounds.max.x,
                minY: gridBounds.min.y,
                maxY: gridBounds.max.y,
                width: gridBounds.max.x - gridBounds.min.x,
                height: gridBounds.max.y - gridBounds.min.y
            });
        } else {
            // Expand bounds to include new grid
            existing.minX = Math.min(existing.minX, gridBounds.min.x);
            existing.maxX = Math.max(existing.maxX, gridBounds.max.x);
            existing.minY = Math.min(existing.minY, gridBounds.min.y);
            existing.maxY = Math.max(existing.maxY, gridBounds.max.y);
            existing.width = existing.maxX - existing.minX;
            existing.height = existing.maxY - existing.minY;
        }
    }

    /**
     * Get Z position for a plane
     * @private
     */
    _getPlaneZ(planeIndex) {
        return this.origin.z - planeIndex * this.spacing.plane;
    }

    /**
     * Connect two grids with a relationship
     * @private
     */
    _connectGrids(gridA, gridB, direction) {
        // Ensure relationship objects exist
        if (!this.relationships.has(gridA)) {
            this.relationships.set(gridA, {
                left: null, right: null,
                up: null, down: null,
                forward: null, backward: null
            });
        }
        if (!this.relationships.has(gridB)) {
            this.relationships.set(gridB, {
                left: null, right: null,
                up: null, down: null,
                forward: null, backward: null
            });
        }

        const relA = this.relationships.get(gridA);
        const relB = this.relationships.get(gridB);

        // Set bidirectional relationship
        switch (direction) {
            case 'right':
                relA.right = gridB;
                relB.left = gridA;
                break;
            case 'left':
                relA.left = gridB;
                relB.right = gridA;
                break;
            case 'down':
                relA.down = gridB;
                relB.up = gridA;
                break;
            case 'up':
                relA.up = gridB;
                relB.down = gridA;
                break;
            case 'backward':
                relA.backward = gridB;
                relB.forward = gridA;
                break;
            case 'forward':
                relA.forward = gridB;
                relB.backward = gridA;
                break;
        }
    }

    /**
     * Remove all relationships for a grid
     * @private
     */
    _removeGridRelationships(grid) {
        const neighbors = this.relationships.get(grid);
        if (!neighbors) return;

        // Clear references from neighbors
        for (const [dir, neighbor] of Object.entries(neighbors)) {
            if (neighbor) {
                const neighborRel = this.relationships.get(neighbor);
                if (neighborRel) {
                    // Find and clear the inverse direction
                    const inverse = {
                        left: 'right', right: 'left',
                        up: 'down', down: 'up',
                        forward: 'backward', backward: 'forward'
                    }[dir];
                    if (inverse) {
                        neighborRel[inverse] = null;
                    }
                }
            }
        }

        // Remove grid's own relationships
        this.relationships.delete(grid);
    }
}

export default GridLayoutManager;
