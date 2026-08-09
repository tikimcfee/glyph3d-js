/**
 * Hand Tracking Defaults
 *
 * Centralized default values for all hand tracking components.
 * Library consumers override these via constructor options.
 */

export const HAND_RENDERER_DEFAULTS = {
    lineColor:  0x00ff88,
    jointColor: 0x00ffcc,
    // Joint/bone radii are in hand-LOCAL units, so the group scale below shrinks
    // them too: at scale 0.2 a 0.006 joint is 0.0012 world units — under 3px on a
    // 1080p canvas, and bones at 0.003 land sub-pixel. Sized here so a hand reads
    // as a skeleton on arrival; tune live with `hand.place jointSize <n>`.
    jointSize:  0.018,
    boneRadius: 0.009,
    // Placement — applied to group transform (uniform, no per-axis distortion):
    spread:     0.4,    // base visual spread multiplier
    depth:      -0.8,   // z position in camera-local space
    scale:      0.5,    // combined with spread for uniform group scale
};

export const WEBCAM_SOURCE_DEFAULTS = {
    detectInterval: 33,   // ~30fps detection throttle
    numHands:       1,
    referenceSpan:  0.2,
    depthScale:     7.0,
    firstPerson:    true,
};

export const GESTURE_DEFAULTS = {
    pinchThreshold:        0.06,
    pinchReleaseThreshold: 0.08,
};

