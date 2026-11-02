import * as THREE from 'three';
import { computeCellMetrics } from '@glyph3d/core/core/cellMetrics.js';
import { getCanvasViewportSize } from '@glyph3d/core/core/canvasSize.js';
import FieldLabel from '@glyph3d/core/collections/FieldLabel.js';
import SceneTransforms from '@glyph3d/core/collections/SceneTransforms.js';
import { createPanelMaterial, BORDER_FLAGS } from '@glyph3d/core/collections/panelMaterial.js';
/** @import { AppContext } from './CommandProvider.jsx' */

/**
 * Dedicated camera layer for the screen overlay (§3.6, §4.5).
 * Main-scene GlyphBatch and PanelBatch only refresh for cameras with layer 0 enabled,
 * and skip objects whose root scene is not the main scene.
 */
export const OVERLAY_LAYER = 30;

// Plate overhang around a FieldLabel text block in row units (matches FieldLabel.js).
const PLATE_PAD_X = 0.72;
const PLATE_PAD_Y = 0.42;

/**
 * Snap a device-pixel coordinate `(x, y)` (top-left origin, +x right, +y down)
 * to integer device-pixel corners and convert to overlay scene coordinates
 * (`left: 0, right: Wdev, top: 0, bottom: -Hdev`, where +y is up).
 *
 * @param {number} x - device pixel x from left
 * @param {number} y - device pixel y from top
 * @returns {{ x: number, y: number, sceneX: number, sceneY: number }}
 */
export function snapOverlayOrigin(x, y) {
    const sx = Math.round(Number(x) || 0);
    const sy = Math.round(Number(y) || 0);
    return {
        x: sx,
        y: sy,
        sceneX: sx,
        sceneY: -sy,
    };
}

/**
 * Compute the uniform world-to-device-pixel scale and cell dimensions that make
 * one text row in `atlas` render at exactly `px` device pixels tall.
 *
 * @param {Object} atlas - GlyphAtlas (exposes getCharSize())
 * @param {number} px - target row height in device pixels
 * @param {number} [worldScale=0.025] - InstancedField world scale
 * @returns {{ scale: number, rowPx: number, colPx: number, rowWorld: number, charWorld: number, emWorld: number }}
 */
export function overlayScaleForPx(atlas, px, worldScale = 0.025) {
    const rowPx = Number(px);
    if (!(rowPx > 0)) {
        throw new Error(`overlayScaleForPx: px must be > 0 (got ${px})`);
    }
    const charSize = atlas?.getCharSize?.() || { width: 29, height: 54.375, em: 48 };
    const cm = computeCellMetrics(charSize, worldScale);
    const rowWorld = cm.lineSpacing;
    const charWorld = cm.charWidth;
    const scale = rowPx / rowWorld;
    return {
        scale,
        rowPx,
        colPx: charWorld * scale,
        rowWorld,
        charWorld,
        emWorld: cm.emWorld,
    };
}

/**
 * Compute the device-pixel bounding rects (`textRect` and full `rect` including optional plate)
 * for a text string laid out at `px` device pixels with top-left text origin at `(x, y)`.
 *
 * @param {Object} atlas
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} px
 * @param {Object|null} [plate=null]
 * @returns {{ x: number, y: number, px: number, scale: number, cols: number, rows: number, textRect: { x: number, y: number, w: number, h: number }, rect: { x: number, y: number, w: number, h: number } }}
 */
export function measureOverlayText(atlas, text, x, y, px, plate = null) {
    const snapped = snapOverlayOrigin(x, y);
    const { scale, rowPx, colPx } = overlayScaleForPx(atlas, px);
    const str = String(text ?? '');
    const lines = str.split('\n');
    const rows = Math.max(lines.length, 1);
    let cols = 0;
    if (str.length > 0) {
        for (const line of lines) {
            const len = [...line].length;
            if (len > cols) cols = len;
        }
    }
    const textW = cols * colPx;
    const textH = rows * rowPx;
    const textRect = {
        x: snapped.x,
        y: snapped.y,
        w: textW,
        h: textH,
    };
    if (!plate) {
        return {
            x: snapped.x,
            y: snapped.y,
            px: rowPx,
            scale,
            cols,
            rows,
            textRect,
            rect: { ...textRect },
        };
    }
    const padX = PLATE_PAD_X * rowPx;
    const padY = PLATE_PAD_Y * rowPx;
    const plateW = Math.max(textW + 2 * padX, rowPx);
    const plateH = textH + 2 * padY;
    return {
        x: snapped.x,
        y: snapped.y,
        px: rowPx,
        scale,
        cols,
        rows,
        textRect,
        rect: {
            x: snapped.x - padX,
            y: snapped.y - padY,
            w: plateW,
            h: plateH,
        },
    };
}

