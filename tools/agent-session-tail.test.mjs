// agent-session-tail.test.mjs — behavior lock for TAIL-GROW session reads:
//
//   bun tools/agent-session-tail.test.mjs
//
// The agent-books restore used to read a session's WHOLE transcript (~30MB per
// boot) to hydrate ~20 spreads. readSessionTail requests only the final
// tailReadBytes (the relay line-aligns the window and reports the absolute
// offset it starts at), parses, and doubles the window until it holds the
// book's event quota or reaches the file's start. This gate locks:
//   - spread IDENTITY: a tail-grow read hydrates exactly the records a
//     whole-file read's cap slice would (not just the same count),
//   - the grow policy: doubling requests, growth on EVENT count (noise tools
//     drop AFTER the cap slice — they must not trigger over-reading),
//   - termination: quota met, or offset 0 (record shallower than the quota),
//   - the unbounded cap (limit 0): one whole-file request, no tail param,
//   - the head-meta top-up: a tail that misses the transcript's early ai-title
//     line pays ONE bounded fromOffset:0 read and gap-fills the missing
//     provenance (tail values — the session's present — stay; firstTs is the
//     head's, the true first),
//   - the torn-first-line guard: a misaligned window warns LOUDLY once and
//     still parses (the adapter skips the torn line).
//
// The provider is a mock implementing cli/sessions.go's window semantics over
// synthetic bytes (the bridge-binary mock pattern); the codec is the real
// main-thread runSessionParseJob — the same pure function the parse workers run.

import { readSessionTail } from '../packages/glyph3d-core/src/services/data/sessionTailRead.js';
import { runSessionParseJob } from '../packages/glyph3d-core/src/workers/sessionParseJob.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want  ${J(b)}`);

// ── synthetic claude transcript: numbered tool events + multi-KB prose ─────────

/** One claude transcript line holding a single content block. */
const line = (block, i) => JSON.stringify({
    cwd: '/proj', timestamp: new Date(1754700000000 + i * 1000).toISOString(),
    message: { role: 'assistant', model: 'claude-fable-5', content: [block] },
}) + '\n';

/** A transcript of `n` events: mostly numbered Reads, every 7th a multi-KB say,
 *  every 11th a TodoWrite (NOISE — an event the registry drops from records). */
function makeTranscript(n) {
    let text = JSON.stringify({ type: 'ai-title', aiTitle: 'tail-grow lock' }) + '\n';
    for (let i = 0; i < n; i++) {
        const block = i % 11 === 10
            ? { type: 'tool_use', id: `t${i}`, name: 'TodoWrite', input: { todos: [] } }
            : i % 7 === 6
                ? { type: 'text', text: `say-${String(i).padStart(4, '0')} ` + 'x'.repeat(3000) }
                : { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `src/seq-${String(i).padStart(4, '0')}.js` } };
        text += line(block, i);
    }
    return new TextEncoder().encode(text);
}

// ── a provider double implementing cli/sessions.go's window semantics ──────────

/** align:false skips the relay's line-boundary advance — the torn-window case. */
function makeProvider(bytes, { align = true } = {}) {
    const size = bytes.byteLength;
    const requests = [];
    return {
        requests,
        async read(_id, opts = {}) {
            requests.push({ ...opts });
            let start = 0, end = size;
            if (opts.fromOffset != null) {
                start = Math.min(opts.fromOffset, size);
                if (opts.maxBytes > 0) end = Math.min(size, start + opts.maxBytes);
            } else if (opts.tailBytes > 0 && opts.tailBytes < size) {
                start = size - opts.tailBytes;
            }
            let offset = start;
            let buf = bytes.subarray(start, end);
            if (start > 0 && align && bytes[start - 1] !== 0x0A) {
                const nl = buf.indexOf(0x0A);
                if (nl >= 0) { offset = start + nl + 1; buf = buf.subarray(nl + 1); }
                else { offset = end; buf = buf.subarray(buf.length); }
            }
            return { bytes: buf.slice(), offset, size, truncated: start > 0 || end < size, mtime: 1, cwd: null };
        },
    };
}

const parse = (bytes, opts) => Promise.resolve(runSessionParseJob({ bytes, ...opts }));

// ── spread identity: tail-grow == whole-file cap slice, record for record ─────
{
    const bytes = makeTranscript(300);
    const want = runSessionParseJob({ bytes: bytes.slice(), harness: 'claude', cap: 20 });
    const r = await readSessionTail(makeProvider(bytes), 'sess-identity', {
        harness: 'claude', cap: 20, startBytes: 512 * 1024, parse,
    });
    eq(r.records, want.records, 'tail-grow hydrates the exact records the whole-file cap slice would');
    ok(r.total >= 20, `window holds the quota (total ${r.total} >= cap 20)`);
    eq(r.attempts, 1, 'a window bigger than the file resolves in one request');
    eq(r.offset, 0, 'a whole-file-sized tail reaches offset 0');
}

