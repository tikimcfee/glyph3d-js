/**
 * TreemapLayoutManager - Dense rectangle packing for CodeGrids
 *
 * Packs code file grids at their actual dimensions using a skyline
 * bin-packing algorithm. Files are sorted by height (tallest first)
 * and packed left-to-right, bottom-up. Directory grouping is maintained
 * by packing each directory's files together as a contiguous block.
 *
 * Z-axis: directory depth. Deeper directories sit slightly behind,
 * creating layered topography visible when zoomed out.
 *
 * No resizing — every file keeps its real dimensions. The layout just
 * finds where to put them so nothing overlaps and space is used well.
 */

import * as THREE from 'three';

class TreemapLayoutManager {
    /**
     * @param {Object} options
     * @param {number} [options.padding=4] - Gap between files
     * @param {number} [options.dirGap=12] - Extra gap between directory groups
     * @param {number} [options.depthZ=8] - Z offset per directory depth
     * @param {number} [options.maxRowWidth=3000] - Max width before wrapping
     * @param {number} [options.originX=0]
     * @param {number} [options.originY=0]
     * @param {number} [options.originZ=0]
     */
    constructor(options = {}) {
        this.options = {
            padding: options.padding ?? 4,
            dirGap: options.dirGap ?? 10,
            depthZ: options.depthZ ?? 8,
            maxRowWidth: options.maxRowWidth ?? 600,
        };

        this.origin = new THREE.Vector3(
            options.originX || 0,
            options.originY || 0,
            options.originZ || 0
        );

        this.grids = [];
        this.root = null;
        this.pathToNode = new Map();
        this.gridToNode = new Map();
    }

    // ============ Main API ============

    layoutTreemap(grids) {
        this.grids = grids;
        this.root = this._buildTree(grids);

        // Collect files grouped by directory, sorted by area descending
        const groups = this._groupByDirectory(this.root);

        // Pack groups using skyline algorithm
        this._packGroups(groups);

        return this.root;
    }

    getTotalBounds() {
        const box = new THREE.Box3();
        for (const grid of this.grids) {
            box.union(grid.getBounds());
        }
        return box;
    }

    getGrids() { return [...this.grids]; }

    getDirectoryBounds(dirPath) {
        const node = this.pathToNode.get(dirPath);
        if (!node || !node.isDir) return null;
        const box = new THREE.Box3();
        this._collectBounds(node, box);
        return box.isEmpty() ? null : box;
    }

    clear() {
        this.grids = [];
        this.root = null;
        this.pathToNode.clear();
        this.gridToNode.clear();
    }

    // ============ Build Tree ============

    _buildTree(grids) {
        const root = { name: '', path: '', isDir: true, grid: null, children: [], parent: null, depth: 0 };
        this.pathToNode.set('', root);

        for (const grid of grids) {
            const sourcePath = grid.userData?.sourcePath || grid.filename || 'unknown';
            const parts = sourcePath.split('/').filter(p => p.length > 0);

            let current = root;
            let currentPath = '';

            for (let i = 0; i < parts.length - 1; i++) {
                currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
                let dirNode = this.pathToNode.get(currentPath);
                if (!dirNode) {
                    dirNode = { name: parts[i], path: currentPath, isDir: true, grid: null, children: [], parent: current, depth: current.depth + 1 };
                    current.children.push(dirNode);
                    this.pathToNode.set(currentPath, dirNode);
                }
                current = dirNode;
            }

            const fileName = parts[parts.length - 1] || sourcePath;
            const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;

            const fileNode = { name: fileName, path: filePath, isDir: false, grid, children: [], parent: current, depth: current.depth + 1 };
            current.children.push(fileNode);
            this.pathToNode.set(filePath, fileNode);
            this.gridToNode.set(grid, fileNode);
        }

        return root;
    }

    // ============ Group by Directory ============

    /**
     * Flatten tree into ordered groups of files.
     * Each group = one directory's direct files.
     * Groups ordered depth-first, directories sorted alphabetically.
     */
    _groupByDirectory(root) {
        const groups = [];
        this._collectGroups(root, groups);
        return groups;
    }

