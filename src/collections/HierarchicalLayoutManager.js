/**
 * HierarchicalLayoutManager - Positions CodeGrids based on directory structure
 *
 * Maps directory hierarchy to 3D spatial layout:
 * - Directories become bounding regions
 * - Files positioned within parent directory bounds
 * - Sibling directories positioned next to each other
 * - Depth can map to Z-axis or nested XY regions
 *
 * CRITICAL: All grid bounds must be computed BEFORE calling layoutHierarchy().
 * This works with the Phase 2/2b separation where workers compute bounds in Phase 2.
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> GlyphCollection -> CodeGrid -> HierarchicalLayoutManager
 */

import * as THREE from 'three';

/**
 * @typedef {Object} TreeNode
 * @property {string} name - Directory or file name
 * @property {string} path - Full path from root
 * @property {boolean} isDirectory - True for directories, false for files
 * @property {CodeGrid|null} grid - Grid for files, null for directories
 * @property {TreeNode[]} children - Child nodes (for directories)
 * @property {TreeNode|null} parent - Parent node
 * @property {Object} bounds - Computed bounds {width, height, depth}
 * @property {THREE.Vector3} position - Final position in 3D space
 */

/**
 * @typedef {Object} LayoutOptions
 * @property {number} [dirPadding=50] - Padding inside directory bounds
 * @property {number} [siblingSpacing=30] - Space between sibling items
 * @property {number} [depthSpacing=100] - Z-spacing for depth (if useZForDepth)
 * @property {boolean} [useZForDepth=false] - Map tree depth to Z-axis
 * @property {boolean} [directoriesInZ=true] - Stack sibling directories in Z (files stay horizontal)
 * @property {number} [directoryZSpacing=50] - Z-spacing between sibling directories
 * @property {'horizontal'|'vertical'} [siblingDirection='horizontal'] - Layout direction for siblings
 * @property {number} [maxRowWidth=1500] - Max width before wrapping (for horizontal)
 */

class HierarchicalLayoutManager {
    /**
     * Create a HierarchicalLayoutManager
     * @param {LayoutOptions} options - Configuration options
     */
    constructor(options = {}) {
        this.options = {
            dirPadding: options.dirPadding || 20,
            dirPaddingDecay: options.dirPaddingDecay ?? 0.7, // padding shrinks per depth
            siblingSpacing: options.siblingSpacing || 10,
            depthSpacing: options.depthSpacing || 100,
            useZForDepth: options.useZForDepth || false,
            directoriesInZ: options.directoriesInZ || false,  // Default false: dirs flow horizontally
            directoryZSpacing: options.directoryZSpacing || 50,
            siblingDirection: options.siblingDirection || 'horizontal',
            maxRowWidth: options.maxRowWidth || 8000,
            // Aspect-ratio-aware layout: target width/height ratio for directories.
            // 0 = disabled (use fixed maxRowWidth). >0 = adaptive.
            // 3.0 means "try to make directories 3× wider than tall"
            targetAspectRatio: options.targetAspectRatio ?? 3.0,
            // Collapsed directory placeholder size
            collapsedWidth: options.collapsedWidth || 80,
            collapsedHeight: options.collapsedHeight || 15
        };

        // Tree structure
        this.root = null;

        // Grid lookup
        this.gridToNode = new Map();  // grid -> TreeNode
        this.pathToNode = new Map();  // path -> TreeNode

        // Collapse state — set of directory paths that are collapsed
        this.collapsedPaths = new Set();

        // Origin offset
        this.origin = new THREE.Vector3(
            options.originX || 0,
            options.originY || 0,
            options.originZ || 0
        );
    }

    // ============ Main API ============

    /**
     * Build tree and compute layout for all grids
     *
     * IMPORTANT: Grid bounds must already be computed (via workers).
     * Call this in Phase 2b after all grids have loaded their content.
     *
     * @param {CodeGrid[]} grids - Array of grids with userData.sourcePath set
     * @returns {TreeNode} The root of the tree
     */
    layoutHierarchy(grids) {
        // Phase 1: Build tree from paths
        this.root = this._buildTree(grids);

        // Phase 2: Compute bounds bottom-up (depth 0 for root)
        this._computeBoundsBottomUp(this.root, 0);

        // Phase 3: Position nodes top-down
        const rootRegion = {
            x: this.origin.x,
            y: this.origin.y,
            z: this.origin.z,
            width: this.root.bounds.width,
            height: this.root.bounds.height
        };
        this._positionNodesTopDown(this.root, rootRegion, 0);

        // Phase 4: Apply positions to grids
        this._applyPositionsToGrids(this.root);

        return this.root;
    }