// ── the grow policy: small windows double until the quota is met ───────────────
{
    const bytes = makeTranscript(300);   // ~110KB — 4KB start forces several doublings
    const want = runSessionParseJob({ bytes: bytes.slice(), harness: 'claude', cap: 20 });
    const p = makeProvider(bytes);
    const r = await readSessionTail(p, 'sess-grow', {
        harness: 'claude', cap: 20, startBytes: 4 * 1024, parse,
    });
    eq(r.records, want.records, 'grown tail hydrates the identical record tail');
    ok(r.attempts > 1, `growth happened (attempts ${r.attempts})`);
    const tails = p.requests.filter((q) => q.tailBytes != null);
    eq(tails.map((q) => q.tailBytes), Array.from({ length: r.attempts }, (_, i) => 4 * 1024 * 2 ** i),
        'each retry doubles the window');
    ok(r.offset > 0, `the final window is still a tail (offset ${r.offset} > 0), not the whole file`);
    ok(r.bytes < bytes.byteLength, `read ${r.bytes} of ${bytes.byteLength} bytes`);
    // The ai-title line sits at the transcript's head, outside every tail window —
    // ONE bounded fromOffset:0 read recovers whole-file first-seen provenance.
    eq(p.requests.filter((q) => q.fromOffset === 0).length, 1, 'exactly one head-meta request');
    eq(r.meta.title, want.meta.title, 'nameplate title gap-fills from the head');
    eq(r.meta.lastTs, want.meta.lastTs, 'lastTs stays the tail\'s (the newest event)');
    eq(r.meta.firstTs, want.meta.firstTs, 'firstTs is the head\'s (the true first)');
}

// ── head-meta top-up is CONDITIONAL: a title in the tail skips the extra read ──
{
    const bytes = makeTranscript(300);
    const p = makeProvider(bytes);
    const r = await readSessionTail(p, 'sess-headskip', {
        harness: 'claude', cap: 20, startBytes: 4 * 1024, headMetaBytes: 0, parse,
    });
    eq(p.requests.filter((q) => q.fromOffset != null).length, 0, 'headMetaBytes 0 disables the head read');
    ok(r.meta.title == null, 'tail-only meta has no title (the demotion the top-up exists for)');
}

// ── termination at the file's start: quota deeper than the record ──────────────
{
    const bytes = makeTranscript(12);
    const want = runSessionParseJob({ bytes: bytes.slice(), harness: 'claude', cap: 20 });
    const r = await readSessionTail(makeProvider(bytes), 'sess-shallow', {
        harness: 'claude', cap: 20, startBytes: 256, parse,
    });
    eq(r.offset, 0, 'reaching offset 0 ends the grow');
    eq(r.records, want.records, 'a shallow record hydrates whole');
    ok(r.total < 20, `quota unmet is fine at offset 0 (total ${r.total})`);
}

// ── unbounded cap (limit 0): the tail IS the file — one whole-file request ─────
{
    const bytes = makeTranscript(50);
    const p = makeProvider(bytes);
    const r = await readSessionTail(p, 'sess-unbounded', {
        harness: 'claude', cap: Infinity, startBytes: 256, parse,
    });
    eq(p.requests.length, 1, 'one request');
    ok(p.requests[0].tailBytes == null, 'no tail param — the plain whole-file read');
    eq(r.offset, 0, 'whole read starts at 0');
    eq(r.records.length, runSessionParseJob({ bytes: bytes.slice(), harness: 'claude' }).records.length,
        'every record hydrates');
}

// ── torn first line: warns LOUDLY once, parse skips it and carries on ──────────
{
    const bytes = makeTranscript(60);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
        const r = await readSessionTail(makeProvider(bytes, { align: false }), 'sess-torn', {
            harness: 'claude', cap: 5, startBytes: 8 * 1024, parse,
        });
        ok(r.records.length >= 5, `torn window still hydrates (${r.records.length} records)`);
        eq(warns.filter((w) => w.includes('sess-torn') && w.includes('torn')).length, 1,
            'exactly one loud torn-first-line warn, naming the session');
        // Same session again: the guard stays quiet (warn-once).
        await readSessionTail(makeProvider(bytes, { align: false }), 'sess-torn', {
            harness: 'claude', cap: 5, startBytes: 8 * 1024, parse,
        });
        eq(warns.filter((w) => w.includes('sess-torn')).length, 1, 'second torn read does not re-warn');
    } finally {
        console.warn = origWarn;
    }
}

console.log(`\nagent-session-tail: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
