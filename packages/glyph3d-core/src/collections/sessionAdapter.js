/**
 * sessionAdapter — harness adapter #1: Claude Code session transcripts (JSONL).
 *
 * The agent books ingest events from an agent HARNESS — a tool that runs an agent and writes a
 * record of what it did. Each harness speaks its own on-disk dialect; the adapter's job is to turn
 * that dialect into the ONE ordered event stream the books understand. This file is that seam:
 * adapter #1 reads Claude Code's session JSONL (`~/.claude/projects/<proj>/<session>.jsonl`).
 * A second harness means a second `parse<Harness>Session` beside this one — same event shapes out.
 *
 *   parseClaudeSession(text) → { events, cwd, firstTs, lastTs }
 *
 * events, in transcript LINE order (block order within a line):
 *   { kind: 'tool',    name, input, response, ts }   — one per tool_use block. `response` is the
 *     structured `toolUseResult` when the transcript carries one, with the tool_result TEXT merged
 *     in as `content` when the structured object lacks a text field (stdout/content/result/output);
 *     bare text when there is no structured object; null when there is neither. tool_result lines
 *     land LATER in the file than their tool_use — pairing runs by tool_use_id across the whole
 *     transcript first, then the event is emitted at the tool_use's own position.
 *   { kind: 'message', mtype: 'text'|'thinking', text, ts } — one per assistant prose block
 *     (whitespace-only blocks dropped), mirroring what the live hook forwards as `agent.message`.
 *
 * SKIPPED: sidechain lines (`isSidechain: true` — subagent work; the live hook gives subagents
 * their own lanes, so folding them into the main book would misattribute), malformed JSON lines,
 * and lines with no `message.content` array (mode/snapshot/attachment/… bookkeeping).
 *
 * ts is the line's `timestamp` (ISO string) as epoch ms, null when absent/unparseable. cwd is the
 * first-seen `cwd` field. firstTs/lastTs are the first and last non-null event ts, in order.
 *
 * Pure: no THREE, no DOM, no node imports — bun scripts, workers, and the browser all import it.
 * What each event MEANS (action/target/detail, noise tools, say/think) is toolRegistry's job, not
 * this file's — the adapter ships raw shapes, the registry interprets them.
 */

/**
 * Merge a tool_result's plain TEXT into the structured `toolUseResult` exactly the way the live
 * forwarders do: the structured object wins; the text rides along as `content` only when the
 * structured object has no text field of its own, so the registry's output extractor always finds
 * the text without per-tool knowledge living here.
 * @param {*} tur         structured toolUseResult (object, string, or null)
 * @param {string} text   flattened tool_result text ('' when none)
 * @returns {*} the merged response (object | string | null)
 */
function mergeResponse(tur, text) {
    if (tur && typeof tur === 'object') {
        const hasText = tur.stdout || tur.content || tur.result || tur.output;
        return (text && !hasText) ? { ...tur, content: text } : tur;
    }
    return tur ?? (text || null);
}

/** Flatten a tool_result block's content (string, or a list of typed blocks) to plain text. */
function resultTextOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((x) => (x?.type === 'text' ? x.text : '')).join('\n');
    return '';
}

/**
 * The lane id a session's book lives under — EXACTLY the live hook's derivation
 * (cli/hook.go agentIdentity): the session id with dashes stripped, first 8 chars.
 * The identity contract that makes a restored book and that session's still-live
 * stream converge on one lane; change it only in lockstep with the hook.
 * @param {string} sessionId
 * @returns {string}
 */
export function agentIdForSession(sessionId) {
    const s = String(sessionId ?? '').replace(/-/g, '');
    return s ? s.slice(0, 8) : 'claude';
}

/** ISO timestamp → epoch ms, or null when absent/unparseable. */
function parseTs(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse a Claude Code session transcript (JSONL text) into the ordered event stream.
 * @param {string} text  the whole .jsonl file
 * @returns {{
 *   events: Array<{kind:'tool', name:string, input:Object, response:*, ts:number|null}
 *                |{kind:'message', mtype:'text'|'thinking', text:string, ts:number|null}>,
 *   cwd: string|null, firstTs: number|null, lastTs: number|null
 * }}
 */
export function parseClaudeSession(text) {
    // Parse once, filter once: malformed lines and sidechain lines drop here, so neither the
    // pairing pass nor the emit pass ever sees them (a sidechain's cwd/results don't leak either).
    const parsed = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.isSidechain === true) continue;
        parsed.push(obj);
    }

    // Pass 1 — pair results by tool_use_id across the WHOLE transcript. A tool_result rides a
    // later `user` line than its tool_use (often many lines later, past interleaved prose), and
    // the structured toolUseResult sits on that line's TOP level, beside the message.
    const texts = new Map();       // tool_use_id -> flattened tool_result text
    const structured = new Map();  // tool_use_id -> structured toolUseResult
    for (const obj of parsed) {
        const content = obj?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            texts.set(b.tool_use_id, resultTextOf(b.content));
            if (obj.toolUseResult != null) structured.set(b.tool_use_id, obj.toolUseResult);
        }
    }

    // Pass 2 — emit at each block's own position: line order, block order within a line.
    const events = [];
    let cwd = null, firstTs = null, lastTs = null;
    const push = (ev) => {
        events.push(ev);
        if (ev.ts != null) { if (firstTs === null) firstTs = ev.ts; lastTs = ev.ts; }
    };
    for (const obj of parsed) {
        if (cwd === null && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
        const content = obj?.message?.content;
        if (!Array.isArray(content)) continue;
        const ts = parseTs(obj.timestamp);
        const assistant = obj?.message?.role === 'assistant';
        for (const b of content) {
            if (b?.type === 'tool_use') {
                push({
                    kind: 'tool', name: b.name, input: b.input || {},
                    response: mergeResponse(structured.get(b.id) ?? null, texts.get(b.id) || ''),
                    ts,
                });
            } else if (assistant && b?.type === 'text') {
                if (typeof b.text === 'string' && b.text.trim()) {
                    push({ kind: 'message', mtype: 'text', text: b.text, ts });
                }
            } else if (assistant && b?.type === 'thinking') {
                if (typeof b.thinking === 'string' && b.thinking.trim()) {
                    push({ kind: 'message', mtype: 'thinking', text: b.thinking, ts });
                }
            }
        }
    }

    return { events, cwd, firstTs, lastTs };
}
