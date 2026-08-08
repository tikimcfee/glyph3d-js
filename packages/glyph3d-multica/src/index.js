/**
 * @glyph3d/multica — talk to a Multica backend, render its board as agent books.
 *
 * This package speaks Multica's HTTP + WebSocket protocol. It contains no Multica
 * source: glyph3d stays MIT, and the Multica License's attribution condition for
 * non-interface consumers is met in NOTICE.md.
 */

export { default as MulticaClient, MulticaError } from './MulticaClient.js';
export { default as MulticaSocket } from './MulticaSocket.js';
export { default as MulticaBridge, bookIdForAgent } from './MulticaBridge.js';
export { BOUND_EVENTS, ACTIVE_TASK_EVENTS } from './types.js';
