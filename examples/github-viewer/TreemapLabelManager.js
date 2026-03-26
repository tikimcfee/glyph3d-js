/**
 * TreemapLabelManager — LOD-aware labels for treemap mode
 *
 * All label text shares a single GlyphCollection (one draw call for all labels).
 * Two tiers:
 *
 *   Directory labels  — shown when camera Z > DIR_THRESHOLD
 *   File labels       — shown when camera Z < FILE_THRESHOLD
 *
 * On layout: each directory and file gets a GlyphCollection text entry.
 * Per frame: camera Z is compared to thresholds; group visibility is toggled
 * via setGroupVisibility() (O(1) DataTexture write, no buffer rebuild).
 *
 * Position:
 *   Directory label  → top-left of directory bounding box + small offset
 *   File label       → centered horizontally above the file's background plane
 *
 * Performance:
 * - Layout: O(n) GlyphCollection addText() calls, one flush()
 * - Per frame: O(d+f) visibility checks + DataTexture writes (d=dirs, f=files)
 * - Draw: 1 draw call (all labels in one GlyphCollection)
 *
 * Worker-compatible paths: uses flushAsync() during construction.
 * Do NOT import from src/workers/builders/ here — this runs in browser context.
 */

import { GlyphCollection } from '../../src/index.js';

// Camera Z thresholds for LOD switching
const DIR_VISIBLE_MIN_Z   = 100;    // directory labels visible above this Z
const FILE_VISIBLE_MAX_Z  = 600;    // file labels visible below this Z

// Label positioning offsets (world units)
const DIR_LABEL_Y_OFFSET  = 4;      // above the directory block's top edge
const DIR_LABEL_Z_OFFSET  = 2;      // in front of backdrops
const FILE_LABEL_Y_OFFSET = 2;      // above the file grid's top edge
const FILE_LABEL_Z_OFFSET = 1;

// GlyphCollection world scale for each tier
const DIR_LABEL_SCALE     = 1.8;
const FILE_LABEL_SCALE    = 0.9;

export class TreemapLabelManager {
    /**
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {TreemapLayoutManager} treemapManager
     * @param {THREE.Camera} camera
     */
    constructor(scene, atlas, treemapManager, camera) {
        this._scene          = scene;
        this._atlas          = atlas;
        this._treemapManager = treemapManager;
        this._camera         = camera;

        /** @type {GlyphCollection|null} Single collection for all labels */
        this._collection = null;

        /**
         * Per-label record: { id, type: 'dir'|'file', groupId }
         * id   = GlyphCollection text ID
         * type = which LOD tier this label belongs to
         * groupId = GlyphCollection group used for visibility toggling
         * @type {Array<{ id: string, type: string, groupId: number }>}
         */
        this._labels = [];

        this._dirGroupIds  = [];   // group IDs used by directory labels
        this._fileGroupIds = [];   // group IDs used by file labels

        this._visible = true;
    }

    // ============ Public API ============

    /**
     * Build all labels from the current treemap layout.
     * Clears any previous labels. Uses async flush (worker path).
     * Call after layoutTreemap() completes.
     */
    async build() {
        this._destroy();

        if (!this._treemapManager || !this._treemapManager.root) return;

        // One GlyphCollection for all labels combined
        this._collection = new GlyphCollection(this._scene, this._atlas);

        // Walk the treemap tree and build label entries
        this._labels = [];
        this._dirGroupIds  = [];
        this._fileGroupIds = [];

        this._walkTree(this._treemapManager.root);

        // Flush to GPU (worker path for large label sets)
        if (this._labels.length > 0) {
            await this._collection.flushAsync();
        }

        // Set initial visibility based on current camera Z
        this._applyLOD();
    }

    /**
     * Call once per frame from the animation loop.
     * Updates LOD visibility from camera Z.
     */
    update() {
        if (!this._visible || !this._collection) return;
        this._applyLOD();
    }