    /**
     * Get the tree node for a grid
     * @param {CodeGrid} grid
     * @returns {TreeNode|null}
     */
    getNodeForGrid(grid) {
        return this.gridToNode.get(grid) || null;
    }

    /**
     * Get the tree node for a path
     * @param {string} path
     * @returns {TreeNode|null}
     */
    getNodeForPath(path) {
        return this.pathToNode.get(path) || null;
    }

    /**
     * Get all grids in a directory (recursive)
     * @param {string} dirPath - Directory path
     * @returns {CodeGrid[]}
     */
    getGridsInDirectory(dirPath) {
        const node = this.pathToNode.get(dirPath);
        if (!node || !node.isDirectory) return [];

        const grids = [];
        this._collectGrids(node, grids);
        return grids;
    }

    /**
     * Get directory hierarchy as flat list with depth
     * @returns {Array<{path: string, depth: number, isDirectory: boolean, grid: CodeGrid|null}>}
     */
    getFlatHierarchy() {
        const result = [];
        this._flattenTree(this.root, 0, result);
        return result;
    }

    /**
     * Get bounding box for a directory
     * @param {string} dirPath - Directory path
     * @returns {THREE.Box3|null}
     */
    getDirectoryBounds(dirPath) {
        const node = this.pathToNode.get(dirPath);
        if (!node) return null;

        return new THREE.Box3(
            new THREE.Vector3(
                node.position.x,
                node.position.y - node.bounds.height,
                node.position.z
            ),
            new THREE.Vector3(
                node.position.x + node.bounds.width,
                node.position.y,
                node.position.z + (this.options.useZForDepth ? this.options.depthSpacing : 0)
            )
        );
    }

    /**
     * Get total bounds of entire layout
     * @returns {THREE.Box3}
     */
    getTotalBounds() {
        if (!this.root) return new THREE.Box3();

        // Z extends in negative direction (behind camera) with directoriesInZ
        const zMin = this.origin.z - this.root.bounds.depth;
        const zMax = this.origin.z;

        return new THREE.Box3(
            new THREE.Vector3(
                this.origin.x,
                this.origin.y - this.root.bounds.height,
                zMin
            ),
            new THREE.Vector3(
                this.origin.x + this.root.bounds.width,
                this.origin.y,
                zMax
            )
        );
    }

    // ============ Collapse API ============

    /**
     * Toggle collapse state for a directory
     * @param {string} dirPath - Directory path
     * @returns {boolean} New collapse state (true = collapsed)
     */
    toggleCollapse(dirPath) {
        if (this.collapsedPaths.has(dirPath)) {
            this.collapsedPaths.delete(dirPath);
            return false;
        } else {
            this.collapsedPaths.add(dirPath);
            return true;
        }
    }

    /**
     * Set collapse state for a directory
     * @param {string} dirPath - Directory path
     * @param {boolean} collapsed - Whether to collapse
     */
    setCollapsed(dirPath, collapsed) {
        if (collapsed) {
            this.collapsedPaths.add(dirPath);
        } else {
            this.collapsedPaths.delete(dirPath);
        }
    }

    /**
     * Check if a directory is collapsed
     * @param {string} dirPath - Directory path
     * @returns {boolean}
     */
    isCollapsed(dirPath) {
        return this.collapsedPaths.has(dirPath);
    }

