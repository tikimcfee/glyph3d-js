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

import { parseKimiSession, parseKimiSessionAsync, kimiAgentIdForSession, createKimiWireState, kimiWireLineToEvents }
  from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const loop = (event, time) => J({ type: 'context.append_loop_event', event, time });

const fixture = [
  // metadata + bookkeeping lines → no events (the Claude adapter's non-message skips mirror);
  // metadata / turn.prompt / llm.request emit nothing but ARE harvested into meta
  J({ type: 'metadata', protocol_version: '1.4', created_at: 999 }),
  J({ type: 'turn.prompt', time: 1000, input: [{ type: 'text', text: 'do the thing' }] }),
  J({ type: 'turn.prompt', time: 1000, input: [{ type: 'text', text: 'second prompt does not override' }] }),
  J({ type: 'context.append_message', time: 1000, message: { role: 'user', content: 'user prose' } }),
  J({ type: 'llm.request', time: 1000, provider: 'kimi', model: 'k3', modelAlias: 'kimi-code/k3' }),
  J({ type: 'llm.request', time: 1000, provider: 'other', model: 'k4', modelAlias: 'kimi-code/k4' }),
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

const { events, cwd, firstTs, lastTs, meta } = parseKimiSession(fixture, '/index/cwd');

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

// ── meta: provenance harvested from the bookkeeping lines (first-seen wins) ───────────
eq(meta, {
  harness: 'kimi', cwd: '/repo',
  title: 'do the thing', createdAt: 999,
  model: 'k3', modelAlias: 'kimi-code/k3', provider: 'kimi',
  firstTs: 1000, lastTs: 1003,
}, 'meta: harness/cwd/title fallback/createdAt/model/alias/provider/span');
ok(meta.cwd === cwd && meta.firstTs === firstTs && meta.lastTs === lastTs,
  'meta span/cwd mirror the top-level fields');

// empty / meta-less transcripts → null fields, harness still set
const bareMeta = parseKimiSession(noCwdFixture).meta;
eq(bareMeta, { harness: 'kimi', cwd: null, title: null, createdAt: null, model: null, modelAlias: null, provider: null, firstTs: 1000, lastTs: 1000 },
  'no meta lines → null fields (cwd parameter fallback applies to meta too when given)');
eq(parseKimiSession(noCwdFixture, '/from/index').meta.cwd, '/from/index', 'meta.cwd falls back to the parameter');
eq(parseKimiSession('').meta, { harness: 'kimi', cwd: null, title: null, createdAt: null, model: null, modelAlias: null, provider: null, firstTs: null, lastTs: null },
  'empty text → all-null meta');

// turn.prompt accepts the old string shape too
eq(parseKimiSession(J({ type: 'turn.prompt', prompt: 'string shape' }) + '\n').meta.title, 'string shape',
  'turn.prompt: plain `prompt` string also harvested');

// ── incremental parity: one line at a time through kimiWireLineToEvents ≡ full parse ──
{
  const state = createKimiWireState();
  const live = [];
  for (const line of fixture.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    live.push(...kimiWireLineToEvents(obj, state));
  }
  eq(live, events, 'live==archive: line-by-line translation yields the SAME events (late results fill in place)');
  eq({
    harness: 'kimi', cwd: state.cwd ?? '/index/cwd',
    title: state.title, createdAt: state.createdAt,
    model: state.model, modelAlias: state.modelAlias, provider: state.provider,
    firstTs: state.firstTs, lastTs: state.lastTs,
  }, meta, 'live==archive: the state accumulators yield the SAME meta');
  eq(state.calls.size, 2, 'pairing map drains to the calls whose results never arrived (edit, glob)');
  eq(state.results.size, 0, 'no orphan results left pending');
}

// result BEFORE its call across batches — pairing still lands
{
  const flipped = [
    loop({ type: 'tool.result', toolCallId: 'tc-x', result: { output: 'early\n' } }, 2000),
    loop({ type: 'tool.call', toolCallId: 'tc-x', name: 'Bash', args: { command: 'echo' } }, 2001),
  ].join('\n') + '\n';
  eq(parseKimiSession(flipped).events[0].response, { output: 'early\n', stdout: 'early\n' },
    'result-before-call pairs in the full parse');
  const st = createKimiWireState();
  const out = [];
  for (const line of flipped.split('\n')) {
    if (!line.trim()) continue;
    out.push(...kimiWireLineToEvents(JSON.parse(line), st));
  }
  eq(out, parseKimiSession(flipped).events, 'result-before-call pairs incrementally too');
  eq(st.calls.size + st.results.size, 0, 'consumed pairing leaves both maps empty');
}

// late result mutates the ALREADY-EMITTED event object (live lanes see the pair complete)
{
  const st = createKimiWireState();
  const [callEv] = kimiWireLineToEvents(JSON.parse(loop({ type: 'tool.call', toolCallId: 'tc-late', name: 'Bash', args: {} }, 3000)), st);
  eq(callEv.response, null, 'call emits with null response before the result');
  const resOut = kimiWireLineToEvents(JSON.parse(loop({ type: 'tool.result', toolCallId: 'tc-late', result: { output: 'done\n' } }, 3001)), st);
  eq(resOut, [], 'tool.result emits no event of its own');
  eq(callEv.response, { output: 'done\n', stdout: 'done\n' }, 'the emitted call event is filled in place');
}

// async driver lockstep: the frame-sliced surface parses IDENTICALLY (budget 0 = yield at every check)
eq(await parseKimiSessionAsync(fixture, '/index/cwd', { budgetMs: 0 }), parseKimiSession(fixture, '/index/cwd'),
  'parseKimiSessionAsync output === sync output (budget 0)');

console.log(`\nkimiSessionAdapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
