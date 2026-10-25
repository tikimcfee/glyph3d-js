/**
 * ActionPage — an agent sheet's DESCRIPTION page (the verso), composed at WORLD size.
 *
 * Book contain-fits each side of a sheet onto its page rect, which is right for content
 * (a file, an output) and wrong for the action call: fit as one block with its info rows,
 * a long command shrank the headline with it. An ActionPage owns its page instead. Its
 * cards (headline, call body, info rows) are sized by their owner in world units — line
 * heights chosen per card, text WRAPPED to the page width — and stacked top-down from
 * the page's top-left margin. The page reports exactly the page rect as its layout box,
 * so Book's fit lands at scale 1 and every card keeps the size it was given.
 *
 * Overflow stays honest: when the stacked cards measure past the page (a body the
 * estimate under-counted, a card wider than the page), the box grows to the real extent
 * and Book's fit shrinks the whole page to contain it — never a clip, never a cut.
 *
 * Text sizing lives with the owner (AgentBooks); fitTextBlock is the shared arithmetic.
 */

import * as THREE from 'three';
import { leafBox } from './layouts/nodeUtils.js';

/**
 * The largest line height (≤ maxLh, stepping down, floored at minLh) at which `text`,
 * wrapped to the columns that fit `innerW`, stacks within `availH`. Rows are estimated
 * per source line as ceil(codepoints / cols) — the fold wraps by slot count, so this is
 * the fold's own arithmetic for single-width text (the page's measured arrange catches
 * the rest). Pure.
 * @param {string} text
 * @param {{innerW:number, availH:number, maxLh:number, minLh:number,
 *          advPerLh:number, extraRows?:number, step?:number}} o
 *   advPerLh — one cell's advance per unit of line height (atlas metrics: charAdvance ÷
 *   lineSpacing); extraRows — rows the card adds beyond its text (a filename header).
 * @returns {{lh:number, cols:number, rows:number}}
 */
export function fitTextBlock(text, { innerW, availH, maxLh, minLh, advPerLh, extraRows = 0, step = 0.92 }) {
    if (!(advPerLh > 0)) throw new Error(`fitTextBlock: advPerLh must be > 0 (got ${advPerLh})`);
    const lens = String(text ?? '').split('\n').map((l) => [...l].length);
    const top = Math.max(maxLh, 1e-6);
    const floor = Math.min(Math.max(minLh, 1e-6), top);
    let lh = top;
    for (;;) {
        const cols = Math.max(1, Math.floor(innerW / (advPerLh * lh)));
        let rows = extraRows;
        for (const n of lens) rows += Math.max(1, Math.ceil(n / cols));
        if (rows * lh <= availH || lh <= floor) return { lh, cols, rows };
        lh = Math.max(floor, lh * step);
    }
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
