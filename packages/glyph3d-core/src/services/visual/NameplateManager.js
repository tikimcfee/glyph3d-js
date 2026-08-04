/**
 * NameplateManager - 3D directory name labels
 *
 * Creates billboard-style text labels at each directory's position
 * in the 3D scene. Labels show the directory name with a collapse
 * indicator prefix. They rotate to face the camera each frame.
 *
 * Uses CodeGrid (same pipeline as file content) for consistent rendering.
 */

import * as THREE from 'three';
import { CodeGrid } from '../../index.js';

/**
 * @typedef {Object} NameplateOptions
 * @property {Object} [color={r:0, g:1, b:0.53}] - Label color (default: accent green)
 * @property {number} [scale=1.5] - Scale relative to normal text
 * @property {number} [yOffset=5] - Y offset above directory top
 * @property {number} [zOffset=5] - Z offset in front of content
 * @property {boolean} [billboard=true] - Face the camera each frame
 * @property {number} [skipDepth=0] - Skip nameplates for root
 * @property {string} [expandedPrefix='▼ '] - Prefix for expanded directories
 * @property {string} [collapsedPrefix='▶ '] - Prefix for collapsed directories
 */

export class NameplateManager {
    /**
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} options - NameplateOptions
     */
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;
        this.config = {
            color: options.color || { r: 0.0, g: 1.0, b: 0.53 },
            scale: options.scale ?? 1.5,
            yOffset: options.yOffset ?? 5,
            zOffset: options.zOffset ?? 5,
            billboard: options.billboard !== false,
            skipDepth: options.skipDepth ?? 0,
            expandedPrefix: options.expandedPrefix ?? '[-] ',
            collapsedPrefix: options.collapsedPrefix ?? '[+] ',
        };

        // Container for all nameplates
        this.group = new THREE.Group();
        this.group.name = 'DirectoryNameplates';
        this.scene.add(this.group);

        // Track individual nameplates by path
        this._nameplates = new Map();  // path -> { grid, wrapper, node, depth }
    }

    /**
     * Create nameplates from the hierarchy tree
     * @param {TreeNode} root - Root of the hierarchy tree
     * @param {Set<string>} [collapsedPaths] - Set of collapsed directory paths
     */
    createNameplates(root, collapsedPaths = new Set()) {
        this.dispose();
        this._buildNameplates(root, 0, collapsedPaths);
    }

    /**
     * Update nameplate positions after re-layout
     * @param {TreeNode} root - Root of the hierarchy tree
     * @param {Set<string>} [collapsedPaths] - Set of collapsed directory paths
     */
    updateNameplates(root, collapsedPaths = new Set()) {
        // Rebuild (simplest approach — nameplate creation is lightweight)
        this.dispose();
        this._buildNameplates(root, 0, collapsedPaths);
    }

    /**
     * Update billboard rotation to face camera.
     * Call this in the animation loop.
     * Rotates around Y axis only to keep text upright.
     * @param {THREE.Camera} camera
     */
    updateBillboards(camera) {
        if (!this.config.billboard) return;

        for (const [path, entry] of this._nameplates) {
            if (entry.wrapper && entry.wrapper.visible) {
                const pos = entry.wrapper.position;
                const camPos = camera.position;

                // Y-axis billboard: rotate to face camera in XZ plane
                const dx = camPos.x - pos.x;
                const dz = camPos.z - pos.z;
                entry.wrapper.rotation.y = Math.atan2(dx, dz);
            }
        }
    }

    /**
     * Toggle visibility of all nameplates
     * @param {boolean} visible
     */
    setVisible(visible) {
        this.group.visible = visible;
    }

    /**
     * Dispose all nameplate resources
     */
    dispose() {
        for (const [path, entry] of this._nameplates) {
            if (entry.grid) {
                entry.grid.dispose();
            }
            if (entry.wrapper) {
                this.group.remove(entry.wrapper);
            }
        }
        this._nameplates.clear();
    }

    /**
     * Full cleanup including removing from scene
     */
    destroy() {
        this.dispose();
        if (this.group) {
            this.scene.remove(this.group);
            this.group = null;
        }
    }

    // ============ Private ============

    /**
     * Recursively build nameplates for directory nodes
     * @private
     */
    _buildNameplates(node, depth, collapsedPaths) {
        if (!node.isDirectory || node.children.length === 0) return;

        // Skip root per config
        if (depth > this.config.skipDepth && node.path !== '') {
            this._createNameplateForNode(node, depth, collapsedPaths);
        }

        // Only recurse into expanded directories
        if (!(node.path !== '' && collapsedPaths.has(node.path))) {
            for (const child of node.children) {
                this._buildNameplates(child, depth + 1, collapsedPaths);
            }
        }
    }

    /**
     * Create a single nameplate for a directory node
     * @private
     */
    _createNameplateForNode(node, depth, collapsedPaths) {
        const isCollapsed = collapsedPaths.has(node.path);
        const prefix = isCollapsed ? this.config.collapsedPrefix : this.config.expandedPrefix;
        const text = prefix + node.name;

        // Wrapper group for billboard rotation (rotates around its own origin)
        const wrapper = new THREE.Group();
        wrapper.name = `nameplate-wrapper:${node.path}`;

        // Create a CodeGrid for text rendering
        // Pass the wrapper as the "scene" context — GlyphCollection adds its group
        // to the scene, but CodeGrid then re-parents it as a child of itself.
        const grid = new CodeGrid(this.scene, this.atlas, {
            name: `nameplate:${node.path}`,
            showBackground: false,
            showFilename: false,
            textColor: this.config.color,
            gridScale: this.config.scale,
        });

        // Load the nameplate text (fire-and-forget — nothing here reads the grid's
        // own buffers; wrapper positioning uses the directory node's position)
        void grid.loadText(text);

        // Add grid to wrapper (local position 0,0,0 within wrapper)
        wrapper.add(grid);

        // Position the wrapper at the directory's top-left corner
        wrapper.position.set(
            node.position.x,
            node.position.y + this.config.yOffset,
            node.position.z + this.config.zOffset
        );

        this.group.add(wrapper);
        this._nameplates.set(node.path, { grid, wrapper, node, depth });
    }
}

export default NameplateManager;
