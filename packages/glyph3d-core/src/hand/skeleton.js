/**
 * The reference hand: each finger-chain bone's length as a ratio of the palm length S
 * (wrist → middle MCP, MediaPipe keypoints), for an adult hand — HandSim's skeleton.
 *
 * It is only a PRIOR: HandModel's bones are S × ratio × (1 + δ), with each bone's own
 * deviation δ admitted as its evidence grows (the hierarchy Meta's trackers and Remelli use: one
 * scale on a reference skeleton first, the per-bone refinements after). A warm start replaces
 * these ratios with the user's own; this table is for a browser that has never seen a hand.
 * Ratios vary across people far less than size does, so a wrong-sized hand still starts close.
 */
export const REFERENCE_RATIOS = {
    '0-1': 0.4134, '1-2': 0.4778, '2-3': 0.3692, '3-4': 0.3041,
    '0-5': 0.9905, '5-6': 0.4344, '6-7': 0.2606, '7-8': 0.2172,
    '0-9': 1, '9-10': 0.4887, '10-11': 0.3041, '11-12': 0.228,
    '0-13': 0.9462, '13-14': 0.4561, '14-15': 0.2932, '15-16': 0.228,
    '0-17': 0.8671, '17-18': 0.3584, '18-19': 0.2063, '19-20': 0.1955,
};

/**
 * Flexion limits per joint, degrees, as [min, max] of the angle a bone turns toward the palm
 * from its parent bone (negative = hyperextension). Index: the CHILD joint of the bend —
 * e.g. 6 (PIP) carries the MCP's flexion. Lin et al. 2000's static constraints, a little
 * generous; the thumb is looser (its frame isn't the fingers').
 */
export const FLEX_LIMITS = (() => {
    const L = {};
    for (const base of [5, 9, 13, 17]) {
        L[base + 1] = [-20, 90];   // MCP
        L[base + 2] = [-10, 110];  // PIP
        L[base + 3] = [-10, 90];   // DIP
    }
    L[2] = [-30, 70]; L[3] = [-30, 80]; L[4] = [-30, 90]; // thumb CMC→MCP, MCP, IP
    return L;
})();
