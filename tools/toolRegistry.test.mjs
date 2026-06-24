// toolRegistry.test.mjs — behavior lock for the ONE tool-call registry.
//
//   bun tools/toolRegistry.test.mjs
//
// normalizeToolCall(name, input, response, cwd) → {action, target, detail, result, meta} | null is
// the single seam BOTH the live hook (`agent.tool`) and the replay funnel through, so a regression
// here breaks every trail card. It's pure (no THREE/DOM), so we test it directly with the real
// Claude Code shapes (file.numLines, structuredPatch, stdout, …). decorateForAction(action, meta) is
// the per-action highlight mapping (0-based, inclusive). Adding a tool? add an entry AND a case here.

import { normalizeToolCall, decorateForAction } from '../packages/glyph3d-core/src/collections/toolRegistry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const CWD = '/home/ivan/dev/glyph3d-js/';

// ── read: partial slice → range meta + relativized target + READ decoration ───────────
{
  const r = normalizeToolCall('Read', { file_path: CWD + 'a/b.js' },
    { type: 'text', file: { numLines: 42, startLine: 40, totalLines: 100 } }, CWD);
  eq(r.action, 'read', 'read: action');
  eq(r.target, 'a/b.js', 'read: target relativized');
  eq(r.result, '', 'read: file content IS the snapshot → no result');
  eq(r.meta, { lines: 42, range: [40, 81] }, 'read: partial meta carries range');
  const d = decorateForAction('read', r.meta);
  eq(d?.map(({ startLine, endLine }) => [startLine, endLine]), [[39, 80]], 'read: decorate is 0-based slice');
  ok(d[0].color.b === 1.0, 'read: decoration is the READ (blue) color');
}

// ── read: a FULL read decorates nothing (no range) ────────────────────────────────────
{
  const r = normalizeToolCall('Read', { file_path: CWD + 'x.js' },
    { file: { numLines: 100, startLine: 1, totalLines: 100 } }, CWD);
  eq(r.meta, { lines: 100 }, 'read full: no range');
  eq(decorateForAction('read', r.meta), null, 'read full: no decoration');
}

// ── edit: structuredPatch → added/removed + added-line runs + ADDED decoration ────────
{
  const sp = [{ newStart: 10, lines: [' a', '+b', '+c', ' d', '-e', '+f'] }];
  const r = normalizeToolCall('Edit', { file_path: CWD + 'a.js' }, { structuredPatch: sp }, CWD);
  eq(r.action, 'edit', 'edit: action');
  eq(r.meta, { added: 3, removed: 1, ranges: [[11, 12], [14, 14]] }, 'edit: counts + added runs');
  const d = decorateForAction('edit', r.meta);
  eq(d.map(({ startLine, endLine }) => [startLine, endLine]), [[10, 11], [13, 13]], 'edit: decorate 0-based runs');
  ok(d[0].color.g === 1.0, 'edit: decoration is the ADDED (green) color');
}

// ── edit aliases: MultiEdit / NotebookEdit normalize to the same action ────────────────
{
  eq(normalizeToolCall('MultiEdit', { file_path: CWD + 'm.js' }, { structuredPatch: [] }, CWD).action, 'edit', 'MultiEdit → edit');
  const nb = normalizeToolCall('NotebookEdit', { notebook_path: CWD + 'n.ipynb' }, { structuredPatch: [] }, CWD);
  eq(nb.action, 'edit', 'NotebookEdit → edit');
  eq(nb.target, 'n.ipynb', 'NotebookEdit: target from notebook_path');
}

// ── write: create → kind + line count, no decoration ──────────────────────────────────
{
  const r = normalizeToolCall('Write', { file_path: CWD + 'w.js' }, { type: 'create', content: 'a\nb\nc' }, CWD);
  eq(r.action, 'write', 'write: action');
  eq(r.meta, { kind: 'create', lines: 3 }, 'write: kind + lines');
  eq(decorateForAction('write', r.meta), null, 'write: no decoration (all-new)');
}

