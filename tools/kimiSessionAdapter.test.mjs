// kimiSessionAdapter.test.mjs — behavior lock for harness adapter #2 (Kimi Code wire.jsonl).
//
//   bun tools/kimiSessionAdapter.test.mjs
//
// parseKimiSession(text, cwd) → { events, cwd, firstTs, lastTs } is the kimi half of the
// session-adapter seam — the SAME event shapes parseClaudeSession emits, so the books, the
// tool registry, and the replay can't tell which harness a session came from. Pure (no
// THREE/DOM) — tested on a synthetic wire log that exercises the real shapes: content.part
// think/text, tool.call/tool.result pairing across distance, the path→file_path dialect
// rename, the Bash stdout + Read file-meta enrichments, and the bookkeeping-line skips.

import { parseKimiSession, kimiAgentIdForSession } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const loop = (event, time) => J({ type: 'context.append_loop_event', event, time });

const fixture = [
  // metadata + bookkeeping lines → no events (the Claude adapter's non-message skips mirror)
  J({ type: 'metadata', protocol_version: '1.4', created_at: 999 }),
  J({ type: 'turn.prompt', time: 1000, prompt: 'do the thing' }),
  J({ type: 'context.append_message', time: 1000, message: { role: 'user', content: 'user prose' } }),
  J({ type: 'llm.request', time: 1000 }),
  J({ type: 'usage.record', time: 1000 }),
  loop({ type: 'step.begin' }, 1000),
  // malformed + non-object lines → skipped, parse survives
  '{this is not json',
  '42',
  // think + text parts, in line order; a whitespace-only part drops
  loop({ type: 'content.part', part: { type: 'think', think: 'let me think' } }, 1000),
  loop({ type: 'content.part', part: { type: 'text', text: 'hello world' } }, 1000),
  loop({ type: 'content.part', part: { type: 'text', text: '   \n  ' } }, 1000),
  // Read: path → file_path; partial read (line_offset 40) — its result lands LAST (pairing
  // across distance) and gets the synthesized file meta
  loop({ type: 'tool.call', toolCallId: 'tc-read', name: 'Read', args: { path: '/repo/a.js', line_offset: 40 } }, 1001),
  // Bash: display.cwd is the transcript's cwd source; output → stdout enrichment
  loop({ type: 'tool.call', toolCallId: 'tc-bash', name: 'Bash', args: { command: 'ls' }, display: { kind: 'command', cwd: '/repo' } }, 1002),
  // Edit: path → file_path; NO time → ts null; its result never arrives → response null
  loop({ type: 'tool.call', toolCallId: 'tc-edit', name: 'Edit', args: { path: '/repo/b.js', old_string: 'a', new_string: 'b' } }),
  // Glob: `path` is a search DIR, not a file target — left alone
  loop({ type: 'tool.call', toolCallId: 'tc-glob', name: 'Glob', args: { pattern: '**/*.js', path: '/repo' } }, 1003),
  loop({ type: 'step.end' }, 1004),
  // results ride LATER lines: bash's here, the first tool's (read) dead last
  loop({ type: 'tool.result', toolCallId: 'tc-bash', result: { output: 'one\ntwo\n' } }, 1005),
  loop({ type: 'tool.result', toolCallId: 'tc-read', result: { output: '40\tfoo\n41\tbar\n' } }, 1006),
].join('\n') + '\n';

const { events, cwd, firstTs, lastTs } = parseKimiSession(fixture, '/index/cwd');

// ── stream shape: 6 events, transcript order, tools at their call positions ──────────
eq(events.length, 6, 'event count (skips: metadata, turn.prompt, user prose, llm/usage, step.*, malformed, non-object, blank part)');
eq(events.map((e) => e.kind), ['message', 'message', 'tool', 'tool', 'tool', 'tool'], 'kinds in transcript order');
eq(events.filter((e) => e.kind === 'tool').map((e) => e.name), ['Read', 'Bash', 'Edit', 'Glob'],
  'tools emit at tool.call order, not result-arrival order');

// ── message events ────────────────────────────────────────────────────────────────────
eq(events[0], { kind: 'message', mtype: 'thinking', text: 'let me think', ts: 1000 }, 'think part → thinking event');
eq(events[1], { kind: 'message', mtype: 'text', text: 'hello world', ts: 1000 }, 'text part → text event');
ok(!events.some((e) => e.text === 'user prose'), 'user prose is not a message event');

// ── dialect translation: inputs come out Claude-shaped ────────────────────────────────
const [read, bash, edit, glob] = events.filter((e) => e.kind === 'tool');
eq(read.input, { line_offset: 40, file_path: '/repo/a.js' }, 'Read: path renamed to file_path');
eq(edit.input, { old_string: 'a', new_string: 'b', file_path: '/repo/b.js' }, 'Edit: path renamed to file_path');
eq(glob.input, { pattern: '**/*.js', path: '/repo' }, 'Glob: path left alone (a search dir, not a file)');
eq(bash.input, { command: 'ls' }, 'Bash: args pass through');

// ── response pairing + enrichments ────────────────────────────────────────────────────
eq(read.response, { output: '40\tfoo\n41\tbar\n', file: { numLines: 2, startLine: 40 } },
  'Read: result paired across distance + synthesized file meta (line_offset → startLine)');
eq(bash.response, { output: 'one\ntwo\n', stdout: 'one\ntwo\n' }, 'Bash: stdout enrichment from output');
eq(edit.response, null, 'no result line → response null');
eq(glob.response, null, 'no result line → response null');

// ── ts / cwd / span ───────────────────────────────────────────────────────────────────
eq(read.ts, 1001, 'tool ts from the line time (epoch ms)');
eq(edit.ts, null, 'line without time → ts null');
eq(cwd, '/repo', 'cwd from the first tool.call display.cwd (not the parameter)');
eq(firstTs, 1000, 'firstTs = first timestamped event');
eq(lastTs, 1003, 'lastTs = last timestamped EVENT (result lines emit nothing)');

// ── cwd fallback: no display.cwd anywhere → the parameter, else null ──────────────────
const noCwdFixture = loop({ type: 'content.part', part: { type: 'text', text: 'hi' } }, 1000) + '\n';
eq(parseKimiSession(noCwdFixture, '/from/index').cwd, '/from/index', 'cwd falls back to the parameter');
eq(parseKimiSession(noCwdFixture).cwd, null, 'no display.cwd, no parameter → null cwd');

// ── degenerate inputs don't throw ─────────────────────────────────────────────────────
eq(parseKimiSession('').events, [], 'empty text → no events');
eq(parseKimiSession('null\n"s"\n').events, [], 'non-object JSON lines skipped');

// ── lane id derivation: the `session_` prefix must not collapse every kimi session ────
eq(kimiAgentIdForSession('session_474cf46e-c317-40eb-ae0e-e02cd9aaa074'), '474cf46e', 'kimi id: strip session_ + dashes, first 8');
eq(kimiAgentIdForSession('474cf46e-c317'), '474cf46e', 'id without the prefix still derives');
eq(kimiAgentIdForSession('session_'), 'kimi', 'empty after strip → kimi');
eq(kimiAgentIdForSession(null), 'kimi', 'null → kimi');

console.log(`\nkimiSessionAdapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
