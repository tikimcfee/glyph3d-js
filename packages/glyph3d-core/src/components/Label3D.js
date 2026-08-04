import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

/**
 * Label3D — a small baked-text plate for in-canvas identification (the interaction-free
 * generalization of Button3D's pill). A real three.js object (extends Mesh) whose face is
 * a baked CanvasTexture pill: a rounded-rect fill in the label's color with centered text.
 * Any Object3D can wear one — dock tiles, nameplates, markers — wherever a thing needs a
 * readable name that isn't part of its glyph content.
 *
 * It is deliberately NOT an r3f component and NOT interactive: `userData.isMarker` is set
 * so the GPU picking pass skips it (a label is information, not chrome). Button3D extends
 * this and re-enables picking for its click/hover role. depthTest is ON, so the label
 * occludes like its parent panel instead of floating over the scene.
 *
 * The text is REBAKABLE in place: setLabel()/setColor() re-run the bake and resize the
 * plane (width always derives from the text), so live info (e.g. a terminal's cols×rows)
 * can track state without recreating the mesh.
 */
export default class Label3D extends THREE.Mesh {
    /**
     * @param {Object} o
     * @param {string}  o.label          text drawn on the pill
     * @param {number}  o.height         pill height in WORLD units; width derives from the label
     * @param {number}  [o.color=0x8899aa]  pill fill color (hex)
     * @param {number}  [o.opacity=0.62]    material opacity (the at-rest translucency)
     * @param {number}  [o.renderOrder=RENDER_ORDER.GRID_CHROME]
     * @param {number}  [o.fontPx=44]     label font size on the bake canvas (resolution, not world size)
     */
    constructor({
        label = '', height = 1, color = 0x8899aa, opacity = 0.62,
        renderOrder = RENDER_ORDER.GRID_CHROME, fontPx = 44,
    } = {}) {
        const { texture, aspect } = Label3D._bake(label, color, fontPx);
        const width = height * aspect;
        super(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthTest: true, depthWrite: false }),
        );
        this.label = label;
        this.color = color;
        this.fontPx = fontPx;
        this.width = width;
        this.height = height;
        this.renderOrder = renderOrder;
        this.name = `Label3D:${label}`;
        this.userData.isMarker = true; // pick-inert: a label is information, not chrome
    }

    /** Rebake with new text, keeping color/height; the plane resizes to fit (width derives
     *  from the label). No-op when the text is unchanged. */
    setLabel(text) {
        if (text === this.label) return;
        this.label = text;
        this.name = `Label3D:${text}`;
        this._rebake();
    }

    /** Rebake with a new fill color, keeping the current text. */
    setColor(hex) {
        if (hex === this.color) return;
        this.color = hex;
        this._rebake();
    }

    /** Re-run the bake for the current label/color and swap texture + geometry width. @private */
    _rebake() {
        const { texture, aspect } = Label3D._bake(this.label, this.color, this.fontPx);
        this.material.map?.dispose();
        this.material.map = texture;
        this.material.needsUpdate = true;
        this.width = this.height * aspect;
        this.geometry.dispose();
        this.geometry = new THREE.PlaneGeometry(this.width, this.height);
    }

    /** Bake "<label>" onto a transparent rounded-rect pill of `color`. The fill is opaque (legible)
     *  and the at-rest translucency comes from material.opacity, so subclasses can fade it up.
     *  Multi-line: '\n' splits into rows — the pill is as wide as the widest line and stacks one
     *  fillText row per line, vertically centered. A single-line label bakes exactly as before.
     *  @returns {{texture:THREE.CanvasTexture, aspect:number}} */
    static _bake(label, color, fontPx) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
        ctx.font = font;
        const padX = Math.round(fontPx * 0.72), padY = Math.round(fontPx * 0.42);
        const lines = String(label ?? '').split('\n');
        const lineStep = Math.round(fontPx * 1.2);    // per-row advance (multi-line plates only)
        const textW = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l || ' ').width)));
        const w = Math.max(textW + padX * 2, fontPx + padY * 2); // never narrower than tall (round "+"/"−")
        const h = (lines.length > 1 ? lines.length * lineStep : fontPx) + padY * 2;
        canvas.width = w; canvas.height = h;          // resizing resets the 2d context state
        ctx.clearRect(0, 0, w, h);
        const r = Math.min(h * 0.34, 22);
        const col = new THREE.Color(color);
        ctx.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
        Label3D._roundRect(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        Label3D._roundRect(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.stroke();
        ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(8,10,16,0.95)';         // dark label on the bright pill
        const y0 = h / 2 + 1 - ((lines.length - 1) * lineStep) / 2;
        for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], w / 2, y0 + i * lineStep);
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

    dispose() {
        this.geometry.dispose();
        this.material.map?.dispose();
        this.material.dispose();
    }
}
