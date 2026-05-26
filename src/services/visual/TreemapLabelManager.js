/**
 * TreemapLabelManager — LOD-aware labels for treemap mode
 *
 * All label text shares a single GlyphRendererV15 instance (one draw call for
 * all labels). Two tiers:
 *
 *   Directory labels  — shown when camera Z > DIR_THRESHOLD
 *   File labels       — shown when camera Z < FILE_THRESHOLD
 *
 * On layout: each directory and file gets a renderer text entry.
 * Per frame: camera Z is compared to thresholds; group visibility is toggled
 * via setGroupVisibility() (O(1) DataTexture write, no buffer rebuild).
 *
 * Position:
 *   Directory label  → top-left of directory bounding box + small offset
 *   File label       → centered horizontally above the file's background plane
 *
 * Performance:
 * - Layout: O(n) queued items, one applyPrebuiltBuffers() via worker (or sync renderBatch)
 * - Per frame: O(d+f) visibility checks + DataTexture writes (d=dirs, f=files)
 * - Draw: 1 draw call (all labels in one renderer)
 *
 * Worker-compatible paths: uses WorkerBridge during construction.
 * Do NOT import from src/workers/builders/ here — this runs in browser context.
 */

import GlyphRendererV15 from '../../GlyphRenderer.js';
import { getWorkerBridge, isWorkersSupported } from '../../workers/WorkerBridge.js';
import { iterGraphemes } from '../../utils/grapheme.js';

// Camera Z thresholds for LOD switching
const DIR_VISIBLE_MIN_Z   = 100;    // directory labels visible above this Z
const FILE_VISIBLE_MAX_Z  = 600;    // file labels visible below this Z

// Label positioning offsets (world units)
const DIR_LABEL_Y_OFFSET  = 4;      // above the directory block's top edge
const DIR_LABEL_Z_OFFSET  = 2;      // in front of backdrops
const FILE_LABEL_Y_OFFSET = 2;      // above the file grid's top edge
const FILE_LABEL_Z_OFFSET = 1;

