#!/usr/bin/env bun
/**
 * bench-reload.mjs — restart Vite and PROVE the fresh glyph-bench.jsx is served.
 *
 *   bun _experiments/glyph-encoding/bench-reload.mjs "<unique string from your edit>"
 *
 * The gotcha this kills: editing app/glyph-bench.jsx and reloading the browser
 * gets you STALE code — Vite's HMR serves the cached module, so your edit silently
 * doesn't take (cost us hours). The fix is always a Vite cache-clear restart. This
 * does that, polls until Vite is up, fetches the SERVED jsx, and (if you pass a
 * marker string you just added) confirms it's actually in the bytes Vite hands out
 * — so you KNOW the browser will get the new code before you hard-reload.
 *
 * Tip: add a marker as a comment in your edit, e.g. // EDIT: packed-attrs-v3, then
 *   bun .../bench-reload.mjs "packed-attrs-v3"
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const marker = process.argv[2];
const PORT = process.env.VITE_PORT || '5173';
const url = `http://localhost:${PORT}/glyph-bench.jsx`;

console.log('→ restarting Vite (clears stale HMR cache)…');
const r = spawnSync('bash', [join(ROOT, 'tools/dev.sh'), 'vite'], { encoding: 'utf8' });
if (r.status !== 0) console.warn('  (dev.sh vite returned non-zero; continuing to poll anyway)');

// Poll until Vite serves the transformed module (transform = no fatal compile error).
let body = null;
for (let i = 0; i < 24; i++) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) { body = await res.text(); break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (body == null) {
  console.error(`✗ Vite never served ${url} — check the log: tail -n 30 /tmp/glyph3d/vite.log`);
  process.exit(1);
}
console.log(`✓ Vite up · glyph-bench.jsx compiled & served (${body.length} bytes)`);

if (!marker) {
  console.log('… no marker arg given — pass a unique string from your edit to verify it is actually live.');
  console.log('  hard-reload the browser (Ctrl+Shift+R) at http://localhost:' + PORT + '/glyph-bench.html');
  process.exit(0);
}
if (body.includes(marker)) {
  console.log(`✓ marker "${marker}" IS in the served code — your edit is live.`);
  console.log('  → hard-reload the browser (Ctrl+Shift+R) at http://localhost:' + PORT + '/glyph-bench.html');
} else {
  console.error(`✗ marker "${marker}" NOT in the served code — Vite is serving STALE, or the edit didn't save / didn't match.`);
  console.error('  re-run after confirming the string is in app/glyph-bench.jsx.');
  process.exit(1);
}
