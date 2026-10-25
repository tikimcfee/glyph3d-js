// toolRegistry.test.mjs — behavior lock for the tool calls' PRESENTATION half.
//
//   bun tools/toolRegistry.test.mjs
//
// What a call did (action/target/detail/meta) is gomuxai's tool table, carried by the event
// stream; this registry only decorates and colors by the record's action:
// decorateForAction(action, meta) is the per-action highlight mapping (1-based meta in,
// 0-based inclusive directives out), kindForAction the identity bucket, ACTION_HUES/cssHue the
// hues the 3D cards and the 2D panel dots share. Meta shapes are gomuxai's
// (transcript.SummarizeTool's doc: read {lines, range?}, edit {added, removed, ranges?, patch?}).

import { decorateForAction, kindForAction, ACTION_HUES, cssHue } from '../packages/glyph3d-core/src/collections/toolRegistry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

// ── read: a partial read's range → a READ fill over its slice ─────────────────────────
{
  const d = decorateForAction('read', { lines: 42, range: [40, 81] });
  eq(d?.map(({ startLine, endLine }) => [startLine, endLine]), [[39, 80]], 'read: decorate is the 0-based slice');
  ok(d[0].color.b === 1.0, 'read: decoration is the READ (blue) color');
  ok(d[0].fill === true, 'read: directive requests a background FILL bar');
  eq(decorateForAction('read', { lines: 100 }), null, 'read full: no range, no decoration');
}

// ── edit: the added-line runs → ADDED fills ──────────────────────────────────────────
{
  const d = decorateForAction('edit', { added: 3, removed: 1, ranges: [[11, 12], [14, 14]] });
  eq(d.map(({ startLine, endLine }) => [startLine, endLine]), [[10, 11], [13, 13]], 'edit: decorate 0-based runs');
  ok(d[0].color.g === 1.0, 'edit: decoration is the ADDED (green) color');
  ok(d.every((x) => x.fill === true), 'edit: directives request a background FILL bar');
  eq(decorateForAction('edit', { added: 0, removed: 2, ranges: [] }), null, 'edit with nothing added: no decoration');
  eq(decorateForAction('edit', { added: 1, removed: 1 }), null, 'a pending edit (no ranges yet): no decoration');
}

// ── nothing else decorates ────────────────────────────────────────────────────────────
{
  eq(decorateForAction('write', { kind: 'create', lines: 3 }), null, 'write: no decoration (all-new)');
  eq(decorateForAction('bash', { lines: 2 }), null, 'bash: no decoration');
  eq(decorateForAction('read', null), null, 'no meta: no decoration');
}

// ── identity buckets: every action a record can carry ─────────────────────────────────
{
  const want = {
    read: 'read', grep: 'search', glob: 'search', search: 'search', edit: 'edit', write: 'write',
    bash: 'run', task: 'run', ask: 'ask', fetch: 'fetch', say: 'say', send: 'say', think: 'think',
    prompt: 'prompt', system: 'system', noise: 'noise', skill: 'other', somenewtool: 'other',
  };
  for (const [action, kind] of Object.entries(want)) eq(kindForAction(action), kind, `${action} → ${kind}`);
  eq(kindForAction('READ'), 'read', 'buckets ignore case');
  ok(Object.values(want).every((k) => ACTION_HUES[k]), 'every bucket has a hue');
}

// ── hues as CSS ───────────────────────────────────────────────────────────────────────
{
  eq(cssHue({ r: 1, g: 0, b: 0.5 }), '#ff0080', 'cssHue: {r,g,b} → #rrggbb');
  eq(cssHue({ r: 2, g: -1, b: 0 }), '#ff0000', 'cssHue clamps to 0..1');
  eq(cssHue(null), '#999999', 'cssHue: no hue → neutral grey');
}

console.log(`\ntoolRegistry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
