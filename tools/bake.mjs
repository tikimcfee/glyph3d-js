#!/usr/bin/env bun
/**
 * bake.mjs — bake a repo's layout index: the idempotent fold over every readable file.
 *
 *   bun tools/bake.mjs <dir> [--out DIR] [--interval N] [--font-size N] [--world-scale N] [--force]
 *
 * For each file, bakeFile (glyphBake.js) streams the bytes once through the REAL
 * font-chain metrics (tools/headlessFontChain.mjs — the same HarfBuzz + FontChain the
 * runtime boots, so baked advances are bit-identical to the live trie's) and the
 * shared index lands as ONE binary file, <dir>/.glyph3d/bake/index.bin
 * (glyphBakeIndex.js: header + census + records + hashes + paths + checkpoint/hist
 * blobs — the consumer fetches once and reads typed views, no JSON anywhere).
 *
 * IDEMPOTENT at every level: a record is keyed by (contentHash, metricsHash,
 * BAKE_VERSION, interval) — unchanged files carry forward by re-slicing the previous
 * index through the same decoder the browser uses; an unchanged repo produces
 * byte-identical output and writes nothing. No timestamps anywhere.
 *
 * What it skips, it skips the way the RUNTIME does (core/fileKind + core/readability
 * — the same partition file.openDir applies), and every skip is counted and printed:
 * a file without a record is a file the runtime never stages as glyphs.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, resolve, relative, sep } from 'path';
import { ROOT, FONTS, bootHeadlessFontChain } from './headlessFontChain.mjs';

const core = `${ROOT}/packages/glyph3d-core/src`;
const { bakeFile, collectCensus, CHECKPOINT_INTERVAL } = await import(`${core}/compute/glyphBake.js`);
const { encodeBakeIndex, decodeBakeIndex } = await import(`${core}/compute/glyphBakeIndex.js`);
const { buildLiveTrie } = await import(`${core}/compute/liveTrie.js`);
const { computeCellMetrics, deriveCharSize } = await import(`${core}/core/cellMetrics.js`);
const { classifyByExtension, classifyBytes } = await import(`${core}/core/fileKind.js`);
const { unreadableReason } = await import(`${core}/core/readability.js`);

// ── args ──
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--out', '--interval', '--font-size', '--world-scale']);
const flag = (n, d) => {
    const i = argv.indexOf(n);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith('--') ? v : d;   // `--out --force` is a missing value, not "--force"
};
let positional = null;
for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { i++; continue; }
    if (!argv[i].startsWith('--')) { positional = argv[i]; break; }
}
const repoDir = resolve(positional || '.');
const outDir = resolve(flag('--out', join(repoDir, '.glyph3d/bake')));
const interval = Math.max(64, Math.trunc(Number(flag('--interval', CHECKPOINT_INTERVAL))));
const fontSize = Number(flag('--font-size', 48));       // app default: settings atlas.fontSize
const worldScale = Number(flag('--world-scale', 0.025)); // the arena's scale (GlyphCanvas)
const force = argv.includes('--force');

/** Mirror of cli/fs.go maxFileSize — the relay never serves a larger file. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNIFF_BYTES = 4096;

// ── the file list: git's when this is a repo (respects .gitignore), else a walk ──
function listFiles(dir) {
    try {
        // Tracked + untracked-unignored: the RUNTIME walks the real filesystem, so an
        // uncommitted new file must bake too — git only contributes .gitignore logic.
        const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 1 << 28 });
        return out.toString('utf8').split('\0').filter(Boolean);
    } catch {
        const files = [];
        const skip = new Set(['.git', '.glyph3d', 'node_modules']);
        const walk = (rel) => {
            for (const name of readdirSync(join(dir, rel))) {
                if (skip.has(name)) continue;
                const r = rel ? `${rel}/${name}` : name;
                const st = lstatSync(join(dir, r));
                if (st.isDirectory()) walk(r);
                else if (st.isFile()) files.push(r);
            }
        };
        walk('');
        return files;
    }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest();

// ── metrics identity: the fonts' bytes + the two config scalars ARE the advances ──
const metricsHash = sha256(JSON.stringify({
    fonts: FONTS.map((f) => ({ name: f.name, sha256: sha256(readFileSync(join(ROOT, f.file))).toString('hex') })),
    fontSize, worldScale,
})).toString('hex').slice(0, 16);

// ── previous index: carry unchanged records forward through the SAME decoder ──
let prev = null;
if (!force) {
    try {
        const bytes = new Uint8Array(readFileSync(join(outDir, 'index.bin')));
        const d = decodeBakeIndex(bytes);           // throws on magic/version mismatch
        const h = d.header;
        if (h.metricsHash === metricsHash && h.checkpointInterval === interval
            && h.fontSize === fontSize && h.worldScale === worldScale) {
            prev = d;
        } else {
            console.log(`[bake] previous index metrics/interval differ — full rebake`);
        }
    } catch (err) {
        if (existsSync(join(outDir, 'index.bin'))) console.log(`[bake] previous index unreadable (${err.message}) — full rebake`);
    }
}

// ── pass 1: classify + hash + census; decide keep-vs-bake per file ──
const t0 = performance.now();
const paths = listFiles(repoDir).sort();
const outPrefix = relative(repoDir, outDir).split(sep).join('/');
const decoder = new TextDecoder();
const census = new Set();
const keep = new Map();   // path → index into prev
const toBake = [];        // { path, hash }
const counts = { image: 0, binary: 0, oversize: 0, unreadable: 0, unreadFile: 0 };
let totalBytes = 0;

const hashEq = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false; return true; };

for (const path of paths) {
    if (outPrefix && !outPrefix.startsWith('..') && path.startsWith(outPrefix + '/')) continue;
    const abs = join(repoDir, path);
    let st;
    try { st = lstatSync(abs); } catch { counts.unreadFile++; continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) { counts.oversize++; continue; }

    const kind = classifyByExtension(path);
    if (kind?.kind === 'image') { counts.image++; continue; }

    let bytes;
    try { bytes = readFileSync(abs); } catch { counts.unreadFile++; continue; }
    if (!kind) {
        const sniffed = classifyBytes(bytes.subarray(0, SNIFF_BYTES));
        if (sniffed.kind !== 'text') { counts.binary++; continue; }
    }
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (unreadableReason(decoder.decode(u8))) { counts.unreadable++; continue; }

    totalBytes += bytes.byteLength;
    collectCensus(u8, census);
    const hash = sha256(bytes);
    const pi = prev?.pathIndex.get(path);
    if (pi !== undefined && hashEq(prev.hashAt(pi), hash)) keep.set(path, pi);
    else toBake.push({ path, hash });
}

console.log(`[bake] ${repoDir}`);
console.log(`[bake] ${keep.size + toBake.length} readable files (${(totalBytes / 1e6).toFixed(1)}MB), census ${census.size} codepoints`
    + ` — ${keep.size} carried, ${toBake.length} to bake`);
const skipped = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
if (skipped) console.log(`[bake] skipped: ${skipped} (same partition the runtime applies — these never stage as glyphs)`);

// ── the trie: ONE build from the repo census, through the real chain ──
const { chain } = await bootHeadlessFontChain();
const { MonospaceShapeCache } = await import(`${core}/shaping/index.js`);
const shapeCache = new MonospaceShapeCache(chain);
{
    // Prime in codepoint order — order only affects slot ids, which the bake never
    // records; advances (all the record sees) are order-independent.
    let s = '';
    for (const cp of [...census].sort((a, b) => a - b)) s += String.fromCodePoint(cp);
    shapeCache.prime(s);
}
const charSize = deriveCharSize(chain, fontSize);
const atlasDuck = { _shapeCache: shapeCache, _shaper: chain, getCharSize: () => charSize };
const trie = buildLiveTrie(atlasDuck, worldScale);
const lineHeight = computeCellMetrics(charSize, worldScale).lineSpacing;

// ── pass 2: bake what changed ──
const baked = new Map();  // path → { record, hash }
const missingUnion = new Set();
for (const { path, hash } of toBake) {
    const bytes = readFileSync(join(repoDir, path));
    const record = bakeFile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), trie,
        { lineHeight, checkpointInterval: interval });
    for (const cp of record.missing) missingUnion.add(cp);
    baked.set(path, { record, hash });
}
if (missingUnion.size > 0) {
    // Should be structurally impossible: the trie was built from the full census.
    console.warn(`[bake] ${missingUnion.size} codepoints missed the trie DESPITE census priming — their advances are the missing fallback. First: ${[...missingUnion].slice(0, 8).map((c) => 'U+' + c.toString(16)).join(' ')}`);
}

// ── assemble, sorted by path, and encode the ONE file ──
const allPaths = [...new Set([...keep.keys(), ...baked.keys()])].sort();
const entries = allPaths.map((path) => {
    const pi = keep.get(path);
    if (pi !== undefined) return { path, hash: prev.hashAt(pi), record: prev.recordAt(pi) };
    const b = baked.get(path);
    return { path, hash: new Uint8Array(b.hash), record: b.record };
});
const out = encodeBakeIndex(
    { fontSize, worldScale, lineHeight, charSize, checkpointInterval: interval, metricsHash },
    Uint32Array.from([...census].sort((a, b) => a - b)),
    entries,
);

// ── write only what changed (an unchanged repo writes nothing) ──
mkdirSync(outDir, { recursive: true });
let wrote = true;
try {
    const old = readFileSync(join(outDir, 'index.bin'));
    if (old.byteLength === out.byteLength && old.equals(Buffer.from(out))) wrote = false;
} catch { /* absent */ }
if (wrote) writeFileSync(join(outDir, 'index.bin'), out);
// The v1 three-file layout is dead — prune it loudly rather than leave a stale twin.
for (const stale of ['index.json', 'checkpoints.bin', 'hist.bin']) {
    if (existsSync(join(outDir, stale))) { rmSync(join(outDir, stale)); console.log(`[bake] pruned v1 artifact ${stale}`); }
}

const ms = performance.now() - t0;
console.log(`[bake] index.bin: ${allPaths.length} records, ${(out.byteLength / 1024).toFixed(0)}KB`
    + ` — ${wrote ? 'written to' : 'UNCHANGED at'} ${outDir}`);
console.log(`[bake] ${ms.toFixed(0)}ms (${(totalBytes / 1e6 / (ms / 1000)).toFixed(1)}MB/s incl. shaping boot)`);
