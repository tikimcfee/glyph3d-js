#!/usr/bin/env bun
/**
 * blob-store.mjs — harness for the generic BlobStore (services/state/BlobStore.js).
 *
 *   bun tools/blob-store.mjs
 *
 * Pure + headless: runs against the MemoryBackend, so no IndexedDB, no window, no
 * browser. Proves the store LOGIC (binary fidelity, namespacing, stat, clear
 * semantics, input normalization) that's identical across both backends — the
 * IndexedDB backend is the thin async-primitive layer, validated in-browser.
 */

import { BlobStore, MemoryBackend } from '../packages/glyph3d-core/src/services/state/BlobStore.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); } };
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const store = new BlobStore({ backend: new MemoryBackend() });

console.log('\n[1] binary fidelity — bytes survive exactly');
const payload = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 0, 42]);
await store.put('slug-core.abc123', payload, { v: 1, hash: 'abc123' });
const got = await store.getBytes('slug-core.abc123');
ok(got !== null && eqBytes(got, payload), 'round-trips a Uint8Array byte-for-byte');
const rec = await store.get('slug-core.abc123');
ok(rec.meta.v === 1 && rec.meta.hash === 'abc123', 'meta preserved');
ok(typeof rec.createdAt === 'number', 'createdAt stamped');

console.log('\n[2] input normalization');
await store.put('raw.arraybuffer', new Uint8Array([9, 8, 7]).buffer);
ok(eqBytes(await store.getBytes('raw.arraybuffer'), new Uint8Array([9, 8, 7])), 'accepts a bare ArrayBuffer');
const u16 = new Uint16Array([0x0102, 0x0304]);                 // 4 bytes, endian-stable round-trip
await store.put('raw.typedview', u16);
ok((await store.getBytes('raw.typedview')).byteLength === 4, 'accepts a non-Uint8 typed array (by byte length)');
let threw = false; try { await store.put('raw.bad', { not: 'bytes' }); } catch { threw = true; }
ok(threw, 'rejects a non-binary value');

console.log('\n[3] presence + delete');
ok(await store.has('slug-core.abc123'), 'has() true for a stored key');
ok(!(await store.has('slug-core.missing')), 'has() false for an absent key');
ok((await store.getBytes('slug-core.missing')) === null, 'getBytes() null for an absent key');
await store.delete('raw.arraybuffer');
ok(!(await store.has('raw.arraybuffer')), 'delete() removes a key');

console.log('\n[4] namespacing + listing');
await store.put('slug-core.def456', new Uint8Array([1]));
await store.put('repo.tree.xyz', new Uint8Array([1, 2]));
const all = await store.listAll();
ok(all.length === 4 && all[0] <= all[1], 'listAll() returns every key, sorted');
const slug = await store.listNamespace('slug-core');
ok(slug.length === 2 && slug.every((k) => k.startsWith('slug-core.')), 'listNamespace() fences to the namespace');
ok((await store.listNamespace('repo')).length === 1, 'a sibling namespace is isolated');

console.log('\n[5] stat (panel listing — sizes without leaking payloads)');
const s = await store.stat('slug-core.abc123');
ok(s.bytes === payload.length && s.key === 'slug-core.abc123', 'stat() reports byte length + key');
ok(s.meta.hash === 'abc123' && typeof s.createdAt === 'number', 'stat() carries meta + createdAt');
ok(!('bytes' in s) || typeof s.bytes === 'number', 'stat() exposes size as a number, not the buffer');
const statAll = await store.statAll();
ok(statAll.length === 4 && statAll.every((e) => typeof e.bytes === 'number'), 'statAll() covers every entry');

console.log('\n[6] clear semantics');
const removed = await store.clearNamespace('slug-core');
ok(removed === 2 && (await store.listNamespace('slug-core')).length === 0, `clearNamespace() removed only its ns (${removed})`);
ok((await store.listNamespace('repo')).length === 1, 'clearNamespace() left siblings intact');
const removedAll = await store.clearAll();
ok(removedAll >= 1 && (await store.listAll()).length === 0, 'clearAll() empties the store');

console.log('\n[7] createdAt pass-through (faithful re-import)');
await store.put('imported.thing', new Uint8Array([7]), {}, 1234567890);
ok((await store.stat('imported.thing')).createdAt === 1234567890, 'an explicit createdAt is preserved (not overwritten)');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
