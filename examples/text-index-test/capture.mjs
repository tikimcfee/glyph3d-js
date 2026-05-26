// Headless capture for the text-index validation harness.
// Usage: bun examples/text-index-test/capture.mjs <url> <outPng>
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8099/examples/text-index-test/index.html';
const out = process.argv[3] || '/tmp/text-index.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(url, { waitUntil: 'networkidle' });

// Wait for the harness to finish booting (or fail).
await page.waitForFunction(() => window.__HARNESS && (window.__HARNESS.ready || window.__HARNESS.error), null, { timeout: 30000 })
  .catch(() => {});

const harness = await page.evaluate(() => window.__HARNESS || { ready: false, error: 'no __HARNESS' });

await page.screenshot({ path: out });
await browser.close();

console.log('=== HARNESS REPORT ===');
console.log(JSON.stringify(harness, null, 2));
if (errors.length) {
  console.log('\n=== CONSOLE ERRORS ===');
  errors.forEach(e => console.log(e));
}
console.log('\nscreenshot →', out);
