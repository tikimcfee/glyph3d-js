/**
 * SpiralLayoutManager - Arranges CodeGrids in a logarithmic spiral
 *
 * Files unwind outward from a center point. Each file's angular sweep
 * is proportional to its content size. Directories form contiguous
 * segments along the spiral arm — adjacency IS the grouping.
 *
 * No backdrops, no bounding boxes. The spiral shape is the structure:
 * - Tight inner coils: the densest directories (src/, lib/)
 * - Outer edge: leaf files, configs, READMEs
 * - Everything flat on Z=0 — the shape tells the story
 *
 * Think vinyl record: the grooves are files, density is code weight,
 * the center is where the heavy stuff lives.
 */

import * as THREE from 'three';

class SpiralLayoutManager {
    /**
     * @param {Object} options
     * @param {number} [options.initialRadius=30] - Starting radius
     * @param {number} [options.growthRate=0.04] - Spiral expansion per radian
     * @param {number} [options.fileGap=2] - Gap between file edges
     * @param {number} [options.armGap=0.08] - Angular gap between directory segments
     * @param {number} [options.originX=0]
     * @param {number} [options.originY=0]
     * @param {number} [options.originZ=0]
     */
    constructor(options = {}) {
        this.options = {
            initialRadius: options.initialRadius ?? 30,
            growthRate: options.growthRate ?? 0.04,
            fileGap: options.fileGap ?? 2,
            armGap: options.armGap ?? 0.08,
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

        // Spiral path points for optional visualization
        this.spiralPoints = [];
    }

    // ============ Main API ============

    /**
     * Layout grids in a spiral.
     * Grid bounds must already be computed.
     *
     * @param {CodeGrid[]} grids - Grids with userData.sourcePath set
     * @returns {Object} The root tree node
     */
    layoutSpiral(grids) {
        this.grids = grids;
        this.spiralPoints = [];

        // Phase 1: Build directory tree
        this.root = this._buildTree(grids);

        // Phase 2: Flatten tree into spiral order
        const ordered = this._spiralOrder(this.root);

        // Phase 3: Walk the spiral, placing each file
        this._placeOnSpiral(ordered);

        return this.root;
    }

    /**
     * Get total bounds of all laid-out grids
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
     * Get all managed grids
     * @returns {CodeGrid[]}
     */
    getGrids() {
        return [...this.grids];
    }

    /**
     * Get the directory path for a grid
     * @param {CodeGrid} grid
     * @returns {string|null}
     */
    getDirectoryForGrid(grid) {
        const node = this.gridToNode.get(grid);
        return node?.parent?.path || null;
    }

    /**
     * Get bounds for a directory (union of its files' spiral positions)
     * @param {string} dirPath
     * @returns {THREE.Box3|null}
     */
    getDirectoryBounds(dirPath) {
        const node = this.pathToNode.get(dirPath);
        if (!node || !node.isDirectory) return null;
        const box = new THREE.Box3();
        this._collectBounds(node, box);
        return box.isEmpty() ? null : box;
    }

    /**
     * Create a Three.js Line showing the spiral path, colored by directory.
     * Add this to your scene for a visual guide.
     * @param {typeof THREE} THREE_MODULE
     * @returns {THREE.Line}
     */
    createSpiralGuide(THREE_MODULE) {
        const T = THREE_MODULE;
        const positions = [];
        const colors = [];

        // Generate a smooth spiral path between placement points
        const { initialRadius } = this.options;
        const growthRate = this._growthRate || this.options.growthRate;
        const maxTheta = this._lastTheta || Math.PI * 8;
        const steps = Math.max(200, Math.floor(maxTheta * 10));

        for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * maxTheta;
            const r = initialRadius * Math.exp(growthRate * t);
            positions.push(
                this.origin.x + r * Math.cos(t),
                this.origin.y + r * Math.sin(t),
                this.origin.z - 1 // slightly behind grids
            );
            // Subtle white, fading outward
            const fade = 1 - (i / steps) * 0.7;
            colors.push(fade * 0.15, fade * 0.15, fade * 0.2);
        }

        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));

        const material = new T.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });

        const line = new T.Line(geometry, material);
        line.name = 'SpiralGuide';
        line.renderOrder = -20;
        return line;
    }

    /**
     * Clear layout state
     */
    clear() {
        this.grids = [];
        this.root = null;
        this.pathToNode.clear();
        this.gridToNode.clear();
        this.spiralPoints = [];
        this._lastTheta = 0;
    }

    // ============ Phase 1: Build Tree ============

    _buildTree(grids) {
        const root = { name: '', path: '', isDirectory: true, grid: null, children: [], parent: null, totalArea: 0, depth: 0 };
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
                    dirNode = { name: parts[i], path: currentPath, isDirectory: true, grid: null, children: [], parent: current, totalArea: 0, depth: current.depth + 1 };
                    current.children.push(dirNode);
                    this.pathToNode.set(currentPath, dirNode);
                }
                current = dirNode;
            }

            const fileName = parts[parts.length - 1] || sourcePath;
            const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;
            const bounds = grid.getBounds();
            const area = (bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y);

            const fileNode = { name: fileName, path: filePath, isDirectory: false, grid, children: [], parent: current, totalArea: area, depth: current.depth + 1 };
            current.children.push(fileNode);
            this.pathToNode.set(filePath, fileNode);
            this.gridToNode.set(grid, fileNode);
        }

        this._computeAreas(root);
        return root;
    }

    _computeAreas(node) {
        if (!node.isDirectory) return node.totalArea;
        let sum = 0;
        for (const child of node.children) {
            sum += this._computeAreas(child);
        }
        node.totalArea = sum;
        return sum;
    }

    // ============ Phase 2: Spiral Ordering ============

    /**
     * Flatten the tree into spiral order.
     *
     * Largest directories first (inner coils). Within a directory,
     * largest files first. This puts the heaviest code at the center
     * and config/leaf files at the outer edge.
     */
    _spiralOrder(root) {
        const result = [];
        this._collectInOrder(root, result);
        return result;
    }

    _collectInOrder(node, result) {
        if (!node.isDirectory) {
            if (node.grid) {
                result.push({ grid: node.grid, depth: node.depth, dirPath: node.parent?.path || '' });
            }
            return;
        }

        const dirs = node.children.filter(c => c.isDirectory).sort((a, b) => b.totalArea - a.totalArea);
        const files = node.children.filter(c => !c.isDirectory).sort((a, b) => b.totalArea - a.totalArea);

        // Largest directories first (they get the tight inner coils)
        for (const dir of dirs) {
            this._collectInOrder(dir, result);
            result.push({ armBreak: true });
        }

        // Then this directory's own files
        for (const file of files) {
            if (file.grid) {
                result.push({ grid: file.grid, depth: file.depth, dirPath: node.path });
            }
        }

        if (files.length > 0) {
            result.push({ armBreak: true });
        }
    }

    // ============ Phase 3: Place on Spiral ============

    /**
     * Walk a logarithmic spiral, placing each grid.
     *
     * r(θ) = a * e^(b*θ)
     *
     * The growth rate is computed adaptively: one full loop (2π radians)
     * must grow the radius by at least the median grid height + gap,
     * so adjacent loops never overlap vertically.
     *
     * Arc consumption per file uses the grid width (tangential direction).
     * The height is handled by the loop separation guarantee.
     */
    _placeOnSpiral(ordered) {
        const { initialRadius, fileGap, armGap } = this.options;

        // Compute adaptive growth rate.
        //
        // Files extend radially OUTWARD from the spiral path.
        // The inner edge sits on the spiral curve; the body pushes outward.
        // Loop separation must exceed the max file height (radial extent)
        // so files from one loop never collide with the next loop's files.
        const heights = [];
        for (const entry of ordered) {
            if (entry.armBreak) continue;
            const b = entry.grid.getBounds();
            heights.push(b.max.y - b.min.y);
        }
        if (heights.length === 0) return;

        heights.sort((a, b) => a - b);
        // 90th percentile height + gap. The remaining 10% tallest files
        // may slightly protrude but won't catastrophically overlap.
        const refHeight = heights[Math.floor(heights.length * 0.9)];
        const loopSeparation = refHeight + fileGap * 4;

        const growthRate = Math.log(1 + loopSeparation / initialRadius) / (2 * Math.PI);

        let theta = 0;

        for (const entry of ordered) {
            if (entry.armBreak) {
                theta += armGap;
                continue;
            }

            const grid = entry.grid;
            const bounds = grid.getBounds();
            const w = bounds.max.x - bounds.min.x;
            const h = bounds.max.y - bounds.min.y;

            const r = initialRadius * Math.exp(growthRate * theta);

            // Arc consumption based on WIDTH (tangential to spiral).
            // Height is handled by loop separation.
            const arcNeeded = w + fileGap;
            const dTheta = arcNeeded / Math.max(r, 1);

            const midTheta = theta + dTheta / 2;
            const midR = initialRadius * Math.exp(growthRate * midTheta);

            const cx = this.origin.x + midR * Math.cos(midTheta);
            const cy = this.origin.y + midR * Math.sin(midTheta);

            // Place grid centered on the spiral point
            grid.position.set(cx - w / 2, cy + h / 2, this.origin.z);

            this.spiralPoints.push({ x: cx, y: cy, theta: midTheta, dirPath: entry.dirPath });

            theta += dTheta;
        }

        this._lastTheta = theta;
        this._growthRate = growthRate;

        // Collision resolution: push overlapping grids apart
        this._resolveCollisions();
    }

    /**
     * Resolve overlapping grids by pushing them radially outward.
     * Simple O(n²) sweep — fine for <200 grids.
     * @private
     */
    _resolveCollisions() {
        const padding = this.options.fileGap;
        const maxPasses = 5;

        for (let pass = 0; pass < maxPasses; pass++) {
            let anyMoved = false;

            for (let i = 0; i < this.grids.length; i++) {
                const a = this.grids[i];
                const aBounds = a.getBounds();

                for (let j = i + 1; j < this.grids.length; j++) {
                    const b = this.grids[j];
                    const bBounds = b.getBounds();

                    // Check AABB overlap
                    if (aBounds.max.x + padding <= bBounds.min.x ||
                        bBounds.max.x + padding <= aBounds.min.x ||
                        aBounds.max.y + padding <= bBounds.min.y ||
                        bBounds.max.y + padding <= aBounds.min.y) {
                        continue; // no overlap
                    }

                    // Overlapping — push the outer grid (higher index = further on spiral) outward
                    const bCenterX = (bBounds.min.x + bBounds.max.x) / 2;
                    const bCenterY = (bBounds.min.y + bBounds.max.y) / 2;

                    // Direction from origin to b's center
                    const dx = bCenterX - this.origin.x;
                    const dy = bCenterY - this.origin.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

                    // Compute overlap amount
                    const overlapX = Math.min(aBounds.max.x - bBounds.min.x, bBounds.max.x - aBounds.min.x);
                    const overlapY = Math.min(aBounds.max.y - bBounds.min.y, bBounds.max.y - aBounds.min.y);
                    const pushAmount = Math.min(overlapX, overlapY) + padding;

                    // Push radially outward
                    b.position.x += (dx / dist) * pushAmount;
                    b.position.y += (dy / dist) * pushAmount;

                    anyMoved = true;
                }
            }

            if (!anyMoved) break;
        }
    }

    // ============ Utilities ============

    _collectBounds(node, box) {
        if (node.grid) {
            box.union(node.grid.getBounds());
        }
        for (const child of node.children) {
            this._collectBounds(child, box);
        }
    }
}

export default SpiralLayoutManager;
