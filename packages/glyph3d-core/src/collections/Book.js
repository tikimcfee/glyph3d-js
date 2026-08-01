/**
 * Book — a durable spatial carrier: content bound into pages.
 *
 * A Book is a REAL, addressable object (not a layout artifact). ContentTree wraps every
 * file leaf in one at insert and keeps it for the leaf's whole life, across every
 * relayout and scheme switch; agent books live outside the tree and grow as their agent
 * works. Layout schemes ARRANGE books; they never create or destroy them.
 *
 * A book holds SHEETS, in order. Each sheet is a page-pair:
 *
 *   { verso, recto } — verso is the left page's content, recto the right's. Either may
 *   be absent: a sheet with one side presents a single centered page (a file book is
 *   exactly that — one sheet, recto = the file's grid). A sheet with both presents a
 *   SPREAD: two pages abreast around a gutter.
 *
 * Structure: each sheet is a node (Group) child of the book; each side's content sits
 * inside its own MOUNT (Group). The contain-fit scale lands on the mount — the book's
 * own transform stays identity scale, and the content's own transform authority
 * (position/zoom, the leaf's ScaleModel) is never written. Sheet nodes and mounts are
 * tagged userData.isBookInternal so tree traversal walks through them to the content.
 *
 * Form is a small state machine:
 *
 *   released (natural) — a transparent carrier: identity mounts, contents at the
 *     origin, no page faces. Every flat scheme (packed/walk/district/tree) measures and
 *     places the book exactly as it would the bare content — layoutBounds passes the
 *     content box through the content's own transform, so the wrap is invisible.
 *
 *   fitted (page form) — each side contain-fits (fit, never skew; capped at
 *     maxUpscale) onto a `pageW × pageH` page rect, content centered, an exact page
 *     face behind each page. layoutBounds reports the page (or spread) rect, so bounds
 *     consumers (markers, arrows, framing) see the bound form.
 *
 * Multi-sheet books read as a ROLODEX DECK: the sheet at `head` fronts the book at
 * z = 0 and the rest recede by deck.zPitch — scrolled-past newer sheets wrap to the
 * back. Paging only moves the head; update(dt) eases each sheet to its slot. The book
 * live-follows its newest sheet (`following`) until paged back; landing on the newest
 * resumes following. A one-sheet book's deck is a no-op.
 *
 * ContentTree._normalize releases every tree book before a layout pass, so each scheme
 * starts from the canonical natural form and switching lenses stays lossless.
 *
 * The inner content keeps its identity everywhere that matters: a file's grid carries
 * the path, owns picking/editing/attention, and remains the navigation target
 * (contentChildren walks THROUGH books). The book carries the path too — it is the
 * unit layout packs, the unit jellyfish re-homes, the unit a shelf holds.
 */

import * as THREE from 'three';
import BoundedObject3D from './BoundedObject3D.js';
import { leafBox } from './layouts/nodeUtils.js';
import { addPanelSurface, ownSurfaceMaterial } from './layouts/panelSurface.js';

/** Page-face fallbacks when fit() is driven directly (a scheme passes its full merged
 *  opts; a bare verb may pass only page dims). */
const PAGE_FACE_DEFAULTS = { surface: true, surfacePad: 0, surfaceDepth: 8 };

/** Deck (rolodex) defaults — multi-sheet books only; a one-sheet book never moves. */
const DECK_DEFAULTS = { zPitch: 90, lerp: 9 };

export default class Book extends BoundedObject3D {
    /**
     * @param {THREE.Object3D} [leaf] initial bound content (a CodeGrid, or any
     *        leafBox-measurable object) — becomes the first sheet's recto. Omit for an
     *        empty book (an agent book before its first moment).
     */
    constructor(leaf) {
        super();
        this.name = 'book';
        this.userData = { isBook: true };   // path/name mirrored on insert by ContentTree
        /** @type {Array<{node:THREE.Group, verso:THREE.Object3D|null, recto:THREE.Object3D|null,
         *               versoMount:THREE.Group, rectoMount:THREE.Group,
         *               faces:THREE.Mesh[], fit:Object, _z:number|null}>} */
        this.sheets = [];
        /** @type {number} the open sheet's index (fronts the deck) */
        this.head = 0;
        /** @type {boolean} live-follow: ride each appended sheet to the front */
        this.following = true;
        /** @type {{zPitch:number, lerp:number}} rolodex knobs (multi-sheet books) */
        this.deck = { ...DECK_DEFAULTS };
        /** @type {{pageW:number,pageH:number,scale:number,contentW:number,contentH:number}|null}
         *  the OPEN sheet's primary-side fit summary while fitted (recto, else verso) */
        this.fitInfo = null;
        this._fitOpts = null;    // the live fit opts — appended sheets take page form immediately
        this._faceMat = null;    // per-book face material (ownFace) — shared singleton otherwise
        if (leaf) this.addSheet({ recto: leaf });
    }

