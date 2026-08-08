// delta-books.test.mjs — behavior lock for DeltaBooks, the before/after change-set
// controller: one BOOK per set, one SHEET per changed file (base verso / head recto).
//
//   bun tools/delta-books.test.mjs
//
// Locks: (1) resolveSet is lookup + field check across every address form —
// set id, group id `delta:book:<id>`, the `delta:<id>` display form, the live
// Book object — with unknown refs NULL (bus honesty), the same law as
// AgentBooks.resolveLane; (2) setFile is idempotent per path — a file UPDATES
// its sheet in place, never grows a second one; (3) follow-the-change: while
// following, an updated file turns the book to itself and `following` SURVIVES
// the turn (pageTo clears it for a non-last index — the restore is the
// contract); paging away parks the head; (4) applyChangeset drops sheets whose
// files left the diff.
//
// Headless: DeltaBooks with a mock ctx (scene + atlas stub; registry/picking null).

import * as THREE from 'three';

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';

globalThis.window ??= { addEventListener() {} };

const { default: DeltaBooks } = await import('../packages/glyph3d-core/src/collections/DeltaBooks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

const deltas = new DeltaBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });

const mkDelta = (n = 1) => ({
    left: [{ type: 'remove', text: 'old', lineNo: 1 }],
    right: Array.from({ length: n }, (_, i) => ({ type: 'add', text: `new${i}`, lineNo: i + 1 })),
    added: n, removed: 1,
});

// --- resolveSet address forms -----------------------------------------------------

const setA = deltas.ensure('dev', { kind: 'watch' });
const setB = deltas.ensure('HEAD~1..HEAD');

ok(deltas.resolveSet('dev')?.[1] === setA, 'set id resolves');
ok(deltas.resolveSet('delta:book:dev')?.[1] === setA, 'registry GROUP id resolves (the wheel/cover path)');
ok(deltas.resolveSet('delta:dev')?.[1] === setA, 'display form resolves when the remainder exists');
ok(deltas.resolveSet(setA.book)?.[1] === setA, 'the live Book OBJECT resolves by field identity');
ok(deltas.resolveSet('delta:book:HEAD~1..HEAD')?.[1] === setB, 'group ids are per-set');
ok(deltas.resolveSet(undefined)?.[1] === setA, 'omitted ref falls to the first set');
ok(deltas.resolveSet('phantom') === null, 'unknown id is NULL (no silent first-set)');
ok(deltas.resolveSet('delta:phantom') === null, 'display alias only applies when the remainder EXISTS');
ok(deltas.resolveSet(new THREE.Object3D()) === null, 'foreign object is NULL');
ok(deltas.moveGroup(undefined, 0, 0, 0) === false, 'moveGroup refuses an unnamed set');
ok(deltas.moveGroup('delta:book:dev', 1, 2, 3) === true, 'moveGroup accepts a group id');

// --- setFile: one sheet per file, updates in place --------------------------------

deltas.setFile('dev', '/p/a.js', mkDelta(2));
ok(setA.book.sheets.length === 1 && setA.order.length === 1, 'first file → one sheet');
deltas.setFile('dev', '/p/b.js', mkDelta(1));
ok(setA.book.sheets.length === 2, 'second file → second sheet');
deltas.setFile('dev', '/p/a.js', mkDelta(5));
ok(setA.book.sheets.length === 2, 'updating a file NEVER grows a second sheet');
ok(setA.entries.get('/p/a.js').stats.added === 5, 'stats refresh on update');

// --- follow-the-change ------------------------------------------------------------

ok(setA.book.following === true, 'a live set starts following');
ok(setA.book.head === 0, 'the update turned the book to the changed file');
deltas.setFile('dev', '/p/b.js', mkDelta(3));
ok(setA.book.head === 1 && setA.book.following === true,
    'following survives the turn (the pageTo-clears-following restore)');
setA.book.pageTo(0);
ok(setA.book.following === false, 'paging to a non-last sheet parks the head');
deltas.setFile('dev', '/p/b.js', mkDelta(4));
ok(setA.book.head === 0, 'a parked head does NOT get yanked by fresh changes');

// --- files roster + removeFile ----------------------------------------------------

const roster = deltas.files('dev');
ok(roster.length === 2 && roster[0].path === '/p/a.js' && roster[0].focused === true,
    'files() reports sheet order + the open sheet');
ok(deltas.removeFile('dev', '/p/a.js') === true, 'removeFile drops a sheet');
ok(setA.book.sheets.length === 1 && !setA.entries.has('/p/a.js'), 'entry + sheet both gone');

// --- applyChangeset drops stale files ---------------------------------------------

const PATCH = '@@ -1,1 +1,2 @@\n-x\n+y\n+z';
deltas.applyChangeset('HEAD~1..HEAD', [
    { path: 'src/one.js', status: 'modified', patch: PATCH },
    { path: 'src/two.js', status: 'added', patch: PATCH },
]);
ok(setB.book.sheets.length === 2, 'changeset lands one sheet per file');
deltas.applyChangeset('HEAD~1..HEAD', [
    { path: 'src/one.js', status: 'modified', patch: PATCH },
]);
ok(setB.book.sheets.length === 1 && !setB.entries.has('src/two.js'),
    'a refreshed changeset drops files that left the diff');
deltas.applyChangeset('HEAD~1..HEAD', [
    { path: 'img/x.png', status: 'binary', patch: '' },
]);
ok(setB.book.sheets.length === 0, 'binary/empty-patch files never sheet');

// --- teardown ---------------------------------------------------------------------

ok(deltas.remove('delta:dev') === true, 'remove accepts the display form');
ok(deltas.sets.size === 1 && deltas.clear() === 1 && deltas.sets.size === 0, 'clear empties the shelf');

console.log(`\ndelta-books.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
