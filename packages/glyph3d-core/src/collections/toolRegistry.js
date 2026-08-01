/**
 * toolRegistry — the ONE home for per-tool-call knowledge, keyed by the RAW tool name Claude Code
 * emits (Read, Edit, Bash, …). It turns a raw tool event into the normalized record the agent
 * books render, plus the highlight directives that decorate a snapshot:
 *
 *   normalizeToolCall(name, input, response, cwd) → { action, target, detail, result, meta } | null
 *   decorateForAction(action, meta)               → [{ startLine, endLine, color }] (0-based, incl.) | null
 *
 * ONE entry per tool, all of a tool's knowledge co-located — add a tool = add a TOOLS entry; remove
 * one = delete it; an unmapped tool falls through to a tolerant generic so it still says something.
 * BOTH ingress paths forward the RAW event and call this — the live Go hook (`agent.tool`) and the
 * offline replay (`tools/agent-replay.mjs`) — so there is no second copy of this knowledge anywhere
 * (the hook is pure transport). `normalizeToolCall` returns null for noise tools the caller drops.
 *
 * Pure: plain `{ r, g, b }` colors, no THREE / DOM — so the bun replay and the unit tests import it.
 *
 * A TOOLS entry's fields (all optional):
 *   action          normalized verb (read/edit/…); defaults to the lowercased tool name.
 *   target(input)   the file/path the action is ABOUT — its content becomes the snapshot.
 *   detail(input)   the one meaningful input arg (command, pattern, url, question).
 *   meta(response)  normalized numeric details (lines, +/−, ranges, tokens…) for the info column.
 *   noise: true     drop entirely (TodoWrite/ToolSearch/… — not worth a card).
 * The RESULT text is generic: a file IS its own snapshot (target → no result), everything else
 * keeps its output via `pickText`. DECORATION is keyed by ACTION (which raw tool produced an edit
 * doesn't change how it lights up), so the edit-shaped tools share one decorator for free.
 */

// Additive highlight — ADDED to the (already syntax-colored) glyph, so it must be bright + saturated
// to read at trail scale. These pop the touched lines without a full background bar.
const ADDED = { r: 0.15, g: 1.00, b: 0.45 };   // bright green — lines an edit added
const READ  = { r: 0.25, g: 0.70, b: 1.00 };   // bright blue  — the slice a partial read touched

// --- shared shape readers -------------------------------------------------

/** Walk unified-diff hunks, collecting runs of consecutive ADDED new-file line numbers (1-based). */
function addedRanges(structuredPatch) {
    const ranges = [];
    for (const h of (structuredPatch || [])) {
        let newLine = h.newStart || 1;
        let runStart = null;
        for (const ln of (h.lines || [])) {
            const c = ln[0];
            if (c === '+') {
                if (runStart === null) runStart = newLine;
                newLine++;
            } else {
                if (runStart !== null) { ranges.push([runStart, newLine - 1]); runStart = null; }
                if (c !== '-') newLine++;   // context advances the new-file cursor; '-' (removed) does not
            }
        }
        if (runStart !== null) ranges.push([runStart, newLine - 1]);
    }
    return ranges;
}

/** Total +added / −removed across all hunks. */
function countPatch(structuredPatch) {
    let added = 0, removed = 0;
    for (const h of (structuredPatch || [])) {
        for (const ln of (h.lines || [])) {
            if (ln[0] === '+') added++;
            else if (ln[0] === '-') removed++;
        }
    }
    return { added, removed };
}

/** The output TEXT of a tool response (a bare string or a structured object), preferring an error. */
function pickText(r) {
    if (r == null) return '';
    if (typeof r === 'string') return r;
    if (typeof r !== 'object') return String(r);
    if (r.is_error && typeof r.error === 'string' && r.error) return 'error: ' + r.error;
    if (typeof r.error === 'string' && r.error) return 'error: ' + r.error;
    for (const k of ['stdout', 'content', 'result', 'output']) {
        if (typeof r[k] === 'string' && r[k]) return r[k];
    }
    return '';
}

/** Strip `cwd` off an absolute path so the card reads a short relative path (out-of-root stays absolute). */
function relativize(p, cwd) {
    if (!p || !cwd) return p || '';
    const c = cwd.endsWith('/') ? cwd : cwd + '/';
    return p.startsWith(c) ? p.slice(c.length) : p;
}

/** Unknown tool: surface the first recognizable scalar so the card still says SOMETHING. */
function fallbackDetail(input) {
    if (!input || typeof input !== 'object') return '';
    for (const k of ['command', 'pattern', 'query', 'url', 'description', 'prompt', 'path', 'file_path', 'name']) {
        if (typeof input[k] === 'string' && input[k]) return input[k];
    }
    return '';
}

// --- per-tool meta readers (the bits worth carrying; null = nothing to show) -----------------------

