// load-profile.mjs — CPU-profile the 1500-file load and aggregate self-time.
// Answers "what exactly eats the frame loop during seat" with a real profile
// instead of ablation guesswork.
//
//   bun tools/load-profile.mjs            (relay :8099, whole-repo openDir)

import { launchBrowser, openApp } from './itest/driver.mjs';

const RELAY = Number(process.env.STORM_RELAY || 8099);
const DIR = process.env.STORM_DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const browser = await launchBrowser({});
try {
    const app = await openApp(browser, { relayPort: RELAY, wait: 6000 });
    if (!app.booted) { console.log('✗ app did not boot'); process.exit(1); }

    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   // µs
    await cdp.send('Profiler.start');

    const t0 = Date.now();
    const r = await app.cmd(`file.openDir ${DIR}`);
    const wall = Date.now() - t0;
    console.log(`openDir: ${r?.text?.slice(0, 90)} · wall ${wall}ms`);

    const { profile } = await cdp.send('Profiler.stop');

    // Aggregate SELF time per function (sample counts × interval).
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();   // "fn @ url:line" -> ms
    const interval = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    for (const id of profile.samples) {
        const n = nodes.get(id);
        if (!n) continue;
        const f = n.callFrame;
        const url = (f.url || '').split('/').slice(-2).join('/');
        const key = `${f.functionName || '(anon)'} @ ${url}:${f.lineNumber}`;
        self.set(key, (self.get(key) || 0) + interval);
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    console.log(`\nprofile: ${profile.samples.length} samples · top self-time:`);
    for (const [k, ms] of top) console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${k}`);
} finally {
    await browser.close();
}
