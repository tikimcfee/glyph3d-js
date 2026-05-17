/**
 * Spacer — invisible gap primitive for stack layouts.
 *
 *     HStack({ gap: 0 }, [
 *         welcome,
 *         Spacer(40),    // 40 world units of space, ignored on cross axis
 *         tryThis,
 *     ])
 *
 * The stack containers know to read `.size` and skip ordinary
 * measurement, so a Spacer contributes only to the flow direction.
 *
 * If you want uniform inter-child gaps, prefer the stack's own
 * `gap` option — Spacer is for when one gap should differ from
 * the rest, or when an explicit named element reads better than
 * an option.
 */

import * as THREE from 'three';
import Layout from './Layout.js';

class SpacerLayout extends Layout {
    constructor(size) {
        super();
        this.name = 'Spacer';
        this.size = size;
    }

    layoutBounds() {
        // Zero in all axes — the stack adds `size` to the flow axis on
        // its own. Returning zero keeps cross-axis alignment unaffected.
        return new THREE.Box3(
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0),
        );
    }
}

/**
 * @param {number} size  world units of space
 */
export default function Spacer(size) {
    return new SpacerLayout(size);
}

export { SpacerLayout };