function readMeta(r) {
    const f = r && r.file;
    if (!f) return null;
    if (f.numLines != null) {
        const m = { lines: f.numLines };
        const partial = f.startLine > 1 || (f.totalLines != null && f.numLines < f.totalLines);
        if (partial && f.startLine != null) m.range = [f.startLine, f.startLine + f.numLines - 1];
        return m;
    }
    if (f.originalSize != null) return { bytes: f.originalSize };   // image / binary read
    return null;
}

function editMeta(r) {
    const { added, removed } = countPatch(r && r.structuredPatch);
    return { added, removed, ranges: addedRanges(r && r.structuredPatch) };
}

function writeMeta(r) {
    return { kind: r && r.type, lines: String((r && r.content) || '').split('\n').length };
}

function bashMeta(r) {
    const out = String((r && r.stdout) || '');
    const m = { lines: out ? out.replace(/\n$/, '').split('\n').length : 0 };
    if (r && r.interrupted) m.interrupted = true;
    return m;
}

function taskMeta(r) {
    if (!r || typeof r !== 'object') return null;
    return { tools: r.totalToolUseCount, tokens: r.totalTokens, ms: r.totalDurationMs };
}

/** The question(s) an AskUserQuestion posed — the meaningful input the watcher wants to see. */
function askDetail(input) {
    const qs = input && Array.isArray(input.questions) ? input.questions : [];
    return qs.map((q) => q && q.question).filter(Boolean).join('\n');
}

// --- the registry: RAW tool name → normalized record fields ---------------------------------------

const TOOLS = {
    Read:         { action: 'read',  target: (i) => i.file_path,     meta: readMeta },
    Edit:         { action: 'edit',  target: (i) => i.file_path,     meta: editMeta },
    MultiEdit:    { action: 'edit',  target: (i) => i.file_path,     meta: editMeta },
    NotebookEdit: { action: 'edit',  target: (i) => i.notebook_path, meta: editMeta },
    Write:        { action: 'write', target: (i) => i.file_path,     meta: writeMeta },
    Bash:         { action: 'bash',  detail: (i) => i.command,       meta: bashMeta },
    // No file target — the MATCHES are the output (a sibling card), not a snapshot of the search path
    // (which is often a directory). meta is pending a real Grep/Glob toolUseResult sample.
    Grep:         { action: 'grep',  detail: (i) => i.pattern },
    Glob:         { action: 'glob',  detail: (i) => i.pattern },
    Task:         { action: 'task',  detail: (i) => i.subagent_type || i.description, meta: taskMeta },
    Agent:        { action: 'task',  detail: (i) => i.subagent_type || i.description, meta: taskMeta },
    Workflow:     { action: 'task',  detail: (i) => 'workflow: ' + (i.name || '') },
    // result holds the chosen answer (the tool response carries it as output text); detail is the question.
    AskUserQuestion: { action: 'ask', detail: askDetail },
    WebFetch:     { action: 'fetch',  detail: (i) => i.url },
    WebSearch:    { action: 'search', detail: (i) => i.query },
    // noise — high-frequency bookkeeping not worth a card (dropped at normalize).
    TodoWrite:    { noise: true },
    ToolSearch:   { noise: true },
    TaskGet:      { noise: true },
    TaskOutput:   { noise: true },
};

// DECORATION is per-ACTION, not per-tool (an edit lights up the same whether Edit/MultiEdit produced it).
// `fill: true` asks the consumer for a background-fill BAR (vs an additive tint) — the touched block
// reads as a filled region; the actual opacity is the consumer's knob (e.g. trail cfg.highlightFillOpacity).
const ACTION_DECORATORS = {
    read: (meta) => (meta && meta.range
        ? [{ startLine: meta.range[0] - 1, endLine: meta.range[1] - 1, color: READ, fill: true }]
        : null),
    edit: (meta) => ((meta && meta.ranges) || []).map(([s, e]) => ({ startLine: s - 1, endLine: e - 1, color: ADDED, fill: true })),
};

/**
 * Normalize a RAW tool event into the trail's record fields. The single seam both the live hook and
 * the replay funnel through; pure, so it's the unit-test surface too.
 * @param {string} name      raw Claude Code tool name (Read/Edit/Bash/…)
 * @param {Object} [input]   the tool's input (file_path, command, pattern, …)
 * @param {Object|string} [response] the tool's result (toolUseResult / hook tool_response)
 * @param {string} [cwd]     working dir, to relativize an absolute target path
 * @returns {{action:string, target:string, detail:string, result:string, meta:Object|null}|null}
 *          null for a noise tool the caller should drop.
 */
