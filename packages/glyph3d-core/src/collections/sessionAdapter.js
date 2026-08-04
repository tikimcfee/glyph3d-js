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
 *               — a fold over the EXPORTED incremental translator
 *               kimiWireLineToEvents(obj, state), so live wire lines (pushed by the kimi
 *               hook) and archive files run through the ONE dialect implementation.
 *
 *   parse<Harness>Session(...) → { events, cwd, firstTs, lastTs, meta }
 *
 * meta is the provenance record the books' nameplates read (cwd/firstTs/lastTs also stay
 * top-level for backward compatibility until callers migrate):
 *   { harness: 'claude'|'kimi', cwd, slug, title, model, version, gitBranch, agentName,
 *     firstTs, lastTs, ... }   — harness-specific extras noted per adapter below.
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
 *
 * SYNC vs ASYNC: each parser is a GENERATOR (`parse<Harness>SessionSteps`) that does the work in
 * budgeted slices, yielding when a slice expires. The sync export drives it straight through
 * (tests, tools, workers); the `...Async` export awaits `yieldToFrame()` between slices so a
 * monster transcript parses on the main thread WITHOUT one long task starving every queued
 * await behind it (the 2026-08 restore stall: 150–500ms parse blocks mid-session-restore).
 * ONE implementation — the two drivers can never drift apart.
 */

import { yieldToFrame } from '../utils/frameYield.js';

/** Default slice budget for the async drivers (ms of work per frame). */
const PARSE_SLICE_MS = 8;

/** Drive a parser generator straight through — the sync surface. */
function runSteps(gen) {
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
}

/** Drive a parser generator frame by frame — the async, main-thread-polite surface. */
async function runStepsAsync(gen) {
    let r = gen.next();
    while (!r.done) { await yieldToFrame(); r = gen.next(); }
    return r.value;
}

/**
 * Slice-budget tracker for parser loops. `check(i)` is called per iteration; it reads the
 * clock only every 256th call (clock reads would dominate a hot JSON.parse loop otherwise)
 * and returns true when the slice has overrun its budget — the generator then yields.
 */
function makeSliceBudget(budgetMs) {
    let slice0 = performance.now();
    return (i) => {
        if ((i & 0xFF) !== 0) return false;
        if (performance.now() - slice0 <= budgetMs) return false;
        slice0 = performance.now();
        return true;
    };
}

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
 *   cwd: string|null, firstTs: number|null, lastTs: number|null,
 *   meta: { harness:'claude', cwd:string|null, slug:string|null, title:string|null,
 *           model:string|null, version:string|null, gitBranch:string|null,
 *           agentName:string|null, firstTs:number|null, lastTs:number|null }
 * }}
 * meta harvests (first-seen wins) the provenance the transcript carries but the event
 * stream drops: `slug`/`version`/`gitBranch` off any line (same spot as `cwd`),
 * `message.model` off assistant lines, `aiTitle`→title off `ai-title` lines, `agentName`
 * off `agent-name` lines.
 */
export function parseClaudeSession(text) {
    return runSteps(parseClaudeSessionSteps(text));
}

/**
 * Async, frame-sliced parse — the main-thread surface (session restore, agent.open).
 * Identical output to parseClaudeSession; the transcript parses in ~PARSE_SLICE_MS
 * slices with a frame yield between them, so a fat history no longer blocks the thread.
 * @param {string} text @param {{budgetMs?: number}} [opts]
 * @returns {Promise<ReturnType<typeof parseClaudeSession>>}
 */
export function parseClaudeSessionAsync(text, { budgetMs = PARSE_SLICE_MS } = {}) {
    return runStepsAsync(parseClaudeSessionSteps(text, budgetMs));
}

/**
 * The ONE parse implementation, as a generator: runs each pass in budgeted slices,
 * yielding (no value) when a slice expires. Drivers above decide what a yield means.
 * @param {string} text @param {number} [budgetMs] slice budget; Infinity = never yield
 */
