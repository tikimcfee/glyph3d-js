// agent-book-history.test.mjs — behavior lock for paging BACK past an agent book's
// resident turns (AgentBooks.setHistory / loadOlder):
//
//   bun tools/agent-book-history.test.mjs
//
// A book keeps its newest turns in space; its history pages the rest in as you read back.
// This gate locks, over a synthetic 100-turn claude transcript and a mock relay window:
//   - every parsed record carries its line's byte offset (`at`), so the oldest resident
//     record IS the backward cursor;
//   - paging to within historyLead of the oldest sheet lays the previous slice in at the
//     front — in order, no duplicates, the reader's page unchanged;
//   - a tool call at the slice's edge still pairs with its result (the overlap read);
//   - reading back to the record's start makes turn numbers exact (turn 1 = the first);
//   - a held book keeps a window around the head: past historyResident it lets go of the
//     end FARTHER from the reader — the newest end detaches it from the live tail, live
//     turns are counted not built, and returning to live reloads the tail;
//   - single-flight: a second page while a slice loads joins it.
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
eq(kept(lane).slice(0, 3), ['bash80', '81', '82'], 'opened at the tail: turns 80..99');
ok(lane.entries.every((e) => Number.isFinite(e.record.at)), 'every resident record knows its byte offset');
ok(new TextDecoder().decode(bytes.subarray(lane.entries[0].record.at)).startsWith('{'), 'the oldest record\'s `at` starts its line');

// ── page back: within historyLead of the oldest sheet loads the previous slice ──
lane.book.pageTo(5);                      // held, 5 from the oldest — outside the lead
ok(!lane.history.loading, 'paging outside historyLead loads nothing');
const headSheet = lane.book.sheets[2];
lane.book.pageTo(2);                      // within the lead
ok(!!lane.history.loading, 'paging within historyLead starts a slice');
const again = books.loadOlder('a');
ok(again === lane.history.loading, 'a second ask joins the slice in flight');
const added = await again;
ok(added === 20, `one slice = historyTurns turns (got ${added})`);
eq(kept(lane).slice(0, 3), ['60', '61', '62'], 'the slice lays in at the front, oldest first');
eq(kept(lane).slice(18, 23), ['78', 'bash79', 'bash80', '81', '82'], '… joining the resident turns with no gap and no duplicate');
const bash79 = lane.entries.find((e) => e.record.detail === 'echo 79');
ok(bash79 && String(bash79.record.result).includes('out 79'), "the slice's last call pairs with a result written past the cursor (the overlap read)");
ok(lane.book.sheets[lane.book.head] === headSheet, "the reader's page didn't move");
ok(lane.entries.every((e, i) => lane.book.sheets[i]?.verso === e.verso), 'the deck stays parallel to the entries (sheet i is turn i)');
await lane.history.counting;
const turnOf = (i) => lane.book.sheets[i].meta.seq + (lane.turnBase || 0) + 1;
ok(lane.seqExact && turnOf(0) === 61, `the first page back counts the turns before it: exact numbers (sheet 0 = turn ${turnOf(0)}, want 61)`);
ok(turnOf(lane.entries.length - 1) === 100 && books.headState('a').turns === 100, 'the newest is turn 100 of 100');
const bash67 = lane.entries.find((e) => e.record.action === 'bash' && e.record.detail === 'echo 67');
ok(bash67 && String(bash67.record.result).includes('out 67'), 'a tool call inside the slice carries its result');

// ── page all the way back: turn numbers become exact ──
for (let i = 0; i < 10 && !lane.history.done; i++) { lane.book.pageTo(0); await lane.history.loading; }
ok(lane.history.done, 'reached the record\'s start');
eq(kept(lane)[0], '0', 'the oldest resident turn is the first one');
ok(lane.entries.length <= Math.max(books._capFor(lane), books.cfg.historyResident), `a held book keeps at most historyResident sheets (got ${lane.entries.length})`);
ok(lane.detached, 'paging that far back let go of the newest end — detached from the live tail');
lane.book.pageTo(0);
const hs = books.headState('a');
ok(hs.exact && hs.turn === 1, `turn numbers exact: the first sheet is turn 1 (got ${hs.exact ? '' : '~'}${hs.turn})`);
eq(lane.book.tabs?.[0]?.label ?? lane.book.tabs?.[0]?.tab?.text ?? '1', '1', 'its tab reads 1');

// ── live turns while detached are counted, then returning to live reloads the tail ──
const seqBefore = lane.seq;
text += L({ message: { role: 'assistant', content: [{ type: 'text', text: 'say 100 live' }] } });
bytes = enc.encode(text);
const liveRec = (await parse(bytes.subarray(bytes.lastIndexOf(0x7B, bytes.length - 2) ), { harness: 'claude' })).records.at(-1);
books.activity('a', 'claude', liveRec ?? { action: 'say', result: 'say 100 live' });
ok(lane.seq === seqBefore + 1 && books.headState('a').newer === 1, 'a live turn while detached is counted, not built');
eq(kept(lane).includes('100'), false, '… and not appended after the gap');
lane.book.pageTo(lane.book.sheets.length - 1);   // back to live
for (let i = 0; i < 50 && lane.detached; i++) await new Promise((r) => setTimeout(r, 5));
ok(!lane.detached && lane.book.following, 'returning to live reloads the tail');
eq(kept(lane).at(-1), '100', 'the reloaded tail ends at the live turn');
ok(lane.entries.length <= books._capFor(lane), 'and keeps the cap');

console.log(`agent-book-history: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
