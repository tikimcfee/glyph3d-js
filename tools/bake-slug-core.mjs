#!/usr/bin/env bun
/**
 * bake-slug-core.mjs — bake the prebaked slug core to a static asset.
 *
 *   bun tools/bake-slug-core.mjs
 *
 * Headless (HarfBuzz + FontChain run in bun). Encodes the LARGE_CORE for the app's font
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
 * changes too; the old asset is simply never requested). If the names below or the ranges
 * drift from the app, the worst case is a runtime 404 → live encode (fail-safe, not broken).
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Disk-backed fetch so FontChain (and emscripten's wasm load) read from the filesystem.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('file://') || url.startsWith('/')) {
        try {
            const p = url.startsWith('file://') ? fileURLToPath(url) : url;
            const buf = readFileSync(p);
            return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        } catch { return { ok: false, status: 404 }; }
    }
    return realFetch(input, init);
};

const { FontChain, MonospaceShapeCache, shapeText, collectUniqueGlyphIds, SlugEncoder,
        slugCoreKey, saveSlugCore } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/index.js`);
const { blobStore } = await import(`${ROOT}/packages/glyph3d-core/src/services/state/index.js`);
const { LARGE_CORE_RANGES } = await import(`${ROOT}/packages/glyph3d-r3f/src/coreRanges.js`);

// MUST match app/main.jsx FONT_CHAIN names (the key is name-based). A mismatch only costs a
// runtime 404 → live encode; it can't render wrong glyphs.
const FONTS = [
    { name: 'Cousine',          file: 'packages/glyph3d-core/src/fonts/Cousine-Regular.ttf' },
    { name: 'MesloLGS NF Mono', file: 'packages/glyph3d-core/src/fonts/MesloLGS-NF-Mono.ttf' },
    { name: 'DejaVu Sans',      file: 'packages/glyph3d-core/src/fonts/DejaVuSans.ttf' },
];

const codepointsFromRanges = (ranges) => {
    let s = '';
    for (const [lo, hi] of ranges) for (let cp = lo; cp <= hi; cp++) s += String.fromCodePoint(cp);
    return s;
};

const fonts = FONTS.map((f) => ({ url: `file://${ROOT}/${f.file}`, name: f.name }));
const chain = new FontChain();
await chain.init(fonts);

// CRITICAL: the runtime sets an EmojiAtlas, and FontChain allocates a BITMAP slot for any
// emoji-presentable codepoint (0x2600–0x27BF, 0x2B00–0x2BFF) that no outline font covers —
// from the SAME dense slot counter as outline glyphs. Without it the bake would skip those
// ~256 slots and every later slot would shift, so the hydrated textures would be keyed wrong
// (common text fine, symbols garbled). This stub replicates EmojiAtlas.ensure() EXACTLY —
// a per-cp-cached monotonic counter capped at the atlas capacity — so the bake's slot+cell
// allocation matches the runtime's. It draws nothing (the runtime redraws cells via prime);
// only the allocation ORDER + CAP matter for alignment. Keep CAPACITY = EmojiAtlas cols² (16²).
const EMOJI_CAPACITY = 256;
const stubEmojiAtlas = {
    _byCp: new Map(), _next: 0,
    ensure(cp) {
        const c = this._byCp.get(cp);
        if (c !== undefined) return c;
        if (this._next >= EMOJI_CAPACITY) return -1;
        const idx = this._next++;
        this._byCp.set(cp, idx);
        return idx;
    },
};
chain.setEmojiAtlas(stubEmojiAtlas);

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
