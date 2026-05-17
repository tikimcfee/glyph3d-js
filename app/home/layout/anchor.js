/**
 * Anchor — a normalized point inside an axis-aligned bounding box.
 *
 * Each anchor is a triple in [0, 1]³ where (0,0,0) is the box's minimum
 * corner and (1,1,1) is its maximum. CENTER is (0.5, 0.5, 0.5).
 *
 * Layout containers use anchors to answer: "where on this object should
 * I treat as its handle when placing it?" — e.g. positioning a
 * cluster's TOP_CENTER at the parent's local origin.
 *
 * The vertical axis follows the screen convention (TOP > BOTTOM in Y),
 * not THREE's world convention. So TOP_CENTER's `y` is 1, BOTTOM's is 0.
 */

export const Anchor = Object.freeze({
    TOP_LEFT:      Object.freeze({ x: 0,   y: 1,   z: 0.5 }),
    TOP_CENTER:    Object.freeze({ x: 0.5, y: 1,   z: 0.5 }),
    TOP_RIGHT:     Object.freeze({ x: 1,   y: 1,   z: 0.5 }),
    LEFT:          Object.freeze({ x: 0,   y: 0.5, z: 0.5 }),
    CENTER:        Object.freeze({ x: 0.5, y: 0.5, z: 0.5 }),
    RIGHT:         Object.freeze({ x: 1,   y: 0.5, z: 0.5 }),
    BOTTOM_LEFT:   Object.freeze({ x: 0,   y: 0,   z: 0.5 }),
    BOTTOM_CENTER: Object.freeze({ x: 0.5, y: 0,   z: 0.5 }),
    BOTTOM_RIGHT:  Object.freeze({ x: 1,   y: 0,   z: 0.5 }),
    // Depth-aware anchors. Use when you want the front face or back face
    // of a 3D-extruded element to be the reference point.
    CENTER_FRONT:  Object.freeze({ x: 0.5, y: 0.5, z: 1   }),
    CENTER_BACK:   Object.freeze({ x: 0.5, y: 0.5, z: 0   }),
});

/**
 * Resolve an anchor against a Box3, returning the world-equivalent point
 * inside the box.
 *
 * @param {{x:number,y:number,z:number}} anchor   normalized 0..1
 * @param {import('three').Box3} box              the bounding box
 * @returns {{x:number,y:number,z:number}}
 */
export function anchorPoint(anchor, box) {
    const sx = box.max.x - box.min.x;
    const sy = box.max.y - box.min.y;
    const sz = box.max.z - box.min.z;
    return {
        x: box.min.x + sx * anchor.x,
        y: box.min.y + sy * anchor.y,
        z: box.min.z + sz * anchor.z,
    };
}
