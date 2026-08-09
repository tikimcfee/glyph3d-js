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
import { addPanelSurface, ownSurfaceMaterial, releasePanelPose } from './layouts/panelSurface.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import Tab3D, { TAB_CONFIG } from '../components/Tab3D.js';

/** Page-face fallbacks when fit() is driven directly (a scheme passes its full merged
 *  opts; a bare verb may pass only page dims). */
const PAGE_FACE_DEFAULTS = { surface: true, surfacePad: 0, surfaceDepth: 8 };

/** Deck (rolodex) defaults — multi-sheet books only; a one-sheet book never moves.
 *  `order` is the wrap DIRECTION: −1 reads by RECENCY (an agent book — newer sheets
 *  front, older recede; scrolled-past newer ones wrap to the back), +1 reads by PAGE
 *  ORDER (a library volume — page 1, 2, 3 recede in sequence; turned pages wrap to
 *  the back in turn order). */
const DECK_DEFAULTS = { zPitch: 90, lerp: 9, order: -1 };

/** Cover styling defaults — bindCover merges over these. */
const COVER_DEFAULTS = { color: 0x8090b0, opacity: 0.06, edgeOpacity: 0.22, pad: 16, zPad: 24 };

/** The one unit box + edge geometry every cover scales (built on first bind). */
let _coverUnit = null;
function coverUnit() {
    if (!_coverUnit) {
        const box = new THREE.BoxGeometry(1, 1, 1);
        _coverUnit = { box, edges: new THREE.EdgesGeometry(box) };
    }
    return _coverUnit;
}

