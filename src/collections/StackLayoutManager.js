/**
 * StackLayoutManager - Album/deck-of-cards layout for CodeGrids
 *
 * Files within each directory are stacked along the Z axis like vinyl
 * records in a bin. Only the top file is fully visible; the rest peek
 * out slightly behind. Directory stacks are arranged in a grid in XY.
 *
 * Interaction states:
 * - **Collapsed** (default): files tightly stacked, titles peek out
 * - **Fanned**: on hover, files spread along Z so titles are readable
 * - **Pulled**: clicked file moves to a separate working space
 *
 * Usage:
 *   const stack = new StackLayoutManager();
 *   stack.layout(grids);             // initial stack positions
 *   stack.fanOut('src/utils');        // hover over a directory stack
 *   stack.collapse('src/utils');      // mouse-leave
 *   stack.pullToWorkspace(grid);      // click to pull a file out
 *   stack.returnToStack(grid);        // send file back
 *
 * Works with the existing SelectionManager (raycasts against _background).
 */

import * as THREE from 'three';

/** @typedef {import('./CodeGrid.js').default} CodeGrid */

/**
 * @typedef {Object} StackEntry
 * @property {CodeGrid} grid
 * @property {THREE.Vector3} stackPosition  - Position when in the stack (collapsed)
 * @property {THREE.Vector3} fanPosition    - Position when fanned out
 * @property {number} indexInStack          - Order within directory stack
 * @property {boolean} pulled               - True if currently in workspace
 */

/**
 * @typedef {Object} DirectoryStack
 * @property {string} dirPath
 * @property {StackEntry[]} entries
 * @property {THREE.Vector3} origin        - Top-left of this stack in world space
 * @property {number} width                - Width of widest file in stack
 * @property {number} height               - Height of tallest file in stack
 * @property {boolean} fanned              - Currently fanned out?
 */

class StackLayoutManager {
    /**
     * @param {Object} options
     * @param {number} [options.stackZOffset=3]      - Z gap between stacked files
     * @param {number} [options.fanZOffset=12]        - Z gap when fanned out
     * @param {number} [options.fanXShift=8]          - X stagger when fanned (hand-of-cards)
     * @param {number} [options.stackPeekY=2]         - Y peek offset per card in stack
     * @param {number} [options.dirSpacingX=20]       - X gap between directory stacks
     * @param {number} [options.dirSpacingY=20]       - Y gap between rows of stacks
     * @param {number} [options.maxStacksPerRow=6]    - Stacks per row before wrapping
     * @param {number} [options.workspaceOffsetX=0]   - Working space X offset from stacks
     * @param {number} [options.workspaceOffsetY=200] - Working space Y offset (above stacks)
     * @param {number} [options.workspaceSpacing=15]  - Gap between files in workspace
     * @param {number} [options.pullZOffset=20]       - Z offset for pulled files (toward camera)
     * @param {number} [options.originX=0]
     * @param {number} [options.originY=0]
     * @param {number} [options.originZ=0]
     */
    constructor(options = {}) {
        this.options = {
            stackZOffset: options.stackZOffset ?? 3,
            fanZOffset: options.fanZOffset ?? 12,
            fanXShift: options.fanXShift ?? 8,
            stackPeekY: options.stackPeekY ?? 2,
            dirSpacingX: options.dirSpacingX ?? 20,
            dirSpacingY: options.dirSpacingY ?? 20,
            maxStacksPerRow: options.maxStacksPerRow ?? 6,
            workspaceOffsetX: options.workspaceOffsetX ?? 0,
            workspaceOffsetY: options.workspaceOffsetY ?? 200,
            workspaceSpacing: options.workspaceSpacing ?? 15,
            pullZOffset: options.pullZOffset ?? 20,
        };

        this.origin = new THREE.Vector3(
            options.originX || 0,
            options.originY || 0,
            options.originZ || 0
        );

        /** @type {Map<string, DirectoryStack>} dirPath -> stack info */
        this.stacks = new Map();

        /** @type {Map<CodeGrid, StackEntry>} grid -> entry */
        this.gridToEntry = new Map();

        /** @type {CodeGrid[]} Files currently in the workspace */
        this.workspaceGrids = [];

        /** @type {CodeGrid[]} All grids managed by this layout */
        this.grids = [];

        // Tree info (mirrors other layout managers)
        this.root = null;
        this.pathToNode = new Map();
        this.gridToNode = new Map();

        // Workspace origin computed after stacks are laid out
        this._workspaceOrigin = new THREE.Vector3();

        // Total bounds of all stacks for computing workspace position
        this._stacksBounds = new THREE.Box3();
    }

    // ============ Main API ============