// Renderer world scale for each tier
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

        /** @type {GlyphRendererV15|null} Single renderer for all labels */
        this._renderer = null;

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

        this._dirGroupIds  = [];
        this._fileGroupIds = [];

        // Collect all items first. Group IDs are pre-assigned as sequential integers
        // starting at 1 (group 0 = identity). This lets us know groupId before the
        // renderer exists, without needing a placeholder renderer for allocation.
        const pendingItems = [];   // { text, position, options, color, scale, groupId }
        let nextGroupId = 1;       // mirrors renderer._groupCount starting at 1

        this._walkTree(this._treemapManager.root, pendingItems, () => nextGroupId++);

        if (pendingItems.length === 0) return;

        // Create the renderer sized to the collected content
        const glyphCount = pendingItems.reduce((s, p) => s + p.text.length, 0);
        this._renderer = new GlyphRendererV15(this._scene, this._atlas, {
            maxInstances: Math.max(glyphCount, 100),
            defaultColor: { r: 1, g: 1, b: 1 },
            worldScale:   0.025,
        });

        // Initialise groups in the renderer to match the pre-assigned IDs.
        // createGroup() increments _groupCount; call it once per pre-assigned ID.
        const totalGroups = nextGroupId - 1; // IDs 1..nextGroupId-1 were assigned
        for (let i = 0; i < totalGroups; i++) {
            this._renderer.createGroup();
        }

        // Set initial group visibilities (all on)
        for (const gid of this._dirGroupIds)  this._renderer.setGroupVisibility(gid, true);
        for (const gid of this._fileGroupIds) this._renderer.setGroupVisibility(gid, true);

        // Flush to GPU
        if (isWorkersSupported()) {
            await this._buildAsync(pendingItems);
        } else {
            this._buildSync(pendingItems);
        }

        // Set initial LOD visibility based on current camera Z
        this._applyLOD();
    }

    /**
     * Call once per frame from the animation loop.
     * Updates LOD visibility from camera Z.
     */
    update() {
        if (!this._visible || !this._renderer) return;
        this._applyLOD();
    }

    /**
     * Show or hide all labels.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._visible = visible;
        if (this._renderer && this._renderer.instanceMesh) {
            this._renderer.instanceMesh.visible = visible;
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
     * Walk the treemap tree, collecting label text items.
     * @private
     * @param {Object} node - TreemapLayoutManager tree node
     * @param {Array} pendingItems - Output array to push items into
     * @param {Function} allocGroupId - Callable that returns the next group ID
     */
    _walkTree(node, pendingItems, allocGroupId) {
        if (!node) return;

        if (node.isDir && node.path !== '') {
            const bounds = this._treemapManager.getDirectoryBounds(node.path);
            if (bounds && !bounds.isEmpty()) {
                const labelText = this._dirLabel(node);
                const x = bounds.min.x;
                const y = bounds.max.y + DIR_LABEL_Y_OFFSET;
                const z = (bounds.max.z || 0) + DIR_LABEL_Z_OFFSET;

                const groupId = allocGroupId();
                this._dirGroupIds.push(groupId);

                pendingItems.push({
                    text:     labelText,
                    position: { x, y, z },
                    options:  { color: { r: 0.0, g: 1.0, b: 0.53 }, groupId },
                    color:    { r: 0.0, g: 1.0, b: 0.53 },
                    scale:    DIR_LABEL_SCALE,
                    groupId,
                });
            }
        }

        if (!node.isDir && node.grid) {
            const gb = node.grid.getBounds();
            if (!gb.isEmpty()) {
                const centerX = (gb.min.x + gb.max.x) / 2;
                const y = gb.max.y + FILE_LABEL_Y_OFFSET;
                const z = (gb.max.z || 0) + FILE_LABEL_Z_OFFSET;

                const groupId = allocGroupId();
                this._fileGroupIds.push(groupId);

                pendingItems.push({
                    text:     node.name,
                    position: { x: centerX, y, z },
                    options:  { color: { r: 0.8, g: 0.8, b: 0.8 }, groupId },
                    color:    { r: 0.8, g: 0.8, b: 0.8 },
                    scale:    FILE_LABEL_SCALE,
                    groupId,
                });
            }
        }

        if (node.children) {
            for (const child of node.children) {
                this._walkTree(child, pendingItems, allocGroupId);
            }
        }
    }

    /**
     * Flush items via worker (async path).
     * @private
     */
    async _buildAsync(pendingItems) {
        const bridge       = getWorkerBridge();
        const defaultColor = { r: 1, g: 1, b: 1 };
        const atlas        = this._atlas;

        // Ensure all codepoints exist in atlas before dispatching
        const missingGraphemes = new Set();
        for (const item of pendingItems) {
            if (!item.text) continue;
            for (const grapheme of iterGraphemes(item.text)) {
                const cp = grapheme.codePointAt(0);
                if (cp > 32 && !atlas.uvMap.has(grapheme)) {
                    missingGraphemes.add(grapheme);
                }
            }
        }
        if (missingGraphemes.size > 0) atlas.ensureGraphemes(Array.from(missingGraphemes));

        const atlasCharSize = atlas.getCharSize();
        const scale = 0.025;
        const metrics = {
            charWidth:     atlasCharSize.width  * scale,
            charHeight:    atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width  * scale * 0.05,
            lineSpacing:   atlasCharSize.height * scale * 1.2,
            worldScale:    scale,
            atlasSize:     atlas.getAtlasTexture().width,
            pixelWidth:    atlasCharSize.width,
            pixelHeight:   atlasCharSize.height,
        };

        try {
            const buffers = await bridge.buildBatchBuffers(pendingItems, { metrics, defaultColor });
            this._renderer.applyPrebuiltBuffers(buffers, pendingItems);
        } catch (err) {
            console.warn('TreemapLabelManager: Worker path failed, falling back to sync:', err);
            this._buildSync(pendingItems);
        }
    }

    /**
     * Flush items synchronously — same builder as _buildAsync, run on the
     * main thread (no worker round-trip).
     * @private
     */
    _buildSync(pendingItems) {
        const atlas = this._atlas;
        const defaultColor = { r: 1, g: 1, b: 1 };
        const atlasCharSize = atlas.getCharSize();
        const scale = 0.025;
        const metrics = {
            charWidth:     atlasCharSize.width  * scale,
            charHeight:    atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width  * scale * 0.05,
            lineSpacing:   atlasCharSize.height * scale * 1.2,
            worldScale:    scale,
            atlasSize:     atlas.getAtlasTexture().width,
            pixelWidth:    atlasCharSize.width,
            pixelHeight:   atlasCharSize.height,
        };
        const buffers = getWorkerBridge().buildBatchBuffersSync(pendingItems, { metrics, defaultColor });
        this._renderer.applyPrebuiltBuffers(buffers, pendingItems);
    }

    /**
     * Build the display text for a directory node.
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
        if (!this._renderer) return;

        const cz = this._camera.position.z;

        const showDirs  = cz > DIR_VISIBLE_MIN_Z;
        const showFiles = cz < FILE_VISIBLE_MAX_Z;

        for (const groupId of this._dirGroupIds) {
            this._renderer.setGroupVisibility(groupId, showDirs);
        }
        for (const groupId of this._fileGroupIds) {
            this._renderer.setGroupVisibility(groupId, showFiles);
        }
    }

    /**
     * Destroy the renderer and clean up scene objects.
     * @private
     */
    _destroy() {
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }
        this._dirGroupIds  = [];
        this._fileGroupIds = [];
    }
}

export default TreemapLabelManager;
