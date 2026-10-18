/**
 * FileRow — a file's DATA presence in the field: the load unit of the
 * rows-not-actors architecture.
 *
 * A bulk load pours FileRows, not heavy CodeGrids. A row is a real THREE.Object3D
 * living in the ContentTree with lightweight instanced glyph rendering and panel
 * backgrounds. The interactive CodeGrid actor materializes on first interaction
 * (focus, edit, etc.) via materializeActor in fileLoader.js.
 */

import * as THREE from 'three';
import BoundedObject3D from './BoundedObject3D.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { resolveLayoutParams, DEFAULT_LAYOUT } from '../workers/builders/index.js';
import LayoutDescription from '../core/LayoutDescription.js';
import { analyzeGrid } from '../parsing/SyntaxColorizer.js';
import InstancedField from './InstancedField.js';
import { generateLayout } from '../core/LayoutGenerator.js';
import { createPanelMaterial } from './panelMaterial.js';
import { enrollPanel } from './PanelBatch.js';

export default class FileRow extends BoundedObject3D {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} atlas - the booted GlyphAtlas
     * @param {Object} [options]
     */
    constructor(scene, atlas, options = {}) {
        super();
        this.scene = scene;
        this.atlas = atlas;
        this.name = options.name || 'FileRow';
        this.isFileRow = true;

        this.config = {
            showBackground: options.showBackground !== false,
            backgroundColor: options.backgroundColor ?? 0x1a1a2e,
            backgroundOpacity: options.backgroundOpacity ?? 0.92,
            backgroundPadding: options.backgroundPadding || 1.0,
            showFilename: options.showFilename !== false,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            textColor: options.textColor || { r: 0.0, g: 1.0, b: 0.0 },
            worldScale: options.worldScale || 0.025,
            layout: { ...DEFAULT_LAYOUT, ...(options.layout || {}) },
        };

        this.filename = '';
        this.sourcePath = null;
        this.content = '';

        this.metrics = computeCellMetrics(atlas?.getCharSize?.() || { width: 9.6, height: 18 }, this.config.worldScale);

        this._analyzeGen = 0;
        this._highlights = null;
        this._layout = null;
        this._layoutOriginY = 0;

        this._renderer = null;
        this._background = null;
        this._panel = null;
        this._borderFlags = 0;
        this._extentCache = null;
        this._localBoundsCache = null;
        this._layoutBoundsCache = null;
        this._pickingSystem = null;
    }

    /**
     * Stage the file's content and filename.
     * @param {string} path
     * @param {string} content
     */
    async load(path, content) {
        this.filename = path;
        this.content = content || '';

        const m = this.metrics;
        const lp = resolveLayoutParams(this.config.layout);
        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -m.lineSpacing * 1.5
            : 0;

        if (!this._renderer) {
            this._renderer = new InstancedField(null, this.atlas, {
                worldScale: this.config.worldScale,
                slugData: this.atlas?._slugData,
                shaper: this.atlas?._shapeCache || this.atlas?._shaper,
                defaultColor: this.config.textColor,
            });
            this.add(this._renderer.instanceMesh);
        }

        let bounds = null;

        // 1. Filename header
        if (this.config.showFilename && this.filename) {
            const fnRes = generateLayout(this.filename, {
                shaper: this.atlas?._shapeCache || this.atlas?._shaper,
                metrics: m,
                origin: { x: 0, y: 0, z: 0 },
                wrapWidth: 0,
                color: this.config.filenameColor,
                targetBuffer: this._renderer.slotBuffer,
                append: false,
            });
            bounds = fnRes.bounds;
        }

        // 2. File content
        if (this.content.length > 0) {
            const hasHeader = !!(this.config.showFilename && this.filename);
            const res = generateLayout(this.content, {
                shaper: this.atlas?._shapeCache || this.atlas?._shaper,
                metrics: m,
                origin: { x: 0, y: this._layoutOriginY, z: 0 },
                wrapWidth: lp.wrapWidth || 0,
                zWrapSpacing: lp.zWrapSpacing || 0,
                color: this.config.textColor,
                tabWidth: lp.tabWidth,
                targetBuffer: this._renderer.slotBuffer,
                targetSizes: this._layout?.sizes,
                append: hasHeader,
                previousBounds: bounds,
            });
            bounds = res.bounds;
            this._renderer.setSlots(res.buffer, res.glyphCount);
            this._renderer.setLayoutExtent(bounds);

            this._layout = new LayoutDescription({
                lineSlotBase: res.lineStarts,
                lineStartRow: res.lineStartRows,
                lineLengths: res.lineLengths,
                sizes: res.sizes,
                wrapWidth: lp.wrapWidth || 0,
                originX: 0,
                originY: this._layoutOriginY,
                originZ: 0,
                lineSpacing: m.lineSpacing,
                totalRows: res.totalRows,
                maxRowExtent: res.maxRowExtent,
                maxSegs: res.maxSegs,
                page: res.page,
            });
        } else if (bounds) {
            this._renderer.setSlots(this._renderer.slotBuffer, this._renderer.slotBuffer.count);
            this._renderer.setLayoutExtent(bounds);
        }

        this._extentCache = bounds ? {
            min: { ...bounds.min },
            max: { ...bounds.max },
            width: bounds.width,
            height: bounds.height,
            depth: bounds.depth,
        } : null;

        this._updateBackground();
        this._analyzeGen++;
        analyzeGrid(this);

        if (this._pickingSystem) {
            this.setPickingSystem(this._pickingSystem);
        }

        return this;
    }

    loadFile(filename, content) {
        return this.load(filename, content);
    }

    // ── Bounds ──────────────────────────────────────────────────────────────

    _recordExtent() {
        return this._extentCache;
    }

    getContentBounds() {
        return this._recordExtent();
    }

    layoutBounds() {
        const cb = this._recordExtent();
        if (!cb) return new THREE.Box3();
        if (!this._layoutBoundsCache) this._layoutBoundsCache = new THREE.Box3();
        this._layoutBoundsCache.min.set(cb.min.x, cb.min.y, cb.min.z);
        this._layoutBoundsCache.max.set(cb.max.x, cb.max.y, cb.max.z);
        return this._layoutBoundsCache;
    }

    getLocalBounds() {
        const cb = this._recordExtent();
        if (!this._localBoundsCache) this._localBoundsCache = new THREE.Box3();
        const box = this._localBoundsCache;
        if (!cb) { box.makeEmpty(); return box; }
        const padding = this.config.backgroundPadding;
        box.min.set(cb.min.x - padding, cb.min.y - padding, (cb.min.z ?? 0) - BOUNDS_Z_PAD);
        box.max.set(cb.max.x + padding, cb.max.y + padding, (cb.max.z ?? 0) + BOUNDS_Z_PAD);
        return box;
    }

    _updateBackground() {
        if (!this.config.showBackground) {
            if (this._background) this._background.visible = false;
            return;
        }

        const cb = this._recordExtent();
        if (!cb || cb.width <= 0 || cb.height <= 0) {
            if (this._background) this._background.visible = false;
            return;
        }

        if (!this._background) {
            const geo = new THREE.PlaneGeometry(1, 1);
            this._panel = createPanelMaterial({
                color: this.config.backgroundColor,
                opacity: this.config.backgroundOpacity,
                side: THREE.DoubleSide,
                depthWrite: true,
            });
            this._background = enrollPanel(new THREE.Mesh(geo, this._panel.material));
            this.add(this._background);
            if (this._pickingSystem) {
                this._pickingSystem.register('grid', this._background, this);
            }
        }

        const padding = this.config.backgroundPadding;
        const width = cb.width + padding * 2;
        const height = cb.height + padding * 2;
        this._background.scale.set(width, height, 1);
        const zMin = cb.min.z !== undefined ? cb.min.z : 0;
        this._background.position.set(
            cb.min.x + cb.width / 2,
            cb.min.y + cb.height / 2,
            zMin - 0.5
        );
        this._background.visible = true;
    }

    // ── Accessors ───────────────────────────────────────────────────────────

    getSourcePath() { return this.sourcePath || this.userData?.sourcePath || null; }
    setSourcePath(path) { this.sourcePath = path; }
    getFilename() { return this.filename; }
    getRenderer() { return this._renderer; }
    getLineCount() {
        return this._layout ? this._layout.lineLengths.length : (this.content ? this.content.split('\n').length : 0);
    }
    getGlyphCount() { return this._renderer?.getGlyphCount() ?? 0; }
    getCharForSlot(slot) { return this._layout?.charForSlot?.(slot) ?? null; }
    getTotalVisualRows() { return this._layout?.totalRows ?? 0; }
    getHighlights() { return this._highlights; }
    update(_dt) {}

    // ── Picking ─────────────────────────────────────────────────────────────

    setPickingSystem(ps) {
        if (!ps) return;
        this._pickingSystem = ps;
        if (this._background) {
            ps.register('grid', this._background, this);
        }
        if (this._renderer?.instanceMesh) {
            ps.register('glyph', this._renderer.instanceMesh, this);
        }
    }

    // ── Border & theme ──────────────────────────────────────────────────────

    setBorderFlag(mask, on) {
        this._borderFlags = on ? (this._borderFlags | mask) : (this._borderFlags & ~mask);
        this._panel?.setBorderFlag?.(mask, on);
    }

    setStateColors(colors) {
        this._panel?.setStateColors?.(colors);
    }

    setBorder(opts) {
        this._panel?.setBorder?.(opts);
    }

    setBackgroundStyle({ color, opacity } = {}) {
        if (color != null) this.config.backgroundColor = color;
        if (opacity != null) this.config.backgroundOpacity = opacity;
        this._panel?.setFill?.(this.config.backgroundColor, this.config.backgroundOpacity);
    }

    showBackground(visible) {
        this.config.showBackground = visible;
        this._updateBackground();
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    dispose() {
        if (this._pickingSystem) {
            if (this._background) this._pickingSystem.unregister('grid', this._background);
            if (this._renderer?.instanceMesh) this._pickingSystem.unregister('glyph', this._renderer.instanceMesh);
            this._pickingSystem = null;
        }
        if (this._renderer) {
            this._renderer.dispose();
            this.remove(this._renderer.instanceMesh);
            this._renderer = null;
        }
        if (this._background) {
            this._background.geometry.dispose();
            this._background.material.dispose();
            this.remove(this._background);
            this._background = null;
            this._panel = null;
        }
        this._layout = null;
        this._extentCache = null;
        this.parent?.remove(this);
    }
}
