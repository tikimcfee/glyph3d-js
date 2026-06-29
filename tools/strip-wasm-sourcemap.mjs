#!/usr/bin/env bun
// Remove (or, with --check, assert the absence of) the `sourceMappingURL` custom
// section in one or more .wasm files.
//
// Why: some upstream wasm builds (notably web-tree-sitter) embed a custom section
// pointing at a `<name>.wasm.map` sidecar. We don't ship that sidecar, so the
// reference dangles: browser devtools try to resolve it, and because the module is
// instantiated from bytes (no associated URL) the base is empty, yielding a noisy
// "URL constructor: is not a valid url" source-map warning on every load.
//
// Removing the section is a well-defined, lossless op — a custom section carries
// no semantics for execution, so the module loads identically.
//
// Usage:
//   strip-wasm-sourcemap.mjs <file.wasm> [more.wasm ...]   strip in place
//   strip-wasm-sourcemap.mjs --check <file.wasm> [...]      verify; exit 1 if any
//                                                           file still carries it
//
// --check is the build guard: it reuses the SAME section walk as the strip path,
// so a verify pass and a strip pass can never silently disagree. Run it over the
// freshly built bundle so a future web-tree-sitter upgrade that this stripper
// fails to clean fails the build LOUDLY instead of shipping the warning again.

import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = 'sourceMappingURL';

/** Read an unsigned LEB128 at `off`; returns [value, bytesConsumed]. */
function readU(buf, off) {
  let result = 0, shift = 0, pos = off;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, pos - off];
}

/** Walk top-level sections, dropping any custom section named TARGET. */
function strip(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('not a wasm module (bad magic)');
  }
  const keep = [buf.subarray(0, 8)]; // magic + version
  let pos = 8;
  let removed = 0;
  while (pos < buf.length) {
    const sectionStart = pos;
    const id = buf[pos++];
    const [size, n] = readU(buf, pos);
    pos += n;
    const payloadStart = pos;
    const sectionEnd = payloadStart + size;
    let drop = false;
    if (id === 0) {
      // custom section: payload begins with a name (uleb len + bytes)
      const [nameLen, nn] = readU(buf, payloadStart);
      const name = buf.toString('utf8', payloadStart + nn, payloadStart + nn + nameLen);
      if (name === TARGET) drop = true;
    }
    if (drop) removed++;
    else keep.push(buf.subarray(sectionStart, sectionEnd));
    pos = sectionEnd;
  }
  return { out: Buffer.concat(keep), removed };
}

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const files = argv.filter((a) => a !== '--check');

if (files.length === 0) {
  console.error('usage: strip-wasm-sourcemap.mjs [--check] <file.wasm> [more.wasm ...]');
  process.exit(1);
}

let offenders = 0;
for (const path of files) {
  const before = readFileSync(path);
  const { out, removed } = strip(before);
  if (check) {
    if (removed > 0) {
      console.error(`  ✗ ${path} still carries a ${TARGET} section`);
      offenders++;
    }
  } else if (removed > 0) {
    writeFileSync(path, out);
    console.log(`  stripped ${removed} ${TARGET} section(s): ${before.length} → ${out.length} bytes  (${path})`);
  } else {
    console.log(`  no ${TARGET} section (${path}) — unchanged`);
  }
}

if (check) {
  if (offenders > 0) {
    console.error(`\nERROR: ${offenders} bundled wasm file(s) still carry a ${TARGET} section.`);
    console.error('The stripper did not clean them — likely an upstream wasm format change.');
    console.error('Fix tools/strip-wasm-sourcemap.mjs before shipping (this would re-introduce');
    console.error('the devtools "URL constructor: is not a valid url" source-map warning).');
    process.exit(1);
  }
  console.log(`  ✓ ${files.length} wasm file(s) clean — no ${TARGET} section`);
}
