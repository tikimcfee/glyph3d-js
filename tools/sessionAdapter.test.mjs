// sessionAdapter.test.mjs — behavior lock for harness adapter #1 (Claude Code JSONL).
//
//   bun tools/sessionAdapter.test.mjs
//
// parseClaudeSession(text) → { events, cwd, firstTs, lastTs } is the seam both the replay
// (tools/agent-replay.mjs) and any future bulk loader read a session through, so a regression here
// silently reshapes every replayed book. Pure (no THREE/DOM) — tested directly on a synthetic
// transcript that exercises the real shapes: tool_use/tool_result pairing across distance, the
// three response-merge branches, assistant prose blocks, sidechain/malformed/non-message skips.

import { parseClaudeSession, parseClaudeSessionAsync } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const T = (s) => `2026-08-01T10:00:0${s}.000Z`;
const asst = (extra, ...content) => J({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const user = (extra, ...content) => J({ type: 'user', message: { role: 'user', content }, ...extra });

const SP = [{ newStart: 1, lines: ['+a'] }];
const fixture = [
  // non-message bookkeeping line → no event
  J({ type: 'mode', mode: 'normal' }),
  // malformed line → skipped, parse survives
  '{this is not json',
  // sidechain line → skipped WHOLESALE: its prose, its tool_use, even its cwd must not leak
  asst({ isSidechain: true, cwd: '/side/land', timestamp: T(0) },
    { type: 'text', text: 'sidechain prose' },
    { type: 'tool_use', id: 'tu-side', name: 'Bash', input: { command: 'rm -rf /' } }),
  // thinking + text blocks, in block order; first-seen cwd
  asst({ cwd: '/main/repo', timestamp: T(0) },
    { type: 'thinking', thinking: 'let me think' },
    { type: 'text', text: 'hello world' }),
  // whitespace-only text dropped; the tool_use beside it still emits
  asst({ timestamp: T(1) },
    { type: 'text', text: '   \n  ' },
    { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/main/repo/a.js' } }),
  asst({ timestamp: T(2) }, { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls' } }),
  asst({ timestamp: T(3) }, { type: 'tool_use', id: 'tu-grep', name: 'Grep', input: { pattern: 'x' } }),
  // no timestamp on this line → ts null; its result never arrives → response null
  asst({}, { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/main/repo/b.js' } }),
  // a USER text block is the prompt, not assistant prose → no message event
  user({ timestamp: T(5) }, { type: 'text', text: 'do the thing' }),
  // structured toolUseResult HAS stdout → kept verbatim, result text NOT merged in
  user({ timestamp: T(6), toolUseResult: { stdout: 'one\ntwo\n', interrupted: false } },
    { type: 'tool_result', tool_use_id: 'tu-bash', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }),
  // no structured object → the plain result text IS the response
  user({ timestamp: T(7) }, { type: 'tool_result', tool_use_id: 'tu-grep', content: 'src/a.js:1:x' }),
  // pairing across distance: the FIRST tool's result lands LAST; structured lacks a text field →
  // the result text rides in as `content`
  user({ timestamp: T(8), toolUseResult: { structuredPatch: SP } },
    { type: 'tool_result', tool_use_id: 'tu-edit', content: 'The file has been updated' }),
  // trailing prose after the last tool
  asst({ timestamp: T(9) }, { type: 'text', text: 'all done' }),
].join('\n') + '\n';

const { events, cwd, firstTs, lastTs } = parseClaudeSession(fixture);

// ── stream shape: 7 events, transcript order, tools at their tool_use positions ───────
eq(events.length, 7, 'event count (skips: sidechain, malformed, non-message, user prompt, blank text)');
eq(events.map((e) => e.kind), ['message', 'message', 'tool', 'tool', 'tool', 'tool', 'message'], 'kinds in transcript order');
eq(events.filter((e) => e.kind === 'tool').map((e) => e.name), ['Edit', 'Bash', 'Grep', 'Read'],
  'tools emit at tool_use order, not result-arrival order');

// ── message events ────────────────────────────────────────────────────────────────────
eq(events[0], { kind: 'message', mtype: 'thinking', text: 'let me think', ts: Date.parse(T(0)) }, 'thinking block');
eq(events[1], { kind: 'message', mtype: 'text', text: 'hello world', ts: Date.parse(T(0)) }, 'text block after it');
eq(events[6].text, 'all done', 'trailing prose is the last event');
ok(!events.some((e) => e.text === 'sidechain prose'), 'sidechain prose skipped');
ok(!events.some((e) => e.text === 'do the thing'), 'user prompt text is not a message event');

// ── response merge: the three branches ────────────────────────────────────────────────
const [edit, bash, grep, read] = events.filter((e) => e.kind === 'tool');
eq(edit.response, { structuredPatch: SP, content: 'The file has been updated' },
  'structured w/o text field: result text merged in as content (across-distance pairing)');
eq(bash.response, { stdout: 'one\ntwo\n', interrupted: false },
  'structured WITH stdout: kept verbatim, no merge');
eq(grep.response, 'src/a.js:1:x', 'no structured: bare result text');
eq(read.response, null, 'no result at all: null');
ok(!events.some((e) => e.name === 'Bash' && e.input?.command === 'rm -rf /'), 'sidechain tool_use skipped');

// ── inputs ride raw ───────────────────────────────────────────────────────────────────
eq(edit.input, { file_path: '/main/repo/a.js' }, 'tool input passes through untouched');

// ── ts / cwd / span ───────────────────────────────────────────────────────────────────
eq(edit.ts, Date.parse(T(1)), 'tool ts from its line timestamp (epoch ms)');
eq(read.ts, null, 'line without a timestamp → ts null');
eq(cwd, '/main/repo', 'first-seen cwd (sidechain cwd does not leak)');
eq(firstTs, Date.parse(T(0)), 'firstTs = first timestamped event');
eq(lastTs, Date.parse(T(9)), 'lastTs = last timestamped event');

// ── degenerate inputs don't throw ─────────────────────────────────────────────────────
eq(parseClaudeSession('').events, [], 'empty text → no events');
eq(parseClaudeSession('').cwd, null, 'empty text → null cwd');
eq(parseClaudeSession('null\n42\n"str"\n').events, [], 'non-object JSON lines skipped');

// ── async driver lockstep: the frame-sliced surface parses IDENTICALLY ─────────────────
// budgetMs 0 forces a yield at every clock check, so the sliced path is fully exercised.
const asyncOut = await parseClaudeSessionAsync(fixture, { budgetMs: 0 });
eq(asyncOut, parseClaudeSession(fixture), 'parseClaudeSessionAsync output === sync output (budget 0)');

console.log(`\nsessionAdapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
