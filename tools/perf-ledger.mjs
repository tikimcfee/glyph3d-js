#!/usr/bin/env bun
/**
 * perf-ledger.mjs — one append-only ledger of performance measurements per HOST, and a compare
 * that reads a new measurement against that host's own history.
 *
 *   bun tools/perf-ledger.mjs compare [--scenario S] [--window 20] [--host KEY]
 *                                     each metric's latest row vs the rolling median of the rows
 *                                     before it, inside its noise band or not (exit 1 on a
 *                                     regression past the band)
 *   bun tools/perf-ledger.mjs show [--scenario S] [--host KEY] [--last 20]
 *   bun tools/perf-ledger.mjs add --scenario S --metric M --median X [--p95 Y] [--n N] [--adapter A]
 *   bun tools/perf-ledger.mjs host                 this machine's key and ledger path
 *
 * A row: {ts, commit, dirty, scenario, metric, median, p95, n, adapter, load}
 *   commit/dirty — what was measured (git HEAD, and whether the tree had changes)
 *   adapter      — the GPU as the page saw it (WEBGL_debug_renderer_info's UNMASKED_RENDERER)
 *   load         — the 1-minute load average per core when the row was written: a busy machine
 *                  swings frame numbers 3×, so a row measured under load says so
 *
 * WHERE: <checkout>/perf/<host-key>.jsonl, where <checkout> is the MAIN checkout (git's common
 * dir), so every worktree of the repo reads and writes one history. `perf/` is gitignored: the
 * rows are this machine's, they would conflict on every branch that appended, and a public repo
 * carries no host identity. GLYPH_PERF_DIR moves it.
 *
 * HOST KEY: the GPU, readable, plus a short hash of the hostname — `nvidia-geforce-rtx-5090-3fa9c1`:
 * two machines with the same GPU stay apart, and the key never spells the hostname. A
 * measurement from another GPU on the same machine is another host. GLYPH_PERF_HOST (or --host)
 * names the key yourself.
 *
 * NOISE BANDS: tools/perf-bands.json, per metric (a key matches a metric exactly, or as a prefix
 * ending in '.'), falling back to "default": the band around the baseline is
 *   max(rel × baseline, abs, k × MAD of the window)
 * and `better` says which direction is a regression ("lower" for times and bytes).
 *
 * Producers: tools/frame-profile.mjs --ledger SCENARIO. Any tool adds rows with
 *   import { appendRows } from './perf-ledger.mjs';
 *   appendRows({ scenario: 'wall-text/direct', adapter, rows: [{ metric, median, p95, n }] });
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, hostname, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANDS_PATH = join(ROOT, 'tools/perf-bands.json');

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });

/** The ledger directory: <main checkout>/perf, shared by every worktree (GLYPH_PERF_DIR overrides). */
export function ledgerDir() {
    if (process.env.GLYPH_PERF_DIR) return resolve(process.env.GLYPH_PERF_DIR);
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim();
    return join(common ? dirname(common) : ROOT, 'perf');
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/**
 * The GPU's own name out of a renderer string: ANGLE's wrapper, the backend and its version, PCI
 * ids, shader models and repeated vendor words go —
 *   'ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 5090 (0x00002B85)), NVIDIA)' → 'NVIDIA GeForce RTX 5090'
 *   'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'                → 'Apple M2'
 *   'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'           → 'NVIDIA GeForce RTX 3080'
 */
export function gpuName(renderer) {
    let s = String(renderer || '');
    const angle = /^ANGLE \((.*)\)$/.exec(s);
    if (angle) s = angle[1].split(', ')[1] ?? angle[1];
    const backend = /^(?:Vulkan|OpenGL(?: ES)?|Metal)[\s\d.]*\((.*)\)$/i.exec(s);
    if (backend) s = backend[1];
    s = s.replace(/.*Renderer:\s*/i, '').replace(/\s*\(0x[0-9a-f]+\)/ig, '').replace(/\s*(Direct3D\d*|vs_\S+|ps_\S+).*$/i, '');
    const words = s.split(/\s+/).filter(Boolean);
    return words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase()).join(' ').trim();
}

