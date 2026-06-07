#!/usr/bin/env bun
/**
 * check.mjs — run every headless bench harness and report a pass/fail summary.
 *
 *   bun _experiments/glyph-encoding/check.mjs
 *
 * This is the DATA-PATH regression guard. Run it after any change that touches
 * the codec, the index layer, OR core (GlyphField/builder/shaping) — measure.js
 * and parity.js import the real core, so a core edit that breaks the build or the
 * slot space shows up here. It does NOT catch GPU/shader RENDER bugs (headless
 * can't draw WebGPU) — for those use the live guard: app/glyph-bench.html +
 * bench-reload.mjs. Exits non-zero if any harness fails.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HARNESSES = [
  ['run.js', 'encoding · fidelity · curves'],
  ['validate_picking.js', 'picking access patterns'],
  ['validate_highlights.js', 'highlight UTF-16 composition'],
  ['parity.js', 'slot-identity vs the app'],
  ['measure.js', 'real-builder byte-identity'],
];

const NOISE = /^\[(HarfBuzz|FontChain|SlugEncoder)\]/;
const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const padL = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));

let failed = 0;
const rows = [];
for (const [file, desc] of HARNESSES) {
  const t0 = Date.now();
  const r = spawnSync('bun', [join(HERE, file)], { encoding: 'utf8' });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) failed++;
  // the verdict = last meaningful stdout line; on failure, the last stderr line.
  const out = (r.stdout || '').split('\n').filter((l) => l.trim() && !NOISE.test(l));
  const err = (r.stderr || '').split('\n').filter((l) => l.trim());
  const verdict = (ok ? out[out.length - 1] : (err[err.length - 1] || out[out.length - 1])) || '(no output)';
  rows.push({ file, desc, ok, ms, verdict });
}

console.log('\n' + pad('harness', 24) + pad('what it guards', 30) + padL('ms', 6) + '  result');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(pad(r.file, 24) + pad(r.desc, 30) + padL(r.ms, 6) + '  ' +
    (r.ok ? '✓ ' : '✗ FAIL — ') + r.verdict.slice(0, 60));
}
console.log('-'.repeat(96));

if (failed) {
  console.error(`\n${failed}/${rows.length} harness(es) FAILED — re-run the failing one directly for full output:`);
  for (const r of rows) if (!r.ok) console.error(`  bun _experiments/glyph-encoding/${r.file}`);
  process.exit(1);
}
console.log(`\nAll ${rows.length} headless harnesses pass. (Visual/GPU guard: open app/glyph-bench.html.) ✓`);
