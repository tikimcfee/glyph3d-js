/**
 * boardLayout — the "board" scheme: the agent shelf arranged as columns of work.
 *
 * Every other scheme here reads a repository. This one reads a *roster*: the books are
 * agents, not files, and the question it answers is "who is doing what right now" rather
 * than "what shape is this project". Books group into ordered columns by a key read off
 * each book's `userData` — lane state by default (`active` / `stalled` / `idle` / `done`),
 * which is exactly the board's own columns once a binding has mapped its statuses onto
 * lane states.
 *
 * Unlike the tree schemes this one is FLAT and absolute: the agent cluster's root holds
 * books directly, so there is no post-order measure and no local-frame recursion. It
 * places each child and returns.
 *
 * Grouping is data, not policy: `groupBy` names the userData path (`'state'`, or
 * `'meta.group'` for a binding that carries its own axis, e.g. pipeline stage), and
 * `columns` fixes the order. A book whose key is missing or unlisted lands in the
 * trailing overflow column rather than being dropped — an agent you can't see is worse
 * than one in the wrong place.
 */

import * as THREE from 'three';
import { leafBox } from './nodeUtils.js';

export const BOARD_DEFAULTS = {
    /** userData path the column key is read from. Dotted paths are walked. */
    groupBy: 'state',
    /**
     * Column order. Keys outside this list collect in a trailing column.
     * `'auto'` derives the columns from the data instead, sorted — for an axis with no
     * natural order (provider, agent name) where a fixed list would send everything to
     * overflow.
     */
    columns: ['active', 'stalled', 'idle', 'done'],
    /** Label for the trailing catch-all column. */
    overflowColumn: 'other',
    /** Horizontal step between columns, added to the widest book in the left column. */
    columnGap: 160,
    /** Vertical step between books within a column, added to each book's height. */
    rowGap: 90,
    /** Sort within a column: 'name' | 'none'. */
    sort: 'name',
    /** Books recede this far per row, so a deep column reads as depth rather than a wall. */
    depthZ: 0,
};

/**
 * Walk a dotted path on an object, tolerating missing links.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
function at(obj, path) {
    let cur = obj;
    for (const part of String(path).split('.')) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

/**
 * Arrange a flat cluster of books into labelled columns.
 *
 * @param {THREE.Object3D} root the cluster root — its direct children are the books
 * @param {Partial<typeof BOARD_DEFAULTS>} [opts]
 * @returns {{columns: Array<{key: string, count: number, x: number}>}} the placement,
 *   so a caller can label the columns or frame one without re-deriving the maths
 */
export default function boardLayout(root, opts = {}) {
    const cfg = { ...BOARD_DEFAULTS, ...(opts || {}) };
    const books = root.children.filter((c) => c.visible !== false);
    if (!books.length) return { columns: [] };

    // Bucket by key. Order of the buckets is cfg.columns, then overflow — NOT insertion
    // order, so a column doesn't move under the operator as agents change state. With
    // 'auto', the sorted distinct keys ARE that stable order.
    const order = cfg.columns === 'auto'
        ? [...new Set(books.map((b) => {
            const k = at(b.userData, cfg.groupBy);
            return k == null ? cfg.overflowColumn : String(k);
        }))].sort()
        : cfg.columns;

    /** @type {Map<string, THREE.Object3D[]>} */
    const buckets = new Map(order.map((k) => [k, []]));
    const overflow = [];
    for (const book of books) {
        const key = at(book.userData, cfg.groupBy);
        const bucket = key != null && buckets.has(String(key)) ? buckets.get(String(key)) : overflow;
        bucket.push(book);
    }
    if (overflow.length) buckets.set(cfg.overflowColumn, overflow);

    if (cfg.sort === 'name') {
        const name = (b) => String(b.userData?.name ?? b.name ?? '');
        for (const group of buckets.values()) group.sort((a, b) => name(a).localeCompare(name(b)));
    }

    // Measure once — leafBox is the shared "how big is this thing" contract, and a Book's
    // page form makes every book the same size, so this is cheap and uniform.
    const boxes = new Map();
    const sizeOf = (book) => {
        if (!boxes.has(book)) {
            const b = leafBox(book);
            boxes.set(book, b.getSize(new THREE.Vector3()));
        }
        return boxes.get(book);
    };

    const placed = [];
    let x = 0;
    for (const [key, group] of buckets) {
        if (!group.length) continue;                     // an empty column takes no space
        const widest = Math.max(...group.map((b) => sizeOf(b).x));
        let y = 0;
        group.forEach((book, row) => {
            const size = sizeOf(book);
            // Column is centered on its own width; books hang downward from y = 0 so every
            // column shares a top edge regardless of depth.
            book.position.set(x + widest / 2, y - size.y / 2, -row * cfg.depthZ);
            y -= size.y + cfg.rowGap;
        });
        placed.push({ key, count: group.length, x: x + widest / 2 });
        x += widest + cfg.columnGap;
    }

    return { columns: placed };
}
