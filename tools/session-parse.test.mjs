// session-parse.test.mjs — behavior lock for the transcript codec stage:
//
//   bun tools/session-parse.test.mjs
//
//   - runSessionParseJob (pure): bytes → { events, total, cwd, meta } matches the
//     sync dialect exactly (claude + kimi), cap pre-slices the tail while total
//     keeps the FULL count
//   - SessionParsePool end-to-end: same result through whichever backend runs
//     (worker in a browser-ish runtime, sliced main-thread fallback otherwise),
//     and consecutive jobs stay FIFO-correct
//   - the pool reports which backend served (offThread) so the lock can see it

import { runSessionParseJob } from '../packages/glyph3d-core/src/workers/sessionParseJob.js';
import { SessionParsePool } from '../packages/glyph3d-core/src/workers/SessionParsePool.js';
import { parseClaudeSession, parseKimiSession } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

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

// ── runSessionParseJob: claude, uncapped — identical to the sync dialect ──────
{
  const job = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude' });
  const want = parseClaudeSession(claudeText);
  eq(job.events, want.events, 'claude events identical to sync parse');
  eq(job.total, want.events.length, 'total = full event count');
  eq(job.cwd, want.cwd, 'cwd harvested');
  eq(job.meta, want.meta, 'meta harvested');
  eq(job.firstTs, want.firstTs, 'firstTs');
  eq(job.lastTs, want.lastTs, 'lastTs');
}

// ── cap pre-slices the tail; total stays full; pairing survives the slice ─────
{
  const job = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude', cap: 2 });
  eq(job.events.length, 2, 'cap keeps exactly the newest 2 events');
  eq(job.events.map((e) => e.text), ['two', 'three'], 'the tail slice, in order');
  eq(job.total, 4, 'total still reports the whole record');
  const sliced = runSessionParseJob({ bytes: enc(claudeText), harness: 'claude', cap: 3 });
  eq(sliced.events[0].response, { stdout: 'out\n' }, 'tool_use inside the window keeps its paired response');
}

// ── runSessionParseJob: kimi — dialect + index-cwd fallback ───────────────────
{
  const job = runSessionParseJob({ bytes: enc(kimiText), harness: 'kimi', cwd: '/index/cwd' });
  const want = parseKimiSession(kimiText, '/index/cwd');
  eq(job.events, want.events, 'kimi events identical to sync parse');
  eq(job.cwd, '/kimi/repo', 'display.cwd wins over the index fallback');
  eq(job.meta.model, 'kimi-k2', 'kimi meta harvested');
}

// ── the pool: same result through whichever backend runs ──────────────────────
{
  const pool = new SessionParsePool();
  const r = await pool.parse(enc(claudeText), { harness: 'claude' });
  eq(r.events, parseClaudeSession(claudeText).events, `pool result matches dialect (backend: ${pool.offThread ? 'worker' : 'main-thread'})`);
  eq(r.total, 4, 'pool total');

  // Consecutive jobs, mixed caps/harnesses — no cross-talk.
  const [a, b] = await Promise.all([
    pool.parse(enc(claudeText), { harness: 'claude', cap: 1 }),
    pool.parse(enc(kimiText), { harness: 'kimi', cwd: '/index/cwd' }),
  ]);
  eq(a.events.map((e) => e.text), ['three'], 'concurrent job A: cap 1 tail');
  eq(b.events.length, 2, 'concurrent job B: kimi full');
  pool.dispose();
}

// ── degenerate inputs ─────────────────────────────────────────────────────────
{
  const job = runSessionParseJob({ bytes: enc(''), harness: 'claude' });
  eq(job.events, [], 'empty bytes → no events');
  eq(job.total, 0, 'empty bytes → total 0');
}

console.log(`\nsession-parse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
