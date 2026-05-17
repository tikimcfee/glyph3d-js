/**
 * HStack — horizontal flow container.
 *
 *     HStack({ gap: 24, align: Anchor.CENTER }, [a, b, c])
 *
 * Children are placed left-to-right starting at the HStack's own
 * local origin (its leftmost edge at x=0). Use `gap` for uniform
 * spacing between every pair, or insert a Spacer for a single
 * irregular gap.
 *
 * Cross-axis alignment options (interpreted on the Y axis):
 *   - Anchor.TOP_*    → align child tops
 *   - Anchor.CENTER   → align child centers (default)
 *   - Anchor.BOTTOM_* → align child bottoms
 *
 * Only the y component of `align` is read; the x component is
 * irrelevant in a horizontal stack.
 */

import Layout from './Layout.js';
import { measureLocalBounds } from './measure.js';
import { Anchor } from './anchor.js';
import { SpacerLayout } from './Spacer.js';

class HStackContainer extends Layout {
    constructor({ gap = 0, align = Anchor.CENTER } = {}, children = []) {
        super();
        this.name = 'HStack';
        this._gap = gap;
        this._align = align;
        for (const ch of children) this.add(ch);
    }

    _layoutSelf() {
        // First pass: measure all real children (Spacers don't measure).
        const items = this.children.map(c => {
            if (c instanceof SpacerLayout) return { kind: 'spacer', node: c, width: c.size };
            const box = measureLocalBounds(c);
            return {
                kind: 'item',
                node: c,
                box,
                width: box.max.x - box.min.x,
            };
        });

        // Cross-axis range across non-spacer children, so align can
        // honor the actual content height instead of zero.
        let crossMin = +Infinity, crossMax = -Infinity;
        for (const it of items) {
            if (it.kind !== 'item') continue;
            if (it.box.min.y < crossMin) crossMin = it.box.min.y;
            if (it.box.max.y > crossMax) crossMax = it.box.max.y;
        }
        if (!isFinite(crossMin)) { crossMin = 0; crossMax = 0; }
        const crossHeight = crossMax - crossMin;
        const crossCenter = (crossMin + crossMax) / 2;
        const ay = this._align?.y ?? 0.5;

        // Second pass: place children, advancing a cursor.
        let cursor = 0;
        let first = true;
        for (const it of items) {
            if (!first) cursor += this._gap;
            first = false;

            if (it.kind === 'spacer') {
                cursor += it.width;
                continue;
            }

            // Place left edge at cursor.
            it.node.position.x = cursor - it.box.min.x;

            // Cross-axis alignment. Compute desired child-anchor-y in
            // stack-local coords, then offset by the child's box.
            const desiredY = crossMin + crossHeight * ay;
            const childAnchorY = it.box.min.y + (it.box.max.y - it.box.min.y) * ay;
            it.node.position.y = desiredY - childAnchorY;

            // Don't touch z — let children declare their own depth.
            cursor += it.width;
        }
    }
}

/**
 * @param {{ gap?: number, align?: object }} opts
 * @param {THREE.Object3D[]} children
 */
export default function HStack(opts, children) {
    return new HStackContainer(opts, children);
}
