#!/usr/bin/env bun
// filekind.itest — headless logic test for the file-type classifier (core/fileKind.js).
// The CLASSIFICATION is the risky logic (extension precedence, magic signatures, the UTF-8
// probe); rendering we verify live. Pure bun, no browser. Uses a real PNG from /tmp if present,
// else a synthetic PNG header.
//   bun tools/filekind.itest.mjs

import { extOf, classifyByExtension, sniffMagic, isProbablyUtf8, classifyBytes } from '../packages/glyph3d-core/src/core/fileKind.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ck = (n, c, got) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}  got ${JSON.stringify(got)}`); } };

// -- extension stage --
ck('extOf is case-insensitive', extOf('/tmp/a.PNG') === 'png', extOf('/tmp/a.PNG'));
ck('extOf extensionless = empty', extOf('/tmp/scratch') === '', extOf('/tmp/scratch'));
ck('ext png → image', classifyByExtension('/tmp/a.png')?.kind === 'image', classifyByExtension('/tmp/a.png'));
ck('ext jpg → jpeg format', classifyByExtension('x.jpg')?.format === 'jpeg', classifyByExtension('x.jpg'));
ck('ext jsx → text', classifyByExtension('app/main.jsx')?.kind === 'text', classifyByExtension('app/main.jsx'));
ck('ext go → text', classifyByExtension('cli/relay.go')?.kind === 'text', classifyByExtension('cli/relay.go'));
ck('ext unknown → null (probe)', classifyByExtension('/tmp/scratch') === null, classifyByExtension('/tmp/scratch'));
ck('ext wasm → null (probe)', classifyByExtension('a.wasm') === null, classifyByExtension('a.wasm'));

// -- magic stage (real PNG if available) --
const pngPath = ['/tmp/trail_baseline.png', '/tmp/glance.png'].find((p) => fs.existsSync(p));
const png = pngPath
    ? new Uint8Array(fs.readFileSync(pngPath)).subarray(0, 64)
    : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
ck(`magic PNG (${pngPath || 'synthetic'})`, sniffMagic(png)?.format === 'png', sniffMagic(png));
ck('PNG not utf8', isProbablyUtf8(png) === false, isProbablyUtf8(png));
ck('classifyBytes PNG → image', classifyBytes(png).kind === 'image', classifyBytes(png));
ck('magic JPEG', sniffMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))?.format === 'jpeg', null);
ck('magic GIF', sniffMagic(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))?.format === 'gif', null);
ck('magic BMP', sniffMagic(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]))?.format === 'bmp', null);
ck('magic WEBP', sniffMagic(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.format === 'webp', null);
ck('no false-positive magic on text', sniffMagic(new TextEncoder().encode('hello world')) === null, null);

// -- utf8 probe --
const txt = new TextEncoder().encode('hello\nworld © λ 日本\n');
ck('utf8 multibyte → text', isProbablyUtf8(txt) === true, isProbablyUtf8(txt));
ck('classifyBytes text → text', classifyBytes(txt).kind === 'text', classifyBytes(txt));
ck('NUL byte → binary', isProbablyUtf8(new Uint8Array([0, 1, 2, 0xff, 0, 0])) === false, null);
ck('classifyBytes binary → binary', classifyBytes(new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0, 0x10])).kind === 'binary', null);
ck('empty → text', isProbablyUtf8(new Uint8Array([])) === true, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
