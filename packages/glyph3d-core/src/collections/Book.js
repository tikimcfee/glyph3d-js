/**
 * Book — a file's durable spatial carrier: the same content, mutable in form.
 *
 * A Book is a REAL, addressable object (not a layout artifact): ContentTree wraps every
 * file leaf in one at insert and keeps it for the leaf's whole life, across every
 * relayout and scheme switch. Layout schemes ARRANGE books; they no longer create or
 * destroy them. That split is what frees form from the layout flow — a book can be
 * looked up (ContentTree.bookAt), asked about, labeled, splayed, or shelved by verbs
 * that run between layout passes, because its identity outlives them all.
 *
 * Form is a small state machine with two poses today:
 *
 *   released (natural) — a transparent carrier: identity transform, leaf at the origin,
 *     no page face. Every flat scheme (packed/walk/district/tree) measures and places
 *     the book exactly as it would the bare leaf — layoutBounds passes the leaf's box
 *     through the leaf's own transform (user zoom included), so the wrap is invisible.
 *
 *   fitted (the library's page) — one uniform contain-fit scale (fit, never skew — the
 *     book's Group scale, NEVER the leaf's own ScaleModel) sizes the content into a
 *     `pageW × pageH` page, content centered, an exact world-true page face behind it.
 *     layoutBounds reports the page, so bounds consumers (markers, arrows, framing)
 *     see the bound form, not the loose content.
 *
 * ContentTree._normalize releases every book in a subtree before a layout pass, so each
 * scheme starts from the canonical natural form and switching lenses stays lossless.
 *
 * The inner leaf keeps its identity everywhere that matters: it carries the path, owns
 * picking/editing/attention, and remains the navigation target (contentChildren walks
 * THROUGH books). The book carries the path too — it is the unit layout packs, the
 * unit jellyfish re-homes, the unit a shelf will one day hold.
 */

import * as THREE from 'three';
import BoundedObject3D from './BoundedObject3D.js';
import { leafBox } from './layouts/nodeUtils.js';
import { addPanelSurface } from './layouts/panelSurface.js';

/** Page-face fallbacks when fit() is driven directly (a scheme passes its full merged
 *  opts; a bare verb may pass only page dims). */
const PAGE_FACE_DEFAULTS = { surface: true, surfacePad: 0, surfaceDepth: 8 };

export default class Book extends BoundedObject3D {
    /**
     * @param {THREE.Object3D} leaf the content this book binds (a CodeGrid, or any
     *        leafBox-measurable object) — adopted as a child at the origin
     */
    constructor(leaf) {
        super();
        this.name = 'book';
        /** @type {THREE.Object3D} the bound content — picking/edit/attention target */
        this.leaf = leaf;
        this.userData = { isBook: true };   // path/name mirrored on insert by ContentTree
        /** @type {THREE.Mesh|null} the page face while fitted */
        this._page = null;
        /** @type {{pageW:number,pageH:number,scale:number,contentW:number,contentH:number}|null} */
        this.fitInfo = null;
        this.add(leaf);
    }

    /** @returns {boolean} true while the book holds its page form */
    get fitted() { return this.fitInfo !== null; }

    /**
     * The leaf's content box in the BOOK's local frame — the leaf's layout box carried
     * through the leaf's own transform (position/zoom), exactly what bounds consumers
     * saw when the leaf sat bare in the tree.
     * @returns {THREE.Box3}
     */
    contentBox() {
        this.leaf.updateMatrix();
        return leafBox(this.leaf).applyMatrix4(this.leaf.matrix);
    }

    /**
     * Take page form: one uniform contain-fit scale onto `pageW × pageH` (capped at
     * maxUpscale), content centered on the page center, an exact page face behind it.
     * The scale lands on the book's own Group transform — the leaf's ScaleModel is
     * never written. Re-fitting is idempotent (the leaf is re-seated first).
     * @param {object} opts pageW/pageH [+ maxUpscale + surface* dials]
     * @returns {{pageW:number,pageH:number,scale:number,contentW:number,contentH:number}}
     */
    fit(opts) {
        // Re-seat the leaf so the fit reads the leaf's own form, not a stale offset.
        this.leaf.position.set(0, 0, 0);
        this.leaf.rotation.set(0, 0, 0);
        const b = this.contentBox();
        const w = Math.max(b.max.x - b.min.x, 1e-6);
        const h = Math.max(b.max.y - b.min.y, 1e-6);
        const s = Math.min(opts.pageW / w, opts.pageH / h, opts.maxUpscale ?? Infinity);
        this.leaf.position.set(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
        this.scale.setScalar(s);
        this.fitInfo = { pageW: opts.pageW, pageH: opts.pageH, scale: s, contentW: w, contentH: h };
        this._refreshPage({ ...PAGE_FACE_DEFAULTS, ...opts });
        return this.fitInfo;
    }

    /**
     * Return to natural form: identity transforms, leaf re-seated at the origin, page
     * face dropped. The book's POSITION is untouched — the next layout pass places it.
     */
    release() {
        this._dropPage();
        this.fitInfo = null;
        this.scale.setScalar(1);
        this.rotation.set(0, 0, 0);
        this.leaf.position.set(0, 0, 0);
        this.leaf.rotation.set(0, 0, 0);
        return this;
    }

    /** Rebuild the page face for the current fit. The book is scaled by fitInfo.scale,
     *  so the box and the pad/depth divide back to book-local units — every page renders
     *  the identical world-true bound size. @private */
    _refreshPage(opts) {
        this._dropPage();
        const { pageW, pageH, scale: s } = this.fitInfo;
        const inv = 1 / s;
        this._page = addPanelSurface(this, {
            mode: 'flat',
            box: new THREE.Box3(
                new THREE.Vector3(-pageW / 2 * inv, -pageH / 2 * inv, 0),
                new THREE.Vector3(pageW / 2 * inv, pageH / 2 * inv, 0)),
        }, { ...opts, surfacePad: opts.surfacePad * inv, surfaceDepth: opts.surfaceDepth * inv });
    }

    /** @private drop the page face (shared plane geometry + material stay alive). */
    _dropPage() {
        if (!this._page) return;
        this.remove(this._page);
        if (this._page.userData.disposeGeometry) this._page.geometry.dispose();
        this._page = null;
    }

    /**
     * Local layout box — the bound form: the page while fitted (x/y exact page in local
     * units; z spans the content), the pass-through content box while released. Schemes
     * and bounds consumers apply the book's own matrix on top (leafBox contract).
     * @returns {THREE.Box3}
     */
    layoutBounds() {
        const cb = this.contentBox();
        if (!this.fitted) return cb;
        const { pageW, pageH, scale: s } = this.fitInfo;
        const hw = pageW / 2 / s, hh = pageH / 2 / s;
        return new THREE.Box3(
            new THREE.Vector3(-hw, -hh, Math.min(cb.min.z, 0)),
            new THREE.Vector3(hw, hh, Math.max(cb.max.z, 0)));
    }

    /** BoundedObject3D's Measurable contract — getBounds() derives the world AABB from this. */
    getLocalBounds() { return this.layoutBounds(); }

    /** Detach the leaf (returned to the caller) and free the page. The book is dead after. */
    dispose() {
        this._dropPage();
        this.remove(this.leaf);
        return this.leaf;
    }
}