    /** @returns {boolean} true while the book holds its page form */
    get fitted() { return this.fitInfo !== null; }

    /** The single bound content of a plain one-sheet carrier (a file book), else null. */
    get leaf() {
        return (this.sheets.length === 1 && !this.sheets[0].verso) ? this.sheets[0].recto : null;
    }

    /** True when the plain carrier's content sits at home in its mount (not docked away). */
    hasLeafAtHome() {
        const l = this.leaf;
        return !!l && l.parent === this.sheets[0].rectoMount;
    }

    /** Every side content across the sheets — the tree walks these as the book's children. */
    contentLeaves() {
        const out = [];
        for (const s of this.sheets) {
            if (s.verso) out.push(s.verso);
            if (s.recto) out.push(s.recto);
        }
        return out;
    }

    /**
     * Append a sheet (page-pair). While following, the head rides to it; while fitted,
     * the new sheet takes page form immediately and seats at its deck slot (no flash).
     * @param {{verso?:THREE.Object3D|null, recto?:THREE.Object3D|null}} sides
     * @returns {number} the new sheet's index
     */
    addSheet({ verso = null, recto = null } = {}) {
        const node = new THREE.Group();
        node.name = `sheet:${this.sheets.length}`;
        node.userData = { isBookInternal: true };
        const mountFor = (content, name) => {
            const m = new THREE.Group();
            m.name = name;
            m.userData = { isBookInternal: true };
            if (content) m.add(content);
            node.add(m);
            return m;
        };
        const sheet = {
            node, verso, recto,
            versoMount: mountFor(verso, 'verso'),
            rectoMount: mountFor(recto, 'recto'),
            faces: [], fit: {}, _z: null,
        };
        this.add(node);
        this.sheets.push(sheet);
        if (this.following) this.head = this.sheets.length - 1;
        if (this._fitOpts) this._fitSheet(sheet, this._fitOpts);
        this._seat(this.sheets.length - 1);
        return this.sheets.length - 1;
    }

    /**
     * The content box of the OPEN sheet in the BOOK's local frame — each side's layout
     * box carried through its own transform, mount, and sheet node. Released, with a
     * single bare sheet, this is exactly what bounds consumers saw when the leaf sat
     * bare in the tree.
     * @returns {THREE.Box3}
     */
    contentBox() {
        const sheet = this.sheets[this.head];
        const out = new THREE.Box3();
        if (!sheet) return out;
        for (const [mount, content] of [[sheet.versoMount, sheet.verso], [sheet.rectoMount, sheet.recto]]) {
            if (!content) continue;
            content.updateMatrix(); mount.updateMatrix(); sheet.node.updateMatrix();
            const b = leafBox(content).applyMatrix4(content.matrix)
                .applyMatrix4(mount.matrix).applyMatrix4(sheet.node.matrix);
            out.union(b);
        }
        return out;
    }

    /**
     * Take page form: every sheet's sides contain-fit onto `pageW × pageH` page rects
     * (a two-sided sheet spreads around `gutter`), content centered per page, an exact
     * page face behind each. The fit scale lands on each side's MOUNT — the book's own
     * transform and the content's transform authority are never written. Re-fitting is
     * idempotent (contents are re-seated first). Appended sheets inherit this form.
     * @param {object} opts pageW/pageH [+ gutter + maxUpscale + surface* and ownFace dials]
     * @returns {{pageW:number,pageH:number,scale:number,contentW:number,contentH:number}|null}
     */
    fit(opts) {
        this._fitOpts = { ...PAGE_FACE_DEFAULTS, ...opts };
        for (const sheet of this.sheets) this._fitSheet(sheet, this._fitOpts);
        return this.fitInfo;
    }

    /** Re-fit ONE sheet against the live fit opts — a streamed card's async bounds
     *  settled and only that page needs re-reading (fit() re-fits the whole book). */
    fitSheet(i) {
        const sheet = this.sheets[i];
        if (sheet && this._fitOpts) this._fitSheet(sheet, this._fitOpts);
    }