/**
 * Put an Object3D and its entire subtree exclusively on OVERLAY_LAYER.
 * @param {THREE.Object3D} root
 */
function setOverlayLayers(root) {
    root.traverse((node) => {
        node.layers.set(OVERLAY_LAYER);
    });
}

/**
 * PlaneOverlay — the 2D device-pixel screen overlay pass (§3.6, §4.1, §4.4).
 *
 * Drawn after the main 3D scene pass on the same WebGLRenderer with depth cleared and
 * an OrthographicCamera at 1 unit = 1 device pixel (`left: 0, right: Wdev, top: 0, bottom: -Hdev`).
 */
export default class PlaneOverlay {
    /**
     * @param {AppContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.atlas = ctx?.atlas ?? null;

        this.scene = new THREE.Scene();
        this.scene.name = 'plane-overlay';
        this.transforms = new SceneTransforms(this.scene);

        this.camera = new THREE.OrthographicCamera(0, 1600, 0, -1000, -100, 100);
        this.camera.name = 'plane-overlay-camera';
        this.camera.position.set(0, 0, 10);
        this.camera.layers.set(OVERLAY_LAYER);

        /** @type {Map<string, Object>} id -> overlay item record */
        this.items = new Map();

        /** @type {THREE.PlaneGeometry|null} shared unit quad for dot markers */
        this._dotGeo = null;

