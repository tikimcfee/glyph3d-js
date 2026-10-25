// agySessionAdapter.test.mjs — behavior lock for harness adapter #3 (Antigravity CLI transcripts).
//
//   bun tools/agySessionAdapter.test.mjs
//
// parseAgySession(text, cwd) → { events, cwd, firstTs, lastTs, meta } is the agy half of the
// session-adapter seam — the SAME event shapes the claude/kimi adapters emit, so the books and the
// tool registry can't tell which harness a session came from. Pure (no THREE/DOM) — tested on a
// synthetic transcript modeled on real transcript_full.jsonl steps: USER_INPUT prompt/settings
// harvest, PLANNER thinking/text/tool_calls, FIFO GENERIC pairing (no ids), the Created/Completed
// strip, failures (ERROR / INVALID / non-zero exit), RUNNING → completion SYSTEM_MESSAGE filled in
// place, cross-conversation SYSTEM_MESSAGE + CHECKPOINT as system sheets, double-encoded path args,
// loud counters (unknown step types, orphan results, malformed lines), the harness dispatch, and a
// tail-grow read through a mock relay (window opening mid-turn, torn final line, index title).

import { parseAgySession, parseAgySessionAsync, parseSession, parseSessionAsync, SESSION_HARNESSES,
         agentIdForEntry, createAgyState, agyStepToEvents }
  from '../packages/glyph3d-core/src/collections/sessionAdapter.js';
import { kindForAction } from '../packages/glyph3d-core/src/collections/toolRegistry.js';
import { eventsToRecords, runSessionParseJob } from '../packages/glyph3d-core/src/workers/sessionParseJob.js';
import { readSessionTail } from '../packages/glyph3d-core/src/services/data/sessionTailRead.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const CONV = '83d95154-0000-4000-8000-000000000001';
const T = (s) => `2026-10-25T00:27:${String(s).padStart(2, '0')}Z`;
const ms = (s) => Date.parse(T(s));
const S = (step) => J({ source: 'MODEL', status: 'DONE', ...step });
const stamp = 'Created At: 2026-10-24T19:27:21-05:00\nCompleted At: 2026-10-24T19:27:22-05:00\n';
const sys = (body) => 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the '
  + 'system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n' + body + '\n</SYSTEM_MESSAGE>';

