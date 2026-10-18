import FieldLabel from '../collections/FieldLabel.js';

/**
 * GLOBAL tab-layout dials — live-tunable via the `tab.*` app settings (Book.syncTabs
 * re-reads them every frame, so they move without a rebuild). lineHeight is bind-time
 * (a relayout re-binds with a new glyph size); these three are geometry the per-frame
 * sync can shift on its own.
 *   steps     0 = fully left-to-right (each sheet one step over by index — the front
 *              tab's X marks deck progress); ≥2 = that many cut positions cycled.
 *   placement 'top' (file-folder tabs off the top edge) | 'fore' (off the +X side).
 *   protrusion how far a tab lifts off its edge, in world units.
 */
export const TAB_DEFAULTS = Object.freeze({ steps: 0, placement: 'top', protrusion: 0 });
export const TAB_CONFIG = { ...TAB_DEFAULTS };
/** Set one global tab dial live (keys: steps, placement, protrusion). */
export function setTabParam(vals) { Object.assign(TAB_CONFIG, vals); }

/**
 * Tab3D — a pickable, live-glyph edge label: the fourth cell of the label system.
 *
 *   Label3D   — baked text, inert   (fixed chrome: nameplates, dock tiles)
 *   Button3D  — baked text, picks   (in-canvas controls: grips, pin)
 *   FieldLabel— live glyphs, inert  (dynamic addressable text: lane labels)
 *   Tab3D     — live glyphs, picks  (THIS: book edge tabs)
 *
 * FieldLabel (a glyph field over a plate, which PanelBatch draws as an instance)
 * + Button3D's interaction role: a role + onClick and default/hover/active visual
 * states (hover pop = node scale, opacity boost = the plate's fill alpha, active
 * recolor = a fill write).
 *
 * Picking is not wired yet: nothing registers a tab, so the central press router
 * (CanvasInteraction) never fires onClick or drives setHovered for one. setActive marks the head sheet's tab — the "you are
 * here" tab.
 */
export default class Tab3D extends FieldLabel {
    /**
     * @param {Object} o - all FieldLabel options ({ atlas, text, lineHeight,
     *   textColor, plate }) plus:
     * @param {string}  [o.role='tab']       carried in the pick token for the dispatcher
     * @param {Function} [o.onClick=null]    (token) => … ; the wrapper wires this to `book.page`
     * @param {number}  [o.activeColor]      hex — the head tab's plate color (null = keep resting)
     */
    constructor({ role = 'tab', onClick = null, activeColor = null, plate, textColor = { r: 1, g: 1, b: 1 }, ...fieldLabelArgs } = {}) {
        // A tab is always a plated label (the plate is the thumb-tab body);
        // default one if the caller (book banding) didn't. Tabs default to light/white text.
        super({ plate: plate ?? { color: 0x8899aa, opacity: 0.85 }, textColor, ...fieldLabelArgs });
        this.userData.isTab = true;
        this.role = role;
        this.onClick = onClick;
        this._activeColor = activeColor;
        this._restColor = this._plateCfg?.color ?? null;
        this._baseOpacity = this._plateCfg?.opacity ?? 0.85;
        this._hovered = false;
        this._active = false;
        this.name = `Tab3D:${this._text || ''}`;
    }

    /** Cursor-over: fade the plate up + a small pop (mirrors Button3D). The TEXT
     *  stays full-alpha so a hovered tab stays legible. Idempotent. */
    setHovered(on) {
        if (this._hovered === on) return;
        this._hovered = on;
        this.scale.setScalar(on ? 1.08 : 1);
        this._refreshOpacity();
    }

    /** "You are here" — the head sheet's tab. Recolors to the active hue (if given)
     *  + a stronger plate read. Idempotent. */
    setActive(on) {
        if (this._active === on) return;
        this._active = on;
        if (this._activeColor != null) this.setPlateColor(on ? this._activeColor : (this._restColor ?? this._activeColor));
        this._refreshOpacity();
    }

    /** Rebind-time re-true of the resting facts (bindTabs diffs tabs in place —
     *  a tab rents substrate texels for its sheet's LIFETIME, never per relayout). */
    retune({ plateColor, activeColor, plateOpacity, textColor } = {}) {
        if (activeColor !== undefined) this._activeColor = activeColor;
        if (plateOpacity !== undefined) this._baseOpacity = plateOpacity;
        if (plateColor !== undefined) {
            this._restColor = plateColor;
            if (!this._active || this._activeColor == null) this.setPlateColor(plateColor);
        }
        if (textColor !== undefined) this.setTextColor(textColor);
        this._refreshOpacity();
    }

    /** @private — plate opacity from the active/hover flags (text untouched). */
    _refreshOpacity() {
        const boost = this._active ? 0.25 : (this._hovered ? 0.2 : 0);
        this._setPlateAlpha(Math.min(1, this._baseOpacity + boost));
    }
}
