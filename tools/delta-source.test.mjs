// delta-source.test.mjs — behavior lock for services/state/deltaSource.js, the
// pure delta algebra behind DeltaBooks: every lane (git diff text, full text
// pairs, an edit event's hunks) reduces to ONE aligned left/right shape.
//
//   bun tools/delta-source.test.mjs
//
// Locks: (1) splitUnifiedDiff owns the per-file split of raw `git diff` output —
// statuses, renames, binary flags, and headers NEVER leaking into the patch
// (DiffParser's aligned parser reads -/+ prefixes positionally, so a leaked
// `--- a/x` header would parse as a removed line); (2) alignTexts keeps the two
// sides index-aligned with spacers and honest +/− stats; (3) reconstructBase
// walks an edit's structuredPatch hunks BACKWARD from the written file to its
// pre-edit text — the watch lane's base capture — tolerating both hunk field
// dialects (jsdiff oldLines / wire oldCount); (4) the tool registry retains an
// edit's hunks on meta.patch (the watch lane's data source).

import { structuredPatch } from 'diff';
import {
    splitUnifiedDiff, alignTexts, alignPatch, reconstructBase, hunksToPatch,
} from '../packages/glyph3d-core/src/services/state/deltaSource.js';
import { normalizeToolCall } from '../packages/glyph3d-core/src/collections/toolRegistry.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

// --- 1. splitUnifiedDiff ----------------------------------------------------------

const GIT_DIFF = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1234567..89abcde 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 20;',
    '+const c = 3;',
    ' export { a };',
    'diff --git a/docs/new.md b/docs/new.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/new.md',
    '@@ -0,0 +1,2 @@',
    '+# hi',
    '+body',
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 90%',
    'rename from old/name.js',
    'rename to new/name.js',
    'index 2222222..3333333 100644',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
    'diff --git a/img/logo.png b/img/logo.png',
    'index 4444444..5555555 100644',
    'Binary files a/img/logo.png and b/img/logo.png differ',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 6666666..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-farewell',
].join('\n');

{
    const files = splitUnifiedDiff(GIT_DIFF);
    ok(files.length === 5, `5 files split (got ${files.length})`);
    const [mod, added, renamed, binary, deleted] = files;
    ok(mod.path === 'src/app.js' && mod.status === 'modified', `modified file (${mod.path} ${mod.status})`);
    ok(mod.patch.startsWith('@@'), 'patch starts at the first @@ — headers stripped');
    ok(!mod.patch.includes('--- a/'), 'no ---/+++ header leaks into the patch');
    ok(added.path === 'docs/new.md' && added.status === 'added', `new file (${added.path} ${added.status})`);
    ok(renamed.status === 'renamed' && renamed.oldPath === 'old/name.js' && renamed.path === 'new/name.js',
        `rename tracked (${renamed.oldPath} → ${renamed.path})`);
    ok(binary.status === 'binary' && binary.patch === '', 'binary flagged, empty patch');
    ok(deleted.status === 'deleted' && deleted.path === 'gone.txt', 'deleted keys by its OLD path');

    // The split patch parses aligned without header pollution: 1 removed, 2 added.
    const a = alignPatch(mod.patch);
    ok(a.added === 2 && a.removed === 1, `alignPatch stats +2 −1 (got +${a.added} −${a.removed})`);
    ok(a.left.length === a.right.length, 'aligned sides equal length');
}

ok(splitUnifiedDiff('').length === 0, 'empty diff → no files');

// --- 2. alignTexts ----------------------------------------------------------------

{
    const base = ['one', 'two', 'three', 'four'].join('\n');
    const head = ['one', 'TWO', 'three', 'three-and-a-half', 'four'].join('\n');
    const a = alignTexts(base, head);   // condensed default
    ok(a.added === 2 && a.removed === 1, `alignTexts stats +2 −1 (got +${a.added} −${a.removed})`);
    ok(a.left.length === a.right.length, 'condensed sides equal length');
    // The change pairs: removed 'two' faces added 'TWO'; the pure insertion faces a spacer.
    const ri = a.right.findIndex((l) => l.text === 'three-and-a-half');
    ok(ri >= 0 && a.left[ri].type === 'spacer', 'a pure insertion faces a spacer on the base side');
    const li = a.left.findIndex((l) => l.type === 'remove');
    ok(li >= 0 && a.left[li].text === 'two' && a.right[li].type === 'add' && a.right[li].text === 'TWO',
        'remove/add pair aligned as a modification');

    const full = alignTexts(base, head, { view: 'full' });
    ok(full.left.length === full.right.length, 'full sides equal length');
    ok(full.left.some((l) => l.text === 'one' && l.type === 'context'), 'full view carries untouched context');
    ok(full.added === 2 && full.removed === 1, 'full view stats match');
}

ok(alignTexts('same\ntext', 'same\ntext').added === 0, 'identical texts → no additions');

// --- 3. reconstructBase -----------------------------------------------------------

{
    const base = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n');
    const head = ['alpha', 'BETA', 'gamma', 'delta', 'inserted', 'epsilon'].join('\n');
    // The event shape: structuredPatch().hunks is exactly what a Claude Edit's
    // toolUseResult carries.
    const { hunks } = structuredPatch('a', 'b', base, head, '', '', { context: 3 });
    ok(reconstructBase(head, hunks) === base, 'jsdiff-shaped hunks reverse-apply to the exact base');

    // Wire-dialect tolerance: oldCount/newCount instead of oldLines/newLines.
    const wire = hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) =>
        ({ oldStart, oldCount: oldLines, newStart, newCount: newLines, lines }));
    ok(reconstructBase(head, wire) === base, 'oldCount/newCount dialect reverse-applies too');

    // A drifted head (the patch no longer matches) is a LOUD null, not silent junk.
    ok(reconstructBase('completely\nunrelated\ncontent', hunks) === null, 'drifted head → null');

    ok(reconstructBase(head, []) === head, 'no hunks → head IS the base');

    // hunksToPatch round-trips through the aligned parser with matching stats.
    const a = alignPatch(hunksToPatch(hunks));
    ok(a.added === 2 && a.removed === 1, `hunksToPatch → alignPatch stats +2 −1 (got +${a.added} −${a.removed})`);
}

// --- 4. the registry retains an edit's hunks --------------------------------------

{
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
    const rec = normalizeToolCall('Edit', { file_path: '/p/f.js', old_string: 'a', new_string: 'b' },
        { structuredPatch: patch }, '/p');
    ok(rec.meta?.patch === patch, 'editMeta retains the structuredPatch hunks on meta.patch');
    ok(rec.meta.added === 1 && rec.meta.removed === 1, 'counts still derived');
    const recNoPatch = normalizeToolCall('Edit', { file_path: '/p/f.js' }, {}, '/p');
    ok(recNoPatch.meta.patch === undefined, 'no hunks → no patch key (meta stays lean)');
}

console.log(`delta-source: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
