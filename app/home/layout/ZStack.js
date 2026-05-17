/**
 * ZStack — depth flow container.
 *
 *     ZStack({ gap: 30, direction: 'toward' }, [back, middle, front])
 *
 * Stacks children along Z. First child placed at z=0, subsequent
 * children either step toward the camera (positive Z, default) or
 * away (negative Z). XY is preserved per child — ZStack only touches
 * z. Cross-axis alignment isn't a thing here; if you want to also
 * center children horizontally inside a ZStack, wrap each child in
 * a Center first.
 *
 * Use ZStack for layered effects — receding panels, lifted-up
 * call-to-action elements, parallax-friendly groupings. Depth IS
 * a layout choice; this primitive makes it composable.
 */

import Layout from './Layout.js';
import { measureLocalBounds } from './measure.js';
import { SpacerLayout } from './Spacer.js';

const DIRS = {
    toward: +1,   // each next child sits in front of the previous one
    away:   -1,   // each next child recedes
};

class ZStackContainer extends Layout {
    constructor({ gap = 0, direction = 'toward' } = {}, children = []) {
        super();
        this.name = 'ZStack';
        this._gap = gap;
        this._dir = DIRS[direction] ?? DIRS.toward;
        for (const ch of children) this.add(ch);
    }

    _layoutSelf() {
        const items = this.children.map(c => {
            if (c instanceof SpacerLayout) return { kind: 'spacer', node: c, depth: c.size };
            const box = measureLocalBounds(c);
            return {
                kind: 'item',
                node: c,
                box,
                depth: Math.max(0, box.max.z - box.min.z),
            };
        });

        let cursor = 0;
        let first = true;
        for (const it of items) {
            if (!first) cursor += this._dir * this._gap;
            first = false;

            if (it.kind === 'spacer') {
                cursor += this._dir * it.depth;
                continue;
            }

            // Place the child's back face (min.z) at cursor when going
            // away, front face (max.z) at cursor when going toward.
            // The asymmetry matches intent: "stack toward me" should
            // visibly march toward the camera.
            const ref = this._dir > 0 ? it.box.min.z : it.box.max.z;
            it.node.position.z = cursor - ref;

            cursor += this._dir * Math.max(it.depth, 0.001);
        }
    }
}

export default function ZStack(opts, children) {
    return new ZStackContainer(opts, children);
}
