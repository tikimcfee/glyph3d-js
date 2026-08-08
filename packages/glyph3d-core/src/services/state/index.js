/**
 * State barrel - file state management, diff parsing, persistence
 */
export { FileStateManager } from './FileStateManager.js';
export { parsePatchAligned, buildAlignedDiff, getDiffColor } from './DiffParser.js';
export { splitUnifiedDiff, alignPatch, alignTexts, reconstructBase, alignedStats, hunksToPatch } from './deltaSource.js';
export { StateController, stateController } from './StateController.js';
export { BlobStore, blobStore, MemoryBackend, IndexedDBBackend } from './BlobStore.js';
