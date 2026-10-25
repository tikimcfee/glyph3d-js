/**
 * ActionPage — an agent sheet's DESCRIPTION page (the verso), composed at WORLD size.
 *
 * Book contain-fits each side of a sheet onto its page rect, which is right for content
 * (a file, an output) and wrong for the action call: fit as one block with its info rows,
 * a long command shrank the headline with it. An ActionPage owns its page instead. Its
 * cards (headline, call body, info rows) are sized by their owner in world units — row
 * heights chosen per card by fitTextStack — and stacked top-down from the page's
 * top-left margin. The page reports exactly the page rect as its layout box, so Book's
 * fit lands at scale 1 and every card keeps the size it was given.
 *
 * Overflow stays honest: when the stacked cards measure past the page (a body the
 * estimate under-counted, a card wider than the page), the box grows to the real extent
 * and Book's fit shrinks the whole page to contain it — never a clip, never a cut.
 *
 * Text sizing lives with the owner (AgentBooks); fitTextStack + wrapText are the shared
 * arithmetic — the verso's stack and the recto's one card size by the same rule.
 */

import * as THREE from 'three';
import { leafBox } from './layouts/nodeUtils.js';

/** A word longer than a row breaks after these (a path's `/`, a URL's `?&=`, `snake_case`,
 *  `kebab-case`, `a.b.c`) before it ever breaks mid-run. */
const WORD_BREAKS = /[^/\\\-_.,;:?&=|]*[/\\\-_.,;:?&=|]+|[^/\\\-_.,;:?&=|]+$/g;

/** Word-wrap `text` to `cols` codepoints per row; the whitespace a row breaks at becomes
 *  the break. A word that fits a row moves whole to the next. A word longer than a row
 *  (a path, a URL) starts where it stands and breaks after its separators (WORD_BREAKS),
 *  inside a run only when the run alone is wider than a row. Wraps, never cuts — every
 *  word's every codepoint stays. Pure. */
export function wrapText(text, cols) {
    const c = Math.max(1, Math.floor(cols));
    const out = [];
    const flush = (row) => out.push(row.join('').trimEnd());
    for (const line of String(text ?? '').split('\n')) {
        let row = [];
        for (const tok of line.split(/(\s+)/)) {
            if (!tok) continue;
            const t = [...tok];
            if (row.length + t.length <= c) { row.push(...t); continue; }
            if (!/\S/.test(tok)) { flush(row); row = []; continue; }
            if (t.length <= c) { flush(row); row = t; continue; }
            for (const piece of tok.match(WORD_BREAKS) ?? [tok]) {
                let p = [...piece];
                if (row.length + p.length <= c) { row.push(...p); continue; }
                if (row.length) { flush(row); row = []; }
                while (p.length > c) { out.push(p.slice(0, c).join('')); p = p.slice(c); }
                row = p;
            }
        }
        flush(row);
    }
    return out.join('\n');
}

/** The smallest share of its configured size a block is set at. Not a taste floor: a stack
 *  whose fixed gaps alone overfill the page would otherwise ask for a zero row height (a
 *  zero-scale card). There the page overflows instead, and Book's fit shrinks it whole. */
const MIN_SHARE = 1e-3;

/**
 * @typedef {Object} TextBlock
 * @property {string} text
 * @property {number} size          its configured row height (world units) — its natural size
 * @property {'wrap'|'natural'} brk wrap to the page width, or only the text's own newlines
 * @property {boolean} [words]      wrap counts WORD-wrapped rows (wrapText — the caller sets
 *                                  the text through it); otherwise the fold's slot wrap
 *                                  (ceil(codepoints / cols) per source line)
 * @property {number} [extraRows]   rows the card adds beyond its text (a filename header)
 */

/**
 * Size text blocks stacked on one page by the ONE rule: a block's natural row height is
 * its configured `size`; if it doesn't fit, it SCALES DOWN to fit — never up past `size`.
 *
 *   natural — only the text's own newlines: a line wider than the page shrinks ITS block
 *             until the line fits the width (left to right, one row per source line).
 *   wrap    — rows wrap to the page width at the block's row height, so a wrapped block
 *             always spans the width at its size; it shrinks only for height.
 *
 * Height is the page's, shared: when the stack (rows × row heights + the `gap` between
 * blocks) is taller than `innerH`, every block takes the same factor k < 1 — their ratios
 * hold — the largest k at which the stack fits. A wrapped block re-wraps wider as it
 * shrinks (rows × row height only grows with k, so k is a bisection). A null block is
 * absent (no rows, no gap). Pure.
 * @param {Array<TextBlock|null>} blocks
 * @param {{innerW:number, innerH:number, gap?:number, advPerLh:number}} o
 *   advPerLh — one cell's advance per unit of row height (atlas metrics: charAdvance ÷
 *   lineSpacing)
 * @returns {Array<{lh:number, cols:number, rows:number}|null>} per block: its row height,
 *   its wrap columns (0 = natural — no wrap), and its rows (extraRows included)
 */
