/**
 * sessionAdapter — harness adapters: session transcripts (JSONL) → the ONE event stream.
 *
 * The agent books ingest events from an agent HARNESS — a tool that runs an agent and writes a
 * record of what it did. Each harness speaks its own on-disk dialect; the adapter's job is to turn
 * that dialect into the ONE ordered event stream the books understand. This file is that seam,
 * one `parse<Harness>Session` per harness — same event shapes out:
 *
 *   adapter #1  parseClaudeSession(text)        Claude Code session JSONL
 *               (~/.claude/projects/<proj>/<session>.jsonl)
 *   adapter #2  parseKimiSession(text, cwd)     Kimi Code wire log
 *               (~/.kimi-code/sessions/<ws>/<session>/agents/main/wire.jsonl)
 *
 *   parse<Harness>Session(...) → { events, cwd, firstTs, lastTs }
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

// --- adapter #2: Kimi Code wire logs ---------------------------------------------------------
//
// Kimi Code records a session as `~/.kimi-code/sessions/<workspace>/<session-id>/agents/
// <agentId>/wire.jsonl`; only the MAIN agent's wire is parsed (agents/agent-N are subagents —
// the same call the Claude adapter makes for sidechains). Each line is one JSON object, most
// carrying a top-level `time` (epoch ms). The payload lines are
// `{"type":"context.append_loop_event","event":{...},"time":<ms>}`; the event subtypes that
// become stream events are:
//   content.part  part {type:'think',think} | {type:'text',text}   → message (thinking | text)
//   tool.call     {toolCallId, name, args, display}                → tool (input = args, translated)
//   tool.result   {toolCallId, result}                             → paired to its call by id,
//                 emitted AT THE CALL's position (results land on later lines — pass 1 pairs
//                 across the whole transcript, exactly like the Claude adapter).
// Everything else (metadata, step.begin/end, turn.prompt, context.append_message — the user's
// prose, llm.request, usage.record, permission.*, tools.*, turn.cancel) is bookkeeping the
// Claude adapter's skips mirror: dropped.
//
// DIALECT TRANSLATION is the adapter's half of the contract — events come out Claude-shaped so
// the ONE tool registry works unchanged:
//   • file tools (Read/Edit/Write/…) name their target arg `path`, not `file_path` → renamed
//     (Glob/Grep keep theirs: there `path` is a search DIR, and the registry only reads `pattern`).
//   • a kimi result is usually just {output}; two generic enrichments reconstruct the bits the
//     registry's meta readers look for — Bash gets stdout=output (line counts), Read gets a
//     synthesized file={numLines, startLine} (line-count meta + partial-read range highlight).

/** Kimi tools whose `path` arg is the FILE the call is about (→ Claude's `file_path`). */
const KIMI_FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The lane id a kimi session's book lives under. Kimi ids look like `session_<uuid-with-dashes>`;
 * the Claude derivation would collapse every one of them to "session_", so the prefix is
 * stripped first, then dashes, first 8 chars. Archive-only for now — NO live-hook lockstep
 * constraint (there is no kimi hook).
 * @param {string} sessionId
 * @returns {string}
 */
export function kimiAgentIdForSession(sessionId) {
    const s = String(sessionId ?? '').replace(/^session_/, '').replace(/-/g, '');
    return s ? s.slice(0, 8) : 'kimi';
}

/** Kimi tool args → Claude-shaped input: the file tools' `path` becomes `file_path`. */
function kimiInput(name, args) {
    const input = (args && typeof args === 'object') ? { ...args } : {};
    if (KIMI_FILE_TOOLS.has(name) && typeof input.path === 'string' && input.file_path == null) {
        input.file_path = input.path;
        delete input.path;
    }
    return input;
}

/**
 * Kimi tool result → Claude-shaped response. Passes the result object through (its `output`
 * key is already in the registry's pickText chain), plus the two generic enrichments:
 * Bash stdout for line counts; Read file={numLines, startLine} for the meta column and the
 * partial-read range highlight. numLines counts the output's lines (kimi prefixes each with
 * "N\t"), matching Claude's numLines semantics closely enough; startLine is the requested
 * line_offset (1-based), so a ranged read lights up its slice.
 */
function kimiResponse(name, input, result) {
    if (!result || typeof result !== 'object') return result ?? null;
    if (typeof result.output !== 'string') return result;
    if (name === 'Bash' && result.stdout == null) {
        return { ...result, stdout: result.output };
    }
    if (name === 'Read' && result.file == null) {
        const out = result.output;
        const numLines = out === '' ? 0 : out.replace(/\n$/, '').split('\n').length;
        return { ...result, file: { numLines, startLine: input.line_offset || 1 } };
    }
    return result;
}

/**
 * Parse a Kimi Code wire log (JSONL text) into the ordered event stream.
 * @param {string} text  the whole wire.jsonl file (the MAIN agent's)
 * @param {string} [cwd] the session's working dir from the archive index — the fallback when
 *        no tool.call display carries one (a session that never ran Bash has none)
 * @returns {{
 *   events: Array<{kind:'tool', name:string, input:Object, response:*, ts:number|null}
 *                |{kind:'message', mtype:'text'|'thinking', text:string, ts:number|null}>,
 *   cwd: string|null, firstTs: number|null, lastTs: number|null
 * }}
 */
export function parseKimiSession(text, cwd) {
    // Pass 0 — parse once, filter once: malformed lines and non-object lines drop here.
    const parsed = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        parsed.push(obj);
    }

    // Pass 1 — pair results by toolCallId across the WHOLE transcript (a result lands on a
    // later line than its call, often many lines later).
    const results = new Map();   // toolCallId -> result object
    for (const obj of parsed) {
        if (obj.type !== 'context.append_loop_event') continue;
        const ev = obj.event;
        if (ev?.type === 'tool.result' && ev.toolCallId != null) {
            results.set(ev.toolCallId, ev.result ?? null);
        }
    }

    // Pass 2 — emit at each event's own position.
    const events = [];
    let cwdOut = null, firstTs = null, lastTs = null;
    const push = (e) => {
        events.push(e);
        if (e.ts != null) { if (firstTs === null) firstTs = e.ts; lastTs = e.ts; }
    };
    for (const obj of parsed) {
        if (obj.type !== 'context.append_loop_event') continue;
        const ev = obj.event;
        if (!ev || typeof ev !== 'object') continue;
        const ts = Number.isFinite(obj.time) ? obj.time : null;
        if (ev.type === 'tool.call') {
            if (cwdOut === null && typeof ev.display?.cwd === 'string' && ev.display.cwd) {
                cwdOut = ev.display.cwd;
            }
            const input = kimiInput(ev.name, ev.args);
            push({
                kind: 'tool', name: ev.name, input,
                response: kimiResponse(ev.name, input, results.get(ev.toolCallId ?? ev.uuid)),
                ts,
            });
        } else if (ev.type === 'content.part') {
            const part = ev.part;
            if (part?.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
                push({ kind: 'message', mtype: 'thinking', text: part.think, ts });
            } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                push({ kind: 'message', mtype: 'text', text: part.text, ts });
            }
        }
    }

    return { events, cwd: cwdOut ?? (typeof cwd === 'string' && cwd ? cwd : null), firstTs, lastTs };
}
