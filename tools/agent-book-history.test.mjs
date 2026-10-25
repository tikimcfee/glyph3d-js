// agent-book-history.test.mjs — behavior lock for an agent book's SLIDING WINDOW over its
// whole run (AgentBooks.setHistory / slide / loadOlder):
//
//   bun tools/agent-book-history.test.mjs
//
// A book is a fixed-size window (its cap of sheets) sliding over the run; turns outside
// it wait as parsed records. This gate locks, over a synthetic 100-turn claude transcript
// and a mock relay window:
//   - every parsed record carries its line's byte offset (`at`);
//   - paging near the oldest sheet PREFETCHES older records — no sheets added;
//   - pushing past the oldest sheet slides the window one turn back: the older turn at the
//     front, the newest out to the newer buffer — the window's size never changes, the
//     deck stays parallel to the entries, the head lands on the turn paged to;
//   - a slide wider than the buffer waits for reads and completes;
//   - a call at a slice edge pairs with its result (the overlap read);
//   - the first page back counts the turns before it (exact numbers); the run's start ends
//     history (turn 1 = the first);
//   - live turns while held wait in the newer buffer (the book doesn't shift); `live`
//     slides the window to the end and resumes following.
//
// The codec is the real main-thread runSessionParseJob; the books are real AgentBooks on
// the headless atlas.

import * as THREE from 'three';
import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { runSessionParseJob } = await import('../packages/glyph3d-core/src/workers/sessionParseJob.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);

// ── a 100-turn transcript: say k (with bulk), and every 10th a Bash whose result is the NEXT line ──
const enc = new TextEncoder();
let ts = 1754700000000;
const L = (o) => JSON.stringify({ cwd: '/p', timestamp: new Date(ts += 1000).toISOString(), ...o }) + '\n';
function transcript(n) {
    let t = '';
    for (let k = 0; k < n; k++) {
        if (k === 79) {
            // two PARALLEL calls straddling the open tail's edge: 80 is the oldest resident turn,
            // so 79 sits in the first older slice with its result written AFTER the cursor
            t += L({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 't79', name: 'Bash', input: { command: 'echo 79' } }] } });
            t += L({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 't80', name: 'Bash', input: { command: 'echo 80' } }] } });
            t += L({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't79', content: 'out 79' }] } });
            t += L({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't80', content: 'out 80' }] } });
            k++;
            continue;
        }
        if (k % 10 === 7) {
            t += L({ message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: 'Bash', input: { command: `echo ${k}` } }] } });
            t += L({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: `out ${k}` }] } });
        } else {
            t += L({ message: { role: 'assistant', content: [{ type: 'text', text: `say ${k} ` + 'x'.repeat(400) }] } });
        }
    }
    return t;
}
let text = transcript(100);
let bytes = enc.encode(text);

/** gomux/read + agentSessions/read's window over the growing bytes (line-aligned start). */
const reads = [];
function read({ fromOffset, maxBytes, tailBytes } = {}) {
    reads.push({ fromOffset, maxBytes, tailBytes });
    const size = bytes.length;
    let start = 0, end = size;
    if (fromOffset != null) { start = Math.min(fromOffset, size); if (maxBytes > 0) end = Math.min(size, start + maxBytes); }
    else if (tailBytes > 0 && tailBytes < size) start = size - tailBytes;
    if (start > 0 && bytes[start - 1] !== 0x0A) { const nl = bytes.indexOf(0x0A, start); start = nl < 0 ? end : nl + 1; }
    return Promise.resolve({ bytes: bytes.slice(start, end), offset: start, size });
}
const parse = (b, opts) => Promise.resolve(runSessionParseJob({ bytes: b, ...opts }));
const label = (r) => r.action === 'say' ? r.result.split(' ')[1] : `bash${r.detail.split(' ')[1]}`;
const kept = (lane) => lane.entries.map((e) => label(e.record));

