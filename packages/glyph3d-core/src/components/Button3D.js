import { RENDER_ORDER } from '../core/renderOrder.js';
import Label3D from './Label3D.js';

/**
 * Button3D — a small labeled control plate for in-canvas window chrome (the resize/scale
 * grips, pin, and the size/scale dials). A Label3D (baked CanvasTexture pill) with an
 * interaction role: it re-enables picking (Label3D is a pick-inert marker) and owns the
 * VISUAL states default / hover / active.
 *
 * It is deliberately NOT an r3f component. Clicks/hover resolve through the app's GPU picking
 * pass (the single interaction source of truth) — the host registers the button on the 'handle'
 * channel and the central press router (CanvasInteraction) invokes `onClick` and flips
 * `setHovered`/`setActive`. The button owns only its visual states, so callers flip booleans
 * rather than re-style. depthTest is ON, so it occludes like its parent panel instead of
 * floating over the scene (it reads RENDER_ORDER.GRID_CHROME).
 */
export default class Button3D extends Label3D {
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
        super({ label, height, color, opacity, renderOrder, fontPx });
        delete this.userData.isMarker; // a button IS a pick target — undo the label's marker flag
        this.role = role;
        this.grab = grab;
        this.onClick = onClick;
        this.onHover = onHover;
        this.name = `Button3D:${role || label}`;
        this._baseOpacity = opacity;
        this._hovered = false;
        this._active = false;
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
}
