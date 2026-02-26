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
    spread:     0.4,
    depth:      -0.8,
    scale:      0.5,
};

export const WEBCAM_SOURCE_DEFAULTS = {
    detectInterval: 66,   // ~15fps detection throttle
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
    url:               'ws://localhost:8765',
    reconnectInterval: 3000,
};