// ── open: the tail (20 turns), as agent.open does ──
const books = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
books.cfg.historySliceBytes = 2048;      // small slices so the grow loop runs
books.cfg.historyOverlapBytes = 1024;
const tail = await read({ tailBytes: 12000 });
const first = await parse(tail.bytes, { harness: 'claude', cap: 20, base: tail.offset });
await books.hydrate('a', first.records, { agentType: 'claude', seqBase: first.total - 20, seqExact: false });
books.setHistory('a', { read, parse, harness: 'claude' });
const lane = books.lanes.get('a');
const W = 20;
const parallel = () => lane.entries.every((e, i) => lane.book.sheets[i]?.verso === e.verso);
const settle = async () => { for (let i = 0; i < 200 && lane.history.loading; i++) await lane.history.loading; };
eq(kept(lane).slice(0, 3), ['bash80', '81', '82'], 'opened at the tail: turns 80..99');
ok(lane.entries.every((e) => Number.isFinite(e.record.at)), 'every resident record knows its byte offset');
ok(new TextDecoder().decode(bytes.subarray(lane.entries[0].record.at)).startsWith('{'), "the oldest record's `at` starts its line");

// ── near the oldest sheet: prefetch, no sheets ──
lane.book.pageTo(5);
ok(!lane.history.loading, 'paging outside historyLead reads nothing');
lane.book.pageTo(2);
ok(!!lane.history.loading, 'paging within historyLead prefetches');
ok(books.loadOlder('a') === lane.history.loading, 'a second ask joins the read in flight');
await settle();
await lane.history.counting;
ok(lane.entries.length === W && lane.older.length === 20, `prefetch fills the older buffer only (window ${lane.entries.length}, buffer ${lane.older.length})`);
const turnOf = (i) => lane.book.sheets[i].meta.seq + (lane.turnBase || 0) + 1;
ok(lane.seqExact && turnOf(0) === 81, `the first page back counts the turns before it: exact (sheet 0 = turn ${turnOf(0)}, want 81)`);
ok(books.headState('a').turns === 100, 'turn 100 of 100 is the newest');

// ── push past the oldest sheet: slide one turn back ──
lane.book.pageTo(0);
lane.book.scroll(-1);
eq(kept(lane).slice(0, 2), ['bash79', 'bash80'], 'the window slid one turn back: the older turn at the front');
ok(lane.entries.length === W, `the window keeps its size (${lane.entries.length})`);
eq(lane.newer.map((x) => label(x.record)), ['99'], 'the newest turn left for the newer buffer');
ok(lane.book.head === 0 && turnOf(0) === 80, 'the head is on the turn paged to (turn 80)');
ok(parallel(), 'the deck stays parallel to the entries');
const b79 = lane.entries[0].record;
ok(String(b79.result).includes('out 79'), "a call at the slice edge pairs with a result written past the cursor (the overlap read)");

// ── a slide wider than the buffer waits for reads, then completes ──
lane.book.scroll(-50);
await settle();
eq(kept(lane)[0], '29', `slid 50 turns back across reads (oldest now ${kept(lane)[0]})`);
ok(lane.entries.length === W && parallel(), 'still the same window, still parallel');
ok(lane.newer.length === 51, `everything newer waits as records (${lane.newer.length})`);

// ── a live turn while held waits; `live` slides to the end ──
const seqBefore = lane.seq;
text += L({ message: { role: 'assistant', content: [{ type: 'text', text: 'say 100 live' }] } });
bytes = enc.encode(text);
books.activity('a', 'claude', { action: 'say', target: '', detail: '', result: 'say 100 live', meta: null });
ok(lane.seq === seqBefore + 1 && lane.newer.length === 52 && kept(lane)[0] === '29', 'a live turn while held joins the newer buffer — the window holds still');
ok(books.headState('a').newer === 52, 'the HUD knows how many newer turns wait');
lane.book.pageTo(Infinity);   // book.page last
eq(kept(lane).at(-1), '100', '`live` slides the window to the newest turn');
ok(lane.entries.length === W && lane.newer.length === 0 && lane.book.following, 'full window, nothing waiting, following again');
ok(parallel(), 'parallel after the jump');
books.activity('a', 'claude', { action: 'say', target: '', detail: '', result: 'say 101 live', meta: null });
eq(kept(lane).at(-1), '101', 'following: a live turn appends');
ok(lane.entries.length === W && lane.older.at(-1) && label(lane.older.at(-1).record) === '81', 'and the shed turn waits in the older buffer');

// ── all the way back: the run's start ──
lane.book.pageTo(0);
lane.book.scroll(-500);
await settle();
eq(kept(lane)[0], '0', 'slid back to the first turn');
ok(lane.history.done && turnOf(0) === 1, `the start: history done, sheet 0 is turn ${turnOf(0)}`);
ok(lane.entries.length === W && parallel(), 'the window is the same size at the start');

console.log(`agent-book-history: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
