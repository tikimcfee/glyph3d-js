// book-resolve.test.mjs — behavior lock for AgentBooks.resolveLane, THE lane
// resolver: every address a lane answers to, resolved by LOOKUP + FIELD CHECK,
// never prefix surgery.
//
//   bun tools/book-resolve.test.mjs
//
// The regression under lock: a blind `agent:` prefix strip in the verb layer
// mutilated the registry group id `agent:book:<id>` into `book:<id>` — no lane,
// no group match → "ERR: no book" → SHIFT+wheel over a book's COVER stopped
// turning pages while its cards (which pass the bare lane id) still worked.
// The resolver now owns every address form; unknown refs are NULL (bus honesty:
// a verb naming a missing book errors, it doesn't quietly turn the first one).
//
// Headless: AgentBooks with a mock ctx (scene only — no atlas, registry, or
// picking needed for lane bookkeeping).

import * as THREE from 'three';

// ensure() builds each lane's FieldLabel nameplate at construction — needs the atlas stub.
import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';

// Module-scope telemetry (ErrorTracker) wants a window with addEventListener.
globalThis.window ??= { addEventListener() {} };

const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

const books = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
const laneA = books.ensure('scribe');
const laneB = books.ensure('sentry');

// every address form → the same lane
ok(books.resolveLane('scribe')?.[1] === laneA, 'lane id resolves');
ok(books.resolveLane('agent:book:scribe')?.[1] === laneA, 'registry GROUP id resolves (the wheel/cover path)');
ok(books.resolveLane('agent:scribe')?.[1] === laneA, 'display label (book.list form) resolves');
ok(books.resolveLane(laneA.book)?.[1] === laneA, 'the live Book OBJECT resolves by field identity');
ok(books.resolveLane('agent:book:sentry')?.[1] === laneB, 'group ids are per-lane, not first-lane');

// omitted → the default (first) lane; unknown → NULL, never a silent wrong book
ok(books.resolveLane(undefined)?.[1] === laneA, 'omitted ref falls to the first lane (default book)');
ok(books.resolveLane('') ?.[1] === laneA, 'empty ref falls to the first lane');
ok(books.resolveLane('phantom') === null, 'unknown lane id is NULL (no silent first-lane)');
ok(books.resolveLane('agent:phantom') === null, 'display-label alias only applies when the remainder EXISTS');
ok(books.resolveLane('agent:book:phantom') === null, 'unknown group id is NULL');
ok(books.resolveLane(new THREE.Object3D()) === null, 'foreign object is NULL');

// the verb-facing surfaces ride the same resolver
ok(books.scroll('agent:book:scribe', 0) !== undefined, 'scroll accepts a group id');
ok(books.headState('agent:scribe')?.agentId === 'scribe', 'headState accepts the display label');
ok(books.moveGroup(undefined, 0, 0, 0) === false, 'moveGroup refuses an unnamed book (no default-to-first)');
ok(books.moveGroup('agent:book:sentry', 1, 2, 3) === true, 'moveGroup accepts a group id');

console.log(`\nbook-resolve.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