    /**
     * Return to natural form: identity mounts, contents re-seated at the origin, page
     * faces dropped, sheets resting at the book origin. The book's POSITION is
     * untouched — the next layout pass places it. Head/following survive a release.
     */
    release() {
        for (const sheet of this.sheets) {
            this._dropFaces(sheet);
            sheet.node.position.set(0, 0, 0);
            sheet.node.rotation.set(0, 0, 0);
            sheet._z = null;
            for (const [mount, content] of [[sheet.versoMount, sheet.verso], [sheet.rectoMount, sheet.recto]]) {
                mount.position.set(0, 0, 0);
                mount.rotation.set(0, 0, 0);
                mount.scale.setScalar(1);
                if (content) { content.position.set(0, 0, 0); content.rotation.set(0, 0, 0); }
            }
            sheet.fit = {};
        }
        this.fitInfo = null;
        this._fitOpts = null;
        this.scale.setScalar(1);
        this.rotation.set(0, 0, 0);
        return this;
    }

    // -- rolodex deck: head is the only nav state; each sheet's depth is a derived slot ------------
    //    slot(i) = (head - i) mod n — older sheets recede, scrolled-past newer ones wrap to the back.

    /** Move the head to a sheet index (0 = oldest, clamped). Landing on the newest resumes
     *  live-following; anywhere else holds. The sheets ease to their new slots in update(dt). */
    pageTo(index) {
        const n = this.sheets.length;
        if (!n) return false;
        this.head = Math.min(Math.max(0, Math.round(index)), n - 1);
        this.following = this.head === n - 1;
        return true;
    }

    /** Move the head by `delta` sheets (− older / back in time, + newer). */
    scroll(delta) { return this.pageTo(this.head + (Number(delta) || 0)); }

    /** The deck's nav state — for panels and verbs. */
    headState() { return { head: this.head, count: this.sheets.length, following: this.following }; }

    /** Ease every sheet toward its deck slot — frame-rate-independent (`1 − e^(−rate·dt)`).
     *  A settled deck skips the write. One-sheet books settle at 0 and stay a no-op. */
    update(dt) {
        const n = this.sheets.length;
        if (n < 2) return;
        const rate = this.deck.lerp;
        const k = rate > 0 ? 1 - Math.exp(-rate * Math.min(Math.max(dt || 0, 0), 0.1)) : 1;
        for (let i = 0; i < n; i++) {
            const sheet = this.sheets[i];
            const target = this._slotZ(i);
            if (sheet._z == null) sheet._z = target;
            else if (Math.abs(target - sheet._z) < 0.05) {
                if (sheet._z !== target) { sheet._z = target; sheet.node.position.z = target; }
                continue;
            } else sheet._z += (target - sheet._z) * k;
            sheet.node.position.z = sheet._z;
        }
    }

    /**
     * The deck's LIVE extent while fitted: every sheet's page (or spread) rect at the
     * z its node ACTUALLY occupies — mid-ease included — thickened for content and
     * faces. This is what a cover that binds the whole book must wrap: measuring slot
     * arithmetic instead leaves pages poking out of their own binding while they ease.
     * Empty for a released or sheetless book.
     * @returns {THREE.Box3}
     */
    deckBounds() {
        const out = new THREE.Box3();
        const o = this._fitOpts;
        if (!o) return out;
        const zPad = (o.surfaceDepth ?? 8) + 2;
        const tmpMin = new THREE.Vector3(), tmpMax = new THREE.Vector3();
        for (const sheet of this.sheets) {
            const sides = (sheet.verso ? 1 : 0) + (sheet.recto ? 1 : 0);
            if (!sides) continue;
            const hw = sides === 2 ? o.pageW + (o.gutter ?? 0) / 2 : o.pageW / 2;
            const hh = o.pageH / 2;
            const z = sheet.node.position.z;
            tmpMin.set(-hw, -hh, z - zPad);
            tmpMax.set(hw, hh, z + zPad);
            out.expandByPoint(tmpMin);
            out.expandByPoint(tmpMax);
        }
        return out;
    }

    /**
     * Local layout box — the bound form while fitted: the LIVE deck extent (see
     * deckBounds) unioned with the open sheet's content depth. Released: the open
     * sheet's pass-through content box. Schemes and bounds consumers apply the book's
     * own matrix on top (leafBox contract).
     * @returns {THREE.Box3}
     */
    layoutBounds() {
        const cb = this.contentBox();
        if (!this.fitted) return cb;
        const db = this.deckBounds();
        if (db.isEmpty()) return cb;
        if (!cb.isEmpty()) db.union(cb);
        return db;
    }

    /** BoundedObject3D's Measurable contract — getBounds() derives the world AABB from this. */
    getLocalBounds() { return this.layoutBounds(); }