/**
 * This machine's key for an adapter: the GPU's name, slugged, + 6 hex of sha256(hostname).
 * @param {string} adapter  UNMASKED_RENDERER (or any GPU description)
 */
export function hostKey(adapter) {
    if (process.env.GLYPH_PERF_HOST) return slug(process.env.GLYPH_PERF_HOST);
    const h = createHash('sha256').update(hostname()).digest('hex').slice(0, 6);
    return `${slug(gpuName(adapter)) || 'unknown-gpu'}-${h}`;
}

export const ledgerPath = (key) => join(ledgerDir(), `${key}.jsonl`);

/**
 * Append measurement rows for one scenario. Each row needs metric + median; p95 and n default to
 * the median and 1 (a single reading). Returns the ledger path written.
 * @param {{scenario: string, adapter: string, rows: Array<{metric: string, median: number, p95?: number, n?: number}>, host?: string}} m
 */
export function appendRows({ scenario, adapter, rows, host }) {
    if (!scenario) throw new Error('perf-ledger: a row needs a scenario');
    const key = host ?? hostKey(adapter);
    const path = ledgerPath(key);
    mkdirSync(dirname(path), { recursive: true });
    const commit = git('rev-parse', '--short', 'HEAD').stdout.trim() || null;
    const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim().length > 0;
    const ts = new Date().toISOString();
    const load = +(loadavg()[0] / availableParallelism()).toFixed(2);
    const lines = rows.map((r) => {
        if (!r.metric || !Number.isFinite(r.median)) throw new Error(`perf-ledger: bad row ${JSON.stringify(r)} (metric + finite median required)`);
        return JSON.stringify({ ts, commit, dirty, scenario, metric: r.metric, median: r.median, p95: r.p95 ?? r.median, n: r.n ?? 1, adapter, load });
    });
    if (lines.length) appendFileSync(path, lines.join('\n') + '\n');
    return path;
}

