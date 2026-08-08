/**
 * Multica wire shapes, as JSDoc typedefs.
 *
 * These describe the HTTP/WebSocket protocol a Multica backend speaks — the same
 * way our own relay's frames are described. Nothing here is imported from the
 * Multica source tree: this package talks to a running backend over the wire and
 * carries no Multica code, so glyph3d stays MIT end to end. See NOTICE.md for the
 * attribution the Multica License asks of a non-interface consumer.
 *
 * Field names are theirs (snake_case on the wire). We keep them verbatim at the
 * boundary and normalize into glyph3d shapes exactly once, in MulticaBridge.
 */

/**
 * @typedef {'idle'|'working'|'blocked'|'error'|'offline'} MulticaAgentStatus
 * The agent lifecycle as the board reports it. `working` is the only state that
 * implies an in-flight task; `blocked` means it is waiting on a human or a barrier.
 */

/**
 * @typedef {Object} MulticaAgent
 * @property {string} id
 * @property {string} name              display name — becomes the book's nameplate
 * @property {string} [description]
 * @property {string} [instructions]
 * @property {MulticaAgentStatus} [status]
 * @property {string} [runtime_id]      the device the agent executes on
 * @property {string} [avatar_url]
 * @property {'workspace'|'private'} [visibility]
 */

/**
 * @typedef {'backlog'|'todo'|'in_progress'|'in_review'|'done'|'blocked'|'cancelled'} MulticaIssueStatus
 */

/**
 * @typedef {'urgent'|'high'|'medium'|'low'|'none'} MulticaIssuePriority
 */

/**
 * @typedef {Object} MulticaIssue
 * @property {string} id
 * @property {number} number
 * @property {string} identifier         e.g. "GLY-4" — the human handle, and our page label
 * @property {string} title
 * @property {string|null} [description]
 * @property {MulticaIssueStatus} status
 * @property {MulticaIssuePriority} priority
 * @property {'member'|'agent'|'squad'|null} [assignee_type]
 * @property {string|null} [assignee_id]
 * @property {string|null} [parent_issue_id]
 * @property {string|null} [project_id]
 * @property {number|null} [stage]       1-based barrier group among siblings; null = unstaged
 * @property {Record<string, string|number|boolean>} [metadata]
 *   Freeform KV agents write pipeline state into (pipeline_status, waiting_on, PR number).
 *   Always present in responses — empty object when unset.
 */

/**
 * @typedef {Object} MulticaRuntime
 * @property {string} id
 * @property {string} name
 * @property {'local'|'cloud'} [mode]
 * @property {string} [provider]         the agent CLI behind it (claude, codex, …)
 * @property {string} [status]
 */

/**
 * @typedef {Object} MulticaWSMessage
 * @property {string} type               e.g. "task:running", "issue:updated"
 * @property {unknown} [payload]
 * @property {string} [actor_id]
 * @property {string} [actor_type]
 */

/**
 * The event names we bind. Multica emits ~100; these are the ones that move a book,
 * a page, or a terminal. Anything else arrives through the catch-all subscriber and
 * is ignored rather than dropped noisily — an unknown frame is a newer server, not
 * an error.
 *
 * @type {readonly string[]}
 */
export const BOUND_EVENTS = Object.freeze([
    // agent lifecycle → book state
    'agent:created', 'agent:status', 'agent:archived', 'agent:restored',
    // task lifecycle → book activity + state
    'task:queued', 'task:dispatch', 'task:running', 'task:progress',
    'task:completed', 'task:failed', 'task:cancelled', 'task:message',
    'task:waiting_local_directory',
    // issues → pages
    'issue:created', 'issue:updated', 'issue:deleted',
    'comment:created', 'activity:created',
    // chat → attached terminals
    'chat:message', 'chat:done',
]);

/** Multica task states that mean "this agent is doing something right now". */
export const ACTIVE_TASK_EVENTS = Object.freeze([
    'task:dispatch', 'task:running', 'task:progress', 'task:message',
]);

export {};
