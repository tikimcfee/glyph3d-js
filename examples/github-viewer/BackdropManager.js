/**
 * BackdropManager - Directory backdrop planes in 3D space
 *
 * Creates semi-transparent colored planes behind each directory group
 * to visually delineate the spatial hierarchy. Colors are depth-coded
 * with decreasing opacity at deeper levels.
 */

import * as THREE from 'three';

/**
 * @typedef {Object} BackdropOptions
 * @property {number} [baseOpacity=0.12] - Opacity for depth-1 directories
 * @property {number} [opacityDecay=0.7] - Multiplier per depth level
 * @property {number} [minOpacity=0.03] - Floor opacity
 * @property {number} [zOffset=-2] - Z offset behind text per depth level
 * @property {boolean} [showEdges=true] - Show wireframe edges
 * @property {number} [edgeOpacity=0.25] - Wireframe edge opacity
 * @property {number} [skipDepth=0] - Skip backdrops for root (depth 0)
 */

// Depth-coded dark color palette (low saturation, dark tones)
const DEPTH_COLORS = [
    new THREE.Color(0x1a2a3a),  // depth 1: dark blue
    new THREE.Color(0x2a1a3a),  // depth 2: dark purple
    new THREE.Color(0x1a3a2a),  // depth 3: dark green
    new THREE.Color(0x3a2a1a),  // depth 4: dark amber
    new THREE.Color(0x2a3a1a),  // depth 5: dark olive
    new THREE.Color(0x1a2a2a),  // depth 6: dark teal
];

export class BackdropManager {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} options - BackdropOptions
     */
    constructor(scene, options = {}) {
        this.scene = scene;
        this.config = {
            baseOpacity: options.baseOpacity ?? 0.12,
            opacityDecay: options.opacityDecay ?? 0.7,
            minOpacity: options.minOpacity ?? 0.03,
            zOffset: options.zOffset ?? -2,
            showEdges: options.showEdges !== false,
            edgeOpacity: options.edgeOpacity ?? 0.25,
            skipDepth: options.skipDepth ?? 0,
        };

        // Container for all backdrop meshes
        this.group = new THREE.Group();
        this.group.name = 'DirectoryBackdrops';
        this.scene.add(this.group);

        // Track individual backdrops by path
        this._backdrops = new Map();  // path -> { plane, edges }
    }

    /**
     * Create backdrop planes from the hierarchy tree
     * @param {TreeNode} root - Root of the hierarchy tree
     * @param {Set<string>} [collapsedPaths] - Set of collapsed directory paths
     */
    createBackdrops(root, collapsedPaths = new Set()) {
        this.dispose();
        this._buildBackdrops(root, 0, collapsedPaths);
    }

    /**
     * Update backdrop positions and sizes after re-layout
     * @param {TreeNode} root - Root of the hierarchy tree
     * @param {Set<string>} [collapsedPaths] - Set of collapsed directory paths
     */
    updateBackdrops(root, collapsedPaths = new Set()) {
        // Rebuild from scratch (simple, reliable)
        this.dispose();
        this._buildBackdrops(root, 0, collapsedPaths);
    }

    /**
     * Toggle visibility of all backdrops
     * @param {boolean} visible
     */
    setVisible(visible) {
        this.group.visible = visible;
    }

    /**
     * Dispose all backdrop resources
     */
    dispose() {
        for (const [path, backdrop] of this._backdrops) {
            if (backdrop.plane) {
                backdrop.plane.geometry.dispose();
                backdrop.plane.material.dispose();
            }
            if (backdrop.edges) {
                backdrop.edges.geometry.dispose();
                backdrop.edges.material.dispose();
            }
        }
        this._backdrops.clear();

        // Remove all children from group
        while (this.group.children.length > 0) {
            this.group.remove(this.group.children[0]);
        }
    }

    /**
     * Full cleanup including removing from scene
     */
    destroy() {
        this.dispose();
        this.scene.remove(this.group);
        this.group = null;
    }

    // ============ Private ============

    /**
     * Recursively build backdrop meshes
     * @private
     */
    _buildBackdrops(node, depth, collapsedPaths) {
        if (!node.isDirectory || node.children.length === 0) return;

        // Skip root or low-depth items per config
        if (depth > this.config.skipDepth && node.path !== '') {
            this._createBackdropForNode(node, depth, collapsedPaths);
        }

        // Don't recurse into collapsed directories
        if (node.path !== '' && collapsedPaths.has(node.path)) {
            return;
        }

        for (const child of node.children) {
            this._buildBackdrops(child, depth + 1, collapsedPaths);
        }
    }

    /**
     * Create a single backdrop plane + optional edges for a directory node
     * @private
     */
    _createBackdropForNode(node, depth, collapsedPaths) {
        const isCollapsed = collapsedPaths.has(node.path);
        const bounds = node.bounds;

        if (bounds.width <= 0 || bounds.height <= 0) return;

        // Color from depth palette
        const colorIndex = (depth - 1) % DEPTH_COLORS.length;
        const color = DEPTH_COLORS[colorIndex].clone();

        // Opacity decreases with depth
        let opacity = this.config.baseOpacity;
        for (let d = 1; d < depth; d++) {
            opacity *= this.config.opacityDecay;
        }
        opacity = Math.max(opacity, this.config.minOpacity);

        // Z position: behind text, offset per depth to avoid z-fighting
        const zPos = node.position.z + (this.config.zOffset * depth) - 1;

        // Create plane
        const geometry = new THREE.PlaneGeometry(bounds.width, bounds.height);
        const material = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        const plane = new THREE.Mesh(geometry, material);
        plane.position.set(
            node.position.x + bounds.width / 2,
            node.position.y - bounds.height / 2,
            zPos
        );
        plane.renderOrder = -10 + depth;  // Draw deeper backdrops first
        plane.name = `backdrop:${node.path}`;
        this.group.add(plane);

        // Optional wireframe edges
        let edges = null;
        if (this.config.showEdges) {
            const edgeGeometry = new THREE.EdgesGeometry(geometry);
            const edgeMaterial = new THREE.LineBasicMaterial({
                color: new THREE.Color(
                    Math.min(color.r * 2.0, 1),
                    Math.min(color.g * 2.0, 1),
                    Math.min(color.b * 2.0, 1)
                ),
                transparent: true,
                opacity: this.config.edgeOpacity,
                depthWrite: false,
            });

            edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
            edges.position.copy(plane.position);
            edges.renderOrder = plane.renderOrder + 1;
            this.group.add(edges);
        }

        this._backdrops.set(node.path, { plane, edges, depth });
    }
}

export default BackdropManager;
