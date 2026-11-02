// The LiDAR hand cloud: the depth crop on the wire, a synthetic sensor with known truth, the
// staged tracker, its worker + page-side pipeline, and the in-scene stage view.
export {
    CLOUD_WIRE_V, DEPTH_UNIT, b64encode, b64decode, encodeDepthCloud, decodeDepthCloud, unprojectCloud, projectToCloud, pixelRay,
} from './depthWire.js';
export { default as DepthSim, DEPTH_SIM_DEFAULTS, PART, PART_NAMES, FACE_DOWN_TO_PHONE } from './DepthSim.js';
export {
    default as HandCloudTracker, HAND_CLOUD_DEFAULTS,
    segmentStage, palmStage, tipsStage, orientStage, holeStage, initStage, edgeStage, visionPrior,
} from './HandCloudTracker.js';
export { solveStage } from './cloudSolve.js';
export { CLS, CLS_NAMES, DEFAULT_BONES, PALM_TEMPLATE, bodyOf, jointRadii, palmTemplate } from './cloudBody.js';
export { default as CloudPipeline } from './CloudPipeline.js';
export { default as CloudView, CLOUD_VIEW_DEFAULTS, CLOUD_LAYERS } from './CloudView.js';
