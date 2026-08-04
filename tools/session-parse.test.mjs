// session-parse.test.mjs — behavior lock for the transcript codec stage:
//
//   bun tools/session-parse.test.mjs
//
//   - eventsToRecords: raw events → normalized records through the ONE registry
//     (noise drops, cwd relativizes); pre-normalized records pass through
//   - runSessionParseJob (pure): bytes → { records, total, cwd, meta } — records
//     equal manual normalization of the sync dialect's events; cap slices the
//     event tail BEFORE normalizing (hydrate's exact order); total stays full
//   - SessionParsePool end-to-end: same result through whichever backend runs,
//     concurrent jobs don't cross-talk, and a real pool (>1 worker) serves them

import { runSessionParseJob, eventsToRecords } from '../packages/glyph3d-core/src/workers/sessionParseJob.js';
import { SessionParsePool } from '../packages/glyph3d-core/src/workers/SessionParsePool.js';
import { parseClaudeSession, parseKimiSession } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';
import { normalizeToolCall, normalizeMessage } from '../packages/glyph3d-core/src/collections/toolRegistry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const T = (s) => `2026-08-01T10:00:0${s}.000Z`;
const asst = (extra, ...content) => J({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const user = (extra, ...content) => J({ type: 'user', message: { role: 'user', content }, ...extra });

const claudeText = [
  asst({ cwd: '/main/repo', timestamp: T(0) }, { type: 'text', text: 'one' }),
  asst({ timestamp: T(1) }, { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }),
  user({ timestamp: T(2), toolUseResult: { stdout: 'out\n' } },
    { type: 'tool_result', tool_use_id: 'tu-1', content: 'out' }),
  asst({ timestamp: T(3) }, { type: 'text', text: 'two' }),
  asst({ timestamp: T(4) }, { type: 'text', text: 'three' }),
].join('\n') + '\n';

const kimiText = [
  J({ type: 'llm.request', model: 'kimi-k2', time: 1000 }),
  J({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'tc-1', name: 'Bash', args: { command: 'ls' }, display: { cwd: '/kimi/repo' } }, time: 1001 }),
  J({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tc-1', result: { output: 'ok\n' } }, time: 1002 }),
  J({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'done' } }, time: 1003 }),
].join('\n') + '\n';

const enc = (s) => new TextEncoder().encode(s);

// ── eventsToRecords: the ONE registry, noise drops, records pass through ──────
{
  const events = parseClaudeSession(claudeText).events;
  const records = eventsToRecords(events, '/main/repo');
  const want = events.map((ev) => ev.kind === 'message'
    ? normalizeMessage(ev.mtype, ev.text)
    : normalizeToolCall(ev.name, ev.input, ev.response, '/main/repo')).filter(Boolean);
  eq(records, want, 'records === manual per-event normalization');
  const rec = { action: 'say', target: '', detail: '', result: 'hi', meta: null };
  eq(eventsToRecords([rec]), [rec], 'a pre-normalized record passes through untouched');
  eq(eventsToRecords([{ kind: 'tool', name: 'TodoWrite', input: {}, response: null, ts: null }]), [],
    'noise tools drop here');
}

// ── runSessionParseJob: claude — records/meta/total against the sync dialect ──
{
  const job = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude' });
  const want = parseClaudeSession(claudeText);
  eq(job.records, eventsToRecords(want.events, want.cwd), 'job records === sync parse + normalize');
  eq(job.total, want.events.length, 'total = full event count');
  eq(job.cwd, want.cwd, 'cwd harvested');
  eq(job.meta, want.meta, 'meta harvested');
}

// ── cap slices EVENTS first, then normalize (hydrate's exact order) ───────────
{
  const job = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude', cap: 2 });
  eq(job.records.map((r) => r.result), ['two', 'three'], 'cap keeps the newest 2 events, normalized');
  eq(job.total, 4, 'total still reports the whole record');
  const sliced = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude', cap: 3 });
  eq(sliced.records[0].result, 'out\n', 'tool_use inside the window keeps its paired response');
}

// ── runSessionParseJob: kimi — dialect + index-cwd fallback ───────────────────
{
  const job = runSessionParseJob({ bytes: enc(kimiText), harness: 'kimi', cwd: '/index/cwd' });
  eq(job.records, eventsToRecords(parseKimiSession(kimiText, '/index/cwd').events, '/kimi/repo'),
    'kimi records === sync parse + normalize');
  eq(job.cwd, '/kimi/repo', 'display.cwd wins over the index fallback');
  eq(job.meta.model, 'kimi-k2', 'kimi meta harvested');
}

// ── the pool: same result through whichever backend runs; jobs fan out ────────
{
  const pool = new SessionParsePool();
  const r = await pool.parse(enc(claudeText), { harness: 'claude' });
  eq(r.records, eventsToRecords(parseClaudeSession(claudeText).events, '/main/repo'),
    `pool result matches dialect (workers: ${pool.workerCount})`);
  ok(pool.workerCount <= 1, `a single job spawns AT MOST one worker (count: ${pool.workerCount})`);

  // Consecutive + concurrent jobs, mixed caps/harnesses — no cross-talk, pool grows on demand.
  const [a, b] = await Promise.all([
    pool.parse(enc(claudeText), { harness: 'claude', cap: 1 }),
    pool.parse(enc(kimiText), { harness: 'kimi', cwd: '/index/cwd' }),
  ]);
  eq(a.records.map((x) => x.result), ['three'], 'concurrent job A: cap 1 tail');
  eq(b.records.length, 2, 'concurrent job B: kimi full');
  ok(pool.workerCount === 0 || pool.workerCount >= 2, `concurrent jobs grew the pool (count: ${pool.workerCount})`);
  const c = await pool.parse(enc(claudeText), { harness: 'claude', cap: 2 });
  eq(c.records.map((x) => x.result), ['two', 'three'], 'a later job after concurrent ones');
  pool.dispose();
}

// ── degenerate inputs ─────────────────────────────────────────────────────────
{
  const job = runSessionParseJob({ bytes: enc(''), harness: 'claude' });
  eq(job.records, [], 'empty bytes → no records');
  eq(job.total, 0, 'empty bytes → total 0');
}

console.log(`\nsession-parse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