    /**
     * Detach every content (returned to their callers' care) and free the sheets, the
     * page faces, and any per-book face material. Returns the plain carrier's single
     * leaf when the book held one (ContentTree.remove's contract), else null.
     */
    dispose() {
        const single = this.leaf;
        for (const sheet of this.sheets) {
            this._dropFaces(sheet);
            if (sheet.verso) sheet.versoMount.remove(sheet.verso);
            if (sheet.recto) sheet.rectoMount.remove(sheet.recto);
            this.remove(sheet.node);
        }
        this.sheets = [];
        this._faceMat?.dispose?.();
        this._faceMat = null;
        return single;
    }

    // -- private --------------------------------------------------------

    /** slot(i) = (head - i) mod n, front = 0 — the local z a sheet rests at. @private */
    _slotZ(i) {
        const n = this.sheets.length;
        const head = Math.min(Math.max(0, this.head), n - 1);
        const slot = ((head - i) % n + n) % n;
        return -slot * this.deck.zPitch;
    }

    /** Seat sheet `i` directly at its slot (no easing) — a new sheet appears in place. @private */
    _seat(i) {
        const sheet = this.sheets[i];
        sheet._z = this._slotZ(i);
        sheet.node.position.z = sheet._z;
    }

    /** Contain-fit one sheet's sides onto their page rects and rebuild its faces. @private */
    _fitSheet(sheet, o) {
        const sides = [];
        if (sheet.verso) sides.push(['verso', sheet.versoMount, sheet.verso]);
        if (sheet.recto) sides.push(['recto', sheet.rectoMount, sheet.recto]);
        this._dropFaces(sheet);
        sheet.fit = {};
        if (!sides.length) return;
        const spread = sides.length === 2;
        const dx = spread ? (o.gutter ?? 0) / 2 + o.pageW / 2 : 0;
        for (const [side, mount, content] of sides) {
            // Re-seat so the fit reads the content's own form, not a stale offset.
            content.position.set(0, 0, 0);
            content.rotation.set(0, 0, 0);
            content.updateMatrix();
            const b = leafBox(content).applyMatrix4(content.matrix);
            // An EMPTY box (async content not yet settled) fits as a point at the page
            // center — a later fitSheet/fit re-reads the real bounds. Centering on an
            // empty box would be NaN (±Infinity midpoints), which poisons every parent
            // bound above, so seat it neutrally instead.
            const empty = !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x);
            const w = Math.max(b.max.x - b.min.x, 1e-6);
            const h = Math.max(b.max.y - b.min.y, 1e-6);
            const s = empty ? 1 : Math.min(o.pageW / w, o.pageH / h, o.maxUpscale ?? Infinity);
            const slotX = side === 'verso' ? -dx : (spread ? dx : 0);
            mount.scale.setScalar(s);
            if (empty) mount.position.set(slotX, 0, 0);
            else mount.position.set(
                slotX - (b.min.x + b.max.x) / 2 * s,
                -(b.min.y + b.max.y) / 2 * s,
                -(b.min.z + b.max.z) / 2 * s);
            sheet.fit[side] = { scale: s, contentW: w, contentH: h };
            this._addFace(sheet, slotX, o);
        }
        if (sheet === this.sheets[this.head] || !this.fitInfo) {
            const primary = sheet.fit.recto || sheet.fit.verso;
            this.fitInfo = { pageW: o.pageW, pageH: o.pageH, ...primary };
        }
    }

    /** One page face behind the page rect centered at `slotX`. Sheet-local units are
     *  world-true (the mounts absorbed the fit scale), so the rect is exact. @private */
    _addFace(sheet, slotX, o) {
        const opts = { ...o };
        if (o.ownFace) {
            this._faceMat ??= ownSurfaceMaterial(o);
            this._faceMat.apply(o);
            opts.material = this._faceMat.material;
        }
        const face = addPanelSurface(sheet.node, {
            mode: 'flat',
            box: new THREE.Box3(
                new THREE.Vector3(slotX - o.pageW / 2, -o.pageH / 2, 0),
                new THREE.Vector3(slotX + o.pageW / 2, o.pageH / 2, 0)),
        }, opts);
        if (face) sheet.faces.push(face);
    }

    /** @private drop a sheet's page faces (shared plane geometry stays alive). */
    _dropFaces(sheet) {
        for (const face of sheet.faces) {
            sheet.node.remove(face);
            if (face.userData.disposeGeometry) face.geometry.dispose();
        }
        sheet.faces = [];
    }
}