    _collectGroups(node, groups) {
        if (!node.isDir) return;

        // Sort children: directories first (alphabetically), then files (by height descending)
        const dirs = node.children.filter(c => c.isDir).sort((a, b) => a.name.localeCompare(b.name));
        const files = node.children.filter(c => !c.isDir);

        // Sort files by height descending (tallest first packs best)
        files.sort((a, b) => {
            const aH = a.grid.getBounds().max.y - a.grid.getBounds().min.y;
            const bH = b.grid.getBounds().max.y - b.grid.getBounds().min.y;
            return bH - aH;
        });

        if (files.length > 0) {
            groups.push({
                dirPath: node.path,
                depth: node.depth,
                files: files,
            });
        }

        for (const dir of dirs) {
            this._collectGroups(dir, groups);
        }
    }

    // ============ Skyline Packing ============

    /**
     * Pack all groups using a two-level shelf algorithm.
     *
     * Level 1: Within each directory, files flow left-to-right in rows.
     * Level 2: Directory groups themselves flow left-to-right, wrapping
     *          to new super-rows — creating a 2D grid of directory blocks.
     */
    _packGroups(groups) {
        const { padding, dirGap, depthZ, maxRowWidth } = this.options;

        // First, compute each group's bounding dimensions
        const groupBlocks = groups.map(group => {
            const block = this._computeGroupBlock(group, padding, maxRowWidth);
            return { group, ...block };
        });

        // Pack group blocks in a 2D flow layout
        // Aim for a roughly square overall shape
        const totalBlockArea = groupBlocks.reduce((s, b) => s + b.width * b.height, 0);
        const superMaxWidth = Math.max(Math.sqrt(totalBlockArea) * 1.5, maxRowWidth);
        let superX = this.origin.x;
        let superY = this.origin.y;
        let superRowHeight = 0;

        for (const block of groupBlocks) {
            // Wrap super-row
            if (superX > this.origin.x && (superX - this.origin.x + block.width) > superMaxWidth) {
                superY -= superRowHeight + dirGap;
                superX = this.origin.x;
                superRowHeight = 0;
            }

            // Place this group's files at (superX, superY)
            const z = this.origin.z - block.group.depth * depthZ;
            this._placeGroupFiles(block.group, superX, superY, z, padding, maxRowWidth);

            superX += block.width + dirGap;
            superRowHeight = Math.max(superRowHeight, block.height);
        }
    }

    /**
     * Compute the bounding box a group of files would occupy.
     * @private
     */
    _computeGroupBlock(group, padding, maxRowWidth) {
        let x = 0;
        let rowHeight = 0;
        let totalWidth = 0;
        let totalHeight = 0;

        for (const fileNode of group.files) {
            const bounds = fileNode.grid.getBounds();
            const w = bounds.max.x - bounds.min.x;
            const h = bounds.max.y - bounds.min.y;

            if (x > 0 && x + w > maxRowWidth) {
                totalHeight += rowHeight + padding;
                totalWidth = Math.max(totalWidth, x - padding);
                x = 0;
                rowHeight = 0;
            }

            x += w + padding;
            rowHeight = Math.max(rowHeight, h);
        }

        totalHeight += rowHeight;
        totalWidth = Math.max(totalWidth, x - padding);

        return { width: totalWidth, height: totalHeight };
    }

    /**
     * Place a group's files at a given origin.
     * @private
     */
    _placeGroupFiles(group, originX, originY, z, padding, maxRowWidth) {
        let x = originX;
        let cursorY = originY;
        let rowHeight = 0;

        for (const fileNode of group.files) {
            const grid = fileNode.grid;
            const bounds = grid.getBounds();
            const w = bounds.max.x - bounds.min.x;
            const h = bounds.max.y - bounds.min.y;

            if (x > originX && (x - originX + w) > maxRowWidth) {
                cursorY -= rowHeight + padding;
                x = originX;
                rowHeight = 0;
            }

            grid.position.set(x, cursorY, z);

            x += w + padding;
            rowHeight = Math.max(rowHeight, h);
        }
    }

    // ============ Utilities ============

    _collectBounds(node, box) {
        if (node.grid) box.union(node.grid.getBounds());
        for (const child of node.children) this._collectBounds(child, box);
    }
}

export default TreemapLayoutManager;
