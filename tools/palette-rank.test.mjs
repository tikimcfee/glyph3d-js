// palette-rank.test.mjs — behavior lock for the palette's scoring seam.
//
//   bun tools/palette-rank.test.mjs
//
// rank() runs fzf in extended-match mode (space-separated terms AND together) with
// the merge policy on top. Under test: the dot-free verb spelling — "grid list"
// must surface AND pin grid.list exactly like typing "grid.list" — plus the
// policy pieces that keep it honest (exact pin, sheet boost, multi-word file
// queries, match-position passthrough).

import { rank } from '../app/client/palette/rank.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg}\n      got  ${a}\n      want ${b}`);

const verb = (key) => ({ kind: 'verb', key });
const entries = [
    verb('grid.list'), verb('grid.layout'), verb('camera.frame.bounds'),
    { kind: 'file', key: 'app/commands/handlers/paneCommands.js' },
    { kind: 'file', key: 'packages/glyph3d-core/src/collections/GridLayoutManager.js' },
    { kind: 'sheet', key: 'app/client/CommandBar.jsx' },
];

// ── dot-free verb spelling ─────────────────────────────────────────────────────────────
eq(rank('grid list', entries)[0]?.entry.key, 'grid.list', 'space spells the dot: "grid list" ranks grid.list first');
eq(rank('grid.list', entries)[0]?.entry.key, 'grid.list', 'dotted exact still pins');
eq(rank('grid li', entries)[0]?.entry.key, 'grid.list', 'partial second word still surfaces the verb');
eq(rank('camera frame bounds', entries)[0]?.entry.key, 'camera.frame.bounds', 'dot-free pin reaches 3-segment verbs');
ok(rank('grid list', entries)[0]?.score >= 1000, 'dot-free fully-typed verb gets the exact pin');

// ── extended match generally ───────────────────────────────────────────────────────────
ok(rank('pane cmd', entries).some((r) => r.entry.key.endsWith('paneCommands.js')),
    'multi-word file query AND-matches across the path');
ok(rank('grid list', entries)[0]?.positions?.size > 0, 'match positions ride along for highlighting');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