// ── bash: no target → keeps stdout as result, lines meta ──────────────────────────────
{
  const r = normalizeToolCall('Bash', { command: 'ls -la' }, { stdout: 'one\ntwo\n', interrupted: false }, CWD);
  eq(r.action, 'bash', 'bash: action');
  eq(r.detail, 'ls -la', 'bash: detail is the command');
  eq(r.result, 'one\ntwo\n', 'bash: result is the stdout (no target)');
  eq(r.meta, { lines: 2 }, 'bash: line count (trailing newline ignored)');
}

// ── grep / glob: detail + result now; meta pending a real shape (null, not a crash) ───
{
  const g = normalizeToolCall('Grep', { path: CWD + 'src', pattern: 'TODO' }, { content: 'src/a.js:1:TODO' }, CWD);
  eq(g.action, 'grep', 'grep: action');
  eq(g.target, '', 'grep: no file target — matches are the output, not a snapshot');
  eq(g.detail, 'TODO', 'grep: detail is the pattern');
  eq(g.result, 'src/a.js:1:TODO', 'grep: matches kept as result (output card)');
  eq(g.meta, null, 'grep: meta null until a real shape lands');
  eq(normalizeToolCall('Glob', { pattern: '**/*.js' }, null, CWD).detail, '**/*.js', 'glob: detail is the pattern');
}

// ── task: subagent → tools/tokens/ms meta; detail prefers subagent_type ───────────────
{
  const r = normalizeToolCall('Task', { subagent_type: 'Explore', description: 'find x' },
    { totalToolUseCount: 7, totalTokens: 1234, totalDurationMs: 4500, content: 'done' }, CWD);
  eq(r.action, 'task', 'task: action');
  eq(r.detail, 'Explore', 'task: detail prefers subagent_type');
  eq(r.meta, { tools: 7, tokens: 1234, ms: 4500 }, 'task: tools/tokens/ms');
  eq(r.result, 'done', 'task: final message kept as result');
  eq(normalizeToolCall('Agent', { description: 'd' }, {}, CWD).action, 'task', 'Agent → task');
}

// ── askUserQuestion / web tools: detail derivation + result text ──────────────────────
{
  const q = normalizeToolCall('AskUserQuestion',
    { questions: [{ question: 'A?' }, { question: 'B?' }] }, 'chose A', CWD);
  eq(q.action, 'ask', 'ask: action');
  eq(q.detail, 'A?\nB?', 'ask: detail joins the questions');
  eq(q.result, 'chose A', 'ask: bare-string response kept as result');
  eq(normalizeToolCall('WebFetch', { url: 'http://x' }, { result: 'summary' }, CWD).detail, 'http://x', 'fetch: detail url');
  eq(normalizeToolCall('WebFetch', { url: 'http://x' }, { result: 'summary' }, CWD).result, 'summary', 'fetch: result from .result');
  eq(normalizeToolCall('WebSearch', { query: 'q' }, { content: 'hits' }, CWD).action, 'search', 'search: action');
}

// ── noise tools drop entirely (null → caller skips) ───────────────────────────────────
{
  eq(normalizeToolCall('TodoWrite', {}, {}, CWD), null, 'TodoWrite → null (noise)');
  eq(normalizeToolCall('ToolSearch', {}, {}, CWD), null, 'ToolSearch → null (noise)');
}

// ── unknown tool: tolerant fallback (lowercased name + first recognizable scalar) ─────
{
  const r = normalizeToolCall('SomeNewTool', { name: 'nope', command: 'do-it' }, { output: 'out' }, CWD);
  eq(r.action, 'somenewtool', 'unknown: lowercased action');
  eq(r.detail, 'do-it', 'unknown: fallback picks the first known scalar (command before name)');
  eq(r.result, 'out', 'unknown: result via generic text extractor (.output)');
}

// ── pickText: an error response is surfaced over normal output ─────────────────────────
{
  const r = normalizeToolCall('Bash', { command: 'boom' }, { is_error: true, error: 'nope', stdout: 'ignored' }, CWD);
  eq(r.result, 'error: nope', 'bash: error preferred over stdout');
}

// ── out-of-cwd target stays absolute (a /tmp file the relay still reaches) ─────────────
{
  const r = normalizeToolCall('Read', { file_path: '/tmp/scratch.txt' }, { file: { numLines: 1 } }, CWD);
  eq(r.target, '/tmp/scratch.txt', 'read: out-of-root target kept absolute');
}

console.log(`\ntoolRegistry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
