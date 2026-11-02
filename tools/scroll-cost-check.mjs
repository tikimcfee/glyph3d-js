// scroll-cost-check.mjs — what a LIVE agent batch costs a scroll book on the live display, against the
// headless number (scroll-form.test.mjs §6): per batch, applyEvents + the frame's flush that lays it,
// read back through book.cost (AgentBooks.scrollCost).
//
//   bun tools/scroll-cost-check.mjs --book <agent book id> [--port 8080] [--seconds 60] [--min-batches 10]
//        [--held] [--budget-ms 4] [--headless] [--gate]
//
// The book must be in its scroll form (an agent book seated at a plane desk is born one). Its agent must be
// RUNNING — the batches are its own live events; nothing is synthesized. --held scrolls the document up a
// few rows first (live events then wait as `+N newer`, the held path) and rides the end again after.
// --headless also runs scroll-form.test.mjs and prints its tail-append numbers beside the live ones.
//
// Measures (and with --gate, asserts):
//   batches  at least --min-batches live batches landed in --seconds (else the agent was idle: no verdict)
//   cost     live p95 ≤ --budget-ms (scroll-form's own budget, 4 ms)
//   held     with --held, every batch was taken while held (the document didn't snap to the end)
// It does not move the camera; with --held it scrolls the book (and puts it back on the live end).

import { dialRelay } from './lib/relay.mjs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const book = opt('book', null);
if (!book) { console.error('usage: bun tools/scroll-cost-check.mjs --book <agent book id> [--port 8080] [--seconds 60] [--min-batches 10] [--held] [--budget-ms 4] [--headless] [--gate]'); process.exit(2); }
const port = Number(opt('port', 8080)), seconds = Number(opt('seconds', 60)), minBatches = Number(opt('min-batches', 10));
const budget = Number(opt('budget-ms', 4)), held = flag('held'), gate = flag('gate');

const relay = await dialRelay(port);
const req = async (line, ms = 10000) => relay.request(line, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v) => (v == null ? '—' : `${v.toFixed(3)} ms`);

const v0 = await req(`book.view ${book}`);
if (!/^OK/.test(v0.text ?? '')) { console.error(v0.text); process.exit(1); }
if (held) {
    const r = await req(`book.rows ${book} -6`);
    if (!/^OK/.test(r.text ?? '') || r.data?.following) { console.error(`could not hold ${book}: ${r.text}`); process.exit(1); }
}
await req(`book.cost ${book} reset`);
const t0 = Date.now();
let c = null;
while (Date.now() - t0 < seconds * 1000) {
    await sleep(1000);
    c = (await req(`book.cost ${book}`)).data;
    process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)} s · ${c.batches} live batches · p95 ${f(c.p95)}   `);
}
process.stdout.write('\n');
if (held) await req(`book.page ${book} last`);
relay.close();

let headless = null;
if (flag('headless')) {
    const r = spawnSync('bun', ['tools/scroll-form.test.mjs'], { encoding: 'utf8', timeout: 300000 });
    const m = /tail-append\s+p50 ([\d.]+) ms\s+p95 ([\d.]+) ms/.exec(r.stdout ?? '');
    headless = m ? { p50: Number(m[1]), p95: Number(m[2]) } : null;
    if (!headless) console.error('  (scroll-form.test.mjs printed no tail-append line)');
}

const results = [];
const report = (name, ok, detail) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name.padEnd(8)} ${detail}`); };
console.log(`book ${book} (${held ? 'held' : 'following'}): ${c.records} events, ${c.rows} rows, ${c.slots} slots in the document`);
console.log(`  live      p50 ${f(c.p50)}  p95 ${f(c.p95)}  max ${f(c.max)}  (apply p95 ${f(c.apply95)}, flush p95 ${f(c.flush95)}; laid p95 ${c.laid95 ?? '—'} slots, uploaded p95 ${c.uploaded95 ?? '—'})`);
if (headless) console.log(`  headless  p50 ${headless.p50.toFixed(3)} ms  p95 ${headless.p95.toFixed(3)} ms  (scroll-form §6, ${'at its 200-event cap'})`);
report('batches', c.batches >= minBatches, `${c.batches} live batches in ${seconds} s (≥ ${minBatches}${c.batches < minBatches ? ' — the agent was idle; no verdict on cost' : ''})`);
report('cost', c.p95 != null && c.p95 <= budget, `live p95 ${f(c.p95)} ≤ ${budget} ms`);
if (held) report('held', c.batches > 0 && c.following === 0, `${c.batches - c.following}/${c.batches} batches taken while held`);
if (gate) process.exit(results.every(Boolean) ? 0 : 1);
