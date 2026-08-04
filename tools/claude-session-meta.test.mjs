// claude-session-meta.test.mjs — meta harvest lock for harness adapter #1 (Claude Code JSONL).
//
//   bun tools/claude-session-meta.test.mjs
//
// parseClaudeSession(text).meta is the provenance record the book nameplates read:
// slug / message.model / aiTitle→title / gitBranch / version / agentName / cwd / ts span —
// harvested first-seen-wins during the same passes that build the event stream. The event
// behavior itself is locked in tools/sessionAdapter.test.mjs; this file locks the meta half
// and the backward-compat top-level fields.

import { parseClaudeSession } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const T = (s) => `2026-08-01T10:00:0${s}.000Z`;
const asst = (extra, ...content) => J({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content }, ...extra });

const fixture = [
  // provenance rides ordinary lines — first-seen wins over the later duplicates below
  asst({ cwd: '/main/repo', slug: 'america-chavez', version: '2.1.207', gitBranch: 'main', timestamp: T(0) },
    { type: 'text', text: 'hello' }),
  asst({ cwd: '/other', slug: 'later-slug', version: '9.9.9', gitBranch: 'later-branch', timestamp: T(1) },
    { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }),
  // a second assistant model must not override the first
  J({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'bye' }] }, timestamp: T(2) }),
  // the dedicated bookkeeping lines (no message.content at all — harvest must not need it)
  J({ type: 'ai-title', aiTitle: 'Fix the launcher error', sessionId: 'sid' }),
  J({ type: 'ai-title', aiTitle: 'Later title does not override', sessionId: 'sid' }),
  J({ type: 'agent-name', agentName: 'fix-linux-launcher', sessionId: 'sid' }),
  // sidechain provenance must NOT leak (sidechain lines drop wholesale in pass 0)
  asst({ isSidechain: true, cwd: '/side/land', slug: 'side-slug', gitBranch: 'side-branch', timestamp: T(3) },
    { type: 'text', text: 'sidechain prose' }),
].join('\n') + '\n';

const { events, cwd, firstTs, lastTs, meta } = parseClaudeSession(fixture);

// ── the meta contract ─────────────────────────────────────────────────────────────────
eq(meta, {
  harness: 'claude',
  cwd: '/main/repo',
  slug: 'america-chavez',
  title: 'Fix the launcher error',
  model: 'claude-opus-4-8',
  version: '2.1.207',
  gitBranch: 'main',
  agentName: 'fix-linux-launcher',
  firstTs: Date.parse(T(0)),
  lastTs: Date.parse(T(2)),
}, 'meta: slug/title/model/version/gitBranch/agentName/cwd/span, first-seen wins');

// ── backward compat: top-level fields unchanged, and meta mirrors them ────────────────
eq(cwd, '/main/repo', 'top-level cwd kept');
eq(firstTs, Date.parse(T(0)), 'top-level firstTs kept');
eq(lastTs, Date.parse(T(2)), 'top-level lastTs kept (sidechain ts does not extend the span)');
ok(meta.cwd === cwd && meta.firstTs === firstTs && meta.lastTs === lastTs, 'meta mirrors the top-level fields');

// ── events unaffected by the harvest ──────────────────────────────────────────────────
eq(events.map((e) => e.kind), ['message', 'tool', 'message'], 'events still emit as before');
ok(!events.some((e) => e.text === 'sidechain prose'), 'sidechain still skipped wholesale');

// ── missing provenance → null fields, harness still set ───────────────────────────────
eq(parseClaudeSession('').meta, {
  harness: 'claude', cwd: null, slug: null, title: null, model: null,
  version: null, gitBranch: null, agentName: null, firstTs: null, lastTs: null,
}, 'empty text → all-null meta');
const noMeta = parseClaudeSession(asst({ timestamp: T(0) }, { type: 'text', text: 'hi' }) + '\n');
eq(noMeta.meta.slug, null, 'no slug line → null slug');
eq(noMeta.meta.title, null, 'no ai-title line → null title');
eq(noMeta.meta.gitBranch, null, 'no gitBranch → null');
eq(noMeta.meta.model, 'claude-opus-4-8', 'model harvested from the assistant message itself');

console.log(`\nclaude-session-meta: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
