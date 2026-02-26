/**
 * Hand Tracking Tuning Config
 *
 * Single source of truth for all tunable parameters.
 * Edit values here — sliders and app both read from this.
 */

const CONFIG = {
    // Default input source: 'mock' | 'webcam' | 'websocket'
    source: 'websocket',

    // Hand renderer
    spread:     0.45,
    depth:      -1.85,
    scale:      1.40,
    boneRadius: 0.01,
    jointSize:  0.01,
    lineColor:  0x00ff88,
    jointColor: 0x00ffcc,

    // Perspective mode
    firstPerson: true,  // true = first-person (knuckles toward you), false = mirror

    // Webcam depth estimation
    refSpan:    0.17,
    depthScale: 13.10,

    // Slider ranges (min, max, step)
    ranges: {
        spread:     [0.1,   2.0,  0.05],
        depth:      [-5.0,  1.0,  0.05],
        scale:      [0.1,   3.0,  0.05],
        refSpan:    [0.01,  0.5,  0.01],
        depthScale: [-30.0, 30.0, 0.1],
        boneRadius: [0.001, 0.02, 0.001],
        jointSize:  [0.002, 0.02, 0.001],
    },
};

export default CONFIG;
