#!/usr/bin/env bun
/**
 * bake.mjs — bake a repo's layout index: the idempotent fold over every readable file.
 *
 *   bun tools/bake.mjs <dir> [--out DIR] [--interval N] [--font-size N] [--world-scale N] [--force]
 *
 * For each file, bakeFile (glyphBake.js) streams the bytes once through the REAL
 * font-chain metrics (tools/headlessFontChain.mjs — the same HarfBuzz + FontChain the
 * runtime boots, so baked advances are bit-identical to the live trie's) and the
 * shared index lands in <dir>/.glyph3d/bake/:
 *
 *   index.json        header (metricsHash, interval, lineHeight, …) + one scalar
 *                     record per file (rows, widest row, box, total summary, blob
 *                     offsets) + the repo codepoint census
 *   checkpoints.bin   every file's monoid checkpoints, f64 LE — random access into
 *                     any file's layout without folding it from byte 0
 *   hist.bin          every file's sparse line-length histogram, u32 LE pairs —
 *                     exact row counts under any wrap width
 *
 * IDEMPOTENT at every level: a record is keyed by (contentHash, metricsHash,
 * BAKE_VERSION, interval) — unchanged files carry their records forward without
 * re-reading them; an unchanged repo produces byte-identical output and writes
 * nothing. No timestamps anywhere.
 *
 * What it skips, it skips the way the RUNTIME does (core/fileKind + core/readability
 * — the same partition file.openDir applies), and every skip is counted and printed:
 * a file without a record is a file the runtime never stages as glyphs.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, resolve, relative, sep } from 'path';
import { ROOT, FONTS, bootHeadlessFontChain } from './headlessFontChain.mjs';

const core = `${ROOT}/packages/glyph3d-core/src`;
const { bakeFile, collectCensus, BAKE_VERSION, CHECKPOINT_INTERVAL, CK_STRIDE } =
    await import(`${core}/compute/glyphBake.js`);
const { buildLiveTrie } = await import(`${core}/compute/liveTrie.js`);
const { computeCellMetrics, deriveCharSize } = await import(`${core}/core/cellMetrics.js`);
const { classifyByExtension, classifyBytes } = await import(`${core}/core/fileKind.js`);
const { unreadableReason } = await import(`${core}/core/readability.js`);

// ── args ──
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--out', '--interval', '--font-size', '--world-scale']);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── metrics identity: the fonts' bytes + the two config scalars ARE the advances ──
const metricsHash = sha256(JSON.stringify({
    fonts: FONTS.map((f) => ({ name: f.name, sha256: sha256(readFileSync(join(ROOT, f.file))) })),
    fontSize, worldScale,
})).slice(0, 16);

// ── previous index: carry unchanged records forward ──
let prev = null, prevCk = null, prevHist = null;
if (!force) {
    try {
        const p = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8'));
        const headerMatches = p.version === BAKE_VERSION && p.metricsHash === metricsHash
            && p.checkpointInterval === interval && p.fontSize === fontSize && p.worldScale === worldScale;
        if (headerMatches) {
            prev = p;
            prevCk = readFileSync(join(outDir, 'checkpoints.bin'));
            prevHist = readFileSync(join(outDir, 'hist.bin'));
        } else {
            console.log(`[bake] previous index header differs (version/metrics/interval) — full rebake`);
        }
    } catch { /* no previous index */ }
}

// ── pass 1: classify + hash + census; decide keep-vs-bake per file ──
const t0 = performance.now();
const paths = listFiles(repoDir).sort();
const outPrefix = relative(repoDir, outDir).split(sep).join('/');
const decoder = new TextDecoder();
const census = new Set();
const keep = new Map();   // path → prev record (carried)
const toBake = [];        // { path, hash }
const counts = { image: 0, binary: 0, oversize: 0, unreadable: 0, unreadFile: 0 };
let totalBytes = 0;

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
    const prevRec = prev?.files?.[path];
    if (prevRec && prevRec.hash === hash) keep.set(path, prevRec);
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
const records = new Map();  // path → { rec } | { carried }
const missingUnion = new Set();
for (const { path, hash } of toBake) {
    const bytes = readFileSync(join(repoDir, path));
    const rec = bakeFile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), trie,
        { lineHeight, checkpointInterval: interval });
    for (const cp of rec.missing) missingUnion.add(cp);
    records.set(path, { rec, hash });
}
if (missingUnion.size > 0) {
    // Should be structurally impossible: the trie was built from the full census.
    console.warn(`[bake] ${missingUnion.size} codepoints missed the trie DESPITE census priming — their advances are the missing fallback. First: ${[...missingUnion].slice(0, 8).map((c) => 'U+' + c.toString(16)).join(' ')}`);
}