    /**
     * Check if a node is hidden by a collapsed ancestor
     * @param {TreeNode} node
     * @returns {boolean}
     */
    isHiddenByCollapse(node) {
        let current = node.parent;
        while (current) {
            if (current.path !== '' && this.collapsedPaths.has(current.path)) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    /**
     * Re-layout existing tree with current collapse state.
     * Skips tree building (Phase 1) - only recomputes bounds, positions, and applies.
     * Call this after toggling collapse state for responsive re-layout.
     */
    relayout() {
        if (!this.root) return;

        // Phase 2: Recompute bounds (collapse-aware)
        this._computeBoundsBottomUp(this.root, 0);

        // Phase 3: Reposition
        const rootRegion = {
            x: this.origin.x,
            y: this.origin.y,
            z: this.origin.z,
            width: this.root.bounds.width,
            height: this.root.bounds.height
        };
        this._positionNodesTopDown(this.root, rootRegion, 0);

        // Phase 4: Apply (with visibility)
        this._applyPositionsToGrids(this.root);
    }

    /**
     * Clear the layout (preserves collapse state)
     */
    clear() {
        this.root = null;
        this.gridToNode.clear();
        this.pathToNode.clear();
    }

    /**
     * Clear the layout including collapse state
     */
    clearAll() {
        this.clear();
        this.collapsedPaths.clear();
    }

    // ============ Phase 1: Build Tree ============

    /**
     * Build tree structure from file paths
     * @private
     * @param {CodeGrid[]} grids
     * @returns {TreeNode}
     */
    _buildTree(grids) {
        // Create root node
        const root = this._createNode('', '', true, null);
        this.pathToNode.set('', root);

        for (const grid of grids) {
            const sourcePath = grid.userData?.sourcePath || grid.filename || 'unknown';
            const parts = sourcePath.split('/').filter(p => p.length > 0);

            let currentNode = root;
            let currentPath = '';

            // Create directory nodes
            for (let i = 0; i < parts.length - 1; i++) {
                currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

                let dirNode = this.pathToNode.get(currentPath);
                if (!dirNode) {
                    dirNode = this._createNode(parts[i], currentPath, true, currentNode);
                    currentNode.children.push(dirNode);
                    this.pathToNode.set(currentPath, dirNode);
                }
                currentNode = dirNode;
            }

            // Create file node
            const fileName = parts[parts.length - 1] || sourcePath;
            const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;

            const fileNode = this._createNode(fileName, filePath, false, currentNode);
            fileNode.grid = grid;
            currentNode.children.push(fileNode);

            this.pathToNode.set(filePath, fileNode);
            this.gridToNode.set(grid, fileNode);
        }

        // Sort children alphabetically (directories first, then files)
        this._sortChildren(root);

        return root;
    }

    /**
     * Create a tree node
     * @private
     */
    _createNode(name, path, isDirectory, parent) {
        return {
            name,
            path,
            isDirectory,
            grid: null,
            children: [],
            parent,
            bounds: { width: 0, height: 0, depth: 0 },
            position: new THREE.Vector3()
        };
    }

    /**
     * Sort children: directories first, then files, alphabetically
     * @private
     */
    _sortChildren(node) {
        if (!node.isDirectory) return;

        node.children.sort((a, b) => {
            // Directories before files
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            // Alphabetically
            return a.name.localeCompare(b.name);
        });

        // Recurse
        for (const child of node.children) {
            this._sortChildren(child);
        }
    }

    // ============ Phase 2: Compute Bounds Bottom-Up ============

    /**
     * Compute padding for a given depth, shrinking at deeper levels
     * @private
     */
    _paddingForDepth(depth) {
        return this.options.dirPadding * Math.pow(this.options.dirPaddingDecay, depth);
    }

    /**
     * Compute bounds for all nodes, bottom-up
     * @private
     * @param {TreeNode} node
     * @param {number} depth - Current tree depth (for depth-aware padding)
     * @returns {{width: number, height: number, depth: number}}
     */
    _computeBoundsBottomUp(node, depth) {
        if (!node.isDirectory) {
            // Leaf node: get bounds from grid (includes Z-depth from long-line wrapping)
            if (node.grid) {
                const gridBounds = node.grid.getBounds();
                const zDepth = Math.abs(gridBounds.max.z - gridBounds.min.z);
                node.bounds = {
                    width: gridBounds.max.x - gridBounds.min.x,
                    height: gridBounds.max.y - gridBounds.min.y,
                    depth: zDepth
                };
            }
            return node.bounds;
        }

        // If this directory is collapsed, return a small placeholder size
        if (node.path !== '' && this.collapsedPaths.has(node.path)) {
            const nameWidth = Math.max(
                node.name.length * 0.5 + 4,
                this.options.collapsedWidth
            );
            node.bounds = {
                width: nameWidth,
                height: this.options.collapsedHeight,
                depth: 0
            };
            return node.bounds;
        }

        // Directory: compute children first
        const childBounds = [];
        let maxDepth = 0;

        for (const child of node.children) {
            const bounds = this._computeBoundsBottomUp(child, depth + 1);
            childBounds.push(bounds);
            maxDepth = Math.max(maxDepth, bounds.depth);
        }

        // Depth-aware padding: shrinks at deeper levels to avoid compounding dead space
        const padding = this._paddingForDepth(depth);
        const spacing = this.options.siblingSpacing;

        if (this.options.siblingDirection === 'horizontal') {
            if (this.options.directoriesInZ) {
                // Legacy Z-stacking mode for directories
                const fileChildren = node.children.filter(c => !c.isDirectory);
                const dirChildren = node.children.filter(c => c.isDirectory);
                const fileBounds = fileChildren.map(c => c.bounds);
                const dirBounds = dirChildren.map(c => c.bounds);

                const fileLayout = this._computeWrappedLayout(fileBounds);
                let fileMaxDepth = 0;
                for (const b of fileBounds) fileMaxDepth = Math.max(fileMaxDepth, b.depth);

                let dirMaxWidth = 0, dirMaxHeight = 0, dirTotalDepth = 0;
                for (const b of dirBounds) {
                    dirMaxWidth = Math.max(dirMaxWidth, b.width);
                    dirMaxHeight = Math.max(dirMaxHeight, b.height);
                    dirTotalDepth += this.options.directoryZSpacing + b.depth;
                }

                node.bounds = {
                    width: Math.max(fileLayout.width, dirMaxWidth) + padding * 2,
                    height: fileLayout.height + dirMaxHeight + (dirChildren.length > 0 ? spacing : 0) + padding * 2,
                    depth: fileMaxDepth + dirTotalDepth
                };
            } else {
                // Horizontal flow: ALL children (files + dirs) in adaptive wrapped layout
                const layout = this._computeWrappedLayout(childBounds);
                // Store the computed wrap width on the node for consistent positioning
                node._layoutWrapWidth = layout._wrapWidth;
                node.bounds = {
                    width: layout.width + padding * 2,
                    height: layout.height + padding * 2,
                    depth: this.options.useZForDepth ? maxDepth + this.options.depthSpacing : maxDepth
                };
            }
        } else {
            // Vertical layout (stack)
            let totalHeight = 0;
            let maxWidth = 0;
            for (const bounds of childBounds) {
                totalHeight += bounds.height;
                maxWidth = Math.max(maxWidth, bounds.width);
            }
            totalHeight += spacing * Math.max(0, childBounds.length - 1);

            node.bounds = {
                width: maxWidth + padding * 2,
                height: totalHeight + padding * 2,
                depth: this.options.useZForDepth ? maxDepth + this.options.depthSpacing : maxDepth
            };
        }

        return node.bounds;
    }

    /**
     * Compute layout dimensions for horizontal wrapping.
     *
     * If `targetAspectRatio` is set, dynamically computes a wrap width
     * that produces a roughly balanced rectangle instead of using a fixed limit.
     * For a target ratio of 3.0, directories aim to be ~3× wider than tall.
     *
     * @private
     * @param {Array<{width, height}>} childBounds
     * @returns {{width: number, height: number, rows: Array, _wrapWidth: number}}
     */
    _computeWrappedLayout(childBounds) {
        if (childBounds.length === 0) {
            return { width: 0, height: 0, rows: [], _wrapWidth: 0 };
        }

        const spacing = this.options.siblingSpacing;

        // Determine wrap width
        let maxRowWidth;

        if (this.options.targetAspectRatio > 0) {
            // Adaptive: compute wrap width targeting a width:height ratio.
            // Estimate total area including spacing.
            let totalArea = 0;
            let maxChildWidth = 0;
            for (const b of childBounds) {
                totalArea += (b.width + spacing) * (b.height + spacing);
                maxChildWidth = Math.max(maxChildWidth, b.width);
            }

            // For target aspect R: W = sqrt(A * R)
            const targetWidth = Math.sqrt(totalArea * this.options.targetAspectRatio);

            // Don't go narrower than the widest child, and cap at maxRowWidth
            maxRowWidth = Math.max(targetWidth, maxChildWidth + spacing);
            maxRowWidth = Math.min(maxRowWidth, this.options.maxRowWidth);
        } else {
            maxRowWidth = this.options.maxRowWidth;
        }

        // Wrap items into rows
        const rows = this._wrapIntoRows(childBounds, maxRowWidth, spacing);

        // Total dimensions
        let totalWidth = 0;
        let totalHeight = 0;
        for (const row of rows) {
            totalWidth = Math.max(totalWidth, row.width);
            totalHeight += row.height;
        }
        totalHeight += spacing * Math.max(0, rows.length - 1);

        return { width: totalWidth, height: totalHeight, rows, _wrapWidth: maxRowWidth };
    }

    /**
     * Wrap child bounds into rows given a max row width.
     * @private
     */
    _wrapIntoRows(childBounds, maxRowWidth, spacing) {
        const rows = [];
        let currentRow = [];
        let currentRowWidth = 0;
        let currentRowHeight = 0;

        for (const bounds of childBounds) {
            const wouldExceed = currentRow.length > 0 &&
                (currentRowWidth + spacing + bounds.width > maxRowWidth);

            if (wouldExceed) {
                rows.push({ items: currentRow, width: currentRowWidth, height: currentRowHeight });
                currentRow = [];
                currentRowWidth = 0;
                currentRowHeight = 0;
            }

            currentRow.push(bounds);
            currentRowWidth += (currentRow.length > 1 ? spacing : 0) + bounds.width;
            currentRowHeight = Math.max(currentRowHeight, bounds.height);
        }

        if (currentRow.length > 0) {
            rows.push({ items: currentRow, width: currentRowWidth, height: currentRowHeight });
        }

        return rows;
    }

    // ============ Phase 3: Position Nodes Top-Down ============

    /**
     * Position nodes within their allocated regions
     * @private
     * @param {TreeNode} node
     * @param {{x, y, z, width, height}} region - Allocated region
     * @param {number} depth - Current depth in tree
     */
    _positionNodesTopDown(node, region, depth) {
        // Set node position (top-left of region)
        node.position.set(region.x, region.y, region.z);

        if (!node.isDirectory || node.children.length === 0) {
            return;
        }

        // If collapsed, don't position children (they'll be hidden)
        if (node.path !== '' && this.collapsedPaths.has(node.path)) {
            return;
        }

        // Depth-aware padding (matches bounds computation)
        const padding = this._paddingForDepth(depth);
        const spacing = this.options.siblingSpacing;

        // Inner region for children (after padding)
        const innerX = region.x + padding;
        const innerY = region.y - padding;
        const innerZ = this.options.useZForDepth
            ? region.z - this.options.depthSpacing
            : region.z;

        // Position children based on layout direction
        if (this.options.siblingDirection === 'horizontal') {
            // Use the wrap width computed during bounds phase if available
            const wrapWidth = node._layoutWrapWidth || this.options.maxRowWidth;
            this._positionChildrenHorizontal(node.children, innerX, innerY, innerZ, depth, wrapWidth);
        } else {
            this._positionChildrenVertical(node.children, innerX, innerY, innerZ, depth);
        }
    }

    /**
     * Position children horizontally with row wrapping.
     * Uses the wrap width from bounds computation for consistency.
     * @private
     */
    _positionChildrenHorizontal(children, startX, startY, z, depth, maxRowWidth) {
        const spacing = this.options.siblingSpacing;

        if (this.options.directoriesInZ) {
            // Legacy Z-stacking mode
            const directories = children.filter(c => c.isDirectory);
            const files = children.filter(c => !c.isDirectory);
            const directoryZSpacing = this.options.directoryZSpacing;

            let x = startX, y = startY, rowHeight = 0, filesMaxY = startY;
            for (const file of files) {
                const bounds = file.bounds;
                if (x > startX && (x - startX + bounds.width > maxRowWidth)) {
                    y -= rowHeight + spacing;
                    x = startX;
                    rowHeight = 0;
                }
                this._positionNodesTopDown(file, { x, y, z, width: bounds.width, height: bounds.height }, depth + 1);
                x += bounds.width + spacing;
                rowHeight = Math.max(rowHeight, bounds.height);
                filesMaxY = Math.min(filesMaxY, y - bounds.height);
            }

            const dirY = files.length > 0 ? (filesMaxY - spacing) : startY;
            let dirZ = z - directoryZSpacing;
            for (const dir of directories) {
                const bounds = dir.bounds;
                this._positionNodesTopDown(dir, { x: startX, y: dirY, z: dirZ, width: bounds.width, height: bounds.height }, depth + 1);
                dirZ -= directoryZSpacing + bounds.depth;
            }
        } else {
            // Flow layout: all children (files + directories) wrap horizontally
            let x = startX;
            let y = startY;
            let rowHeight = 0;

            for (const child of children) {
                const bounds = child.bounds;

                if (x > startX && (x - startX + bounds.width > maxRowWidth)) {
                    y -= rowHeight + spacing;
                    x = startX;
                    rowHeight = 0;
                }

                this._positionNodesTopDown(child, { x, y, z, width: bounds.width, height: bounds.height }, depth + 1);

                x += bounds.width + spacing;
                rowHeight = Math.max(rowHeight, bounds.height);
            }
        }
    }

    /**
     * Position children vertically (stacked)
     * @private
     */
    _positionChildrenVertical(children, startX, startY, z, depth) {
        const spacing = this.options.siblingSpacing;
        let y = startY;

        for (const child of children) {
            const bounds = child.bounds;

            const childRegion = {
                x: startX,
                y: y,
                z: z,
                width: bounds.width,
                height: bounds.height
            };

            this._positionNodesTopDown(child, childRegion, depth + 1);

            y -= bounds.height + spacing;
        }
    }

    // ============ Phase 4: Apply Positions to Grids ============

    /**
     * Apply computed positions to actual grids
     * @private
     * @param {TreeNode} node
     */
    _applyPositionsToGrids(node, hidden = false) {
        if (!node.isDirectory && node.grid) {
            // Apply position and visibility to grid
            node.grid.position.copy(node.position);
            node.grid.visible = !hidden;
        }

        // Check if this directory is collapsed (its children should be hidden)
        const childrenHidden = hidden ||
            (node.isDirectory && node.path !== '' && this.collapsedPaths.has(node.path));

        // Recurse for directories
        for (const child of node.children) {
            this._applyPositionsToGrids(child, childrenHidden);
        }
    }

    // ============ Utility Methods ============

    /**
     * Collect all grids under a node
     * @private
     */
    _collectGrids(node, grids) {
        if (node.grid) {
            grids.push(node.grid);
        }
        for (const child of node.children) {
            this._collectGrids(child, grids);
        }
    }

    /**
     * Flatten tree to list with depth
     * @private
     */
    _flattenTree(node, depth, result) {
        const isCollapsed = node.isDirectory && node.path !== '' && this.collapsedPaths.has(node.path);

        result.push({
            path: node.path,
            name: node.name,
            depth,
            isDirectory: node.isDirectory,
            isCollapsed,
            childCount: node.children.length,
            grid: node.grid,
            bounds: node.bounds,
            position: node.position.clone()
        });

        // If collapsed, still include children but mark them
        for (const child of node.children) {
            this._flattenTree(child, depth + 1, result);
        }
    }

    // ============ Debug / Visualization ============

    /**
     * Create debug visualization meshes for directory bounds
     * @param {THREE.Scene} scene - Scene to add meshes to
     * @param {Object} options - Visualization options
     * @returns {THREE.Group} Group containing all debug meshes
     */
    createDebugVisualization(scene, options = {}) {
        const group = new THREE.Group();
        group.name = 'HierarchicalLayoutDebug';

        const colors = options.colors || [
            0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff
        ];
        const opacity = options.opacity || 0.1;

        this._createDebugMeshes(this.root, group, colors, opacity, 0);

        scene.add(group);
        return group;
    }

    /**
     * Create debug meshes recursively
     * @private
     */
    _createDebugMeshes(node, group, colors, opacity, depth) {
        if (node.isDirectory && node.children.length > 0) {
            // Create wireframe box for directory
            const geometry = new THREE.BoxGeometry(
                node.bounds.width,
                node.bounds.height,
                10  // Thin in Z
            );

            const material = new THREE.MeshBasicMaterial({
                color: colors[depth % colors.length],
                transparent: true,
                opacity: opacity,
                wireframe: false,
                side: THREE.DoubleSide
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(
                node.position.x + node.bounds.width / 2,
                node.position.y - node.bounds.height / 2,
                node.position.z - 5
            );
            mesh.name = `dir:${node.path}`;
            group.add(mesh);

            // Add wireframe outline
            const wireGeometry = new THREE.EdgesGeometry(geometry);
            const wireMaterial = new THREE.LineBasicMaterial({
                color: colors[depth % colors.length],
                linewidth: 2
            });
            const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
            wireframe.position.copy(mesh.position);
            group.add(wireframe);
        }

        // Recurse
        for (const child of node.children) {
            this._createDebugMeshes(child, group, colors, opacity, depth + 1);
        }
    }

    /**
     * Print tree structure to console
     */
    printTree() {
        this._printNode(this.root, 0);
    }

    /**
     * Print single node
     * @private
     */
    _printNode(node, depth) {
        const indent = '  '.repeat(depth);
        const icon = node.isDirectory ? '📁' : '📄';
        const bounds = `${node.bounds.width.toFixed(0)}x${node.bounds.height.toFixed(0)}`;
        const pos = `(${node.position.x.toFixed(0)}, ${node.position.y.toFixed(0)})`;
        console.debug(`${indent}${icon} ${node.name || '(root)'} [${bounds}] @ ${pos}`);

        for (const child of node.children) {
            this._printNode(child, depth + 1);
        }
    }
}

export default HierarchicalLayoutManager;