    /**
     * Layout grids in stacks grouped by directory.
     * Grid bounds must already be computed.
     *
     * @param {CodeGrid[]} grids - Grids with userData.sourcePath set
     * @returns {Object} root tree node (for consistency with other managers)
     */
    layout(grids) {
        this.clear();
        this.grids = [...grids];

        // Build directory tree (same structure as other managers)
        this.root = this._buildTree(grids);

        // Group files by their parent directory
        const dirGroups = this._groupByDirectory(this.root);

        // Create stack entries
        for (const group of dirGroups) {
            this._createStack(group.dirPath, group.files);
        }

        // Position stacks in a grid arrangement
        this._positionStacks();

        // Apply positions to grids
        this._applyStackPositions();

        return this.root;
    }

    /**
     * Fan out a directory stack (hover interaction).
     * Files spread along Z with an X stagger.
     * @param {string} dirPath - Directory path
     */
    fanOut(dirPath) {
        const stack = this.stacks.get(dirPath);
        if (!stack || stack.fanned) return;

        stack.fanned = true;

        for (const entry of stack.entries) {
            if (entry.pulled) continue;
            entry.grid.position.copy(entry.fanPosition);
        }
    }

    /**
     * Collapse a directory stack back (mouse-leave).
     * @param {string} dirPath - Directory path
     */
    collapse(dirPath) {
        const stack = this.stacks.get(dirPath);
        if (!stack || !stack.fanned) return;

        stack.fanned = false;

        for (const entry of stack.entries) {
            if (entry.pulled) continue;
            entry.grid.position.copy(entry.stackPosition);
        }
    }

    /**
     * Check if a directory stack is currently fanned out.
     * @param {string} dirPath
     * @returns {boolean}
     */
    isFanned(dirPath) {
        const stack = this.stacks.get(dirPath);
        return stack ? stack.fanned : false;
    }

    /**
     * Pull a file out of its stack into the working space.
     * @param {CodeGrid} grid
     */
    pullToWorkspace(grid) {
        const entry = this.gridToEntry.get(grid);
        if (!entry || entry.pulled) return;

        entry.pulled = true;
        this.workspaceGrids.push(grid);

        // Re-layout workspace
        this._layoutWorkspace();

        // Refresh the stack (show gap where file was)
        const stack = this._getStackForGrid(grid);
        if (stack) {
            this._refreshStackPositions(stack);
        }
    }

    /**
     * Return a file from the workspace back to its stack.
     * @param {CodeGrid} grid
     */
    returnToStack(grid) {
        const entry = this.gridToEntry.get(grid);
        if (!entry || !entry.pulled) return;

        entry.pulled = false;

        // Remove from workspace
        const idx = this.workspaceGrids.indexOf(grid);
        if (idx >= 0) this.workspaceGrids.splice(idx, 1);

        // Return to stack position
        const stack = this._getStackForGrid(grid);
        if (stack) {
            const pos = stack.fanned ? entry.fanPosition : entry.stackPosition;
            grid.position.copy(pos);
            this._refreshStackPositions(stack);
        }

        // Re-layout remaining workspace files
        this._layoutWorkspace();
    }

    /**
     * Return all files from workspace back to their stacks.
     */
    returnAll() {
        // Work from a copy since returnToStack mutates the array
        const pulled = [...this.workspaceGrids];
        for (const grid of pulled) {
            this.returnToStack(grid);
        }
    }

    /**
     * Check if a grid is currently pulled to workspace.
     * @param {CodeGrid} grid
     * @returns {boolean}
     */
    isPulled(grid) {
        const entry = this.gridToEntry.get(grid);
        return entry ? entry.pulled : false;
    }

    /**
     * Get the directory path for a grid.
     * @param {CodeGrid} grid
     * @returns {string|null}
     */
    getDirectoryForGrid(grid) {
        const stack = this._getStackForGrid(grid);
        return stack ? stack.dirPath : null;
    }

    /**
     * Get all directory paths that have stacks.
     * @returns {string[]}
     */
    getDirectoryPaths() {
        return [...this.stacks.keys()];
    }

    /**
     * Get grids in a specific directory stack.
     * @param {string} dirPath
     * @returns {CodeGrid[]}
     */
    getStackGrids(dirPath) {
        const stack = this.stacks.get(dirPath);
        if (!stack) return [];
        return stack.entries.map(e => e.grid);
    }

    /**
     * Get all grids in the workspace.
     * @returns {CodeGrid[]}
     */
    getWorkspaceGrids() {
        return [...this.workspaceGrids];
    }

    /**
     * Get total bounds of the entire layout (stacks + workspace).
     * @returns {THREE.Box3}
     */
    getTotalBounds() {
        const box = new THREE.Box3();
        for (const grid of this.grids) {
            box.union(grid.getBounds());
        }
        return box;
    }