const _coverSize = new THREE.Vector3();
const _coverCenter = new THREE.Vector3();

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
        /** @type {{mesh:THREE.Mesh, edges:THREE.LineSegments, fill:THREE.Material, edge:THREE.Material, opts:Object}|null} */
        this.cover = null;       // the identity/interaction body while bound (bindCover)
        /** @type {Object|null} a nameplate plate (Label3D) parked above the cover box (setNameplate) */
        this.nameplate = null;
        /** @type {Array<{sheet:Object, tab:Tab3D, key:string}>|null} per-sheet edge tabs (null until bindTabs) */
        this.tabs = null;
        this._tabOpts = null;
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
        if (this._tabOpts) this.tabs?.push(this._makeTab(sheet));   // keep tabs parallel to sheets
        if (this.following) this.head = this.sheets.length - 1;
        if (this._fitOpts) this._fitSheet(sheet, this._fitOpts);
        this._seat(this.sheets.length - 1);
        return this.sheets.length - 1;
    }

    /**
     * Unbind sheet `i`: its contents detach (returned to the caller's care — the book
     * never disposes what it carries), its node and page faces free, and the deck closes
     * up — slots re-derive from the new indices and ease shut in update(dt). While
     * following the head keeps riding the newest; a held head stays on its sheet,
     * shifting down when it sat past the removed one.
     * @param {number} i
     * @returns {{verso:THREE.Object3D|null, recto:THREE.Object3D|null}|null} the detached sides
     */
    removeSheet(i) {
        const sheet = this.sheets[i];
        if (!sheet) return null;
        this._dropFaces(sheet);
        releasePanelPose(sheet.node);
        if (sheet.verso) sheet.versoMount.remove(sheet.verso);
        if (sheet.recto) sheet.rectoMount.remove(sheet.recto);
        this.remove(sheet.node);
        this.sheets.splice(i, 1);
        if (this.tabs) { const tt = this.tabs.splice(i, 1)[0]; if (tt) { this.remove(tt.tab); tt.tab.dispose(); } }
        const n = this.sheets.length;
        if (!n) {
            this.head = 0;
            this.following = true;
            this.fitInfo = null;
        } else {
            if (this.head > i) this.head -= 1;
            this.head = Math.min(this.head, n - 1);
            if (this.following) this.head = n - 1;
            const primary = this.sheets[this.head].fit.recto || this.sheets[this.head].fit.verso;
            if (this._fitOpts && primary) {
                this.fitInfo = { pageW: this._fitOpts.pageW, pageH: this._fitOpts.pageH, ...primary };
            }
        }
        return { verso: sheet.verso, recto: sheet.recto };
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

    /** Seat every sheet directly at its slot (no easing) — a builder lays a deck down
     *  settled, so a freshly-assembled book appears in place instead of converging. */
    seatAll() {
        for (let i = 0; i < this.sheets.length; i++) this._seat(i);
        return this;
    }

    // -- the cover: the book's identity + interaction body -----------------------------
    //    A translucent box (the ContentTreeMarkers prism recipe) wrapping the LIVE deck
    //    bounds — it grows as sheets append and breathes as pages ease. Parented IN
    //    (rides every transform), userData.isMarker (bounds/schemes/gather skip it).
    //    The cover is what a WRAPPER points interaction at: agent books and library
    //    volumes both register it as their pick handle, so the wheel over a cover turns
    //    the book the same way everywhere. Book owns build/sync/teardown; identity
    //    (color), registration, and picking stay the wrapper's.

    /** Build the cover — or restyle a bound one (idempotent; dials tune live). */
    bindCover(opts = {}) {
        const o = { ...COVER_DEFAULTS, ...(this.cover?.opts ?? {}), ...opts };
        if (!this.cover) {
            const unit = coverUnit();
            const fill = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
            const edge = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
            const mesh = new THREE.Mesh(unit.box, fill);
            mesh.userData = { isMarker: true, isBookCover: true };
            const edges = new THREE.LineSegments(unit.edges, edge);
            edges.userData = { isMarker: true };
            mesh.add(edges);   // edges inherit the mesh's scale/position
            this.add(mesh);
            this.cover = { mesh, edges, fill, edge, opts: o };
        } else {
            this.cover.opts = o;
        }
        const c = this.cover;
        c.fill.color.set(o.color);
        c.fill.opacity = o.opacity;
        c.edge.color.set(o.color);
        c.edge.opacity = o.edgeOpacity;
        c.mesh.renderOrder = o.renderOrder ?? RENDER_ORDER.BACKDROP_BASE;
        c.edges.renderOrder = c.mesh.renderOrder;
        this.syncCover();
        return this;
    }

    /** Wrap the cover around the LIVE deck bounds (mid-ease included) — for a fitted
     *  sheetless book that's the closed-cover rect (deckBounds), so an empty book
     *  still shows a spine. Runs from update() every frame while bound; call
     *  directly after an out-of-band reshape. */
    syncCover() {
        const c = this.cover;
        if (!c) return this;
        const b = this.layoutBounds();
        if (b.isEmpty()) {
            c.mesh.visible = false;
            if (this.nameplate) this.nameplate.visible = false;
            return this;
        }
        b.getSize(_coverSize);
        b.getCenter(_coverCenter);
        c.mesh.position.copy(_coverCenter);
        c.mesh.scale.set(_coverSize.x + 2 * c.opts.pad, _coverSize.y + 2 * c.opts.pad, _coverSize.z + 2 * c.opts.zPad);
        c.mesh.visible = true;
        c.edges.visible = c.opts.edgeOpacity > 0;
        // The nameplate rides the cover's top edge (the dock's tile-label idiom:
        // edge + small gap + half the plate), re-anchored every sync.
        const np = this.nameplate;
        if (np) {
            np.visible = true;
            np.position.set(
                _coverCenter.x,
                _coverCenter.y + (_coverSize.y + 2 * c.opts.pad) / 2 + np.height * 0.8,
                _coverCenter.z);
        }
        return this;
    }

    /** Give the book a nameplate (a Label3D): parented in (rides every transform),
     *  parked just above the cover box by syncCover() each frame, and disposed with
     *  the cover. Replacing an existing plate disposes it; null detaches without
     *  disposing (the caller keeps it). */
    setNameplate(label) {
        if (this.nameplate && this.nameplate !== label) {
            this.remove(this.nameplate);
            this.nameplate.dispose?.();
        }
        this.nameplate = label || null;
        if (this.nameplate) {
            this.add(this.nameplate);
            this.syncCover();
        }
        return this;
    }

    /** Drop the cover (materials freed; the shared unit geometry stays alive).
     *  The nameplate goes with it — the cover owns the plate's placement, so its
     *  lifetime ends here too. */
    dropCover() {
        if (this.nameplate) {
            this.remove(this.nameplate);
            this.nameplate.dispose?.();
            this.nameplate = null;
        }
        if (!this.cover) return this;
        this.remove(this.cover.mesh);
        this.cover.fill.dispose();
        this.cover.edge.dispose();
        this.cover = null;
        return this;
    }

    // -- tabs: per-sheet edge labels, banded by a content key ------------------------
    //    One Tab3D per sheet (exact page navigation), staggered along the deck's own
    //    Z-recede — each tab rides its sheet's LIVE slot (mid-ease), so the deck's
    //    rolodex cascade IS the thumb-index stagger for free — and banded UP the cover
    //    edge by a per-book content key (files → first letter, agent moments → action
    //    kind) so the deck reads as stable groups. syncTabs() repositions every frame
    //    like syncCover does for the nameplate. Picking stays the wrapper's job (a
    //    'handle'-channel panel block resolving hits to tabs); Book owns build/sync only.

    /** Bind one pickable tab per sheet. `keyOf`/`labelOf`/`hueOf` default to the
     *  basename-first-letter idiom; wrappers override (agent → action kind, etc.).
     *  A re-bind is a DIFF, not a rebuild: existing sheets keep their Tab3D (its
     *  text/pitch/hue re-true in place) — tabs rent substrate group texels, and
     *  ids retire on dispose, so per-relayout rebuilds would burn the texel space.
     *  The geometry dials — stagger, edge, lift — are the GLOBAL live `tab.*`
     *  settings (Tab3D's TAB_CONFIG), re-read by syncTabs every frame. */
    bindTabs({ atlas, keyOf = null, labelOf = null, hueOf = null,
              lineHeight = 7, plateOpacity = 0.85, activeColor = 0x6ee7a0 } = {}) {
        const prev = new Map((this.tabs ?? []).map((t) => [t.sheet, t]));
        this._tabOpts = { atlas, keyOf, labelOf, hueOf, lineHeight, plateOpacity, activeColor };
        this.tabs = this.sheets.map((sheet, i) => {
            const t = prev.get(sheet);
            if (!t) return this._makeTab(sheet);
            prev.delete(sheet);
            t.key = this._tabKeyOf(sheet);
            const label = this._tabLabelOf(sheet);
            t.tab.setText(label);
            t.tab.setLineHeight(lineHeight);
            t.tab.retune({ plateColor: this._tabHueOf(t.key), activeColor, plateOpacity });
            t.tab.name = `tab:${i}:${label}`;
            return t;
        });
        for (const t of prev.values()) { this.remove(t.tab); t.tab.dispose(); }
        return this;
    }

    /** One tab for an existing sheet (used at bind + by addSheet's maintenance). @private */
    _makeTab(sheet) {
        const o = this._tabOpts;
        const i = this.sheets.indexOf(sheet);
        const key = this._tabKeyOf(sheet);
        const label = this._tabLabelOf(sheet);
        const tab = new Tab3D({
            atlas: o.atlas,
            text: label,
            lineHeight: o.lineHeight,
            plate: { color: this._tabHueOf(key), opacity: o.plateOpacity },
            activeColor: o.activeColor,
        });
        tab.name = `tab:${i}:${label}`;
        this.add(tab);
        return { sheet, tab, key };
    }

    /** Default band key: the recto content's basename first letter ('#' otherwise). */
    _tabKeyOf(sheet) {
        if (this._tabOpts.keyOf) return this._tabOpts.keyOf(sheet);
        const name = sheet.recto?.userData?.name ?? sheet.verso?.userData?.name ?? '';
        const c = String(name).trim()[0]?.toUpperCase();
        return c && /[A-Z0-9]/.test(c) ? c : '#';
    }

    /** Default tab text: the recto content's basename (no truncation). */
    _tabLabelOf(sheet) {
        if (this._tabOpts.labelOf) return this._tabOpts.labelOf(sheet);
        return String(sheet.recto?.userData?.name ?? sheet.verso?.userData?.name ?? '');
    }

    /** Default band color: a stable hue from the key's hash (wrappers pass a real palette). */
    _tabHueOf(key) {
        if (this._tabOpts.hueOf) return this._tabOpts.hueOf(key);
        let h = 0;
        for (let k = 0; k < key.length; k++) h = (h * 31 + key.charCodeAt(k)) >>> 0;
        return Math.floor(((h % 360) / 360) * 0xffffff);
    }

    /** Re-position every tab each frame. Each tab rides its sheet's LIVE Z slot
     *  (the deck's cascade = the shuffle); bands stagger across the edge by key.
     *  The head's tab is marked active. @see bindTabs for the placement shapes. */
    syncTabs() {
        if (!this.tabs) return;
        const o = this._tabOpts;
        const { steps, placement, protrusion } = TAB_CONFIG;        // live `tab.*` dials (re-read each frame)
        const b = this.layoutBounds();
        if (b.isEmpty()) { for (const t of this.tabs) t.tab.visible = false; return; }
        const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
        const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y;
        // Distinct keys → band ranks (sorted, stable) — used by the 'fore' side banding.
        const keys = Array.from(new Set(this.tabs.map((t) => t.key))).sort();
        const bandOf = new Map(keys.map((k, idx) => [k, idx]));
        const kB = keys.length;
        const tabH = o.lineHeight;
        const N = steps;                                            // 0 = left-to-right; ≥2 = cycled slots
        const innerW = Math.max(sx - 2 * tabH, tabH);               // step range across the top (margin each end)
        const bandPitch = Math.min(sx / Math.max(kB, 1), tabH * 6); // 'fore' band pitch (clustered when few)
        const count = this.sheets.length;
        for (const t of this.tabs) {
            const idx = this.sheets.indexOf(t.sheet);
            if (idx < 0) { t.tab.visible = false; continue; }
            const band = bandOf.get(t.key) ?? 0;
            const z = t.sheet.node.position.z;                      // live slot — the cascade
            let x, y, rotY = 0;
            if (placement === 'fore') {                             // +X side, facing +X
                x = cx + sx / 2 + protrusion + tabH * 0.5;
                y = kB > 1 ? cy + sy / 2 - tabH - (band / (kB - 1)) * (sy - tabH * 2) : cy;
                rotY = Math.PI / 2;
            } else if (N > 1) {                                     // 'top' + slots: cycle N cut positions
                x = (cx - innerW / 2) + (idx % N) * (innerW / (N - 1));
                y = cy + sy / 2 + tabH / 2 + protrusion;
            } else {                                                // 'top' + left-to-right: one step per sheet
                x = count > 1 ? (cx - innerW / 2) + (idx / (count - 1)) * innerW : cx;
                y = cy + sy / 2 + tabH / 2 + protrusion;            // attached to the top edge, sticking up
            }
            t.tab.position.set(x, y, z);
            t.tab.rotation.set(0, rotY, 0);
            t.tab.visible = true;
            t.tab.setActive(idx === this.head);
        }
    }

    /** Drop all tabs (dispose). Idempotent. */
    dropTabs() {
        if (this.tabs) {
            for (const t of this.tabs) { this.remove(t.tab); t.tab.dispose(); }
        }
        this.tabs = null;
        this._tabOpts = null;
        return this;
    }

    /** The deck's nav state — for panels and verbs. */
    headState() { return { head: this.head, count: this.sheets.length, following: this.following }; }

    /** Ease every sheet toward its deck slot — frame-rate-independent (`1 − e^(−rate·dt)`).
     *  A settled deck skips the write; the cover re-wraps the live bounds either way.
     *  One-sheet books settle at 0 and stay a no-op. */
    update(dt) {
        if (this.cover) this.syncCover();
        this.syncTabs();
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
     * Empty only for a RELEASED book; a fitted sheetless one reports its closed cover.
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
        // A fitted book with nothing in it is CLOSED, not dimensionless: one page
        // rect — the cover. An empty book on a shelf reads as a blank spine holding
        // its seat (and measures that way for contain-fits), never as a gap.
        if (out.isEmpty()) {
            out.min.set(-o.pageW / 2, -o.pageH / 2, -zPad);
            out.max.set(o.pageW / 2, o.pageH / 2, zPad);
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
        this.dropCover();
        this.dropTabs();
        for (const sheet of this.sheets) {
            this._dropFaces(sheet);
            releasePanelPose(sheet.node);
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

    /** slot(i) = (order · (i − head)) mod n, front = 0 — the local z a sheet rests at.
     *  order −1 recovers the recency rolodex (head − i); +1 reads in page order. @private */
    _slotZ(i) {
        const n = this.sheets.length;
        const head = Math.min(Math.max(0, this.head), n - 1);
        const slot = (((this.deck.order ?? -1) * (i - head)) % n + n) % n;
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

    /** @private drop a sheet's page faces — panel-field slot handles release,
     *  meshes detach (shared plane geometry stays alive). The sheet node's pose
     *  RENTAL survives here on purpose: faces re-create per fit, and a released
     *  group id retires forever — the rental dies with the sheet (removeSheet /
     *  dispose call releasePanelPose). */
    _dropFaces(sheet) {
        for (const face of sheet.faces) {
            if (face.isPanelFace) { face.release(); continue; }
            sheet.node.remove(face);
            if (face.userData.disposeGeometry) face.geometry.dispose();
        }
        sheet.faces = [];
    }
}
