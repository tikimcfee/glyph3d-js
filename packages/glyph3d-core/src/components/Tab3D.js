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
 * FieldLabel (real glyphs over a baked plate — minifies through the LOD system
 * instead of blurring on a tilted edge) + Button3D's interaction role: the plate
 * re-enters picking (FieldLabel marks it isMarker/inert), carries a role + onClick,
 * and owns default/hover/active visual states. The shared glyph-vertex transform
 * means a scaled tab (tilted edge, hover pop) picks correctly.
 *
 * Not an r3f component; clicks/hover resolve through the GPU picking pass — the
 * host registers `pickMesh` (the plate) on the 'handle' channel and the central
 * press router (CanvasInteraction) fires onClick + drives setHovered, exactly as
 * it does for Button3D.
 *
 * The plate mesh is reused across FieldLabel's live rebakes (only its geometry +
 * texture swap), so the isMarker deletion from the constructor persists for the
 * tab's life. setActive marks the head sheet's tab — the "you are here" tab.
 */
export default class Tab3D extends FieldLabel {
    /**
     * @param {Object} o - all FieldLabel options ({ atlas, text, lineHeight,
     *   textColor, plate, maxInstances }) plus:
     * @param {string}  [o.role='tab']       carried in the pick token for the dispatcher
     * @param {Function} [o.onClick=null]    (token) => … ; the wrapper wires this to `book.page`
     * @param {number}  [o.activeColor]      hex — the head tab's plate color (null = keep resting)
     */
    constructor({ role = 'tab', onClick = null, activeColor = null, plate, ...fieldLabelArgs } = {}) {
        // A tab is always a plated label (the plate is the pick surface + the
        // thumb-tab body); default one if the caller (book banding) didn't.
        super({ plate: plate ?? { color: 0x8899aa, opacity: 0.85 }, ...fieldLabelArgs });
        // The plate is the pick surface — undo FieldLabel's inert-marker flag.
        if (this._plate?.mesh) delete this._plate.mesh.userData.isMarker;
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

    /** The mesh a host registers for picking — the backing plate (a flat plane). */
    get pickMesh() { return this._plate?.mesh ?? null; }

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

    /** @private — plate opacity from the active/hover flags (text untouched). */
    _refreshOpacity() {
        if (!this._plate) return;
        const boost = this._active ? 0.25 : (this._hovered ? 0.2 : 0);
        this._plate.mesh.material.opacity = Math.min(1, this._baseOpacity + boost);
    }
}