    /**
     * Get the origin of the workspace area.
     * Useful for camera navigation.
     * @returns {THREE.Vector3}
     */
    getWorkspaceOrigin() {
        return this._workspaceOrigin.clone();
    }

    /**
     * Get the center of the stack area (excluding workspace).
     * @returns {THREE.Vector3}
     */
    getStackCenter() {
        const center = new THREE.Vector3();
        this._stacksBounds.getCenter(center);
        return center;
    }

    /**
     * Get all managed grids.
     * @returns {CodeGrid[]}
     */
    getGrids() {
        return [...this.grids];
    }

    /**
     * Clear all state.
     */
    clear() {
        this.stacks.clear();
        this.gridToEntry.clear();
        this.workspaceGrids = [];
        this.grids = [];
        this.root = null;
        this.pathToNode.clear();
        this.gridToNode.clear();
        this._stacksBounds.makeEmpty();
    }

    // ============ Tree Building (mirrors HierarchicalLayoutManager) ============

    /**
     * Build tree structure from file paths.
     * @private
     * @param {CodeGrid[]} grids
     * @returns {Object} root node
     */
    _buildTree(grids) {
        const root = { name: '', path: '', isDirectory: true, grid: null, children: [], parent: null };
        this.pathToNode.set('', root);

        for (const grid of grids) {
            const sourcePath = grid.userData?.sourcePath || grid.filename || 'unknown';
            const parts = sourcePath.split('/').filter(p => p.length > 0);

            let current = root;
            let currentPath = '';

            // Create directory nodes
            for (let i = 0; i < parts.length - 1; i++) {
                currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
                let dirNode = this.pathToNode.get(currentPath);
                if (!dirNode) {
                    dirNode = { name: parts[i], path: currentPath, isDirectory: true, grid: null, children: [], parent: current };
                    current.children.push(dirNode);
                    this.pathToNode.set(currentPath, dirNode);
                }
                current = dirNode;
            }

            // Create file node
            const fileName = parts[parts.length - 1] || sourcePath;
            const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;

            const fileNode = { name: fileName, path: filePath, isDirectory: false, grid, children: [], parent: current };
            current.children.push(fileNode);
            this.pathToNode.set(filePath, fileNode);
            this.gridToNode.set(grid, fileNode);
        }

        return root;
    }

    // ============ Grouping ============

    /**
     * Collect files grouped by their immediate parent directory.
     * @private
     * @param {Object} root - Tree root
     * @returns {Array<{dirPath: string, dirName: string, files: CodeGrid[]}>}
     */
    _groupByDirectory(root) {
        const groups = [];
        this._collectGroups(root, groups);
        return groups;
    }

    /**
     * @private
     */
    _collectGroups(node, groups) {
        if (!node.isDirectory) return;

        const files = node.children
            .filter(c => !c.isDirectory && c.grid)
            .map(c => c.grid);

        if (files.length > 0) {
            groups.push({
                dirPath: node.path,
                dirName: node.name || '(root)',
                files
            });
        }

        // Recurse into subdirectories
        const dirs = node.children.filter(c => c.isDirectory);
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        for (const dir of dirs) {
            this._collectGroups(dir, groups);
        }
    }

    // ============ Stack Creation ============

    /**
     * Create a DirectoryStack for a group of files.
     * @private
     * @param {string} dirPath
     * @param {CodeGrid[]} files
     */
    _createStack(dirPath, files) {
        let maxWidth = 0;
        let maxHeight = 0;

        const entries = files.map((grid, index) => {
            const bounds = grid.getBounds();
            const w = bounds.max.x - bounds.min.x;
            const h = bounds.max.y - bounds.min.y;
            maxWidth = Math.max(maxWidth, w);
            maxHeight = Math.max(maxHeight, h);

            /** @type {StackEntry} */
            const entry = {
                grid,
                stackPosition: new THREE.Vector3(),
                fanPosition: new THREE.Vector3(),
                indexInStack: index,
                pulled: false
            };

            this.gridToEntry.set(grid, entry);
            return entry;
        });

        /** @type {DirectoryStack} */
        const stack = {
            dirPath,
            entries,
            origin: new THREE.Vector3(),
            width: maxWidth,
            height: maxHeight,
            fanned: false
        };

        this.stacks.set(dirPath, stack);
    }

    // ============ Positioning ============