const lines = [
  // ── turn 1: prompt (title) + a settings change naming the model ──
  S({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(0),
      content: '<USER_REQUEST>\nlist the files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-24T19:27:17-05:00.\n</ADDITIONAL_METADATA>\n'
        + '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>' }),
  // thinking + 3 calls; results arrive as the next 3 GENERIC steps IN ORDER (no ids)
  S({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: T(1), input_tokens: 12888, output_tokens: 185,
      thinking: 'I should list them and read the readme.',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls', Cwd: '/proj/sub', WaitMsBeforeAsync: 5000, toolSummary: 'List files' } },
        // a double-JSON-encoded path (seen on older view_file calls)
        { name: 'view_file', args: { AbsolutePath: '"/proj/README.md"', StartLine: 3, EndLine: 4 } },
        { name: 'read_file', args: J({ Path: '/proj/notes.md' }) },   // args as a JSON string
      ] }),
  S({ step_index: 2, type: 'GENERIC', created_at: T(2), content: stamp + '\nThe command exited with code 0.\nOutput:\nREADME.md\nnotes.md' }),
  S({ step_index: 3, type: 'GENERIC', created_at: T(3),
      content: stamp + 'File Path: `file:///proj/README.md`\nTotal Lines: 10\nTotal Bytes: 99\nShowing lines 3 to 4\n3: hello\n4: world' }),
  S({ step_index: 4, type: 'GENERIC', created_at: T(4), content: stamp + 'Showing lines 1-2 of 2\n1: a\n2: b' }),
  // malformed + unknown-type lines: counted, parse survives
  '{this is not json',
  S({ step_index: 5, type: 'FUTURE_STEP', created_at: T(5), content: 'new agy thing' }),
  // reply text, no calls
  S({ step_index: 6, type: 'PLANNER_RESPONSE', created_at: T(6), content: 'Two files: README.md and notes.md.' }),

  // ── turn 2: edits, failures, a background task ──
  S({ step_index: 7, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(7), content: '<USER_REQUEST>\nfix it\n</USER_REQUEST>' }),
  S({ step_index: 8, type: 'PLANNER_RESPONSE', created_at: T(8), tool_calls: [
      { name: 'replace_file_content', args: { TargetFile: '/proj/a.js', StartLine: 4, EndLine: 4, TargetContent: 'x', ReplacementContent: 'y' } },
      { name: 'edit_file', args: { Path: '/proj/b.js', Target: 'old', Replacement: 'new\nnewer' } },
      { name: 'write_to_file', args: { TargetFile: '/proj/c.md', CodeContent: 'one\ntwo\nthree', Overwrite: false } },
      { name: 'run_command', args: { CommandLine: 'go build ./...' } },
      { name: 'view_file', args: { AbsolutePath: '/etc/secret' } },
      { name: 'view_file', args: { AbsolutePath: '/proj/x' } },
      { name: 'run_command', args: { CommandLine: 'sleep 100' } },
    ] }),
  S({ step_index: 9, type: 'GENERIC', created_at: T(9), content: stamp
      + 'The following changes were made by the replace_file_content tool to: /proj/a.js.\n[diff_block_start]\n@@ -3,3 +3,4 @@\n ctx\n-x\n+y\n+y2\n\n[diff_block_end]\n\nPlease note that the above snippet only shows the MODIFIED lines.' }),
  S({ step_index: 10, type: 'GENERIC', created_at: T(10), content: stamp + 'Made 1 replacement in /proj/b.js starting at line 409 (+2/-1 lines).' }),
  S({ step_index: 11, type: 'GENERIC', created_at: T(11), content: stamp + 'Created file /proj/c.md' }),
  S({ step_index: 12, type: 'GENERIC', created_at: T(12), content: stamp + '\nThe command exited with code 1.\nOutput:\nmain.go:3: undefined: x' }),
  S({ step_index: 13, type: 'GENERIC', status: 'ERROR', created_at: T(13), error: 'permission denied',
      content: 'Created At: 2026-10-24T19:28:04-05:00\nEncountered error in step execution: permission denied' }),
  S({ step_index: 14, type: 'GENERIC', status: 'INVALID', created_at: T(14),
      content: stamp + "Error invalid tool call: invalid arguments:\n- missing property 'toolSummary'" }),
  S({ step_index: 15, type: 'GENERIC', status: 'RUNNING', created_at: T(15),
      content: `Created At: 2026-10-24T19:28:05-05:00\nTool is running as a background task with task id: ${CONV}/task-15\nTask logs are available at: file:///home/u/.gemini/antigravity-cli/brain/${CONV}/.system_generated/tasks/task-15.log` }),
  // the completion (fills task-15 in place) + a cross-conversation message (a system sheet),
  // in ONE system message — the preamble's "<SYSTEM_MESSAGE>" mention is the tag trap
  S({ step_index: 16, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: T(16), content: sys(
      `[Message] timestamp=2026-10-25T00:31:56Z sender=${CONV}/task-15 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-15" finished with result:\nCommand exited with code 0.\n\nCommand output:\nslept\n`
      + '[Message] timestamp=2026-10-25T00:52:21Z sender=27f6670e-0000-4000-8000-000000000002 priority=MESSAGE_PRIORITY_HIGH content=# Findings\nall good') }),
  S({ step_index: 17, type: 'PLANNER_RESPONSE', created_at: T(17), tool_calls: [
      { name: 'send_message', args: { Recipient: '27f6670e-0000-4000-8000-000000000002', Message: 'thanks — next: X' } },
      { name: 'invoke_subagent', args: { Subagents: [{ Role: 'Perf Researcher', TypeName: 'research', Prompt: 'look' }] } },
      { name: 'run_command', args: { CommandLine: 'interrupted before its result' } },
    ] }),
  S({ step_index: 18, type: 'GENERIC', created_at: T(18), content: stamp + 'Message sent to "27f6670e-0000-4000-8000-000000000002".' }),
  S({ step_index: 19, type: 'GENERIC', created_at: T(19), content: stamp + 'Created the following subagent: {...}' }),
  // a new prompt while run_command is still pending: the turn was interrupted — its response stays null
  S({ step_index: 20, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(20), content: '<USER_REQUEST>\nstop\n</USER_REQUEST>' }),
  S({ step_index: 21, source: 'SYSTEM', type: 'CHECKPOINT', created_at: T(21), content: '# Resuming from a compaction\n\n<summary>did things</summary>' }),
];
const fixture = lines.join('\n') + '\n';

