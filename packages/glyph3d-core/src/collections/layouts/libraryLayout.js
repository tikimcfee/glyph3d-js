/**
 * libraryLayout — the "library" scheme: every file is a BOOK, and the repository is a
 * library — the same content, mutable in form.
 *
 * The mental model is painfully simple, and that is the point. The books themselves are
 * DURABLE objects (collections/Book.js) — ContentTree wraps every leaf in one at insert,
 * addressable via bookAt(path) for the whole life of the file. This scheme does not
 * create or own them; it only asks each book to take page form and then arranges the
 * collection. fit() is one uniform contain-fit scale (fit, never skew) onto a
 * `pageW × pageH` page with an exact page face behind it, so every book presents the
 * identical bound form regardless of what it holds. A directory's books then just stack
 * in a sorted order at a tight, configurable distance:
 *
 *   stack 'z' — a DECK: co-located (same x,y), stepped back one `gap` per book,
 *   stack 'x' — a SHELF: books abreast left→right,
 *   stack 'y' — a PILE: books descending one below the other.
 *
 * Sorting picks the question you're asking of the collection: 'name' (alphabetic),
 * 'size' (content area, big books first), 'ext' (genre shelves); `reverse` flips any
 * of them. Child directories are their own collections, packed in canonical serpentine
 * order below the node's stack and one depthZ step back — the same depth-is-hierarchy
 * reading as packed.
 *
 * FORM-WRITING scheme: measure calls book.fit() (a state write on a durable object,
 * analogous to jellyfish's panel surfaces) — ContentTree._normalize releases every book
 * before any layout pass, so other schemes read the natural form and lens-switching
 * stays lossless. Books stay live grids throughout: they page-flip via
 * grid.layout/grid.frame and drag like any code sheet. Otherwise the shared contract:
 * relative (children in the node's LOCAL frame, origin = footprint top-center),
 * measure post-order / place pre-order.
 */

import { flowBoxes } from './flowBoxes.js';
import { partitionChildren } from './nodeUtils.js';
import { PANEL_SURFACE_DEFAULTS } from './panelSurface.js';
import { extOf } from '../../core/fileKind.js';

export const LIBRARY_DEFAULTS = {
    pageW: 900,        // the page width every book presents (world units)
    pageH: 1200,       // the page height — portrait: these are books, not monitors
    gap: 40,           // stack spacing: the FULL z step of a deck; the gap ADDED between shelf/pile pages
    stack: 'z',        // 'z' deck (co-located) | 'x' shelf (abreast) | 'y' pile (descending)
    sort: 'name',      // 'name' | 'size' (content area, big first) | 'ext' (genre shelves)
    reverse: false,    // flip the stack order
    maxUpscale: 4,     // contain-fit may enlarge small files up to this — caps the one-liner giant
    dirGap: 80,        // gap between a node's own stack and its child-directory tier
    depthZ: 500,       // per-level z step for child dirs (packed's proven readable value)
    aspect: 1.5,       // child-tier wrap target (w ≈ aspect × h)
    ...PANEL_SURFACE_DEFAULTS,   // surface* — the page face behind each book's content
    surfacePad: 0,     // the page IS the book's exact bound — no margin past pageW × pageH
};

const byName = (a, b) =>
    String(a.userData.name).localeCompare(String(b.userData.name), undefined, { sensitivity: 'base' });
const area = (b) => b.fitInfo.contentW * b.fitInfo.contentH;

/** Order the books by the active question. Sorts fall back to name so equal keys stay stable. */
function sortBooks(books, o) {
    if (o.sort === 'size') books.sort((a, b) => (area(b) - area(a)) || byName(a, b));
    else if (o.sort === 'ext') books.sort((a, b) =>
        extOf(a.userData.path).localeCompare(extOf(b.userData.path)) || byName(a, b));
    else books.sort(byName);
    if (o.reverse) books.reverse();
}

/** The stack's bounding extent: pages are uniform, so this is pure arithmetic. The deck
 *  overlaps on z (gap IS the step); shelf/pile step by a full page plus the gap. */
