/**
 * ScaleModel — the single authority for a window's Object3D.scale.
 *
 * A window's on-screen size is two independent things, multiplied:
 *
 *   placement (scalar) — the CONTEXT scale. At home it is the window's natural
 *     `gridScale`; docked, the CameraDock overrides it with a tile-normalized
 *     (height-fit) value. These are MUTUALLY EXCLUSIVE — a window is either at
 *     home or docked, never both — so there is no base×fit product, just one
 *     `placement` slot whose owner changes. This is the value that ANIMATES.
 *
 *   user ({x,y,z}) — the persisted ZOOM the operator dialed in for readability,
 *     default 1. A scalar broadcasts to uniform (glyph aspect preserved — the
 *     intended "make it legible" path); a per-axis tuple is the deliberate
 *     stretch that distorts glyphs (the icky escape hatch, never the mouse).
 *
 * `resolve()` composes them onto `obj.scale = placement · user`, componentwise,
 * and is the ONLY writer of a window's scale. The dock contributes `placement`
 * and READS `user` for its layout geometry — it never writes the final transform.
 * That keeps the x/y/z scale computed in exactly one place.
 *
 * Plain numbers / {x,y,z} only (no THREE import): the model is the record, and
 * resolve() pushes into the live `obj.scale` Vector3 via .set().
 */
export class ScaleModel {
    /** @param {number} [placement=1] the initial context (home/`gridScale`) scale */
    constructor(placement = 1) {
        /** @type {number} context scale — home gridScale or the dock's tile fit */
        this.placement = placement;
        /** @type {{x:number,y:number,z:number}} persisted zoom multiplier */
        this.user = { x: 1, y: 1, z: 1 };
    }

    /**
     * Set the zoom. A number broadcasts to a uniform zoom (glyph aspect kept);
     * an {x,y,z} sets the per-axis stretch (deliberate distortion).
     * @param {number|{x?:number,y?:number,z?:number}} factor
     * @returns {this}
     */
    setZoom(factor) {
        if (typeof factor === 'number') {
            this.user = { x: factor, y: factor, z: factor };
        } else {
            this.user = { x: factor.x ?? 1, y: factor.y ?? 1, z: factor.z ?? 1 };
        }
        return this;
    }

    /** Uniform zoom magnitude (the common case); the x component. @returns {number} */
    get zoomScalar() { return this.user.x; }

    /** True when the zoom is non-uniform (the deliberate stretch). @returns {boolean} */
    get isStretched() { return this.user.x !== this.user.y || this.user.y !== this.user.z; }

    /**
     * Compose `placement · user` onto the object's scale. The sole writer.
     * @param {{scale: {set:(x:number,y:number,z:number)=>void}}} obj a THREE.Object3D
     * @returns {*} obj (for chaining)
     */
    resolve(obj) {
        const p = this.placement;
        obj.scale.set(p * this.user.x, p * this.user.y, p * this.user.z);
        return obj;
    }
}

export default ScaleModel;
