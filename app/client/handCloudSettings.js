// Settings ▸ Hand cloud — every knob of the LiDAR hand tracker (core hand/cloud) and its
// in-scene view, live on ctx.handCloud. Wide ranges: clamp only what would break.

import { HAND_CLOUD_DEFAULTS, CLOUD_VIEW_DEFAULTS } from '@glyph3d/core/hand/cloud/index.js';

/** [key, label, min, max, step] — a missing min marks a bool. */
const TRACKER_KNOBS = [
    ['ceilingMargin', 'Segment: background within (m) of the ceiling', 0, 2, 0.01],
    ['maxHandZ', 'Segment: the hand is nearer than (m)', 0.05, 5, 0.01],
    ['minHandZ', 'Segment: … and farther than (m)', 0, 0.5, 0.005],
    ['minConf', 'Segment: keep sensor confidence ≥ (0–2)', 0, 2, 1],
    ['jumpAbs', 'Segment: one surface while depth jumps < (m)', 0.0005, 0.1, 0.0005],
    ['jumpRel', 'Segment: … + this × depth', 0, 0.5, 0.005],
    ['minSupport', 'Segment: flying unless neighbours on its surface ≥', 0, 8, 1],
    ['minBlobPx', 'Segment: smallest hand blob (px)', 1, 100000, 10],
    ['armCut', 'Segment: forearm starts behind the wrist by (m)', -0.05, 0.1, 0.001],
    ['armCutK', 'Segment, no Vision: forearm behind the palm centre (× its radius)', 0, 10, 0.05],
    ['palmSearch', 'Palm: look for its centre within (m) of Vision’s', 0.005, 0.3, 0.005],
    ['palmRegionK', 'Palm: plane region (× inscribed radius)', 0.1, 5, 0.05],
    ['ransacIters', 'Palm: RANSAC iterations', 1, 1000, 1],
    ['ransacThresh', 'Palm: RANSAC inlier within (m)', 0.0005, 0.05, 0.0005],
    ['palmMinInliers', 'Palm: inliers needed', 3, 100000, 1],
    ['geoSmooth', 'Tips: smooth the surface walked over (px radius)', 0, 6, 1],
    ['geoStride', 'Tips: walk every Nth pixel', 1, 8, 1],
    ['tipMinGeo', 'Tips: at least (m of surface) from the palm', 0, 0.3, 0.005],
    ['tipMinSep', 'Tips: stop when the farthest is within (m)', 0.002, 0.2, 0.001],
    ['tipMax', 'Tips: at most', 0, 20, 1],
    ['tipMatch', 'Tips: named by a Vision tip ray within (m)', 0.001, 0.2, 0.001],
    ['edgePx', 'Tips: clipped within (px) of the image edge', 0, 20, 1],
    ['edgeAlertPx', 'View: the hand is at the edge with ≥ this many pixels on the border', 1, 10000, 1],
    ['holeMinArea', 'Pinch: hole of at least (m²)', 0, 0.01, 0.00001],
    ['holeMinBgFrac', 'Pinch: hole that measured background (fraction)', 0, 1, 0.05],
    ['pinchClose', 'Pinch: closed, tips within (m)', 0, 0.2, 0.001],
    ['pinchOpen', 'Pinch: open, tips beyond (m)', 0, 0.3, 0.001],
    ['lmIters', 'Fit: Levenberg–Marquardt iterations', 0, 50, 1],
    ['lmLambda', 'Fit: initial damping', 1e-7, 10, 1e-4],
    ['maxSamples', 'Fit: hand points per iteration', 10, 20000, 10],
    ['corrMax', 'Fit: outlier beyond (m) of every capsule', 0.001, 0.2, 0.001],
    ['huber', 'Fit: data residual counts linearly beyond (m)', 0.0005, 0.05, 0.0005],
    ['wData', 'Fit: data weight', 0, 10, 0.05],
    ['wTemporal', "Fit: last frame's angles weight", 0, 1, 0.0005],
    ['wLimit', 'Fit: joint-limit weight', 0, 10, 0.01],
    ['reinitRms', 'Fit: re-solve from Vision when the residual exceeds (m) …', 0.0005, 0.1, 0.0005],
    ['reinitK', 'Fit: … or this × the hand\'s running median residual', 1, 10, 0.05],
    ['reinitWindow', 'Fit: … over its last N fits', 5, 1000, 1],
    ['wRay', 'Fit: Vision ray weight', 0, 10, 0.05],
    ['wVisionPoint', 'Fit: Vision depth pull', 0, 2, 0.05],
    ['visionSkin', 'Fit: Vision points are skin'],
    ['wTip', 'Fit: named tip pull', 0, 2, 0.05],
    ['wFree', 'Fit: free-space push', 0, 2, 0.05],
    ['freeK', 'Fit: … behind the surface by (× radius)', 0, 3, 0.05],
    ['wSil', 'Fit: silhouette pull', 0, 2, 0.05],
    ['silSearch', 'Fit: silhouette search (px)', 0, 100, 1],
    ['kPlane', 'Fit: palm onto its plane', 0, 1, 0.05],
    ['palmRadius', 'Body: palm half-thickness (m)', 0.002, 0.05, 0.0005],
    ['abduction', 'Limits: finger spread either side (°)', 0, 90, 1],
    ['supportMin', 'Fit: a joint is "cloud" with ≥ points', 0, 1000, 1],
    ['supportFull', 'Fit: … fully confident with ≥ points', 1, 10000, 1],
    ['prevMaxAge', 'Fit: start from last frame if younger than (s)', 0, 2, 0.01],
    ['outputSkin', 'Output: skin points (else joint centres)'],
];

const VIEW_KNOBS = [
    ['fraction', 'View: height (fraction of the canvas)', 0.05, 1, 0.01],
    ['aspect', 'View: width / height', 0.3, 4, 0.05],
    ['margin', 'View: margin from the top-left corner (px)', 0, 400, 1],
    ['span', 'View: metres of desk across its height', 0.02, 2, 0.01],
    ['stride', 'View: draw every Nth pixel', 1, 16, 1],
    ['pointPx', 'View: point size (px)', 0.5, 20, 0.5],
    ['follow', 'View: follow the palm (easing per frame; 0 = phone at the centre)', 0, 1, 0.05],
];

export const HAND_CLOUD_SETTINGS = [
    {
        key: 'hand.cloudView.visible', label: 'View: shown (picture-in-picture, top left)', group: 'Hand cloud', type: 'bool', default: false,
        apply: (ctx, v) => ctx.handCloud?.view.setVisible(v),
    },
    ...TRACKER_KNOBS.map(([k, label, min, max, step]) => ({
        key: `hand.cloud.${k}`, label, group: 'Hand cloud', default: HAND_CLOUD_DEFAULTS[k],
        ...(min == null ? { type: 'bool' } : { type: 'number', min, max, step }),
        apply: (ctx, v) => ctx.handCloud?.set(k, v),
    })),
    ...VIEW_KNOBS.map(([k, label, min, max, step]) => ({
        key: `hand.cloudView.${k}`, label, group: 'Hand cloud', type: 'number',
        default: CLOUD_VIEW_DEFAULTS[k], min, max, step,
        apply: (ctx, v) => { if (ctx.handCloud) { ctx.handCloud.view.place[k] = v; ctx.handCloud.view.refresh(); } },
    })),
];
