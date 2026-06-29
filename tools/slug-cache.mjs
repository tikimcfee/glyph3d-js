#!/usr/bin/env bun
/**
 * slug-cache.mjs — end-to-end harness for the slug-core cache (slugCoreCache.js).
 *
 *   bun tools/slug-cache.mjs
 *
 * Exercises the full client path — key → pack → gzip → blobStore → ungzip → unpack →
 * descriptor — headlessly. In bun there is no IndexedDB, so the `blobStore` singleton
 * auto-selects MemoryBackend; CompressionStream/DecompressionStream are bun globals.
 * The real LARGE_CORE size measurement is a separate in-browser probe (real FontChain).
 */

import { SlugBuffer } from '../packages/glyph3d-core/src/shaping/slugData.js';
import { slugCoreKey, saveSlugCore, loadSlugCore } from '../packages/glyph3d-core/src/shaping/slugCoreCache.js';
import { blobStore } from '../packages/glyph3d-core/src/services/state/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); } };
const eqU32 = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// A fake shaper with a high-id glyph (5000) so the glyph-map carries a long sparse
// zero run — the realistic case that makes gzip a clear win.
const fakeShaper = {
    upem: 2048, isBitmapSlot() { return false; },
    glyphAdvance() { return 1024; }, fontExtents() { return { ascender: 1638, descender: -410 }; },
    glyphName(id) { return `g${id}`; },
    glyphOutline(id) {
        if (id % 7 === 0) return [];
        const segs = [{ type: 'M', values: [0, 0] }];
        for (let k = 0; k <= (id % 4); k++) segs.push({ type: 'Q', values: [(id * 7 + k) % 900, (id * 11) % 900, (id * 13) % 900, (id * 3) % 900] });
        segs.push({ type: 'Z', values: [] });
        return segs;
    },
};

const buf = new SlugBuffer();
buf.addGlyphs(fakeShaper, [1, 2, 3, 7, 42, 5000]);
const d = buf.serialize();

const cfgA = { fonts: [{ url: '/fonts/Cousine.ttf', name: 'primary' }], encodeRanges: [[32, 126], [0x2500, 0x257f]] };

// ── 1. key: stable + sensitive ───────────────────────────────────────────────
console.log('\n[1] content-addressed key');
const keyA = slugCoreKey(cfgA);
ok(keyA === slugCoreKey(cfgA), 'same inputs → same key (stable)');
ok(keyA.startsWith('slug-core.'), `key is namespaced (${keyA})`);
ok(slugCoreKey({ ...cfgA, encodeRanges: [[32, 126]] }) !== keyA, 'different ranges → different key');
ok(slugCoreKey({ ...cfgA, fonts: [{ url: '/fonts/Other.ttf' }] }) !== keyA, 'different font chain → different key');

// ── 2. round-trip through gzip + blobStore ───────────────────────────────────
console.log('\n[2] save → load round-trip');
const gzBytes = await saveSlugCore(keyA, d);
ok(gzBytes > 0, 'saveSlugCore stored a non-empty blob');
const d2 = await loadSlugCore(keyA);
ok(d2 !== null, 'loadSlugCore returned a descriptor');
ok(d2 && eqU32(d.encodedIds, d2.encodedIds), 'encodedIds round-trip');
ok(d2 && eqU32(d.curve, d2.curve), 'curve array round-trips byte-for-byte');
ok(d2 && eqU32(d.map, d2.map), 'glyph-map array round-trips byte-for-byte');
ok(d2 && d2.curveCount === d.curveCount && d2.maxGlyphId === d.maxGlyphId && d2.v === d.v, 'counts + format preserved');
ok(SlugBuffer.deserialize(d2).size === buf.size, 'the loaded descriptor hydrates a live buffer');

// ── 3. gzip actually compresses (sparse map → big win) ───────────────────────
console.log('\n[3] compression');
const rawBytes = (8 + d.encodedIds.length + d.curve.length + d.map.length) * 4;
ok(gzBytes < rawBytes, `gz ${(gzBytes / 1024).toFixed(1)}KB < raw ${(rawBytes / 1024).toFixed(1)}KB (sparse map compresses)`);

// ── 4. miss → null ───────────────────────────────────────────────────────────
console.log('\n[4] miss');
ok((await loadSlugCore('slug-core.does-not-exist')) === null, 'absent key → null');

// ── 5. corruption → null + self-heal ─────────────────────────────────────────
console.log('\n[5] corruption is fail-safe');
await blobStore.put(keyA, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));   // not a gzip stream
const corrupt = await loadSlugCore(keyA);
ok(corrupt === null, 'un-gunzippable bytes → null (caught, not thrown)');
ok(!(await blobStore.has(keyA)), 'the corrupt entry was discarded (self-heal → recompute next boot)');

// ── 6. re-save after self-heal works ─────────────────────────────────────────
console.log('\n[6] recovery');
await saveSlugCore(keyA, d);
ok((await loadSlugCore(keyA)) !== null, 're-cached cleanly after a discard');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