// The unknown step type must WARN (loud), not vanish — every warn is captured for the asserts.
const warns = [];
console.warn = (...a) => { warns.push(a.join(' ')); };
const out = parseAgySession(fixture, '/proj');
const { events, cwd, firstTs, lastTs, meta } = out;

// ── stream shape ──────────────────────────────────────────────────────────────
eq(events.map((e) => e.kind === 'tool' ? e.name : `${e.mtype}`), [
  'thinking', 'run_command', 'view_file', 'read_file', 'text',
  'replace_file_content', 'edit_file', 'write_to_file', 'run_command', 'view_file', 'view_file', 'run_command',
  'system', 'send_message', 'invoke_subagent', 'run_command', 'system',
], 'events in transcript order; tools at their PLANNER position; system sheets for the message + checkpoint');
const tools = events.filter((e) => e.kind === 'tool');
eq(tools.slice(0, 3).map((e) => e.id), ['step_1_tool_0', 'step_1_tool_1', 'step_1_tool_2'], 'synthesized ids: step_<i>_tool_<j>');
eq(events[0].ts, ms(1), 'ts = created_at as epoch ms');
eq([firstTs, lastTs], [ms(1), ms(21)], 'firstTs/lastTs span the emitted events');
eq(cwd, '/proj', 'the index workspace wins over the run_command Cwd');
eq(parseAgySession(fixture).cwd, '/proj/sub', 'no index cwd → the first run_command Cwd');

// ── meta harvest + loud counters ──────────────────────────────────────────────
eq(meta.harness, 'agy', 'meta.harness');
eq(meta.title, 'list the files', 'title = the first <USER_REQUEST> (metadata blocks stripped)');
eq(meta.model, 'Gemini 4 Argon (High)', 'model off the Model Selection settings change');
eq(meta.unknownSteps, { FUTURE_STEP: 1 }, 'unknown step type COUNTED');
ok(warns.some((w) => w.includes('FUTURE_STEP×1')), 'unknown step type WARNED once per parse');
eq(meta.malformedLines, 1, 'malformed line counted');
eq(meta.orphanResults, 0, 'every GENERIC found its call');

// ── FIFO pairing + per-tool response reconstruction ───────────────────────────
const [ls, view, read] = tools;
eq(ls.response.stdout, 'The command exited with code 0.\nOutput:\nREADME.md\nnotes.md', 'Created/Completed stripped; stdout = output');
eq(ls.response.exitCode, 0, 'exit 0 parsed');
ok(!ls.response.is_error, 'exit 0 is not a failure');
eq(view.input.AbsolutePath, '/proj/README.md', 'double-encoded path arg unquoted');
eq(view.response.file, { numLines: 2, startLine: 3, totalLines: 10 }, 'view_file: "Showing lines 3 to 4" + Total Lines → file meta');
eq(read.input.Path, '/proj/notes.md', 'JSON-string args decoded');
eq(read.response.file, { numLines: 2, startLine: 1, totalLines: 2 }, 'read_file: "Showing lines 1-2 of 2"');

const [rep, edit, write, build, denied, invalid, sleep] = tools.slice(3);
eq(rep.response.structuredPatch, [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' ctx', '-x', '+y', '+y2', ' '] }],
  'replace_file_content: the diff block → structuredPatch');
eq(edit.response.replacement, { startLine: 409, added: 2, removed: 1 }, 'edit_file: "Made 1 replacement … (+2/-1 lines)"');
eq([write.response.type, write.response.content], ['create', 'one\ntwo\nthree'], 'write_to_file: type + content off the args');
ok(build.response.is_error === true && build.response.exitCode === 1, 'exit code 1 → is_error + exitCode');
eq([denied.response.is_error, denied.response.error], [true, 'permission denied'], 'ERROR + error field → is_error/error');
ok(invalid.response.is_error === true && /missing property/.test(invalid.response.error), 'INVALID → is_error, output as the error');