function stackExtent(n, o) {
    if (n === 0) return { w: 0, h: 0, d: 0 };
    if (o.stack === 'x') return { w: n * o.pageW + (n - 1) * o.gap, h: o.pageH, d: 0 };
    if (o.stack === 'y') return { w: o.pageW, h: n * o.pageH + (n - 1) * o.gap, d: 0 };
    return { w: o.pageW, h: o.pageH, d: (n - 1) * o.gap };
}

/** Serpentine ordered pack for the child-dir tier — canonical order preserved, wrap width
 *  targeting the aspect from total area (the packed scheme's area heuristic). */
function orderedPack(sizes, gap, aspect) {
    let area = 0, maxW = 0;
    for (const s of sizes) { area += (s.w + gap) * (s.h + gap); maxW = Math.max(maxW, s.w); }
    const wrapWidth = sizes.length <= 1 ? Infinity : Math.max(Math.sqrt(area * aspect), maxW + gap);
    return flowBoxes(sizes, { margin: gap, wrapWidth, serpentine: true });
}

/** Post-order: ask this node's books for page form, sort them, measure child
 *  collections, union the footprint (stack on top, child tier below). size.z is
 *  honest — a deep deck extends. */
function measure(node, o) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    const books = files;   // in a ContentTree every file child IS a durable Book
    for (const b of books) b.fit(o);
    sortBooks(books, o);
    const ext = stackExtent(books.length, o);

    const dirSizes = dirs.map((d) => measure(d, o));
    const childPack = dirs.length ? orderedPack(dirSizes, o.dirGap, o.aspect) : null;

    const empty = !books.length && !childPack;
    const w = empty ? 0 : Math.max(ext.w, childPack?.width ?? 0);
    const h = empty ? 0 : ext.h + (books.length && childPack ? o.dirGap : 0) + (childPack?.height ?? 0);
    const d = Math.max(ext.d, dirs.length ? o.depthZ + Math.max(...dirSizes.map((s) => s.d)) : 0);

    node.userData._lib = { books, dirs, ext, dirSizes, childPack };
    node.userData.size = { x: w, y: h, z: d };
    return { w, h, d };
}

/** Pre-order: the stack anchors at the top-center of the node's footprint (the shared
 *  origin contract); child collections pack below it, one depthZ step back. */
function place(node, o) {
    const lib = node.userData._lib;
    if (!lib) return;
    const { books, dirs, ext, dirSizes, childPack } = lib;

    books.forEach((book, i) => {
        if (o.stack === 'x') {
            book.position.set(-ext.w / 2 + o.pageW / 2 + i * (o.pageW + o.gap), -o.pageH / 2, 0);
        } else if (o.stack === 'y') {
            book.position.set(0, -o.pageH / 2 - i * (o.pageH + o.gap), 0);
        } else {
            book.position.set(0, -o.pageH / 2, -i * o.gap);   // the deck: co-located, stepped back
        }
        book.rotation.set(0, 0, 0);
    });

    if (!childPack) return;
    const cLeft = -childPack.width / 2;
    const cTop = -(books.length ? ext.h + o.dirGap : 0);
    dirs.forEach((child, j) => {
        const s = childPack.slots[j];
        child.position.set(cLeft + s.x + dirSizes[j].w / 2, cTop + s.y, -o.depthZ);
        child.rotation.set(0, 0, 0);
        place(child, o);
    });
}

/**
 * Lay out a ContentTree subtree as a library of uniform books.
 * @param {import('three').Object3D} root the node to lay out (children positioned in its local frame)
 * @param {object} [opts] overrides for LIBRARY_DEFAULTS (pageW/pageH/gap/stack/sort/reverse/
 *   maxUpscale/dirGap/depthZ/aspect + surface*)
 * @returns {{w:number,h:number}} the root's measured footprint; the deck depth lives on
 *   node.userData.size.z
 */
export default function libraryLayout(root, opts = {}) {
    const o = { ...LIBRARY_DEFAULTS, ...opts };
    const { w, h } = measure(root, o);
    place(root, o);
    return { w, h };
}