// ── assemble, sorted by path: blobs + index, deterministically ──
const allPaths = [...new Set([...keep.keys(), ...records.keys()])].sort();
const ckParts = [], histParts = [];
let ckOff = 0, histOff = 0;
const files = {};
for (const path of allPaths) {
    const carried = keep.get(path);
    if (carried) {
        // Slice the carried blobs out of the previous files; offsets renumber below.
        const ckBytes = prevCk.subarray(carried.ck[0], carried.ck[0] + carried.ck[1] * CK_STRIDE * 8);
        const histBytes = prevHist.subarray(carried.hist[0], carried.hist[0] + carried.hist[1] * 8);
        ckParts.push(ckBytes); histParts.push(histBytes);
        files[path] = { ...carried, ck: [ckOff, carried.ck[1]], hist: [histOff, carried.hist[1]] };
        ckOff += ckBytes.byteLength; histOff += histBytes.byteLength;
        continue;
    }
    const { rec, hash } = records.get(path);
    const ckBytes = new Uint8Array(rec.checkpoints.buffer, 0, rec.checkpoints.byteLength);
    const histPairs = [...rec.lineHist.entries()].sort((a, b) => a[0] - b[0]);
    const histU32 = new Uint32Array(histPairs.length * 2);
    histPairs.forEach(([len, count], i) => { histU32[i * 2] = len; histU32[i * 2 + 1] = count; });
    const histBytes = new Uint8Array(histU32.buffer);
    ckParts.push(ckBytes); histParts.push(histBytes);
    files[path] = {
        hash,
        bytes: rec.byteLength,
        leaders: rec.leaders,
        newlines: rec.newlines,
        rows: rec.totalRows,
        maxRowExtent: rec.maxRowExtent,
        maxLineWidth: rec.maxLineWidth,
        maxHeight: rec.maxHeight,
        box: rec.box,
        total: {
            nl: rec.total.nl, glyphs: rec.total.glyphs, rows: rec.total.rows,
            headLen: rec.total.headLen, tailLen: rec.total.tailLen, tailAdv: rec.total.tailAdv,
        },
        ck: [ckOff, rec.checkpoints.length / CK_STRIDE],
        hist: [histOff, histPairs.length],
    };
    ckOff += ckBytes.byteLength; histOff += histBytes.byteLength;
}

const concat = (parts, size) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
};
const index = {
    version: BAKE_VERSION,
    metricsHash,
    checkpointInterval: interval,
    fontSize, worldScale, lineHeight,
    charSize,
    fonts: FONTS.map((f) => f.name),
    census: [...census].sort((a, b) => a - b),
    files,
};

// ── write only what changed (an unchanged repo writes nothing) ──
mkdirSync(outDir, { recursive: true });
const writeIfChanged = (name, bytes) => {
    try {
        const old = readFileSync(join(outDir, name));
        if (old.byteLength === bytes.byteLength && old.equals(Buffer.from(bytes))) return false;
    } catch { /* absent */ }
    writeFileSync(join(outDir, name), bytes);
    return true;
};
const wroteIndex = writeIfChanged('index.json', Buffer.from(JSON.stringify(index)));
const wroteCk = writeIfChanged('checkpoints.bin', concat(ckParts, ckOff));
const wroteHist = writeIfChanged('hist.bin', concat(histParts, histOff));

const ms = performance.now() - t0;
console.log(`[bake] index: ${allPaths.length} records, checkpoints ${(ckOff / 1024).toFixed(0)}KB, hist ${(histOff / 1024).toFixed(0)}KB`
    + ` — ${wroteIndex || wroteCk || wroteHist ? 'written to' : 'UNCHANGED at'} ${outDir}`);
console.log(`[bake] ${ms.toFixed(0)}ms (${(totalBytes / 1e6 / (ms / 1000)).toFixed(1)}MB/s incl. shaping boot)`);