// RUNNING → completion SYSTEM_MESSAGE fills the SAME event in place
ok(sleep.response.backgrounded === true && sleep.response.taskId === `${CONV}/task-15`, 'background completion filled the RUNNING call in place');
eq(sleep.response.stdout, 'Command exited with code 0.\n\nCommand output:\nslept', 'completion output enriched like any run_command result');
const sysMsg = events.find((e) => e.mtype === 'system');
eq(sysMsg.text, 'from 27f6670e-0000-4000-8000-000000000002\n\n# Findings\nall good',
  'the cross-conversation message (only) becomes the system sheet; the preamble tag mention is not the body');
eq(tools[tools.length - 1].response, null, 'a call interrupted by a new prompt keeps response null');

// ── incremental: RUNNING before its completion arrives ────────────────────────
{
  const st = createAgyState();
  const evs = agyStepToEvents(JSON.parse(lines[9]), st);   // the 7-call planner
  for (let k = 10; k <= 16; k++) agyStepToEvents(JSON.parse(lines[k]), st);
  const bg = evs[6];
  ok(bg.response.running === true && bg.response.taskId === `${CONV}/task-15`, 'RUNNING: launch notice + task id');
  ok(st.running.has(`${CONV}/task-15`), 'RUNNING call parked under its task id');
  agyStepToEvents(JSON.parse(lines[17]), st);
  ok(!st.running.has(`${CONV}/task-15`) && bg.response.backgrounded === true, 'completion fills the emitted event and releases it');
}

// ── normalized records through the ONE registry ───────────────────────────────
{
  const recs = eventsToRecords(events, cwd);
  const by = (a) => recs.filter((r) => r.action === a);
  eq(recs.map((r) => r.action), [
    'think', 'bash', 'read', 'read', 'say',
    'edit', 'edit', 'write', 'bash', 'read', 'read', 'bash',
    'system', 'send', 'task', 'bash', 'system',
  ], 'actions: agy tools land on the Read/Edit/Write/Bash/Task equivalents');
  const r0 = by('read')[0];
  eq([r0.target, r0.meta], ['README.md', { lines: 2, range: [3, 4] }], 'view_file: relativized target + partial-read range');
  eq(by('read')[1].meta, { lines: 2 }, 'read_file: whole file → no range');
  const [e0, e1] = by('edit');
  eq([e0.target, e0.meta.added, e0.meta.removed, e0.meta.ranges], ['a.js', 2, 1, [[4, 5]]], 'replace_file_content: patch → +/− and added ranges');
  ok(Array.isArray(e0.meta.patch), 'replace_file_content: hunks ride on meta.patch (delta books)');
  eq([e1.target, e1.meta], ['b.js', { added: 2, removed: 1, ranges: [[409, 410]] }], 'edit_file: replacement → +/− and range, no patch');
  eq(by('write')[0].meta, { kind: 'create', lines: 3 }, 'write_to_file: writeMeta');
  eq([by('bash')[0].detail, by('bash')[0].meta], ['ls', { lines: 4 }], 'run_command: detail = CommandLine, line count');
  eq(by('send')[0].detail, '→ 27f6670e-0000-4000-8000-000000000002\nthanks — next: X', 'send_message: recipient + the whole message');
  eq(by('task')[0].detail, 'Perf Researcher', 'invoke_subagent: the role');
  eq(by('system')[1].result, '# Resuming from a compaction\n\n<summary>did things</summary>', 'CHECKPOINT: the summary verbatim');
  eq(kindForAction('system'), 'system', 'system has its own identity bucket');
  eq(kindForAction('send'), 'say', 'send buckets with say');
}

// ── orphan results: a tail window that opens mid-turn ─────────────────────────
{
  const tail = lines.slice(3).join('\n') + '\n';   // starts at the view_file result
  const t = parseAgySession(tail, '/proj');
  eq(t.meta.orphanResults, 2, 'GENERICs before any planner in the window are counted as orphans');
  ok(t.events[0].mtype === 'text', 'the window still parses from its first planner');
}

