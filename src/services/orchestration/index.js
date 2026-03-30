/**
 * Orchestration services barrel - command routing, API facade, WebSocket bridge,
 * diff controller, and hand gesture adapter
 */
export { DiffController } from './DiffController.js';
export { HandGestureAdapter } from './HandGestureAdapter.js';
export { default as CommandRouter } from './CommandRouter.js';
export { default as ViewerAPI } from './ViewerAPI.js';
export { default as WebSocketBridge } from './WebSocketBridge.js';