    /**
     * Arrange directory stacks in a grid layout.
     * @private
     */
    _positionStacks() {
        const {
            dirSpacingX, dirSpacingY, maxStacksPerRow,
            stackZOffset, fanZOffset, fanXShift, stackPeekY
        } = this.options;

        let col = 0;
        let rowY = this.origin.y;
        let rowMaxHeight = 0;
        let x = this.origin.x;

        this._stacksBounds.makeEmpty();

        for (const [dirPath, stack] of this.stacks) {
            // Wrap to next row
            if (col >= maxStacksPerRow) {
                col = 0;
                rowY -= rowMaxHeight + dirSpacingY;
                rowMaxHeight = 0;
                x = this.origin.x;
            }

            // Set stack origin
            stack.origin.set(x, rowY, this.origin.z);

            // Compute positions for each file in the stack
            const fileCount = stack.entries.length;

            for (let i = 0; i < fileCount; i++) {
                const entry = stack.entries[i];
                // Reverse order: first file (index 0) is on top (closest to camera)
                const depthIndex = i;

                // Stack position: each card slightly behind and peeking below
                entry.stackPosition.set(
                    x,
                    rowY - (depthIndex * stackPeekY),
                    this.origin.z + (fileCount - 1 - depthIndex) * stackZOffset
                );

                // Fan position: spread along Z with X stagger (like a hand of cards)
                entry.fanPosition.set(
                    x + depthIndex * fanXShift,
                    rowY - (depthIndex * stackPeekY * 0.5),
                    this.origin.z + (fileCount - 1 - depthIndex) * fanZOffset
                );
            }

            // Update bounds for this stack region
            const stackExtentX = stack.width;
            const stackExtentY = stack.height + (fileCount - 1) * stackPeekY;
            this._stacksBounds.expandByPoint(
                new THREE.Vector3(x, rowY, this.origin.z)
            );
            this._stacksBounds.expandByPoint(
                new THREE.Vector3(
                    x + stackExtentX,
                    rowY - stackExtentY,
                    this.origin.z + fileCount * stackZOffset
                )
            );

            x += stack.width + dirSpacingX;
            rowMaxHeight = Math.max(rowMaxHeight, stackExtentY);
            col++;
        }

        // Compute workspace origin: above the stacks area
        this._workspaceOrigin.set(
            this._stacksBounds.min.x + this.options.workspaceOffsetX,
            this._stacksBounds.max.y + this.options.workspaceOffsetY,
            this.origin.z + this.options.pullZOffset
        );
    }

    /**
     * Apply current stack positions to all grids.
     * @private
     */
    _applyStackPositions() {
        for (const entry of this.gridToEntry.values()) {
            if (!entry.pulled) {
                entry.grid.position.copy(entry.stackPosition);
            }
        }
    }

    /**
     * Refresh positions within a single stack (e.g., after a file is pulled/returned).
     * Entries that are pulled leave a visual gap.
     * @private
     * @param {DirectoryStack} stack
     */
    _refreshStackPositions(stack) {
        const { stackZOffset, fanZOffset, fanXShift, stackPeekY } = this.options;
        const x = stack.origin.x;
        const y = stack.origin.y;

        let visibleIndex = 0;

        for (const entry of stack.entries) {
            if (entry.pulled) {
                // Pulled files stay in workspace; skip but leave a gap
                continue;
            }

            if (stack.fanned) {
                // Recalculate fan position with compacted indices
                entry.grid.position.set(
                    x + visibleIndex * fanXShift,
                    y - (visibleIndex * stackPeekY * 0.5),
                    this.origin.z + (stack.entries.length - 1 - visibleIndex) * fanZOffset
                );
            } else {
                entry.grid.position.set(
                    x,
                    y - (visibleIndex * stackPeekY),
                    this.origin.z + (stack.entries.length - 1 - visibleIndex) * stackZOffset
                );
            }

            visibleIndex++;
        }
    }

    /**
     * Layout files in the workspace area (simple horizontal row).
     * @private
     */
    _layoutWorkspace() {
        const { workspaceSpacing, pullZOffset } = this.options;
        let x = this._workspaceOrigin.x;
        const y = this._workspaceOrigin.y;
        const z = this.origin.z + pullZOffset;

        for (const grid of this.workspaceGrids) {
            grid.position.set(x, y, z);

            const bounds = grid.getBounds();
            const w = bounds.max.x - bounds.min.x;
            x += w + workspaceSpacing;
        }
    }

    // ============ Utility ============

    /**
     * Find which stack a grid belongs to.
     * @private
     * @param {CodeGrid} grid
     * @returns {DirectoryStack|null}
     */
    _getStackForGrid(grid) {
        const entry = this.gridToEntry.get(grid);
        if (!entry) return null;

        // Find the directory this grid belongs to
        const node = this.gridToNode.get(grid);
        if (!node || !node.parent) return null;

        return this.stacks.get(node.parent.path) || null;
    }
}

export default StackLayoutManager;