export function normalizeToolCall(name, input = {}, response = null, cwd = '') {
    const t = TOOLS[name];
    if (t && t.noise) return null;
    const action = (t && t.action) || String(name || 'act').toLowerCase();
    const target = relativize((t && t.target && t.target(input)) || '', cwd);
    const detail = (t && t.detail ? t.detail(input) : (t ? '' : fallbackDetail(input))) ?? '';
    // A file's content IS its snapshot, so a target action carries no result text; everything else
    // keeps its output (the command/search/fetch result becomes a sibling output grid).
    const result = target ? '' : pickText(response);
    const meta = (t && t.meta && t.meta(response)) || null;
    return { action, target, detail, result, meta };
}

// --- conversation blocks: an assistant turn's PROSE → the same record shape ------------------------
// A turn is not only its tool calls — it's the reasoning and speech around them. The hook reads
// `text` / `thinking` blocks from the session transcript (it already has transcript_path) and
// forwards them through the SAME agent.* path as the tools; the offline replay can forward them too.
// So this is the one home for "an assistant block → a record", the sibling of normalizeToolCall:
// a `text` block becomes a `say` moment (what the agent told you), a `thinking` block a `think`
// moment (its interior reasoning, whether or not a tool followed).
//
// The FULL prose rides as the moment's body — NEVER truncated. It takes the same target-less path a
// bash/grep output does ("nothing is truncated here; the grid's layout system does the line-splitting
// and any framing"), so the words are all there to read; you fly into the card. The headline is just
// the role tag. No previews, no gist, no '…' — clamping the corpus is the layout's job, not ours.

/**
 * Normalize one assistant conversation block into the trail's record fields. Pure, so the replay
 * and the unit tests import it alongside normalizeToolCall.
 * @param {string} kind  the transcript block type: 'text' | 'thinking'
 * @param {string} text  the block's prose
 * @returns {{action:string, target:string, detail:string, result:string, meta:null}|null}
 *          null for an empty/whitespace block the caller should drop.
 */
export function normalizeMessage(kind, text) {
    const full = String(text ?? '').trim();
    if (!full) return null;
    const action = String(kind).toLowerCase() === 'thinking' ? 'think' : 'say';
    // result = the whole block, verbatim; no detail/headline preview (that was a truncation seam).
    return { action, target: '', detail: '', result: full, meta: null };
}

/**
 * Highlight directives for a snapshot grid, given a record's action + normalized meta.
 * @param {string} action  normalized action (read/edit/…)
 * @param {Object} meta
 * @returns {Array<{startLine:number, endLine:number, color:{r:number,g:number,b:number}}>|null}
 */
export function decorateForAction(action, meta) {
    if (!meta) return null;
    const d = ACTION_DECORATORS[action] && ACTION_DECORATORS[action](meta);
    return (d && d.length) ? d : null;
}

// --- action identity: kind buckets + hues, the ONE home (3D cards and 2D panel dots) --------------
// Keyed by the NORMALIZED action this registry emits (not raw tool names) — adding a tool
// entry above automatically lands its action in a bucket here, or falls to 'other'.

const ACTION_KIND = {
    read: 'read',
    grep: 'search', glob: 'search', search: 'search',
    edit: 'edit', write: 'write',
    bash: 'run', task: 'run',
    ask: 'ask', fetch: 'fetch',
    say: 'say', think: 'think',
};

/** The identity bucket an action colors/sorts under. Unknown actions read as 'other'. */
export function kindForAction(action) {
    return ACTION_KIND[String(action || '').toLowerCase()] || 'other';
}

/** Default per-kind identity hues (plain {r,g,b} 0–1, pure). Consumers may carry a live
 *  override table (e.g. an agent-books cfg) seeded from this. */
export const ACTION_HUES = {
    read:   { r: 0.35, g: 0.66, b: 0.92 },   // cool blue
    search: { r: 0.70, g: 0.50, b: 0.85 },   // violet
    edit:   { r: 0.90, g: 0.66, b: 0.36 },   // amber
    write:  { r: 0.90, g: 0.66, b: 0.36 },   // amber (its own reachable entry — dial apart at will)
    run:    { r: 0.44, g: 0.76, b: 0.46 },   // mint
    ask:    { r: 0.95, g: 0.58, b: 0.55 },   // warm coral — the agent needs YOU
    fetch:  { r: 0.45, g: 0.82, b: 0.78 },   // teal — reaching out to the network
    say:    { r: 0.92, g: 0.94, b: 0.98 },   // near-white — the agent SPEAKING (its reply to you)
    think:  { r: 0.58, g: 0.52, b: 0.78 },   // dim violet — interior REASONING (the thinking turns)
    other:  { r: 0.62, g: 0.64, b: 0.68 },
};

/** An {r,g,b} hue as a CSS hex string — for the 2D panels' identity dots. */
export function cssHue(hue) {
    const h = (n) => Math.round(Math.min(Math.max(n, 0), 1) * 255).toString(16).padStart(2, '0');
    return hue ? `#${h(hue.r)}${h(hue.g)}${h(hue.b)}` : '#999999';
}
