#!/usr/bin/env bun
/**
 * bake-slug-core.mjs — bake the prebaked slug core to a static asset.
 *
 *   bun tools/bake-slug-core.mjs
 *
 * Headless (HarfBuzz + FontChain run in bun, via tools/headlessFontChain.mjs — the
 * same harness the layout bake uses). Encodes the LARGE_CORE for the app's font
 * chain and writes a gzipped blob to app/public/slug-core/<key>.bin — Vite copies public/
 * into the build, and `make build` stages that into the binary, so the asset ships with
 * both the web app and the CLI. At runtime the boot ladder fetches `/slug-core/<key>.bin`,
 * so even a fresh device (empty IndexedDB) hydrates instead of encoding.
 *
 * It reuses the PRODUCTION path: SlugEncoder → descriptor → saveSlugCore (into bun's
 * in-memory blobStore) → drain to disk. So the bytes are byte-identical to what the runtime
 * would encode+cache, and the key is the same name-based key the runtime computes.
 *
 * Re-run this when the font files, LARGE_CORE_RANGES, or SLUG_BUFFER_FORMAT change (the key
 * changes too; the old asset is simply never requested). If the names in headlessFontChain
 * or the ranges drift from the app, the worst case is a runtime 404 → live encode
 * (fail-safe, not broken).
 */

import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { ROOT, bootHeadlessFontChain } from './headlessFontChain.mjs';

const { chain, fonts } = await bootHeadlessFontChain();

const { MonospaceShapeCache, shapeText, collectUniqueGlyphIds, SlugEncoder,
        slugCoreKey, saveSlugCore } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/index.js`);
const { blobStore } = await import(`${ROOT}/packages/glyph3d-core/src/services/state/index.js`);
const { LARGE_CORE_RANGES } = await import(`${ROOT}/packages/glyph3d-r3f/src/coreRanges.js`);

const codepointsFromRanges = (ranges) => {
    let s = '';
    for (const [lo, hi] of ranges) for (let cp = lo; cp <= hi; cp++) s += String.fromCodePoint(cp);
    return s;
};

const text = codepointsFromRanges(LARGE_CORE_RANGES);
const shapeCache = new MonospaceShapeCache(chain);
shapeCache.prime(text);
const glyphIds = collectUniqueGlyphIds(shapeText(shapeCache, text).lines);

const enc = new SlugEncoder(chain);
enc.encode(glyphIds);
const descriptor = enc.serialize();

const key = slugCoreKey({ fonts, encodeRanges: LARGE_CORE_RANGES });
await saveSlugCore(key, descriptor);                 // production envelope+gzip → bun MemoryBackend
const bytes = await blobStore.getBytes(key);

const outDir = join(ROOT, 'app/public/slug-core');
mkdirSync(outDir, { recursive: true });
// Prune stale bakes (old keys) so only the current one ships.
for (const f of readdirSync(outDir)) {
    if (f.endsWith('.bin') && f !== `${key}.bin`) { rmSync(join(outDir, f)); console.log(`[bake] pruned stale ${f}`); }
}
const outPath = join(outDir, `${key}.bin`);
writeFileSync(outPath, bytes);

console.log(`\n[bake] key:    ${key}`);
console.log(`[bake] glyphs: ${descriptor.encodedIds.length}   curves: ${descriptor.curveCount}`);
console.log(`[bake] wrote:  app/public/slug-core/${key}.bin  (${(bytes.byteLength / 1024).toFixed(1)}KB gz)`);
