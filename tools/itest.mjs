// itest.mjs — integration tests against the live app in a real (WebGPU) browser.
//
//   bun tools/itest.mjs [--headed] [--url URL] [name-filter]
//
// Each tools/itests/*.itest.mjs default-exports an async function:
//   export default async ({ app, assert, url }) => { ... }
// where `app` is a booted, error-capturing driver (openApp) with .cmd / .evalPage /
// .shot / .waitFor / .booted / .errors, and `assert` is the tiny throwing assert
// (ok / equal / atLeast / noErrors). One fresh page per test for isolation; exit
// non-zero on any failure.
//
// Needs the dev loop up (tools/dev.sh). Use --headed on a GPU box for real WebGPU.
// Tests that repo.load reach GitHub (network) — a relay-served project avoids that.
// This is where panel/command/state correctness gets locked in as the UI lands.

import { readdirSync } from 'node:fs';
import { launchBrowser, openApp, makeAssert } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const urlIdx = argv.indexOf('--url');
const url = urlIdx >= 0 ? argv[urlIdx + 1] : 'http://localhost:5173/';
const filter = argv.find((a, i) => !a.startsWith('--') && i !== urlIdx + 1);

const dir = new URL('./itests/', import.meta.url);
let files;
try { files = readdirSync(dir).filter((f) => f.endsWith('.itest.mjs')); }
catch { console.error('no tools/itests/ directory'); process.exit(1); }
if (filter) files = files.filter((f) => f.includes(filter));
if (!files.length) { console.error('no matching tests'); process.exit(1); }

const browser = await launchBrowser({ headed });
let failed = 0;
for (const f of files.sort()) {
  const name = f.replace('.itest.mjs', '');
  const mod = await import(new URL(f, dir).href);
  if (typeof mod.default !== 'function') { console.log(`  ? ${name}: no default export`); continue; }
  const app = await openApp(browser, { url });
  try {
    await mod.default({ app, assert: makeAssert(), url });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
    for (const er of app.errors.slice(0, 3)) console.log(`      └ ${er.text}`);
  } finally {
    await app.close();
  }
}
await browser.close();
console.log(failed ? `\n${failed}/${files.length} FAILED` : `\nall ${files.length} passed`);
process.exit(failed ? 1 : 0);
