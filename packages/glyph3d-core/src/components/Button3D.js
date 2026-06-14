import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

/**
 * Button3D — a small labeled control plate for in-canvas window chrome (the resize/scale
 * grips, pin, and the size/scale dials). A real three.js object (extends Mesh) whose face is
 * a baked CanvasTexture pill: a rounded-rect fill in the control's color with a centered
 * label ("Resize", "Scale", "Pin", "+", "−").
 *
 * It is deliberately NOT an r3f component. Clicks/hover resolve through the app's GPU picking
 * pass (the single interaction source of truth) — the host registers the button on the 'handle'
 * channel and the central press router (CanvasInteraction) invokes `onClick` and flips
 * `setHovered`/`setActive`. The button owns only its VISUAL states (default / hover / active),
 * so callers flip booleans rather than re-style. depthTest is ON, so it occludes like its
 * parent panel instead of floating over the scene (it reads RENDER_ORDER.GRID_CHROME).
 */
export default class Button3D extends THREE.Mesh {
    /**
     * @param {Object} o
     * @param {string}  o.label          text drawn on the pill ("Resize", "Pin", "+", …)
     * @param {number}  o.height         pill height in WORLD units; width derives from the label
     * @param {number}  [o.color=0x8899aa]  pill fill color (hex)
     * @param {number}  [o.opacity=0.62]    base material opacity (the at-rest translucency)
     * @param {boolean} [o.grab=false]    true = a drag affordance (cursor hint), false = a click button
     * @param {string}  [o.role='']       carried in the pick token for the central dispatcher
     * @param {Function} [o.onClick=null] optional press handler (id, grid) => … ; else the role map runs
     * @param {Function} [o.onHover=null] optional (hovered:boolean) => … side-channel
     * @param {number}  [o.renderOrder=RENDER_ORDER.GRID_CHROME]
     * @param {number}  [o.fontPx=44]     label font size on the bake canvas (resolution, not world size)
     */
    constructor({
        label = '', height = 1, color = 0x8899aa, opacity = 0.62, grab = false,
        role = '', onClick = null, onHover = null,
        renderOrder = RENDER_ORDER.GRID_CHROME, fontPx = 44,
    } = {}) {
        const { texture, aspect } = Button3D._bake(label, color, fontPx);
        const width = height * aspect;
        super(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthTest: true, depthWrite: false }),
        );
        this.label = label;
        this.role = role;
        this.grab = grab;
        this.onClick = onClick;
        this.onHover = onHover;
        this.width = width;
        this.height = height;
        this.renderOrder = renderOrder;
        this.name = `Button3D:${role || label}`;
        this._baseOpacity = opacity;
        this._hovered = false;
        this._active = false;
    }

    /** Bake "<label>" onto a transparent rounded-rect pill of `color`. The fill is opaque (legible)
     *  and the at-rest translucency comes from material.opacity, so hover/active can fade it up.
     *  @returns {{texture:THREE.CanvasTexture, aspect:number}} */
    static _bake(label, color, fontPx) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
        ctx.font = font;
        const padX = Math.round(fontPx * 0.72), padY = Math.round(fontPx * 0.42);
        const textW = Math.ceil(ctx.measureText(label || ' ').width);
        const w = Math.max(textW + padX * 2, fontPx + padY * 2); // never narrower than tall (round "+"/"−")
        const h = fontPx + padY * 2;
        canvas.width = w; canvas.height = h;          // resizing resets the 2d context state
        ctx.clearRect(0, 0, w, h);
        const r = Math.min(h * 0.34, 22);
        const col = new THREE.Color(color);
        ctx.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
        Button3D._roundRect(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        Button3D._roundRect(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.stroke();
        ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(8,10,16,0.95)';         // dark label on the bright pill
        ctx.fillText(label, w / 2, h / 2 + 1);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        return { texture, aspect: w / h };
    }

    /** Path a rounded rectangle onto `ctx` (no fill/stroke — caller does). @private */
    static _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /** Recompute the effective opacity from the current hover/active flags. @private */
    _refresh() {
        const boost = this._hovered ? 0.33 : (this._active ? 0.2 : 0);
        this.material.opacity = Math.min(1, this._baseOpacity + boost);
    }

    /** Cursor-over visual: fade up + a small pop. Idempotent; also fires the onHover side-channel. */
    setHovered(on) {
        if (this._hovered === on) return;
        this._hovered = on;
        this.scale.setScalar(on ? 1.08 : 1);
        this._refresh();
        this.onHover?.(on);
    }

    /** Sticky "this control's state is engaged" visual (e.g. a pinned window's Pin button). */
    setActive(on) {
        if (this._active === on) return;
        this._active = on;
        this._refresh();
    }

    dispose() {
        this.geometry.dispose();
        this.material.map?.dispose();
        this.material.dispose();
    }
}
