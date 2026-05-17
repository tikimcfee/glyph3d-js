/**
 * VStack — vertical flow container.
 *
 *     VStack({ gap: 12, align: Anchor.CENTER }, [a, b, c])
 *
 * Children flow top-to-bottom: first child's TOP edge sits at y=0,
 * subsequent children descend (Y decreases). This matches the screen
 * mental model — first item is highest.
 *
 * Cross-axis alignment options (interpreted on the X axis):
 *   - Anchor.*_LEFT    → left-align
 *   - Anchor.CENTER    → center-align (default)
 *   - Anchor.*_RIGHT   → right-align
 */

import Layout from './Layout.js';
import { measureLocalBounds } from './measure.js';
import { Anchor } from './anchor.js';
import { SpacerLayout } from './Spacer.js';

class VStackContainer extends Layout {
    constructor({ gap = 0, align = Anchor.CENTER } = {}, children = []) {
        super();
        this.name = 'VStack';
        this._gap = gap;
        this._align = align;
        for (const ch of children) this.add(ch);
    }

    _layoutSelf() {
        const items = this.children.map(c => {
            if (c instanceof SpacerLayout) return { kind: 'spacer', node: c, height: c.size };
            const box = measureLocalBounds(c);
            return {
                kind: 'item',
                node: c,
                box,
                height: box.max.y - box.min.y,
            };
        });

        // Cross-axis (X) range across real items.
        let crossMin = +Infinity, crossMax = -Infinity;
        for (const it of items) {
            if (it.kind !== 'item') continue;
            if (it.box.min.x < crossMin) crossMin = it.box.min.x;
            if (it.box.max.x > crossMax) crossMax = it.box.max.x;
        }
        if (!isFinite(crossMin)) { crossMin = 0; crossMax = 0; }
        const crossWidth = crossMax - crossMin;
        const ax = this._align?.x ?? 0.5;

        // Cursor starts at 0 (top of stack), descends.
        let cursor = 0;
        let first = true;
        for (const it of items) {
            if (!first) cursor -= this._gap;
            first = false;

            if (it.kind === 'spacer') {
                cursor -= it.height;
                continue;
            }

            // Place top edge at cursor (top edge = box.max.y in child-local).
            it.node.position.y = cursor - it.box.max.y;

            const desiredX = crossMin + crossWidth * ax;
            const childAnchorX = it.box.min.x + (it.box.max.x - it.box.min.x) * ax;
            it.node.position.x = desiredX - childAnchorX;

            cursor -= it.height;
        }
    }
}

export default function VStack(opts, children) {
    return new VStackContainer(opts, children);
}
