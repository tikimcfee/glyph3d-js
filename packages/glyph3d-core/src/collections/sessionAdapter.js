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
 *   adapter #3  parseAgySession(text, cwd)      Antigravity CLI (agy) conversation transcript
 *               (~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript_full.jsonl)
 *               — a fold over the exported step translator agyStepToEvents(obj, state).
 *
 *   parse<Harness>Session(...) → { events, cwd, firstTs, lastTs, meta }
 *   parseSession(text, { harness, cwd })  — the ONE harness dispatch (throws on an unknown
 *               harness); the parse codec and its main-thread fallback both ride it.
 *
 * meta is the provenance record the books' nameplates read (cwd/firstTs/lastTs also stay
 * top-level for backward compatibility until callers migrate):
 *   { harness: 'claude'|'kimi'|'agy', cwd, slug, title, model, version, gitBranch, agentName,
 *     firstTs, lastTs, ... }   — harness-specific extras noted per adapter below.
 *
 * events, in transcript LINE order (block order within a line). Every event carries `line`, the
 * 0-based index of the transcript line it came from (its tool CALL's line for a tool) — the codec
 * turns it into the event's byte offset in the file, which is how a book pages back through a
 * record in windows (sessionParseJob `at`).
 *   { kind: 'tool',    name, input, response, ts }   — one per tool_use block. `response` is the
 *     structured `toolUseResult` when the transcript carries one, with the tool_result TEXT merged
 *     in as `content` when the structured object lacks a text field (stdout/content/result/output);
 *     bare text when there is no structured object; null when there is neither. tool_result lines
 *     land LATER in the file than their tool_use — pairing runs by tool_use_id across the whole
 *     transcript first, then the event is emitted at the tool_use's own position.
 *   { kind: 'message', mtype: 'text'|'thinking', text, ts } — one per assistant prose block
 *     (whitespace-only blocks dropped), mirroring what the live hook forwards as `agent.message`.
 *     agy adds mtype 'system' — what the harness told the model (messages, compaction summaries).
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
    const lineOf = [];             // parsed[k]'s transcript line index
    let i = 0, li = -1;
    for (const line of String(text ?? '').split('\n')) {
        li++;
        if (overBudget(i++)) yield;
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.isSidechain === true) continue;
        parsed.push(obj);
        lineOf.push(li);
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
    let curLine = 0;
    const push = (ev) => {
        ev.line = curLine;
        events.push(ev);
        if (ev.ts != null) { if (firstTs === null) firstTs = ev.ts; lastTs = ev.ts; }
    };
    i = 0;
    for (let k = 0; k < parsed.length; k++) {
        const obj = parsed[k];
        curLine = lineOf[k];
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

/**
 * The lane id an archive entry opens under — the per-harness derivation (a kimi id's
 * `session_` prefix would collapse every kimi lane to one id under the claude rule; an agy
 * conversation id is a bare UUID, so the claude rule fits it as-is).
 * The ONE place an archive entry meets a lane: open, the panel's open-lane filter, and
 * restore of a prefix-only (hook-born) book all compare lane ids through it.
 * @param {{ id: string, harness?: string }} entry
 * @returns {string}
 */
export function agentIdForEntry({ id, harness }) {
    return harness === 'kimi' ? kimiAgentIdForSession(id) : agentIdForSession(id);
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
    let i = 0, li = -1;
    for (const line of String(text ?? '').split('\n')) {
        li++;
        if (overBudget(i++)) yield;
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        for (const e of kimiWireLineToEvents(obj, state)) { e.line = li; events.push(e); }
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

// --- adapter #3: Antigravity CLI (agy) conversation transcripts ------------------------------
//
// agy records a conversation as `~/.gemini/antigravity-cli/brain/<conversationId>/
// .system_generated/logs/transcript_full.jsonl` — one STEP per line:
//   { step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type, status: DONE|RUNNING|ERROR|INVALID,
//     created_at (ISO), content?, thinking?, tool_calls?: [{name, args}], error?,
//     input_tokens?, cache_read_tokens?, output_tokens?, cwd? }
// The step types:
//   USER_INPUT        a turn's prompt: the typed text sits inside <USER_REQUEST>…</USER_REQUEST>,
//                     followed by <ADDITIONAL_METADATA> / <USER_SETTINGS_CHANGE> blocks. Emits
//                     nothing (the Claude adapter emits no user prose either); the first prompt
//                     is the title fallback, a `Model Selection` settings change names the model.
//                     Calls still awaiting a result when a new prompt lands are abandoned (an
//                     interrupted turn) — their responses stay null.
//   PLANNER_RESPONSE  the model's turn: `thinking` → message thinking, `content` → message text,
//                     then one tool event per `tool_calls` entry.
//   GENERIC           ONE TOOL RESULT. Results carry no call id: the next N GENERIC steps answer
//                     the N pending calls IN ORDER (a FIFO), so the pair is positional. Each call
//                     gets a synthesized id `step_<planner step_index>_tool_<j>` on its event.
//                     The content leads with "Created At:" / "Completed At:" lines (stripped).
//   SYSTEM_MESSAGE    the harness talking to the model: background-task completions and messages
//                     from other conversations (`[Message] … sender=<id> … content=<text>`). A
//                     completion whose task id names a backgrounded (RUNNING) call fills that
//                     call's response in place — the result belongs to the command; everything
//                     else becomes a `system` message (the timeline keeps what the model was told).
//   CHECKPOINT        a compaction summary → a `system` message.
// Any other type is COUNTED in meta.unknownSteps and warned once per parse — never silently
// dropped (fail loud: a new agy step type must read as format drift, not as an empty book).
// A GENERIC with no pending call (a tail window that opens mid-turn) is counted in
// meta.orphanResults; a call whose result never lands keeps response null (live, or interrupted).
//
// TOOL NAMES stay agy's own (view_file, run_command, …) — the tool registry carries an entry per
// agy name that reads agy's native arg keys (AbsolutePath, CommandLine, TargetFile, …). The
// adapter's half: unwrap double-JSON-encoded path args, and reconstruct the Claude-shaped
// RESPONSE fields the registry's shared meta readers look for, from agy's result TEXT:
//   every result      { output } (+ is_error/error on ERROR|INVALID|error, + exitCode and
//                     is_error on "The command exited with code N≠0", + running/taskId on RUNNING)
//   run_command       stdout = output (line counts)
//   view_file/read_file  file = { numLines, startLine, totalLines } off "Showing lines A-B of T" /
//                     "Total Lines: T" (line-count meta + partial-read range highlight)
//   replace_file_content  structuredPatch off the [diff_block_start]…[diff_block_end] unified diff
//                     (skipped when agy truncated the preview — a partial patch would mislead the
//                     delta books' base reconstruction)
//   edit_file         replacement = { startLine, added, removed } off "Made 1 replacement in …
//                     starting at line L (+A/-R lines)" (its Target is free text, not whole
//                     lines, so no patch is synthesized)
//   write_to_file/write_file  { type: 'create'|'update', content } off the content arg

/** Step types the agy translator understands (anything else is counted as unknown). */
const AGY_STEP_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE', 'CHECKPOINT']);

/** Arg keys holding a PATH — the ones agy is seen to double-JSON-encode ("\"/a/b.go\""). Free-text
 *  args (queries, commands, messages) can legitimately start and end with a quote, so they pass
 *  through untouched. */
const AGY_PATH_ARGS = ['AbsolutePath', 'Path', 'TargetFile', 'SearchPath', 'DirectoryPath', 'Cwd'];

/** "\"/path\"" → "/path" when the value is a JSON-encoded string; anything else unchanged. */
function agyUnquote(v) {
    if (typeof v !== 'string' || v.length < 2 || v[0] !== '"' || v[v.length - 1] !== '"') return v;
    try { const inner = JSON.parse(v); return typeof inner === 'string' ? inner : v; } catch { return v; }
}

/** A tool call's args → the event input: an object (a JSON-string args blob is decoded), path
 *  args unquoted. Non-object args become {} (the call still emits, it just says less). */
function agyInput(args) {
    let a = args;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    if (!a || typeof a !== 'object' || Array.isArray(a)) return {};
    const input = { ...a };
    for (const k of AGY_PATH_ARGS) if (k in input) input[k] = agyUnquote(input[k]);
    return input;
}

/** A tool result's text without the leading "Created At:" / "Completed At:" lines. */
function agyOutput(content) {
    let rest = typeof content === 'string' ? content : '';
    for (;;) {
        const nl = rest.indexOf('\n');
        const line = nl < 0 ? rest : rest.slice(0, nl);
        if (!line.startsWith('Created At:') && !line.startsWith('Completed At:')) break;
        rest = nl < 0 ? '' : rest.slice(nl + 1);
    }
    return rest.trim();
}

/** The typed prompt of a USER_INPUT step (inside <USER_REQUEST>), else the whole content. */
function agyPrompt(content) {
    const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
    return (m ? m[1] : content).trim();
}

const AGY_EXIT_RE = /^(?:The c|C)ommand exited with code (\d+)\./m;
const AGY_TASK_RE = /background task with task id: (\S+)/;
const AGY_REPLACE_RE = /^Made 1 replacement in .* starting at line (\d+) \(\+(\d+)\/-(\d+) lines\)/m;

/** "Showing lines A-B of T" / "Showing lines A to B" + "Total Lines: T" → Claude's file meta. */
function agyReadFile(output, input) {
    const show = /^Showing lines (\d+)\s*(?:-|to)\s*(\d+)(?: of (\d+))?/m.exec(output);
    const total = /^Total Lines: (\d+)/m.exec(output);
    const totalLines = show?.[3] != null ? Number(show[3]) : total ? Number(total[1]) : null;
    if (show) {
        const startLine = Number(show[1]);
        return { numLines: Math.max(0, Number(show[2]) - startLine + 1), startLine, totalLines };
    }
    // No "Showing" header: count the numbered lines the body carries.
    const numbered = output.split('\n').filter((l) => /^\d+: /.test(l));
    if (!numbered.length) return null;
    return { numLines: numbered.length, startLine: Number(input.StartLine) || 1, totalLines };
}

/** The [diff_block_start]…[diff_block_end] unified diff → Claude's structuredPatch hunks. */
function agyDiffPatch(output) {
    if (/middle of the output truncated/.test(output)) return null;
    const m = /\[diff_block_start\]\n([\s\S]*?)\n?\[diff_block_end\]/.exec(output);
    if (!m) return null;
    const hunks = [];
    let h = null;
    for (const line of m[1].split('\n')) {
        const hd = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hd) {
            h = { oldStart: Number(hd[1]), oldLines: hd[2] != null ? Number(hd[2]) : 1,
                  newStart: Number(hd[3]), newLines: hd[4] != null ? Number(hd[4]) : 1, lines: [] };
            hunks.push(h);
        } else if (h && (line[0] === ' ' || line[0] === '+' || line[0] === '-' || line === '')) {
            h.lines.push(line === '' ? ' ' : line);   // a blank context line can lose its leading space
        }
    }
    return hunks.length ? hunks : null;
}

/**
 * Per-tool enrichment of a response whose `output` is set — shared by GENERIC results and
 * background-task completions. Mutates and returns `r`.
 * @param {string} name @param {Object} input @param {Object} r
 */
function agyEnrich(name, input, r) {
    const output = r.output;
    const exit = AGY_EXIT_RE.exec(output);
    if (exit) {
        r.exitCode = Number(exit[1]);
        if (r.exitCode !== 0) r.is_error = true;
    }
    switch (name) {
        case 'run_command':
            r.stdout = output;
            break;
        case 'view_file': case 'read_file': {
            const file = agyReadFile(output, input);
            if (file) r.file = file;
            break;
        }
        case 'replace_file_content': {
            const patch = agyDiffPatch(output);
            if (patch) r.structuredPatch = patch;
            break;
        }
        case 'edit_file': {
            const m = AGY_REPLACE_RE.exec(output);
            if (m) r.replacement = { startLine: Number(m[1]), added: Number(m[2]), removed: Number(m[3]) };
            break;
        }
        case 'write_to_file': case 'write_file': {
            const content = name === 'write_to_file' ? input.CodeContent : input.Content;
            r.type = input.Overwrite ? 'update' : 'create';
            if (typeof content === 'string') r.content = content;
            break;
        }
    }
    return r;
}

/**
 * A GENERIC step → the Claude-shaped response the registry's meta readers understand.
 * @param {string} name   agy tool name
 * @param {Object} input  the call's (unquoted) args
 * @param {Object} step   the GENERIC step (content/status/error)
 * @returns {Object}
 */
function agyResponse(name, input, step) {
    const r = { output: agyOutput(step.content) };
    const err = typeof step.error === 'string' && step.error ? step.error : null;
    if (step.status === 'ERROR' || step.status === 'INVALID' || err) {
        r.is_error = true;
        r.error = err || r.output || String(step.status);
        return r;
    }
    if (step.status === 'RUNNING') {
        r.running = true;
        const t = AGY_TASK_RE.exec(r.output);
        if (t) r.taskId = t[1];
        return r;   // the output is the launch notice — no per-tool shape to read off it
    }
    return agyEnrich(name, input, r);
}

/** The `[Message] timestamp=… sender=… priority=… content=…` entries of a SYSTEM_MESSAGE.
 *  @param {string} content */
function agySystemEntries(content) {
    // The preamble names the tag too ("The following is a <SYSTEM_MESSAGE> not actually sent
    // by the user…"), so the body opens at the LAST opening tag before the closing one.
    const close = content.lastIndexOf('</SYSTEM_MESSAGE>');
    const open = close < 0 ? -1 : content.lastIndexOf('<SYSTEM_MESSAGE>', close);
    const body = (open < 0 ? content : content.slice(open + '<SYSTEM_MESSAGE>'.length, close)).trim();
    return body.split(/^(?=\[Message\] )/m).map((p) => p.trim()).filter(Boolean).map((p) => {
        const h = /^\[Message\] (?:timestamp=\S+ )?sender=(\S+) (?:priority=\S+ )?content=([\s\S]*)$/.exec(p);
        return h ? { sender: h[1], text: h[2].trim() } : { sender: null, text: p };
    });
}

/**
 * Fresh state for the incremental agy step translator — one per conversation. Carries the FIFO
 * of calls awaiting their GENERIC result, the backgrounded calls awaiting a completion message,
 * the harvested-meta accumulators, and the loud-skip counters.
 * @returns {{
 *   pending: Array<{name:string, input:Object, event:Object}>,
 *   running: Map<string, {name:string, input:Object, event:Object}>,
 *   cwd: string|null, title: string|null, model: string|null,
 *   firstTs: number|null, lastTs: number|null,
 *   unknownSteps: Object<string, number>, orphanResults: number
 * }}
 */
export function createAgyState() {
    return {
        pending: [],          // calls emitted, GENERIC result not seen yet (FIFO)
        running: new Map(),   // taskId -> call — backgrounded, completion message not seen yet
        cwd: null, title: null, model: null,
        firstTs: null, lastTs: null,
        unknownSteps: {}, orphanResults: 0,
    };
}

/**
 * Translate ONE parsed agy step into stream events — the single dialect implementation the
 * archive fold (parseAgySession) runs; a live tail can feed it line by line.
 *
 * Pairing is incremental, like the kimi translator: a call emits its event immediately
 * (response null) and its GENERIC result fills that ALREADY-EMITTED event in place; a
 * background-task completion fills a RUNNING call's event the same way.
 * @param {Object} obj    one JSON.parsed transcript line (non-objects are a no-op)
 * @param {Object} state  from createAgyState()
 * @returns {Array} the events this step emitted
 */
export function agyStepToEvents(obj, state) {
    const events = [];
    if (!obj || typeof obj !== 'object') return events;
    const ts = parseTs(obj.created_at);
    const push = (e) => {
        events.push(e);
        if (e.ts != null) { if (state.firstTs === null) state.firstTs = e.ts; state.lastTs = e.ts; }
    };
    if (state.cwd === null && typeof obj.cwd === 'string' && obj.cwd) state.cwd = obj.cwd;
    const type = obj.type;
    if (!AGY_STEP_TYPES.has(type)) {
        const k = String(type);
        state.unknownSteps[k] = (state.unknownSteps[k] || 0) + 1;
        return events;
    }
    const content = typeof obj.content === 'string' ? obj.content : '';

    if (type === 'USER_INPUT') {
        const prompt = agyPrompt(content);
        if (state.title === null && prompt) state.title = prompt;
        // The model in force is the LATEST selection (a settings change mid-conversation moves it).
        const sel = /setting `Model Selection` from .*? to (.+?)\. /.exec(content);
        if (sel) state.model = sel[1];
        if (prompt) state.pending = [];   // a new turn: unanswered calls were interrupted
        return events;
    }
    if (type === 'PLANNER_RESPONSE') {
        if (typeof obj.thinking === 'string' && obj.thinking.trim()) {
            push({ kind: 'message', mtype: 'thinking', text: obj.thinking, ts });
        }
        if (content.trim()) push({ kind: 'message', mtype: 'text', text: content, ts });
        const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
        calls.forEach((tc, j) => {
            const name = typeof tc?.name === 'string' && tc.name ? tc.name : 'unknown';
            const input = agyInput(tc?.args);
            if (state.cwd === null && name === 'run_command' && typeof input.Cwd === 'string' && input.Cwd) {
                state.cwd = input.Cwd;
            }
            const event = { kind: 'tool', id: `step_${obj.step_index}_tool_${j}`, name, input, response: null, ts };
            state.pending.push({ name, input, event });
            push(event);
        });
        return events;
    }
    if (type === 'GENERIC') {
        const call = state.pending.shift();
        if (!call) { state.orphanResults++; return events; }
        const r = agyResponse(call.name, call.input, obj);
        call.event.response = r;
        if (r.running && r.taskId) state.running.set(r.taskId, call);
        return events;
    }
    if (type === 'SYSTEM_MESSAGE') {
        const shown = [];
        for (const { sender, text } of agySystemEntries(content)) {
            const done = /^Task id "([^"]+)" finished with result:\n?([\s\S]*)$/.exec(text);
            const call = done ? state.running.get(done[1]) : null;
            if (call) {
                // The backgrounded call's real result: fill its event in place.
                state.running.delete(done[1]);
                call.event.response = agyEnrich(call.name, call.input,
                    { output: done[2].trim(), backgrounded: true, taskId: done[1] });
                continue;
            }
            shown.push(sender ? `from ${sender}\n\n${text}` : text);
        }
        if (shown.length) push({ kind: 'message', mtype: 'system', text: shown.join('\n\n'), ts });
        return events;
    }
    // CHECKPOINT — the compaction summary the model resumes from.
    if (content.trim()) push({ kind: 'message', mtype: 'system', text: content, ts });
    return events;
}

/**
 * Parse an agy conversation transcript (JSONL text) into the ordered event stream — a fold over
 * agyStepToEvents.
 * @param {string} text  the whole transcript_full.jsonl (or a line-aligned tail window of it)
 * @param {string} [cwd] the conversation's workspace from the archive index — WINS over the
 *        transcript's own (a step `cwd`, else the first run_command Cwd arg), which is
 *        per-command and may sit below the workspace targets should relativize against
 * @returns {{
 *   events: Array<{kind:'tool', id:string, name:string, input:Object, response:*, ts:number|null}
 *                |{kind:'message', mtype:'text'|'thinking'|'system', text:string, ts:number|null}>,
 *   cwd: string|null, firstTs: number|null, lastTs: number|null,
 *   meta: { harness:'agy', cwd:string|null, title:string|null, model:string|null,
 *           firstTs:number|null, lastTs:number|null,
 *           unknownSteps:Object<string,number>, orphanResults:number, malformedLines:number }
 * }}
 * malformedLines counts unparseable lines (a live transcript's torn final line lands here).
 */
export function parseAgySession(text, cwd) {
    return runSteps(parseAgySessionSteps(text, cwd));
}

/**
 * Async, frame-sliced parse — the main-thread surface. Identical output to parseAgySession;
 * see parseClaudeSessionAsync.
 * @param {string} text @param {string} [cwd] @param {{budgetMs?: number}} [opts]
 * @returns {Promise<ReturnType<typeof parseAgySession>>}
 */
export function parseAgySessionAsync(text, cwd, { budgetMs = PARSE_SLICE_MS } = {}) {
    return runStepsAsync(parseAgySessionSteps(text, cwd, budgetMs));
}

/** The ONE agy parse implementation, as a generator (budgeted slices — see parseClaudeSessionSteps). */
function* parseAgySessionSteps(text, cwd, budgetMs = Infinity) {
    const overBudget = makeSliceBudget(budgetMs);
    const state = createAgyState();
    const events = [];
    let malformedLines = 0;
    let i = 0, li = -1;
    for (const line of String(text ?? '').split('\n')) {
        li++;
        if (overBudget(i++)) yield;
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { malformedLines++; continue; }
        for (const e of agyStepToEvents(obj, state)) { e.line = li; events.push(e); }
    }
    const unknown = Object.keys(state.unknownSteps);
    if (unknown.length) {
        console.warn('[sessionAdapter] agy: unknown step types skipped —',
            unknown.map((k) => `${k}×${state.unknownSteps[k]}`).join(', '));
    }
    const cwdOut = (typeof cwd === 'string' && cwd) ? cwd : state.cwd;
    return {
        events, cwd: cwdOut, firstTs: state.firstTs, lastTs: state.lastTs,
        meta: {
            harness: 'agy', cwd: cwdOut, title: state.title, model: state.model,
            firstTs: state.firstTs, lastTs: state.lastTs,
            unknownSteps: state.unknownSteps, orphanResults: state.orphanResults, malformedLines,
        },
    };
}

// --- harness dispatch: the ONE place a harness name picks its parser --------------------------

/** harness name → its sync + async parse; `cwd` is the archive index's working dir (claude's
 *  lines carry their own, so its parser takes none). */
const PARSERS = {
    claude: { sync: (text) => parseClaudeSession(text), async: (text) => parseClaudeSessionAsync(text) },
    kimi:   { sync: parseKimiSession, async: parseKimiSessionAsync },
    agy:    { sync: parseAgySession,  async: parseAgySessionAsync },
};

/** The harnesses an archive entry may name — anything else is a caller or relay bug. */
export const SESSION_HARNESSES = Object.freeze(Object.keys(PARSERS));

/** @param {string} harness @returns {{sync: Function, async: Function}} */
function parserFor(harness) {
    const p = Object.hasOwn(PARSERS, harness) ? PARSERS[harness] : null;
    if (!p) throw new Error(`unknown session harness '${harness}' (want ${SESSION_HARNESSES.join('|')})`);
    return p;
}

/**
 * Parse a transcript in its harness's dialect. THROWS on an unknown harness — a silent fallback
 * to the claude dialect would render another harness's record as an empty book.
 * @param {string} text
 * @param {{harness?: string, cwd?: string|null}} [opts] cwd = the archive index's working dir
 *        (kimi: fallback; agy: the workspace, which wins)
 * @returns {{events: Array, cwd: string|null, firstTs: number|null, lastTs: number|null, meta: Object}}
 */
export function parseSession(text, { harness = 'claude', cwd = null } = {}) {
    return parserFor(harness).sync(text, cwd ?? undefined);
}

/**
 * Async, frame-sliced parseSession — the main-thread surface. Same throw contract.
 * @param {string} text @param {{harness?: string, cwd?: string|null}} [opts]
 * @returns {Promise<ReturnType<typeof parseSession>>}
 */
export function parseSessionAsync(text, { harness = 'claude', cwd = null } = {}) {
    return parserFor(harness).async(text, cwd ?? undefined);
}
