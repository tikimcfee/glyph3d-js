/**
 * ContentTree layout schemes — pluggable, pure, tree-resident (measure post-order,
 * place pre-order, children in the node's LOCAL frame, origin = footprint top-center).
 * A scheme is a lens on the project's shape: the walk-tree is a stairway you descend,
 * the district is a city map you read by containment. The LAYOUT_SCHEMES registry is
 * what the layout.scheme verb and the Layout panel enumerate.
 */

import walkTreeLayout, { WALK_DEFAULTS } from './walkTreeLayout.js';
import districtLayout, { DISTRICT_DEFAULTS } from './districtLayout.js';
import packedLayout, { PACKED_DEFAULTS } from './packedLayout.js';
import jellyfishLayout, { JELLYFISH_DEFAULTS } from './jellyfishLayout.js';

export { flowBoxes, squareWrap } from './flowBoxes.js';
export { childSort, leafBox } from './nodeUtils.js';
export { default as StackContainer, VStack, HStack, ZStack } from './StackContainer.js';
export { walkTreeLayout, districtLayout, packedLayout, jellyfishLayout };
export { WALK_DEFAULTS, DISTRICT_DEFAULTS, PACKED_DEFAULTS, JELLYFISH_DEFAULTS };

/** name → scheme function. Order here is presentation order (packed = the default). */
export const LAYOUT_SCHEMES = {
    packed: packedLayout,
    walk: walkTreeLayout,
    district: districtLayout,
    jellyfish: jellyfishLayout,
};

/** Reverse lookup for reporting: the registry name of a scheme fn, or null if custom. */
export function schemeNameOf(fn) {
    for (const [name, scheme] of Object.entries(LAYOUT_SCHEMES)) {
        if (scheme === fn) return name;
    }
    return null;
}