function* parseClaudeSessionSteps(text, budgetMs = Infinity) {
    const overBudget = makeSliceBudget(budgetMs);
    // Parse once, filter once: malformed lines and sidechain lines drop here, so neither the
    // pairing pass nor the emit pass ever sees them (a sidechain's cwd/results don't leak either).
    const parsed = [];
    let i = 0;
    for (const line of String(text ?? '').split('\n')) {
        if (overBudget(i++)) yield;
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
    i = 0;
    for (const obj of parsed) {
        if (overBudget(i++)) yield;
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
    let slug = null, title = null, model = null, version = null, gitBranch = null, agentName = null;
    const push = (ev) => {
        events.push(ev);
        if (ev.ts != null) { if (firstTs === null) firstTs = ev.ts; lastTs = ev.ts; }
    };
    i = 0;
    for (const obj of parsed) {
        if (overBudget(i++)) yield;
        // Meta harvest: first-seen wins, on ANY line (the bookkeeping lines that carry
        // slug/aiTitle/agentName have no message.content, so this runs before that skip).
        if (cwd === null && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
        if (slug === null && typeof obj.slug === 'string' && obj.slug) slug = obj.slug;
        if (version === null && typeof obj.version === 'string' && obj.version) version = obj.version;
        if (gitBranch === null && typeof obj.gitBranch === 'string' && obj.gitBranch) gitBranch = obj.gitBranch;
        if (title === null && obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle) title = obj.aiTitle;
        if (agentName === null && obj.type === 'agent-name' && typeof obj.agentName === 'string' && obj.agentName) agentName = obj.agentName;
        const content = obj?.message?.content;
        if (!Array.isArray(content)) continue;
        const ts = parseTs(obj.timestamp);
        const assistant = obj?.message?.role === 'assistant';
        if (assistant && model === null && typeof obj.message.model === 'string' && obj.message.model) model = obj.message.model;
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

    return {
        events, cwd, firstTs, lastTs,
        meta: { harness: 'claude', cwd, slug, title, model, version, gitBranch, agentName, firstTs, lastTs },
    };
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
// Everything else (step.begin/end, context.append_message — the user's prose, usage.record,
// permission.*, tools.*, turn.cancel) is bookkeeping the Claude adapter's skips mirror: dropped.
// Three bookkeeping line types emit no events but ARE harvested into meta: `llm.request`
// (provider/model/modelAlias), `metadata` (created_at), and the first `turn.prompt` (name
// fallback — its text is the `prompt` string, or the first text part of the `input` array).
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
 * stripped first, then dashes, first 8 chars. LOCKSTEP constraint, BOTH ways: kimi has hooks
 * just like claude, and the live kimi hook (cli/hook.go `--kimi` mode) derives the lane id
 * from the hook payload's session_id with this exact algorithm — change it only together
 * with the Go side, or restored books and their still-live streams stop converging.
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
 * Fresh state for the incremental kimi wire translator — one per session/lane. Carries the
 * pending tool.call/tool.result pairing maps (results may arrive before OR after their call
 * across line batches) plus the harvested-meta accumulators. Not mutated by anything but
 * kimiWireLineToEvents; read the accumulators off it for the live lane's meta.
 * @returns {{
 *   calls: Map<string, {name:string, input:Object, event:Object}>,
 *   results: Map<string, *>,
 *   cwd: string|null, title: string|null, createdAt: number|null,
 *   model: string|null, modelAlias: string|null, provider: string|null,
 *   firstTs: number|null, lastTs: number|null
 * }}
 */
export function createKimiWireState() {
    return {
        calls: new Map(),    // toolCallId -> { name, input, event } — call seen, result pending
        results: new Map(),  // toolCallId -> result — result seen, call not seen yet
        cwd: null, title: null, createdAt: null,
        model: null, modelAlias: null, provider: null,
        firstTs: null, lastTs: null,
    };
}

/**
 * Translate ONE parsed wire.jsonl line into stream events — the single dialect implementation
 * shared by archive (parseKimiSession folds over it) and live ingress (the agent.kimi-wire
 * handler feeds hook-pushed lines through it).
 *
 * Pairing is incremental: a tool.call emits its event immediately; when the result arrives
 * later the ALREADY-EMITTED event's `response` is filled in place (the events array holds
 * the same object, so readers see the pair complete). A result whose call hasn't been seen
 * yet waits in state.results and is attached when the call lands. Either order, any batching.
 *
 * @param {Object} obj    one JSON.parsed wire line (non-objects are a no-op)
 * @param {Object} state  from createKimiWireState()
 * @returns {Array} the events this line emitted (0 or 1; tool.result lines emit none)
 */
export function kimiWireLineToEvents(obj, state) {
    const events = [];
    if (!obj || typeof obj !== 'object') return events;
    const push = (e) => {
        events.push(e);
        if (e.ts != null) { if (state.firstTs === null) state.firstTs = e.ts; state.lastTs = e.ts; }
    };

    // Meta harvest — first-seen wins, no events emitted.
    if (obj.type === 'llm.request') {
        if (state.model === null && typeof obj.model === 'string' && obj.model) state.model = obj.model;
        if (state.modelAlias === null && typeof obj.modelAlias === 'string' && obj.modelAlias) state.modelAlias = obj.modelAlias;
        if (state.provider === null && typeof obj.provider === 'string' && obj.provider) state.provider = obj.provider;
        return events;
    }
    if (obj.type === 'metadata') {
        if (state.createdAt === null && Number.isFinite(obj.created_at)) state.createdAt = obj.created_at;
        return events;
    }
    if (obj.type === 'turn.prompt') {
        if (state.title === null) {
            const t = typeof obj.prompt === 'string' ? obj.prompt
                : Array.isArray(obj.input)
                    ? obj.input.find((p) => p?.type === 'text' && typeof p.text === 'string' && p.text)?.text
                    : null;
            if (t) state.title = t;
        }
        return events;
    }

    if (obj.type !== 'context.append_loop_event') return events;
    const ev = obj.event;
    if (!ev || typeof ev !== 'object') return events;
    const ts = Number.isFinite(obj.time) ? obj.time : null;
    if (ev.type === 'tool.call') {
        if (state.cwd === null && typeof ev.display?.cwd === 'string' && ev.display.cwd) {
            state.cwd = ev.display.cwd;
        }
        const input = kimiInput(ev.name, ev.args);
        const id = ev.toolCallId ?? ev.uuid;
        const event = { kind: 'tool', name: ev.name, input, response: null, ts };
        if (id != null) {
            if (state.results.has(id)) {
                // Result arrived BEFORE the call — attach it now.
                event.response = kimiResponse(ev.name, input, state.results.get(id));
                state.results.delete(id);
            } else {
                // Result pending — fill the emitted event in place when it lands.
                state.calls.set(id, { name: ev.name, input, event });
            }
        }
        push(event);
    } else if (ev.type === 'tool.result') {
        const id = ev.toolCallId;
        if (id != null) {
            const pending = state.calls.get(id);
            if (pending) {
                pending.event.response = kimiResponse(pending.name, pending.input, ev.result ?? null);
                state.calls.delete(id);
            } else {
                state.results.set(id, ev.result ?? null);
            }
        }
    } else if (ev.type === 'content.part') {
        const part = ev.part;
        if (part?.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
            push({ kind: 'message', mtype: 'thinking', text: part.think, ts });
        } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            push({ kind: 'message', mtype: 'text', text: part.text, ts });
        }
    }
    return events;
}

/**
 * Parse a Kimi Code wire log (JSONL text) into the ordered event stream — a fold over
 * kimiWireLineToEvents, so archive and live ingress can never drift apart.
 * @param {string} text  the whole wire.jsonl file (the MAIN agent's)
 * @param {string} [cwd] the session's working dir from the archive index — the fallback when
 *        no tool.call display carries one (a session that never ran Bash has none)
 * @returns {{
 *   events: Array<{kind:'tool', name:string, input:Object, response:*, ts:number|null}
 *                |{kind:'message', mtype:'text'|'thinking', text:string, ts:number|null}>,
 *   cwd: string|null, firstTs: number|null, lastTs: number|null,
 *   meta: { harness:'kimi', cwd:string|null, title:string|null, createdAt:number|null,
 *           model:string|null, modelAlias:string|null, provider:string|null,
 *           firstTs:number|null, lastTs:number|null }
 * }}
 */
export function parseKimiSession(text, cwd) {
    return runSteps(parseKimiSessionSteps(text, cwd));
}

/**
 * Async, frame-sliced parse — the main-thread surface (session restore, agent.open).
 * Identical output to parseKimiSession; see parseClaudeSessionAsync.
 * @param {string} text @param {string} [cwd] @param {{budgetMs?: number}} [opts]
 * @returns {Promise<ReturnType<typeof parseKimiSession>>}
 */
export function parseKimiSessionAsync(text, cwd, { budgetMs = PARSE_SLICE_MS } = {}) {
    return runStepsAsync(parseKimiSessionSteps(text, cwd, budgetMs));
}

/**
 * The ONE parse implementation, as a generator (budgeted slices — see
 * parseClaudeSessionSteps). @param {number} [budgetMs] Infinity = never yield
 */
function* parseKimiSessionSteps(text, cwd, budgetMs = Infinity) {
    const overBudget = makeSliceBudget(budgetMs);
    const state = createKimiWireState();
    const events = [];
    let i = 0;
    for (const line of String(text ?? '').split('\n')) {
        if (overBudget(i++)) yield;
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        events.push(...kimiWireLineToEvents(obj, state));
    }
    const cwdOut = state.cwd ?? (typeof cwd === 'string' && cwd ? cwd : null);
    return {
        events, cwd: cwdOut, firstTs: state.firstTs, lastTs: state.lastTs,
        meta: {
            harness: 'kimi', cwd: cwdOut,
            title: state.title, createdAt: state.createdAt,
            model: state.model, modelAlias: state.modelAlias, provider: state.provider,
            firstTs: state.firstTs, lastTs: state.lastTs,
        },
    };
}