/** Every row of a host's ledger, oldest first. */
export function readRows(key) {
    const path = ledgerPath(key);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function bandFor(metric) {
    const cfg = JSON.parse(readFileSync(BANDS_PATH, 'utf8'));
    const keys = Object.keys(cfg).filter((k) => k !== 'default' && !k.startsWith('//')
        && (k === metric || (k.endsWith('.') && metric.startsWith(k))))
        .sort((a, b) => b.length - a.length);
    return { rel: 0.1, abs: 0, k: 3, better: 'lower', minBaseline: 3, ...cfg.default, ...(keys.length ? cfg[keys[0]] : {}) };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Each (scenario, metric)'s latest row against the rolling median of up to `window` rows before it.
 * @returns {Array<{scenario, metric, now, base, n, band, delta, verdict}>}
 */
export function compare({ key, scenario = null, window = 20 }) {
    const rows = readRows(key).filter((r) => !scenario || r.scenario === scenario);
    const groups = new Map();
    for (const r of rows) {
        const g = `${r.scenario}\u0000${r.metric}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
    }
    const out = [];
    for (const list of groups.values()) {
        const last = list[list.length - 1];
        const prior = list.slice(Math.max(0, list.length - 1 - window), -1).map((r) => r.median);
        const b = bandFor(last.metric);
        if (prior.length < b.minBaseline) {
            out.push({ scenario: last.scenario, metric: last.metric, now: last.median, base: null, n: prior.length, band: null, delta: null, verdict: `no baseline (${prior.length} of ${b.minBaseline} rows)`, last });
            continue;
        }
        const base = median(prior);
        const mad = median(prior.map((v) => Math.abs(v - base)));
        const band = Math.max(b.rel * Math.abs(base), b.abs, b.k * mad);
        const delta = last.median - base;
        const worse = b.better === 'higher' ? delta < -band : delta > band;
        const better = b.better === 'higher' ? delta > band : delta < -band;
        out.push({ scenario: last.scenario, metric: last.metric, now: last.median, base, n: prior.length, band, delta,
            verdict: worse ? 'REGRESSED' : better ? 'improved' : 'within', last });
    }
    return out.sort((a, b) => (a.scenario + a.metric).localeCompare(b.scenario + b.metric));
}

const fmt = (v) => (v == null ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : +(+v).toFixed(3));

/** Print a compare table; returns the number of regressions. */
export function printCompare(results) {
    let bad = 0;
    for (const r of results) {
        if (r.verdict === 'REGRESSED') bad++;
        const pct = r.base ? ` ${r.delta >= 0 ? '+' : ''}${((100 * r.delta) / r.base).toFixed(1)}%` : '';
        const loadNote = r.last.load > 0.5 ? `  (load ${r.last.load}/core)` : '';
        const dirty = r.last.dirty ? '+dirty' : '';
        console.log(`${r.verdict.padEnd(10)} ${r.scenario} ${r.metric.padEnd(30)} now ${fmt(r.now)}  base ${fmt(r.base)} (median of ${r.n})${pct}  band ±${fmt(r.band)}  @${r.last.commit}${dirty}${loadNote}`);
    }
    return bad;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
    const argv = process.argv.slice(2);
    const flag = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const verb = argv[0];
    const adapterGuess = () => {
        // No page at hand: the GPU as the OS names it (only for picking a key — rows from pages
        // carry the page's UNMASKED_RENDERER).
        const smi = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' });
        return smi.status === 0 ? smi.stdout.trim().split('\n')[0] : 'unknown-gpu';
    };
    const key = flag('--host') ?? (process.env.GLYPH_PERF_HOST ? hostKey('') : null);
    const pickKey = () => {
        if (key) return key;
        const keys = existsSync(ledgerDir()) ? readdirSync(ledgerDir()).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)) : [];
        const suffix = hostKey('x').split('-').pop();
        const mine = keys.filter((k) => k.endsWith(`-${suffix}`));
        if (mine.length === 1) return mine[0];
        if (mine.length > 1) { console.error(`several ledgers on this host (${mine.join(', ')}) — pick one with --host`); process.exit(2); }
        return hostKey(adapterGuess());
    };
    if (verb === 'host') {
        const k = pickKey();
        console.log(`host key ${k}\nledger   ${ledgerPath(k)}  (${readRows(k).length} rows)`);
    } else if (verb === 'add') {
        const path = appendRows({
            scenario: flag('--scenario'), adapter: flag('--adapter', adapterGuess()), host: key ?? undefined,
            rows: [{ metric: flag('--metric'), median: Number(flag('--median')), p95: flag('--p95') == null ? undefined : Number(flag('--p95')), n: flag('--n') == null ? undefined : Number(flag('--n')) }],
        });
        console.log(`appended → ${path}`);
    } else if (verb === 'show') {
        const k = pickKey();
        const rows = readRows(k).filter((r) => !flag('--scenario') || r.scenario === flag('--scenario'));
        for (const r of rows.slice(-Number(flag('--last', 20)))) console.log(JSON.stringify(r));
        console.log(`${rows.length} rows in ${ledgerPath(k)}`);
    } else if (verb === 'compare') {
        const k = pickKey();
        const res = compare({ key: k, scenario: flag('--scenario'), window: Number(flag('--window', 20)) });
        if (!res.length) { console.log(`no rows${flag('--scenario') ? ` for ${flag('--scenario')}` : ''} in ${ledgerPath(k)}`); process.exit(0); }
        const bad = printCompare(res);
        console.log(bad ? `REGRESSED — ${bad} metric(s) past their band (host ${k})` : `within bands — ${res.length} metric(s) (host ${k})`);
        process.exit(bad ? 1 : 0);
    } else {
        console.error('usage: bun tools/perf-ledger.mjs compare|show|add|host [...]   (see the header)');
        process.exit(2);
    }
}