    /**
     * Show or hide all labels.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._visible = visible;
        if (this._collection) {
            // Toggle the Three.js group that contains all label meshes
            if (this._collection.group) {
                this._collection.group.visible = visible;
            }
        }
    }

    /**
     * Destroy all label resources and remove from scene.
     */
    destroy() {
        this._destroy();
    }

    // ============ Private ============

    /**
     * Walk the treemap tree, queuing label text for directories and files.
     * @private
     * @param {Object} node - TreemapLayoutManager tree node
     */
    _walkTree(node) {
        if (!node) return;

        if (node.isDir && node.path !== '') {
            // Directory label
            const bounds = this._treemapManager.getDirectoryBounds(node.path);
            if (bounds && !bounds.isEmpty()) {
                const labelText = this._dirLabel(node);
                const x = bounds.min.x;
                const y = bounds.max.y + DIR_LABEL_Y_OFFSET;
                const z = (bounds.max.z || 0) + DIR_LABEL_Z_OFFSET;

                // Each directory gets its own group for O(1) visibility toggle
                const groupId = this._collection.createGroup();
                this._collection.setGroupVisibility(groupId, true);

                const id = this._collection.addText(labelText, { x, y, z }, {
                    worldScale: DIR_LABEL_SCALE,
                    color: { r: 0.0, g: 1.0, b: 0.53 },  // accent green
                    groupId,
                });

                this._labels.push({ id, type: 'dir', groupId });
                this._dirGroupIds.push(groupId);
            }
        }

        if (!node.isDir && node.grid) {
            // File label
            const gb = node.grid.getBounds();
            if (!gb.isEmpty()) {
                const centerX = (gb.min.x + gb.max.x) / 2;
                const y = gb.max.y + FILE_LABEL_Y_OFFSET;
                const z = (gb.max.z || 0) + FILE_LABEL_Z_OFFSET;

                const groupId = this._collection.createGroup();
                this._collection.setGroupVisibility(groupId, true);

                const id = this._collection.addText(node.name, { x: centerX, y, z }, {
                    worldScale: FILE_LABEL_SCALE,
                    color: { r: 0.8, g: 0.8, b: 0.8 },
                    groupId,
                });

                this._labels.push({ id, type: 'file', groupId });
                this._fileGroupIds.push(groupId);
            }
        }

        // Recurse
        if (node.children) {
            for (const child of node.children) {
                this._walkTree(child);
            }
        }
    }

    /**
     * Build the display text for a directory node.
     * Format: "dirname (N)" where N is the count of direct + indirect files.
     * @private
     */
    _dirLabel(node) {
        const fileCount = this._countFiles(node);
        const name = node.name || node.path.split('/').pop() || node.path;
        return fileCount > 0 ? `${name} (${fileCount})` : name;
    }

    /**
     * Count all file descendants of a node.
     * @private
     */
    _countFiles(node) {
        let count = 0;
        if (!node.children) return 0;
        for (const child of node.children) {
            if (!child.isDir) count++;
            else count += this._countFiles(child);
        }
        return count;
    }

    /**
     * Apply LOD visibility based on current camera Z.
     * @private
     */
    _applyLOD() {
        if (!this._collection) return;

        const cz = this._camera.position.z;

        // Directory labels: visible when zoomed out enough to see directory structure
        const showDirs  = cz > DIR_VISIBLE_MIN_Z;
        // File labels: visible when zoomed in enough to read individual filenames
        const showFiles = cz < FILE_VISIBLE_MAX_Z;

        for (const groupId of this._dirGroupIds) {
            this._collection.setGroupVisibility(groupId, showDirs);
        }
        for (const groupId of this._fileGroupIds) {
            this._collection.setGroupVisibility(groupId, showFiles);
        }
    }

    /**
     * Destroy the collection and clean up scene objects.
     * @private
     */
    _destroy() {
        if (this._collection) {
            this._collection.dispose();
            this._collection = null;
        }
        this._labels = [];
        this._dirGroupIds  = [];
        this._fileGroupIds = [];
    }
}

export default TreemapLabelManager;
