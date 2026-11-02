/**
 * cloudBody — the hand body the cloud tracker fits: joint groups, the default adult palm
 * template and bone lengths, the sphere-capsules (radii from the tracker's knobs), and the
 * palm template stretched to a hand's learned bones. Shared by the tracker's stages and its
 * solver.
 *
 * Pure: no DOM, no Three.js.
 */

import { Joint, JOINT_COUNT } from '../HandData.js';
import { v3, scale, len, boneKey } from '../handMath.js';

/** A crop pixel's class after segmentation (NEAR: not yet decided). */
export const CLS = { NONE: 0, BG: 1, FLY: 2, OTHER: 3, ARM: 4, HAND: 5, NEAR: 6 };
export const CLS_NAMES = ['none', 'bg', 'fly', 'other', 'arm', 'hand'];

export const PALM_SET = [Joint.WRIST, Joint.THUMB_CMC, Joint.INDEX_MCP, Joint.MIDDLE_MCP, Joint.RING_MCP, Joint.PINKY_MCP];
export const MCPS = [Joint.INDEX_MCP, Joint.MIDDLE_MCP, Joint.RING_MCP, Joint.PINKY_MCP];
export const TIP_JOINTS = [Joint.THUMB_TIP, Joint.INDEX_TIP, Joint.MIDDLE_TIP, Joint.RING_TIP, Joint.PINKY_TIP];

/** The default adult right hand, hand-local (wrist origin, +y fingers, +x toward the pinky), m. */
export const PALM_TEMPLATE = {
    [Joint.WRIST]: v3(0, 0, 0),
    [Joint.THUMB_CMC]: v3(-0.018, 0.030, -0.015),
    [Joint.INDEX_MCP]: v3(-0.024, 0.088, 0),
    [Joint.MIDDLE_MCP]: v3(-0.004, 0.092, 0),
    [Joint.RING_MCP]: v3(0.014, 0.086, 0),
    [Joint.PINKY_MCP]: v3(0.030, 0.074, 0),
};

/** Default adult bone lengths (chain bones), m. */
export const DEFAULT_BONES = (() => {
    const b = {};
    const P = { [Joint.INDEX_MCP]: [0.040, 0.024, 0.020], [Joint.MIDDLE_MCP]: [0.045, 0.028, 0.021], [Joint.RING_MCP]: [0.042, 0.027, 0.021], [Joint.PINKY_MCP]: [0.033, 0.019, 0.018] };
    for (const m of MCPS) { b[boneKey(0, m)] = len(PALM_TEMPLATE[m]); P[m].forEach((L, k) => { b[boneKey(m + k, m + k + 1)] = L; }); }
    b[boneKey(0, 1)] = len(PALM_TEMPLATE[Joint.THUMB_CMC]);
    [0.044, 0.034, 0.028].forEach((L, k) => { b[boneKey(1 + k, 2 + k)] = L; });
    return b;
})();

/** A bone's length: the learned one, else the adult default. @param {Record<string, number>} bones */
export const boneLength = (bones) => (a, b) => bones[boneKey(a, b)] ?? DEFAULT_BONES[boneKey(a, b)];

/** The capsules the fit explains the cloud with: [joint a, joint b, radius]. @param {{palmRadius: number, fingerRadius: number[], thumbRadius: number[]}} o */
export function bodyOf(o) {
    const pr = o.palmRadius;
    const caps = [];
    for (const m of MCPS) caps.push([Joint.WRIST, m, pr]);
    caps.push([Joint.WRIST, Joint.THUMB_CMC, pr], [Joint.THUMB_CMC, Joint.INDEX_MCP, pr]);
    for (let i = 0; i < 3; i++) caps.push([MCPS[i], MCPS[i + 1], pr]);
    for (const m of MCPS) for (let k = 0; k < 3; k++) caps.push([m + k, m + k + 1, o.fingerRadius[k]]);
    for (let k = 0; k < 3; k++) caps.push([1 + k, 2 + k, o.thumbRadius[k]]);
    return caps;
}

/** Each joint's body radius (its largest capsule's). */
export function jointRadii(o) {
    const r = new Array(JOINT_COUNT).fill(o.palmRadius);
    for (const m of MCPS) for (let k = 1; k <= 3; k++) r[m + k] = o.fingerRadius[k - 1];
    for (let k = 2; k <= 4; k++) r[k] = o.thumbRadius[k - 2];
    return r;
}

/**
 * The palm template for this hand: the default shape with each joint's distance from the wrist
 * stretched to the learned bone, mirrored for a left hand.
 */
export function palmTemplate(bones, handedness) {
    const mir = handedness === 'left' ? -1 : 1;
    const T = {};
    for (const j of PALM_SET) {
        const d = PALM_TEMPLATE[j];
        const L0 = len(d);
        const L = j === Joint.WRIST ? 0 : (bones[boneKey(0, j)] ?? L0);
        T[j] = L0 > 0 ? scale(v3(d.x * mir, d.y, d.z), L / L0) : v3();
    }
    return T;
}