export function fitTextStack(blocks, { innerW, innerH, gap = 0, advPerLh }) {
    if (!(advPerLh > 0)) throw new Error(`fitTextStack: advPerLh must be > 0 (got ${advPerLh})`);
    const W = Math.max(innerW, 1e-6);
    const live = blocks.map((b) => {
        if (!b) return null;
        if (!(b.size > 0)) throw new Error(`fitTextStack: a block's size must be > 0 (got ${b.size})`);
        const text = String(b.text ?? '');
        const lens = text.split('\n').map((l) => [...l].length);
        const extra = b.extraRows ?? 0;
        if (b.brk === 'natural') {
            const widest = lens.reduce((m, n) => Math.max(m, n), 1);
            return { base: Math.min(b.size, W / (widest * advPerLh)), rowsAt: () => lens.length + extra, natural: true };
        }
        const memo = new Map();
        const rowsAt = (cols) => {
            let r = memo.get(cols);
            if (r == null) {
                r = extra;
                if (b.words) r += wrapText(text, cols).split('\n').length;
                else for (const n of lens) r += Math.max(1, Math.ceil(n / cols));
                memo.set(cols, r);
            }
            return r;
        };
        return { base: b.size, rowsAt, natural: false };
    });
    const gaps = Math.max(0, live.filter(Boolean).length - 1) * gap;
    const sized = (k) => live.map((p) => {
        if (!p) return null;
        const lh = p.base * k;
        const cols = p.natural ? 0 : Math.max(1, Math.floor(W / (advPerLh * lh) + 1e-9));
        return { lh, cols, rows: p.rowsAt(cols) };
    });
    const height = (out) => gaps + out.reduce((h, s) => h + (s ? s.rows * s.lh : 0), 0);
    const full = sized(1);
    if (height(full) <= innerH) return full;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (height(sized(mid)) <= innerH) lo = mid; else hi = mid;
    }
    return sized(Math.max(lo, MIN_SHARE));
}

export default class ActionPage extends THREE.Group {
    constructor() {
        super();
        this.name = 'action-page';
        this.userData = { isActionPage: true };
        /** @type {THREE.Object3D[]} the cards, top to bottom */
        this.parts = [];
        this._box = new THREE.Box3();
        this._tmp = new THREE.Box3();
    }

    /** Set the stacked cards (top to bottom; nulls skipped). Cards leaving are detached,
     *  not disposed — their owner holds them. */
    setParts(parts) {
        const next = parts.filter(Boolean);
        for (const p of this.parts) if (!next.includes(p)) this.remove(p);
        for (const p of next) if (p.parent !== this) this.add(p);
        this.parts = next;
        return this;
    }

    /**
     * Stack the cards top-down from the page's top-left margin, each at its own scale,
     * `gap` apart, and state the layout box: the page rect, grown to any overflow.
     * @param {{pageW:number, pageH:number, margin:number, gap:number}} o
     * @returns {this}
     */
    arrange({ pageW, pageH, margin, gap }) {
        const left = -pageW / 2 + margin;
        let top = pageH / 2 - margin;
        this._box.min.set(-pageW / 2, -pageH / 2, 0);
        this._box.max.set(pageW / 2, pageH / 2, 0);
        for (const card of this.parts) {
            card.position.set(0, 0, 0);
            card.updateMatrix();
            const b = this._tmp.copy(leafBox(card)).applyMatrix4(card.matrix);
            if (b.isEmpty()) continue;
            card.position.set(left - b.min.x, top - b.max.y, 0);
            card.updateMatrix();
            this._box.union(this._tmp.copy(leafBox(card)).applyMatrix4(card.matrix));
            top -= (b.max.y - b.min.y) + gap;
        }
        this._box.min.z = 0;
        this._box.max.z = 0;
        return this;
    }

    /** The page rect (grown to overflow) — Book's fit reads this through leafBox. */
    layoutBounds() { return this._box.clone(); }
}
