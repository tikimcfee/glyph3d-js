/**
 * agentWaiting — "is this agent waiting on YOU?", read off the SAME normalized records
 * the books already render. The sibling of toolRegistry.js: that file says what a turn
 * DID, this one says whether the turn ENDED ON YOU.
 *
 * Two shapes of wait, both derived (never announced by the harness):
 *
 *   ask  — a call that blocks on a human answer (the TOOLS entry's `blocking` flag:
 *          AskUserQuestion, ExitPlanMode). Live, that's the PRE-tool event: between the
 *          call and the answer the agent is stopped. In a record, an `ask` whose result
 *          is still empty is the same state seen after the fact (an archive tail parsed
 *          mid-question, a replay).
 *   say  — the turn ended on the agent's PROSE. The last thing it did was talk to you,
 *          so the ball is in your court. `think` blocks trail speech, so they're
 *          transparent here; a turn that ended on a tool call is not a wait.
 *
 * Pure — plain records in, `{ reason, message }` out, no THREE / DOM / registry — so the
 * bun tests and the headless replay import it exactly as they import the tool registry.
 * The MESSAGE is the agent's own words, whole: the panel that shows it does the framing,
 * and nothing is truncated here.
 */

import { blocksOnUser, normalizeToolCall } from './toolRegistry.js';

/** A blocking call is in flight (AskUserQuestion / ExitPlanMode). */
export const WAIT_ASK = 'ask';
/** The turn ended on the agent's prose — it said its piece and stopped. */
export const WAIT_SAY = 'say';
/** Raised by hand — the `agent.request` verb (a human, or the agent itself, saying "needs you"). */
export const WAIT_REQUEST = 'request';

/** `{ reason, message }` with a non-empty message, or null. @private */
function wait(reason, message) {
    const m = String(message ?? '').trim();
    return m ? { reason, message: m } : null;
}

/**
 * The PRE-tool event: a tool is about to run. Non-blocking tools answer null (the
 * overwhelming majority — the ingress drops them); a blocking one answers with the
 * question it is about to stop on, normalized through the ONE registry so the wait
 * reads exactly like the sheet that lands when the answer arrives.
 * @param {string} name raw tool name (Read/Edit/AskUserQuestion/…)
 * @param {Object} [input] the tool's input
 * @param {string} [cwd]
 * @returns {{reason:string, message:string}|null}
 */
export function waitFromPreTool(name, input = {}, cwd = '') {
    if (!blocksOnUser(name)) return null;
    const rec = normalizeToolCall(name, input, null, cwd);
    return rec ? wait(WAIT_ASK, rec.detail || rec.target) : null;
}

/**
 * One normalized record: an `ask` still missing its answer is a live wait. Everything
 * else — including an ask that came back answered — is the agent working.
 * @param {{action?:string, detail?:string, result?:string}} record
 * @returns {{reason:string, message:string}|null}
 */
export function waitFromRecord(record) {
    if (!record || record.action !== 'ask') return null;
    if (String(record.result ?? '').trim()) return null;   // answered → the hand is down
    return wait(WAIT_ASK, record.detail);
}

/**
 * The turn ended (the harness Stop hook): walk back over the records it produced and
 * decide whether it ended on you. Speech wins; interior reasoning is transparent; a
 * pending question still holds the hand up; a tool call means it just stopped working.
 * @param {Array<{action?:string, detail?:string, result?:string}>} records oldest → newest
 * @returns {{reason:string, message:string}|null}
 */
export function waitFromTurnEnd(records) {
    const list = Array.isArray(records) ? records : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const rec = list[i];
        const action = String(rec?.action ?? '');
        if (action === 'think') continue;                       // reasoning trailing the speech
        if (action === 'say') return wait(WAIT_SAY, rec.result);
        return waitFromRecord(rec);                             // a pending ask holds; a tool call doesn't
    }
    return null;
}
