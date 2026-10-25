/**
 * toolRegistry — the PRESENTATION half of an agent's tool calls: how a record's action reads
 * on a page. What a call DID (its action, target, detail, meta) is gomuxai's — its one tool
 * table (`transcript.SummarizeTool`) summarizes every call, and the event stream carries it
 * (collections/agentEvents.js turns an event into a record). This module only colors and
 * decorates by that action:
 *
 *   decorateForAction(action, meta) → [{ startLine, endLine, color, fill }] (0-based, incl.) | null
 *   kindForAction(action)           → the identity bucket an action colors/sorts under
 *   ACTION_HUES                     → the per-kind hues (3D cards and 2D panel dots)
 *   cssHue(hue)                     → a hue as CSS hex
 *
 * DECORATION is keyed by ACTION (which raw tool produced an edit doesn't change how it lights
 * up), reading the meta gomuxai's table documents: a partial read's `range`, an edit's added
 * line `ranges`.
 *
 * Pure: plain `{ r, g, b }` colors, no THREE / DOM — so the unit tests import it.
 */

// Additive highlight — ADDED to the (already syntax-colored) glyph, so it must be bright + saturated
// to read at trail scale. These pop the touched lines without a full background bar.
const ADDED = { r: 0.15, g: 1.00, b: 0.45 };   // bright green — lines an edit added
const READ  = { r: 0.25, g: 0.70, b: 1.00 };   // bright blue  — the slice a partial read touched

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
 * Highlight directives for a snapshot grid, given a record's action + meta (1-based,
 * inclusive line numbers in, 0-based out).
 * @param {string} action  the record's action (read/edit/…)
 * @param {Object} meta
 * @returns {Array<{startLine:number, endLine:number, color:{r:number,g:number,b:number}, fill?:boolean}>|null}
 */
export function decorateForAction(action, meta) {
    if (!meta) return null;
    const d = ACTION_DECORATORS[action] && ACTION_DECORATORS[action](meta);
    return (d && d.length) ? d : null;
}

// --- action identity: kind buckets + hues, the ONE home (3D cards and 2D panel dots) --------------
// Keyed by the record's action (gomuxai's tool table's actions, plus the event kinds prompt/say/
// think/system and noise) — an action not listed here falls to 'other'.

const ACTION_KIND = {
    read: 'read',
    grep: 'search', glob: 'search', search: 'search',
    edit: 'edit', write: 'write',
    bash: 'run', task: 'run',
    ask: 'ask', fetch: 'fetch',
    say: 'say', send: 'say', think: 'think',
    prompt: 'prompt',
    system: 'system',
    noise: 'noise',
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
    prompt: { r: 0.96, g: 0.42, b: 0.78 },   // rose — a message INTO the agent (yours, queued, delivered, a notification)
    system: { r: 0.80, g: 0.74, b: 0.52 },   // muted sand — the HARNESS speaking (system messages, compaction)
    noise:  { r: 0.34, g: 0.36, b: 0.40 },   // dim slate — bookkeeping calls (ToolSearch, TodoWrite…): background, not content
    other:  { r: 0.62, g: 0.64, b: 0.68 },
};

/** An {r,g,b} hue as a CSS hex string — for the 2D panels' identity dots. */
export function cssHue(hue) {
    const h = (n) => Math.round(Math.min(Math.max(n, 0), 1) * 255).toString(16).padStart(2, '0');
    return hue ? `#${h(hue.r)}${h(hue.g)}${h(hue.b)}` : '#999999';
}
