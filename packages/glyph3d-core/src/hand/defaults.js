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
    // Placement — anchor and shape are separate dials.
    // Units are NEAR-PLANE multiples: HandPresence scales the camera rig by
    // camera.near each frame, so |depth| must exceed 1 to clear the near plane
    // (with margin for the hand's own extent), at ANY near setting.
    //
    // TRAVERSAL: the wrist anchor maps the device's tracking range onto the
    // visible canvas rect at `depth` (HandPresence feeds the frustum extent per
    // frame). `coverage` multiplies that rect — 1 sweeps edge to edge, below 1
    // underwraps (hand stays inside the frame), above 1 overwraps (reaches past
    // the edges). SIZE: spread × scale governs the skeleton around its anchor.
    spread:     0.4,    // base visual spread multiplier
    depth:      -1.6,   // z position in camera-local space, in units of camera.near
    scale:      1.0,    // combined with spread for uniform hand size
    coverage:   1.0,    // fraction of the visible canvas the anchor traverses
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

