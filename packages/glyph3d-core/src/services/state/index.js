/**
 * State barrel - file state management, diff parsing, persistence
 */
export { FileStateManager } from './FileStateManager.js';
export { parsePatchAligned, buildAlignedDiff, getDiffColor } from './DiffParser.js';
export { StateController, stateController } from './StateController.js';
