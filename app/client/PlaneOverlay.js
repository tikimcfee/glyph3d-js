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


        this._domCanvas = ctx?.renderer?.domElement ?? ctx?.canvas ?? null;
        this._onDomClick = (e) => {
            if (e.button != null && e.button !== 0) return;
            const vp = this.viewport();
            const rect = this._domCanvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
            const devX = (e.clientX - rect.left) * vp.dpr;
            const devY = (e.clientY - rect.top) * vp.dpr;
            const hit = this.hitTest(devX, devY);
            if (hit && typeof hit.onClick === 'function') {
                e.stopPropagation?.();
                hit.onClick(hit);
            }
        };
        this._domCanvas?.addEventListener?.('click', this._onDomClick, true);
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
        const width = canvas?.width || this.ctx?.width || cssW || 1600;
        const height = canvas?.height || this.ctx?.height || cssH || 1000;
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
     * Create or update a screen-overlay card item (used by Strip for carrel cards).
     *
     * @param {string} id
     * @param {Object} opts
     * @param {number} opts.x - device-pixel top-left x
     * @param {number} opts.y - device-pixel top-left y
     * @param {number} [opts.w=132] - device-pixel width
     * @param {number} [opts.h=80] - device-pixel height
     * @param {THREE.Texture|null} [opts.texture=null] - optional card thumbnail texture
     * @param {string} [opts.title=''] - card title text
     * @param {string} [opts.badge=''] - optional badge text (e.g. waiting badge)
     * @param {number} [opts.color=0x0b1220] - backing panel fill color
     * @param {number} [opts.borderColor=0x334155] - border hairline color
     * @param {number} [opts.borderWidth=1.5] - border width in device pixels (0 disables border)
     * @param {number} [opts.badgeColor=0xf59e0b] - badge plate color
     * @param {number} [opts.opacity=1.0] - opacity `0..1`
     * @param {number} [opts.z=5] - overlay z order
     * @param {string} [opts.kind='strip'] - owner kind
     * @param {boolean} [opts.interactive=true] - whether `hitTest` / `clickAt` can hit this item
     * @param {Function|null} [opts.onClick=null] - click handler `(rec) => void`
     * @param {Object|null} [opts.data=null] - arbitrary metadata (e.g. `{ carrel, waiting, stale }`)
     */
    setCard(id, {
        x = 0,
        y = 0,
        w = 132,
        h = 80,
        texture = null,
        title = '',
        badge = '',
        color = 0x0b1220,
        borderColor = 0x334155,
        borderWidth = 1.5,
        badgeColor = 0xf59e0b,
        opacity = 1.0,
        z = 5,
        kind = 'strip',
        interactive = true,
        onClick = null,
        data = null,
    } = {}) {
        if (!id) throw new Error('PlaneOverlay.setCard: id is required');
        const atlas = this.atlas ?? this.ctx?.atlas;
        const snapped = snapOverlayOrigin(x, y);
        const snapW = Math.max(8, Math.round(Number(w) || 132));
        const snapH = Math.max(8, Math.round(Number(h) || 80));

        let rec = this.items.get(id);
        if (rec && rec.type !== 'card') {
            this.remove(id);
            rec = null;
        }

        if (!this._dotGeo) this._dotGeo = new THREE.PlaneGeometry(1, 1);

        if (!rec) {
            const group = new THREE.Group();
            group.name = `overlay-card:${id}`;

            const panel = createPanelMaterial({
                color,
                opacity,
                side: THREE.DoubleSide,
                depthWrite: true,
            });
            panel.setBorder({ color: borderColor, width: borderWidth, intensity: borderWidth > 0 ? 0.9 : 0 });
            panel.setBorderFlag(BORDER_FLAGS.EDGE, borderWidth > 0);
            const bgMesh = new THREE.Mesh(this._dotGeo, panel.material);
            bgMesh.name = `overlay-card-bg:${id}`;
            group.add(bgMesh);

            const thumbMat = new THREE.MeshBasicMaterial({
                map: texture || null,
                transparent: true,
                opacity: texture ? opacity : 0,
                depthTest: true,
                depthWrite: false,
            });
            const thumbMesh = new THREE.Mesh(this._dotGeo, thumbMat);
            thumbMesh.name = `overlay-card-thumb:${id}`;
            thumbMesh.visible = !!texture && opacity > 0;
            group.add(thumbMesh);

            this.scene.add(group);
            rec = {
                id,
                type: 'card',
                kind,
                x: snapped.x,
                y: snapped.y,
                z,
                px: snapH,
                scale: 1,
                text: String(title ?? ''),
                badge: String(badge ?? ''),
                color,
                borderColor,
                borderWidth,
                badgeColor,
                opacity,
                interactive: interactive !== false,
                cols: 0,
                rows: 0,
                textRect: { x: snapped.x, y: snapped.y, w: snapW, h: snapH },
                rect: { x: snapped.x, y: snapped.y, w: snapW, h: snapH },
                object: group,
                texture: texture || null,
                onClick,
                data,
                _panel: panel,
                _bgMesh: bgMesh,
                _thumbMesh: thumbMesh,
                _thumbMat: thumbMat,
                _titleLabel: null,
                _badgeLabel: null,
            };
            this.items.set(id, rec);
        }

        const group = /** @type {THREE.Group} */ (rec.object);
        group.position.set(snapped.sceneX, snapped.sceneY, z);
        group.visible = opacity > 0;

        rec._panel.setFill(color, opacity);
        rec._panel.setBorder({ color: borderColor, width: borderWidth, intensity: borderWidth > 0 ? 0.9 : 0 });
        rec._panel.setBorderFlag(BORDER_FLAGS.EDGE, borderWidth > 0);
        rec._bgMesh.scale.set(snapW, snapH, 1);
        rec._bgMesh.position.set(snapW * 0.5, -snapH * 0.5, 0);

        const pad = 2;
        const innerW = Math.max(2, snapW - pad * 2);
        const innerH = Math.max(2, snapH - pad * 2);
        rec._thumbMesh.scale.set(innerW, innerH, 1);
        rec._thumbMesh.position.set(snapW * 0.5, -snapH * 0.5, 0.2);
        if (rec._thumbMat.map !== (texture || null)) {
            rec._thumbMat.map = texture || null;
            rec._thumbMat.needsUpdate = true;
        }
        rec._thumbMat.opacity = texture ? opacity : 0;
        rec._thumbMesh.visible = !!texture && opacity > 0;

        const titleStr = String(title ?? '');
        if (!rec._titleLabel && atlas && titleStr) {
            const titleLabel = new FieldLabel({
                atlas,
                text: titleStr,
                lineHeight: 11,
                textColor: 0xe2e8f0,
                plate: { color: 0x070d18, opacity: 1.0, hairline: false },
            });
            titleLabel.name = `overlay-card-title:${id}`;
            group.add(titleLabel);
            rec._titleLabel = titleLabel;
        }
        if (rec._titleLabel) {
            if (titleStr && rec._titleLabel.text !== titleStr) rec._titleLabel.setText(titleStr);
            rec._titleLabel._anchor.position.set(0, 0, 0);
            rec._titleLabel.position.set(6, -(snapH - 16), 0.6);
            this._applyLabelOpacity(rec._titleLabel, titleStr ? opacity : 0, { opacity: 1.0 });
        }

        const badgeStr = String(badge ?? '');
        if (!rec._badgeLabel && atlas && badgeStr) {
            const badgeLabel = new FieldLabel({
                atlas,
                text: badgeStr,
                lineHeight: 10,
                textColor: 0x080c14,
                plate: { color: badgeColor, opacity: 1.0, hairline: true },
            });
            badgeLabel.name = `overlay-card-badge:${id}`;
            group.add(badgeLabel);
            rec._badgeLabel = badgeLabel;
        }
        if (rec._badgeLabel) {
            if (badgeStr && rec._badgeLabel.text !== badgeStr) rec._badgeLabel.setText(badgeStr);
            rec._badgeLabel.setPlateColor(badgeColor);
            rec._badgeLabel._anchor.position.set(0, 0, 0);
            const bw = rec._badgeLabel.width || 16;
            rec._badgeLabel.position.set(Math.max(6, snapW - bw - 6), -6, 0.8);
            this._applyLabelOpacity(rec._badgeLabel, badgeStr ? opacity : 0, { opacity: 1.0 });
        }

        setOverlayLayers(group);

        rec.kind = kind;
        rec.x = snapped.x;
        rec.y = snapped.y;
        rec.z = z;
        rec.px = snapH;
        rec.text = titleStr;
        rec.badge = badgeStr;
        rec.color = color;
        rec.borderColor = borderColor;
        rec.borderWidth = borderWidth;
        rec.badgeColor = badgeColor;
        rec.opacity = opacity;
        rec.interactive = interactive !== false;
        rec.texture = texture || null;
        rec.placeholder = Boolean(data?.placeholder ?? !texture);
        rec.onClick = onClick;
        rec.data = data;
        rec.textRect = { x: snapped.x, y: snapped.y, w: snapW, h: snapH };
        rec.rect = { x: snapped.x, y: snapped.y, w: snapW, h: snapH };

        return rec;
    }

    /**
     * Dispatch a click at device-pixel coordinates `(devX, devY)`.
     * If the topmost hit overlay item has an `onClick` callback, invokes it and returns the item.
     *
     * @param {number} devX
     * @param {number} devY
     * @returns {Object|null}
     */
    clickAt(devX, devY) {
        const hit = this.hitTest(devX, devY);
        if (hit && typeof hit.onClick === 'function') {
            hit.onClick(hit);
        }
        return hit;
    }

    /**
     * Convert CSS client coordinates `(clientX, clientY)` relative to the canvas into
     * device pixels and invoke `clickAt`.
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {Object|null}
     */
    pickAt(clientX, clientY) {
        const vp = this.viewport();
        const canvas = this.ctx?.renderer?.domElement ?? this.ctx?.canvas ?? null;
        const rect = canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        const devX = (clientX - rect.left) * vp.dpr;
        const devY = (clientY - rect.top) * vp.dpr;
        return this.clickAt(devX, devY);
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
        } else if (rec.type === 'card') {
            rec._titleLabel?.dispose?.();
            rec._badgeLabel?.dispose?.();
            rec._thumbMat?.dispose?.();
            rec._panel?.material?.dispose?.();
            rec.object?.parent?.remove(rec.object);
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
            if (rec.interactive === false || rec.opacity <= 0 || !rec.object?.visible) continue;
            const r = rec.rect;
            if (devX >= r.x && devX <= r.x + r.w && devY >= r.y && devY <= r.y + r.h) {
                if (!best || rec.z >= best.z) best = rec;
            }
        }
        return best;
    }

    /**
     * Render the overlay scene over the current framebuffer with depth cleared — the frame's
     * `overlay` pass (FramePasses.js), right after the main pass.
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
        this._domCanvas?.removeEventListener?.('click', this._onDomClick, true);
        this._domCanvas = null;
        this._onDomClick = null;
        this.clear();
        this._dotGeo?.dispose();
        this._dotGeo = null;
        this.transforms?.dispose();
    }
}
