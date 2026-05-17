/**
 * Center — place a single child so its CENTER anchor sits on
 * the Center's local origin.
 *
 *     scene.add(Center(welcome));
 *
 * Add the Center to the scene wherever you want "centered" to mean
 * (typically at the world origin / camera lookAt). The child's
 * geometric centroid will land exactly there.
 */

import Layout from './Layout.js';
import { measureLocalBounds } from './measure.js';
import { Anchor, anchorPoint } from './anchor.js';

class CenterContainer extends Layout {
    constructor(child, { anchor = Anchor.CENTER } = {}) {
        super();
        this.name = 'Center';
        this._childAnchor = anchor;
        if (child) this.add(child);
    }

    _layoutSelf() {
        const child = this.children[0];
        if (!child) return;
        const box = measureLocalBounds(child);
        const p = anchorPoint(this._childAnchor, box);
        // Negate so the child's anchor point lands on (0,0,0).
        child.position.set(-p.x, -p.y, -p.z);
    }
}

/**
 * Functional form so call sites read top-to-bottom as a layout DSL.
 * @param {THREE.Object3D} child
 * @param {Object} [opts]
 * @returns {CenterContainer}
 */
export default function Center(child, opts) {
    return new CenterContainer(child, opts);
}