        this._hookedScene = null;
        this._prevAfterRender = null;
        if (ctx?.scene?.isScene) {
            this.hookScene(ctx.scene);
        }
    }

    /**
     * Hook `mainScene.onAfterRender` so the overlay draws automatically after the
     * main view pass on the same renderer.
     * @param {THREE.Scene} mainScene
     */
    hookScene(mainScene) {
        if (!mainScene?.isScene || this._hookedScene === mainScene) return;
        this.unhookScene();
        this._hookedScene = mainScene;
        const prev = mainScene.onAfterRender;
        this._prevAfterRender = prev;
        mainScene.onAfterRender = (renderer, sc, camera) => {
            if (typeof prev === 'function') prev.call(sc, renderer, sc, camera);
            // Only draw after the main view pass (layer 0 to the default framebuffer).
            if (renderer?.getRenderTarget?.() == null && camera?.layers?.isEnabled?.(0)) {
                this.render(renderer);
            }
        };
    }

    /** Unhook from `mainScene.onAfterRender`. */
    unhookScene() {
        if (this._hookedScene && this._prevAfterRender !== null) {
            this._hookedScene.onAfterRender = this._prevAfterRender;
        }
        this._hookedScene = null;
        this._prevAfterRender = null;
    }

    /**
     * Read the viewport in DEVICE pixels (the drawing buffer `canvas.width × canvas.height`),
     * matching `ViewerCameraController.planeViewport()`.
     * @returns {{ width: number, height: number, cssWidth: number, cssHeight: number, dpr: number }}
     */
    viewport() {
        const canvas = this.ctx?.renderer?.domElement ?? this.ctx?.canvas ?? null;
        let cssW = 0, cssH = 0;
        if (canvas && (canvas.parentElement || canvas.clientWidth > 0 || typeof window !== 'undefined')) {
            try {
                const css = getCanvasViewportSize(canvas);
                cssW = css.width;
                cssH = css.height;
            } catch {
                cssW = canvas.clientWidth || 0;
                cssH = canvas.clientHeight || 0;
            }
        }
        const width = canvas?.width || cssW || 1600;
        const height = canvas?.height || cssH || 1000;
        if (!(cssW > 0)) cssW = width;
        if (!(cssH > 0)) cssH = height;
        return {
            width,
            height,
            cssWidth: cssW,
            cssHeight: cssH,
            dpr: cssW > 0 ? width / cssW : 1,
        };
    }

    /**
     * Sync the orthographic camera frustum (`left: 0, right: Wdev, top: 0, bottom: -Hdev`)
     * to the current drawing buffer dimensions.
     * @returns {{ width: number, height: number, cssWidth: number, cssHeight: number, dpr: number }}
     */
    syncCamera() {
        const vp = this.viewport();
        if (this.camera.left !== 0 || this.camera.right !== vp.width
            || this.camera.top !== 0 || this.camera.bottom !== -vp.height) {
            this.camera.left = 0;
            this.camera.right = vp.width;
            this.camera.top = 0;
            this.camera.bottom = -vp.height;
            this.camera.updateProjectionMatrix();
        }
        return vp;
    }

    /**
     * Apply opacity to both the glyph field (group 0 alpha) and any backing plate.
     * @private
     */
    _applyLabelOpacity(label, opacity, plate) {
        const a = Math.max(0, Math.min(1, Number(opacity) || 0));
        const plateAlpha = plate ? a * (plate.opacity ?? 0.85) : a;
        label.setOpacity(plateAlpha);
        label._instancedField?.setGroupAlpha?.(0, a);
        if (label._instancedField?.instanceMesh) {
            label._instancedField.instanceMesh.visible = a > 0;
        }
        label.visible = a > 0;
    }

    /**
     * Pin a FieldLabel so that its text block top-left corner sits at exact integer
     * device-pixel coordinates `(snapX, -snapY, z)` in the overlay scene.
     * @private
     */
    _pinLabelTopLeft(label, snapX, snapY, z = 0) {
        // FieldLabel._applyGeometry() offsets _anchor by (-cx*s, -cy*s, 0) to center the label
        // around its origin in 3D space. Zeroing _anchor.position places the text cell grid's
        // top-left origin directly on label.position, while _plateMesh (also under _anchor)
        // stays centered on the text block.
        label._anchor.position.set(0, 0, 0);
        label.position.set(snapX, -snapY, z);
        setOverlayLayers(label);
    }

    /**
     * Create or update a pixel-snapped text label in the overlay.
     *
     * @param {string} id - unique identifier
     * @param {Object} opts
     * @param {number} opts.x - device-pixel x of the text block's top-left corner
     * @param {number} opts.y - device-pixel y of the text block's top-left corner
     * @param {number} [opts.px=13] - row height in device pixels
     * @param {string} [opts.text=''] - label text
     * @param {number|Object|null} [opts.color=null] - glyph color
     * @param {Object|null} [opts.plate=null] - backing plate config `{ color, opacity, hairline }`
     * @param {number} [opts.opacity=1] - opacity `0..1`
     * @param {number} [opts.z=0] - overlay z order (`-50..50`)
     * @param {string} [opts.kind='manual'] - owner kind (`'manual'` for `overlay.text`, `'map'` for MapLabels)
     * @returns {Object} the stored item record
     */
    setText(id, {
        x = 0,
        y = 0,
        px = 13,
        text = '',
        color = null,
        plate = null,
        opacity = 1,
        z = 0,
        kind = 'manual',
    } = {}) {
        if (!id) throw new Error('PlaneOverlay.setText: id is required');
        const rowPx = Number(px);
        if (!(rowPx > 0)) throw new Error(`PlaneOverlay.setText: px must be > 0 (got ${px})`);
        const atlas = this.atlas ?? this.ctx?.atlas;
        if (!atlas) throw new Error('PlaneOverlay.setText: atlas is required');

        const str = String(text ?? '');
        const measured = measureOverlayText(atlas, str, x, y, rowPx, plate);

        let rec = this.items.get(id);
        const plateChanged = Boolean(rec?.plate) !== Boolean(plate);
        if (rec && (rec.type !== 'text' || plateChanged)) {
            this.remove(id);
            rec = null;
        }

        if (!rec) {
            const label = new FieldLabel({
                atlas,
                text: str,
                lineHeight: rowPx,
                textColor: color,
                plate: plate ? { ...plate } : null,
            });
            label.name = `overlay-text:${id}`;
            this._pinLabelTopLeft(label, measured.x, measured.y, z);
            this._applyLabelOpacity(label, opacity, plate);
            this.scene.add(label);
            rec = {
                id,
                type: 'text',
                kind,
                x: measured.x,
                y: measured.y,
                z,
                px: rowPx,
                scale: measured.scale,
                text: str,
                color,
                plate: plate ? { ...plate } : null,
                opacity,
                cols: measured.cols,
                rows: measured.rows,
                textRect: measured.textRect,
                rect: measured.rect,
                object: label,
            };
            this.items.set(id, rec);
        } else {
            const label = /** @type {FieldLabel} */ (rec.object);
            if (rec.text !== str) label.setText(str);
            if (rec.px !== rowPx) label.setLineHeight(rowPx);
            if (color != null && color !== rec.color) label.setTextColor(color);
            if (plate && rec.plate && plate.color != null && plate.color !== rec.plate.color) {
                label.setPlateColor(plate.color);
            }
            if (rec.opacity !== opacity) this._applyLabelOpacity(label, opacity, plate);
            this._pinLabelTopLeft(label, measured.x, measured.y, z);
            rec.kind = kind;
            rec.x = measured.x;
            rec.y = measured.y;
            rec.z = z;
            rec.px = rowPx;
            rec.scale = measured.scale;
            rec.text = str;
            rec.color = color ?? rec.color;
            rec.plate = plate ? { ...plate } : null;
            rec.opacity = opacity;
            rec.cols = measured.cols;
            rec.rows = measured.rows;
            rec.textRect = measured.textRect;
            rec.rect = measured.rect;
        }

        return rec;
    }

    /**
     * Create or update a small device-pixel dot marker in the overlay (used by MapLabels dot fallback).
     *
     * @param {string} id
     * @param {Object} opts
     * @param {number} opts.x - device-pixel center x
     * @param {number} opts.y - device-pixel center y
     * @param {number} [opts.sizePx=5] - dot square size in device pixels
     * @param {number} [opts.color=0x8fa0b8] - hex color
     * @param {number} [opts.opacity=0.85] - opacity `0..1`
     * @param {number} [opts.z=0] - overlay z order
     * @param {string} [opts.kind='map'] - owner kind
     */
    setDot(id, {
        x = 0,
        y = 0,
        sizePx = 5,
        color = 0x8fa0b8,
        opacity = 0.85,
        z = 0,
        kind = 'map',
    } = {}) {
        if (!id) throw new Error('PlaneOverlay.setDot: id is required');
        const s = Math.max(1, Math.round(Number(sizePx) || 5));
        const snapped = snapOverlayOrigin(x, y);
        let rec = this.items.get(id);
        if (rec && rec.type !== 'dot') {
            this.remove(id);
            rec = null;
        }
        if (!rec) {
            if (!this._dotGeo) this._dotGeo = new THREE.PlaneGeometry(1, 1);
            const panel = createPanelMaterial({
                color,
                opacity,
                side: THREE.DoubleSide,
                depthWrite: true,
            });
            panel.setBorderFlag(BORDER_FLAGS.EDGE, true);
            const mesh = new THREE.Mesh(this._dotGeo, panel.material);
            mesh.name = `overlay-dot:${id}`;
            mesh.scale.set(s, s, 1);
            mesh.position.set(snapped.sceneX, snapped.sceneY, z);
            mesh.visible = opacity > 0;
            setOverlayLayers(mesh);
            this.scene.add(mesh);
            rec = {
                id,
                type: 'dot',
                kind,
                x: snapped.x,
                y: snapped.y,
                z,
                px: s,
                scale: s,
                text: '',
                color,
                plate: null,
                opacity,
                cols: 0,
                rows: 0,
                textRect: { x: snapped.x - s / 2, y: snapped.y - s / 2, w: s, h: s },
                rect: { x: snapped.x - s / 2, y: snapped.y - s / 2, w: s, h: s },
                object: mesh,
                _panel: panel,
            };
            this.items.set(id, rec);
        } else {
            const mesh = /** @type {THREE.Mesh} */ (rec.object);
            rec._panel?.setFill(color, opacity);
            mesh.scale.set(s, s, 1);
            mesh.position.set(snapped.sceneX, snapped.sceneY, z);
            mesh.visible = opacity > 0;
            setOverlayLayers(mesh);
            rec.kind = kind;
            rec.x = snapped.x;
            rec.y = snapped.y;
            rec.z = z;
            rec.px = s;
            rec.scale = s;
            rec.color = color;
            rec.opacity = opacity;
            rec.textRect = { x: snapped.x - s / 2, y: snapped.y - s / 2, w: s, h: s };
            rec.rect = { x: snapped.x - s / 2, y: snapped.y - s / 2, w: s, h: s };
        }
        return rec;
    }

    /**
     * Remove and dispose one overlay item by id.
     * @param {string} id
     * @returns {boolean}
     */
    remove(id) {
        const rec = this.items.get(id);
        if (!rec) return false;
        this.items.delete(id);
        if (rec.type === 'text') {
            rec.object?.dispose?.();
        } else if (rec.object) {
            rec.object.material?.dispose?.();
            rec.object.parent?.remove(rec.object);
        }
        return true;
    }

    /**
     * Clear overlay items.
     * @param {string|null} [id=null] - specific item id to remove, or null to clear all matching `kind`
     * @param {{ kind?: string|null }} [opts] - if `kind` is given (e.g. `'manual'`), only clear items of that kind
     * @returns {number} count of removed items
     */
    clear(id = null, { kind = null } = {}) {
        if (id != null && id !== '') {
            return this.remove(id) ? 1 : 0;
        }
        let removed = 0;
        for (const [key, rec] of [...this.items.entries()]) {
            if (kind && rec.kind !== kind) continue;
            if (this.remove(key)) removed++;
        }
        return removed;
    }

    /**
     * List overlay items as plain serializable records.
     * @param {{ kind?: string|null }} [opts]
     * @returns {Array<{ id: string, type: string, kind: string, x: number, y: number, z: number, px: number, scale: number, text: string, opacity: number, cols: number, rows: number, textRect: { x: number, y: number, w: number, h: number }, rect: { x: number, y: number, w: number, h: number } }>}
     */
    list({ kind = null } = {}) {
        const out = [];
        for (const rec of this.items.values()) {
            if (kind && rec.kind !== kind) continue;
            out.push({
                id: rec.id,
                type: rec.type,
                kind: rec.kind,
                x: rec.x,
                y: rec.y,
                z: rec.z,
                px: rec.px,
                scale: rec.scale,
                text: rec.text,
                opacity: rec.opacity,
                cols: rec.cols,
                rows: rec.rows,
                textRect: { ...rec.textRect },
                rect: { ...rec.rect },
            });
        }
        return out;
    }

    /**
     * CPU rect hit resolver (§3.6): resolves the topmost visible overlay item
     * containing device-pixel coordinate `(devX, devY)`.
     * @param {number} devX
     * @param {number} devY
     * @returns {Object|null}
     */
    hitTest(devX, devY) {
        let best = null;
        for (const rec of this.items.values()) {
            if (rec.opacity <= 0 || !rec.object?.visible) continue;
            const r = rec.rect;
            if (devX >= r.x && devX <= r.x + r.w && devY >= r.y && devY <= r.y + r.h) {
                if (!best || rec.z >= best.z) best = rec;
            }
        }
        return best;
    }

    /**
     * Render the overlay scene over the current framebuffer with depth cleared.
     * @param {THREE.WebGLRenderer} [renderer]
     */
    render(renderer = this.ctx?.renderer) {
        this.syncCamera();
        if (this.items.size === 0) return;
        if (!renderer?.render) return;

        const prevAutoClear = renderer.autoClear;
        const prevAutoReset = renderer.info ? renderer.info.autoReset : true;
        renderer.autoClear = false;
        if (renderer.info) renderer.info.autoReset = false;
        try {
            renderer.clearDepth?.();
            renderer.render(this.scene, this.camera);
        } finally {
            renderer.autoClear = prevAutoClear;
            if (renderer.info) renderer.info.autoReset = prevAutoReset;
        }
    }

    dispose() {
        this.unhookScene();
        this.clear();
        this._dotGeo?.dispose();
        this._dotGeo = null;
        this.transforms?.dispose();
    }
}
