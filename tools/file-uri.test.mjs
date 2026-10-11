// file-uri.test.mjs — behavior lock for the ONE file:// codec (core/fileUri.js) that
// providers, the registry's sourcePath meta, and LSP locations share.
//
//   bun tools/file-uri.test.mjs
//
// Locks:
//   - toFileUri folds leading slashes into the scheme: '/a/b' and 'a/b' share one URI
//   - fromFileUri inverts it: POSIX paths keep their leading '/', Windows drive paths
//     stay 'C:/x', percent-escapes (as LSP servers send them) decode
//   - round trip: fromFileUri(toFileUri(p)) === p for absolute POSIX paths

import { toFileUri, fromFileUri } from '../packages/glyph3d-core/src/core/fileUri.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

eq(toFileUri('/a/b.js'), 'file:///a/b.js', 'absolute path');
eq(toFileUri('a/b.js'), 'file:///a/b.js', 'relative path shares the URI');
eq(toFileUri('//a/b.js'), 'file:///a/b.js', 'extra leading slashes fold');
eq(toFileUri(''), 'file:///', 'empty path = root');

eq(fromFileUri('file:///a/b.js'), '/a/b.js', 'POSIX path keeps its leading slash');
eq(fromFileUri('file:///C:/x/y.js'), 'C:/x/y.js', 'Windows drive path');
eq(fromFileUri('file:///a/my%20file.js'), '/a/my file.js', 'percent-escapes decode');
eq(fromFileUri('file://a/b.js'), '/a/b.js', 'two-slash form');

for (const p of ['/', '/a', '/home/x/proj/src/index.js'])
    eq(fromFileUri(toFileUri(p)), p, `round trip ${p}`);

console.log(`\nfile-uri.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
