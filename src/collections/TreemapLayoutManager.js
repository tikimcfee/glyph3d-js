/**
 * TreemapLayoutManager - Squarified treemap layout for CodeGrids
 *
 * Every file gets a rectangular region proportional to its line count.
 * The entire area is filled — no wasted space. Directories become
 * nested sub-regions. The result is a GrandPerspective-style dense map
 * where file weight is instantly visible from any zoom level.
 *
 * Z-axis: directory depth creates layered topography — deeper files
 * sit slightly behind, giving a 3D stepped look.
 */

import * as THREE from 'three';

class TreemapLayoutManager {
    /**
     * @param {Object} options
     * @param {number} [options.padding=3] - Gap between siblings
     * @param {number} [options.dirPadding=6] - Inset for directory containers
     * @param {number} [options.depthZ=5] - Z step per directory depth
     * @param {number} [options.totalWidth=2000] - Total treemap width
     * @param {number} [options.totalHeight=1200] - Total treemap height
     * @param {number} [options.originX=0]
     * @param {number} [options.originY=0]
     * @param {number} [options.originZ=0]
     */
    constructor(options = {}) {
        this.options = {
            padding: options.padding ?? 3,
            dirPadding: options.dirPadding ?? 6,
            depthZ: options.depthZ ?? 5,
            totalWidth: options.totalWidth ?? 2000,
            totalHeight: options.totalHeight ?? 1200,
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

        const rect = {
            x: this.origin.x,
            y: this.origin.y,
            w: this.options.totalWidth,
            h: this.options.totalHeight,
        };

        this._layout(this.root, rect, 0);
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
        if (!node || !node._rect) return null;
        const r = node._rect;
        return new THREE.Box3(
            new THREE.Vector3(r.x, r.y - r.h, this.origin.z - (node.depth || 0) * this.options.depthZ),
            new THREE.Vector3(r.x + r.w, r.y, this.origin.z)
        );
    }

    clear() {
        this.grids = [];
        this.root = null;
        this.pathToNode.clear();
        this.gridToNode.clear();
    }

    // ============ Build Tree ============

    _buildTree(grids) {
        const root = { name: '', path: '', isDir: true, grid: null, children: [], parent: null, area: 0, depth: 0 };
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
                    dirNode = { name: parts[i], path: currentPath, isDir: true, grid: null, children: [], parent: current, area: 0, depth: current.depth + 1 };
                    current.children.push(dirNode);
                    this.pathToNode.set(currentPath, dirNode);
                }
                current = dirNode;
            }

            const fileName = parts[parts.length - 1] || sourcePath;
            const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;
            const bounds = grid.getBounds();
            const lineCount = Math.max(bounds.max.y - bounds.min.y, 1);

            const fileNode = { name: fileName, path: filePath, isDir: false, grid, children: [], parent: current, area: lineCount, depth: current.depth + 1 };
            current.children.push(fileNode);
            this.pathToNode.set(filePath, fileNode);
            this.gridToNode.set(grid, fileNode);
        }

        this._computeAreas(root);
        this._sortByArea(root);
        return root;
    }

    _computeAreas(node) {
        if (!node.isDir) return node.area;
        let sum = 0;
        for (const child of node.children) sum += this._computeAreas(child);
        node.area = sum;
        return sum;
    }

    _sortByArea(node) {
        if (!node.isDir) return;
        node.children.sort((a, b) => b.area - a.area);
        for (const child of node.children) this._sortByArea(child);
    }

    // ============ Layout ============

    _layout(node, rect, depth) {
        node._rect = { ...rect };

        if (!node.isDir) {
            if (node.grid) {
                const z = this.origin.z - depth * this.options.depthZ;
                node.grid.position.set(rect.x, rect.y, z);
            }
            return;
        }

        if (node.children.length === 0) return;

        // Inset for directory padding
        const pad = depth > 0 ? this.options.dirPadding : 0;
        const inner = {
            x: rect.x + pad,
            y: rect.y - pad,
            w: Math.max(rect.w - pad * 2, 1),
            h: Math.max(rect.h - pad * 2, 1),
        };

        // Squarify children into this rectangle
        this._squarify(node.children, inner, depth);
    }

    /**
     * Squarified treemap: slice-and-dice with aspect ratio optimization.
     * Places children into rect, recursing for directory children.
     */
    _squarify(children, rect, depth) {
        if (children.length === 0) return;

        const totalArea = children.reduce((s, c) => s + c.area, 0);
        if (totalArea <= 0) return;

        // Working copy of the remaining rectangle
        let rx = rect.x;
        let ry = rect.y;
        let rw = rect.w;
        let rh = rect.h;

        let i = 0;
        const pad = this.options.padding;

        while (i < children.length) {
            // Determine layout direction: lay rows along the shorter side
            const vertical = rw <= rh; // if rect is taller, lay horizontal strips

            const remainingArea = children.slice(i).reduce((s, c) => s + c.area, 0);
            const areaScale = (rw * rh) / remainingArea;

            // Greedily build a row that minimizes worst aspect ratio
            let rowEnd = i + 1;
            let bestWorst = Infinity;

            for (let end = i + 1; end <= children.length; end++) {
                let rowArea = 0;
                for (let k = i; k < end; k++) rowArea += children[k].area;

                const rowPixels = rowArea * areaScale;
                const sideLen = vertical ? rw : rh;
                const rowThickness = rowPixels / sideLen;

                // Compute worst aspect ratio in this row
                let worst = 0;
                for (let k = i; k < end; k++) {
                    const itemPixels = children[k].area * areaScale;
                    const itemLen = itemPixels / rowThickness;
                    const ar = Math.max(rowThickness / Math.max(itemLen, 0.01), itemLen / Math.max(rowThickness, 0.01));
                    worst = Math.max(worst, ar);
                }

                if (worst <= bestWorst) {
                    bestWorst = worst;
                    rowEnd = end;
                } else {
                    break;
                }
            }

            // Lay out the chosen row
            let rowArea = 0;
            for (let k = i; k < rowEnd; k++) rowArea += children[k].area;

            const rowPixels = rowArea * areaScale;
            const sideLen = vertical ? rw : rh;
            const rowThickness = rowPixels / sideLen;

            let offset = 0;
            for (let k = i; k < rowEnd; k++) {
                const itemFrac = children[k].area / rowArea;
                const itemLen = itemFrac * sideLen;

                let childRect;
                if (vertical) {
                    // Horizontal strips stacked top to bottom
                    childRect = {
                        x: rx,
                        y: ry - offset,
                        w: rowThickness - pad,
                        h: itemLen - pad,
                    };
                } else {
                    // Vertical strips laid left to right
                    childRect = {
                        x: rx + offset,
                        y: ry,
                        w: itemLen - pad,
                        h: rowThickness - pad,
                    };
                }

                // Ensure non-negative dimensions
                childRect.w = Math.max(childRect.w, 0);
                childRect.h = Math.max(childRect.h, 0);

                this._layout(children[k], childRect, depth + 1);
                offset += itemLen;
            }

            // Shrink remaining rectangle
            if (vertical) {
                rx += rowThickness;
                rw -= rowThickness;
            } else {
                ry -= rowThickness;
                rh -= rowThickness;
            }

            rw = Math.max(rw, 0);
            rh = Math.max(rh, 0);

            i = rowEnd;
        }
    }
}

export default TreemapLayoutManager;