// ── shape tolerance: odd fields never crash ───────────────────────────────────
{
  const odd = [
    J({ type: 'PLANNER_RESPONSE', tool_calls: [{ args: null }, { name: 'view_file', args: [1, 2] }, null], content: 42 }),
    J({ type: 'GENERIC' }), J({ type: 'GENERIC', content: null, status: 'ERROR' }), J({ type: 'GENERIC' }),
    J({ type: 'USER_INPUT', content: { not: 'a string' } }),
    J({ type: 'SYSTEM_MESSAGE' }), J({ type: 'CHECKPOINT', content: '   ' }),
    J({ type: 'SYSTEM_MESSAGE', content: 'plain text, no tags' }),
    J({ noType: true }), '[]', 'null',
  ].join('\n');
  const w0 = warns.length;
  const t = parseAgySession(odd);
  const seen = warns.slice(w0);
  eq(t.events.map((e) => e.kind === 'tool' ? e.name : e.mtype), ['unknown', 'view_file', 'unknown', 'system'],
    'odd steps: nameless call → "unknown", non-object args → {}, null call tolerated, untagged system text kept');
  ok(t.events.every((e) => e.kind !== 'tool' || e.response !== undefined), 'every tool event has a response slot');
  eq(t.events[1].response?.error, 'ERROR', 'an ERROR step with no text still reads as a failure');
  eq(t.meta.unknownSteps, { undefined: 2 }, 'typeless lines (an object without `type`, an array) are counted, not dropped silently');
  eq(t.meta.orphanResults, 0, 'three GENERICs, three calls');
  ok(seen.length === 1, 'warned once');
}

// ── harness dispatch + async parity + lane id ────────────────────────────────
{
  eq(SESSION_HARNESSES, ['claude', 'kimi', 'agy'], 'the known harnesses');
  eq(J(parseSession(fixture, { harness: 'agy', cwd: '/proj' })), J(out), 'parseSession dispatches agy');
  eq(J(await parseSessionAsync(fixture, { harness: 'agy', cwd: '/proj' })), J(out), 'parseSessionAsync dispatches agy');
  eq(J(await parseAgySessionAsync(fixture, '/proj', { budgetMs: 0 })), J(out), 'async (yielding every slice) === sync');
  let threw = null;
  try { parseSession('', { harness: 'gemini' }); } catch (e) { threw = e.message; }
  ok(threw && threw.includes("unknown session harness 'gemini'"), 'an unknown harness THROWS (no silent claude fallback)');
  threw = null;
  try { parseSession('', { harness: 'constructor' }); } catch (e) { threw = e.message; }
  ok(!!threw, 'a prototype key is not a harness');
  eq(agentIdForEntry({ id: CONV, harness: 'agy' }), '83d95154', 'agy lane id: dashes stripped, first 8');
}

// ── tail-grow read through a mock relay: torn final line + index title ────────
{
  // A live transcript: the final line is still being written (torn).
  const live = fixture + J({ step_index: 22, type: 'PLANNER_RESPONSE', created_at: T(22), content: 'half' }).slice(0, 25);
  const bytes = new TextEncoder().encode(live);
  const reads = [];
  // cli/sessions.go's window semantics: tailBytes → line-aligned final window; cwd + title from the index.
  const provider = {
    async read(id, opts) {
      reads.push(opts);
      let start = 0;
      if (opts.tailBytes != null && opts.tailBytes < bytes.length) {
        start = bytes.length - opts.tailBytes;
        if (bytes[start - 1] !== 0x0A) { const nl = bytes.indexOf(0x0A, start); start = nl < 0 ? bytes.length : nl + 1; }
      }
      return { bytes: bytes.slice(start), offset: start, size: bytes.length, cwd: '/proj', title: 'Relax Review' };
    },
  };
  const r = await readSessionTail(provider, CONV, {
    harness: 'agy', cap: 3, startBytes: 600,
    parse: async (b, o) => runSessionParseJob({ bytes: b, ...o }),
  });
  ok(r.total >= 3, `tail grew until the window held the cap (total ${r.total}, ${reads.length} reads)`);
  eq(r.records.map((x) => x.action), ['task', 'bash', 'system'], 'the newest 3 events, normalized');
  eq(r.meta.malformedLines, 1, 'the torn final line is counted, not fatal');
  eq(r.meta.title, 'Relax Review', 'the index title wins over the transcript-derived one');
  ok(reads.every((o) => o.fromOffset == null), 'an index title makes the head-meta read unnecessary');
  eq(r.cwd, '/proj', 'index cwd');
  const whole = await readSessionTail(provider, CONV, { harness: 'agy', cap: Infinity, parse: async (b, o) => runSessionParseJob({ bytes: b, ...o }) });
  eq(whole.total, events.length, 'whole read: the torn line drops, every complete step survives');
}

console.log(`\nagySessionAdapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
