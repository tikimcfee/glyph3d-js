/**
 * Hand Tracking Defaults
 *
 * Centralized default values for all hand tracking components.
 * Library consumers can override these via constructor options.
 * The example app's config.js provides tuned overrides for the demo.
 */

export const HAND_RENDERER_DEFAULTS = {
    lineColor:  0x00ff88,
    jointColor: 0x00ffcc,
    jointSize:  0.006,
    boneRadius: 0.003,
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

export const WEBSOCKET_SOURCE_DEFAULTS = {
    url:               'ws://localhost:8080',
    reconnectInterval: 3000,
};
