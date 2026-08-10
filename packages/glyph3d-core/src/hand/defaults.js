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
    // Placement — applied to group transform (uniform, no per-axis distortion).
    // Units are NEAR-PLANE multiples: HandPresence scales the camera rig by
    // camera.near each frame, so |depth| must exceed 1 to clear the near plane
    // (with margin for the hand's own extent), at ANY near setting.
    spread:     0.4,    // base visual spread multiplier
    depth:      -1.6,   // z position in camera-local space, in units of camera.near
    scale:      1.0,    // combined with spread for uniform group scale
    // Yaw about the hand's own Y axis, in DEGREES (a human-tuned dial, so human
    // units). 180 turns the palms away from the viewer: the device sees your palm,
    // so unrotated hands face you like someone else's. Rotated, they read as your
    // own hands reaching into the scene — a spatial proxy rather than a mirror.
    // A rotation, not a mirror, so chirality is preserved.
    yaw:        180,
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

