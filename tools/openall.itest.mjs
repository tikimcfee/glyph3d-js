#!/usr/bin/env bun
// openall.itest — headless logic test for all-files mode's two pure gates:
//   1. partitionDirEntries (core/fileKind.js) — the bulk-open lane split: images must
//      never take the size-based oversized lane (byte size ≠ char count); with showAll
//      off the split must equal the historical behavior exactly.
//   2. filterCodeFiles with excludeExtensions: [] (RepositoryAdapter) — the toggle's
//      filter bypass: admits images/binaries/extensionless, keeps the path-noise
//      excludes and the size cap.
// Pure bun, no browser.
//   bun tools/openall.itest.mjs

import { partitionDirEntries } from '../packages/glyph3d-core/src/core/fileKind.js';
import { RepositoryAdapter } from '../packages/glyph3d-core/src/services/data/RepositoryAdapter.js';

let pass = 0, fail = 0;
const ck = (n, c, got) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}  got ${JSON.stringify(got)}`); } };

const MAX = 1_000_000;   // stand-in for READABLE_MAX_CHARS

// -- partitionDirEntries --
const listing = [
    { path: 'src/main.js', size: 4000 },            // known text
    { path: 'assets/logo.png', size: 5_000_000 },   // image, BIG — must not placeholder
    { path: 'assets/tiny.gif', size: 900 },         // image, small
    { path: 'bin/app.wasm', size: 30_000 },         // known-binary ext → texty (fails text fetch → hex)
    { path: 'Makefile.inc', size: 1200 },           // unknown ext → texty
    { path: 'LICENSE', size: 1100 },                // extensionless → texty
    { path: 'dist/bundle.js', size: 9_000_000 },    // oversized text → placeholder
];

const on = partitionDirEntries(listing, { showAll: true, readableMax: MAX });
ck('showAll: images = the two image exts',
    on.images.map((f) => f.path).join(',') === 'assets/logo.png,assets/tiny.gif', on.images);
ck('showAll: big image NOT oversized',
    !on.oversized.some((f) => f.path === 'assets/logo.png'), on.oversized.map((f) => f.path));
ck('showAll: oversized = only the giant text file',
    on.oversized.length === 1 && on.oversized[0].path === 'dist/bundle.js', on.oversized);
ck('showAll: texty = text + binary-ext + unknown + extensionless',
    on.texty.map((f) => f.path).join(',') === 'src/main.js,bin/app.wasm,Makefile.inc,LICENSE', on.texty.map((f) => f.path));

const off = partitionDirEntries(listing, { showAll: false, readableMax: MAX });
ck('showAll off: no image lane', off.images.length === 0, off.images);
ck('showAll off: historical split (pure size cut, no image lane)',
    off.oversized.map((f) => f.path).join(',') === 'assets/logo.png,dist/bundle.js'
        && off.texty.some((f) => f.path === 'assets/tiny.gif'),
    { texty: off.texty.length, oversized: off.oversized.map((f) => f.path) });

const edge = partitionDirEntries([], { showAll: true, readableMax: MAX });
ck('empty listing → empty lanes', edge.images.length + edge.texty.length + edge.oversized.length === 0, edge);

// -- filterCodeFiles bypass (RepositoryAdapter's blacklist, called like the providers do) --
const filter = RepositoryAdapter.prototype.filterCodeFiles;
const tree = { tree: [
    { path: 'src/main.js', type: 'blob', size: 4000 },
    { path: 'assets/logo.png', type: 'blob', size: 50_000 },
    { path: 'bin/app.wasm', type: 'blob', size: 30_000 },
    { path: 'LICENSE', type: 'blob', size: 1100 },
    { path: 'node_modules/leftpad/index.js', type: 'blob', size: 100 },
    { path: 'huge.js', type: 'blob', size: 11 * 1024 * 1024 },
    { path: 'docs', type: 'tree' },
] };

const relaxed = filter.call(null, tree, { excludeExtensions: [] }).map((f) => f.path);
ck('bypass admits png/wasm/extensionless',
    ['assets/logo.png', 'bin/app.wasm', 'LICENSE'].every((p) => relaxed.includes(p)), relaxed);
ck('bypass keeps path-noise excludes', !relaxed.includes('node_modules/leftpad/index.js'), relaxed);
ck('bypass keeps the size cap', !relaxed.includes('huge.js'), relaxed);
ck('bypass still skips directories', !relaxed.includes('docs'), relaxed);

const strict = filter.call(null, tree, {}).map((f) => f.path);
ck('default filter still blacklists png/wasm',
    !strict.includes('assets/logo.png') && !strict.includes('bin/app.wasm') && strict.includes('LICENSE'), strict);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
