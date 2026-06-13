#!/usr/bin/env bun
// rank-check — locks the palette's verb-ranking intent without a browser.
// rank() is a pure function over (query, entries); the only thing it needs is
// the workspace 'fzf' dep, so this runs standalone: `bun tools/rank-check.mjs`.
//
// What it guards (see app/client/palette/rank.js, VERB_NUDGE):
//   • the everyday moves (*.focus, *.open[Dir]) lead on ambiguous short queries,
//   • highlight.* (niche, usually programmatic) does NOT lead there,
//   • but highlight IS still surfaced when the query clearly targets it.
// Exits non-zero on the first failed expectation.
import { rank } from '../app/client/palette/rank.js';

const VERBS = [
  'camera.focus', 'sheet.focus', 'terminal.focus',
  'file.open', 'file.openDir', 'sheet.open',
  'highlight.clear', 'highlight.glyph', 'highlight.grid',
  'highlight.lines', 'highlight.range', 'highlight.token',
].map((name) => ({ kind: 'verb', key: name }));

const top = (q) => rank(q, VERBS, 12)[0]?.entry.key ?? null;
const isHl = (k) => !!k && k.startsWith('highlight.');

// [query, predicate(topKey) -> ok, human description]
const cases = [
  ['l',  (t) => !isHl(t), 'a bare "l" leads with a focus/open verb, not highlight.lines'],
  ['to', (t) => !isHl(t), '"to" leads with open/focus, not highlight.token'],
  ['t',  (t) => t === 'terminal.focus', '"t" leads with terminal.focus'],
  ['h',  (t) => !isHl(t), '"h" does not lead with highlight'],
  ['o',  (t) => t === 'file.open', '"o" leads with file.open'],
  ['focus', (t) => /\.focus$/.test(t), '"focus" leads with a *.focus verb'],
  // highlight is still reachable when the query clearly targets it:
  ['hi', isHl, '"hi" still surfaces a highlight verb on top'],
  ['gl', isHl, '"gl" still surfaces highlight.glyph family on top'],
  ['cl', isHl, '"cl" still surfaces highlight.clear on top'],
  // a fully-typed verb still pins regardless of nudge:
  ['highlight.grid', (t) => t === 'highlight.grid', 'an exact verb name pins to the top'],
];

let failed = 0;
for (const [q, ok, desc] of cases) {
  const t = top(q);
  const pass = ok(t);
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  q=${JSON.stringify(q).padEnd(16)} top=${String(t).padEnd(16)} — ${desc}`);
}
console.log(failed ? `\n${failed} failed` : '\nall ranking expectations hold');
process.exit(failed ? 1 : 0);
