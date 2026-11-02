// scroll-form.test.mjs — the agent SCROLL form (Book form 'scroll': a run read as ONE document
// at one size), driven from gomuxai's event corpus through AgentEventReader and the app's REAL
// font chain (cell widths are the layout's own rule — an emoji is two cells):
//
//   bun tools/scroll-form.test.mjs        (GOMUXAI_DIR=<gomuxai checkout>, default ~/dev/gomuxai)
//
// It locks:
//   1. shown text == source text — every event's headline, call, info rows and body, rejoined
//      from the document's rows, are exactly the record's (CRLF → LF, one trailing newline
//      dropped); nothing is truncated; a long output is ONE summary row until expanded;
//   2. no row is wider than the document (cells by the layout's rule, and the laid-out pens);
//      every glyph's pen sits on the cell grid;
//   3. a held document doesn't move when 30 events append (they wait: `+30 newer`), nor when
//      an event above the frame grows; reaching the end follows again;
//   4. a reload restores the top row by (session, at) — also when that event has to slide
//      back in from the older buffer;
//   5. one book id across the registry, attention and tuning: switching forms keeps the same
//      registry entry and object, the pick token is the book;
//   6. the cost: at the window cap, a live batch lays out and uploads only its new rows, and
//      scrolling lays out nothing — budgets with teeth (the full re-lay path fails them).

import * as THREE from 'three';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './headless-canvas.mjs';
import { bootHeadlessFontChain } from './headlessFontChain.mjs';
const { deriveCharSize } = await import('../packages/glyph3d-core/src/core/cellMetrics.js');
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { AgentEventReader, eventRecord } = await import('../packages/glyph3d-core/src/collections/agentEvents.js');
const { rowCells } = await import('../packages/glyph3d-core/src/collections/ScrollDocument.js');
const { generateLayout } = await import('../packages/glyph3d-core/src/core/LayoutGenerator.js');
const { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y } = await import('../packages/glyph3d-core/src/core/InstancedSlotBuffer.js');
const { AttentionManager } = await import('../packages/glyph3d-core/src/services/interaction/AttentionManager.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);

// ── the corpus + the font chain ───────────────────────────────────────────────────────
const GOMUXAI = process.env.GOMUXAI_DIR || join(homedir(), 'dev/gomuxai');
const CORPUS = join(GOMUXAI, 'internal/transcript/testdata/corpus');
if (!existsSync(CORPUS)) {
    console.error(`scroll-form: FAIL — no event corpus at ${CORPUS} (set GOMUXAI_DIR to a gomuxai checkout).`);
    process.exit(1);
}
const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.events.jsonl') ? [p] : []);
});
const CASES = walk(CORPUS).sort().map((f) => [f.slice(CORPUS.length + 1).replace(/\.events\.jsonl$/, ''), readFileSync(f, 'utf8')]);
ok(CASES.length >= 13, `the corpus has its streams (${CASES.length})`);

const { chain } = await bootHeadlessFontChain();
const ATLAS = { getCharSize: () => deriveCharSize(chain, 48), _shaper: chain, _shapeCache: null, _slugData: null, _live: null };

/** A registry + pick system that remember what was registered (the identity checks). */
function host() {
    const reg = new Map(), log = [];
    const registry = {
        setPickable() {}, register(id, obj, meta) { reg.set(id, { id, grid: obj, meta }); log.push(['reg', id]); },
        unregister(id) { reg.delete(id); log.push(['unreg', id]); }, findByMeta: () => [],
    };
    const picks = new Map();
    const pickingSystem = { register(ch, mesh, token) { picks.set(mesh, { ch, token }); }, unregister(_ch, mesh) { picks.delete(mesh); } };
    return { reg, log, picks, ctx: { scene: new THREE.Scene(), camera: null, atlas: ATLAS, registry, pickingSystem, fileProvider: null } };
}
const newBooks = (h = host(), opts = {}) => { const b = new AgentBooks(h.ctx, opts); b.cfg.maxSheets = 0; return b; };
const feed = (books, lane, text) => { const r = new AgentEventReader(); books.applyEvents(lane, r.push(text).concat(r.end()), { agentType: 'claude' }); };
const flushAll = (books) => books.update(0);

const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
/** Rejoin a block's rows of one part into its source text (a wrap continuation joins its line). */
function rejoin(block, part) {
    const lines = [];
    for (const r of block.rows) {
        if (r.src.part !== part) continue;
        const t = r.segs.map((s) => s.text).join('');
        if (r.src.cont) lines[lines.length - 1] += t; else lines.push(t);
    }
    return lines.join('\n');
}

// ── 1 + 2. shown text == source text; no row wider than the document ───────────────────
{
    let blocks = 0, collapsedSeen = 0, wide = 0;
    for (const [name, text] of CASES) {
        const books = newBooks();
        books.cfg.scrollCollapseRows = 6;   // small, so the corpus exercises collapse
        const laneId = `L:${name}`;
        books.ensure(laneId, 'claude').book.setForm('scroll');
        feed(books, laneId, text);
        flushAll(books);
        const lane = books.lanes.get(laneId);
        const doc = lane.doc;
        ok(!!doc && lane.book.form === 'scroll', `${name}: the book is a scroll`);
        // Collapsed first: a long output / file is one summary row.
        for (const b of doc.blocks) {
            const e = lane.entries.find((_, i) => String(lane.book.sheets[i].meta.seq) === b.id);
            const c = books._scrollContent(e.record);
            if (!c || c.role === 'prose') continue;
            const n = norm(c.text).split('\n').length;
            if (n > 6) {
                collapsedSeen++;
                const sum = b.rows.filter((r) => r.src.part === 'summary');
                ok(sum.length === 1 && sum[0].segs[0].text === `▸ ${c.name} · ${n} lines` && !b.rows.some((r) => r.src.part === 'body'),
                    `${name}: a ${n}-line ${c.name} collapses to one summary row`);
            }
        }
        ok(books.expand(laneId, 'all') >= 0, `${name}: expand all`);
        eq(doc.blocks.length, lane.entries.length, `${name}: one block per event in the window`);
        const cols = doc.cfg.cols, cw = doc.metrics.charWidth;
        for (let i = 0; i < lane.entries.length; i++) {
            const e = lane.entries[i], b = doc.blocks[i];
            const call = e.call;
            eq(rejoin(b, 'head'), call.head ? `[${call.verb}] ${call.head}` : `[${call.verb}]`, `${name}#${i}: the headline`);
            eq(rejoin(b, 'call'), norm(call.rest), `${name}#${i}: the call's other lines`);
            eq(rejoin(b, 'info'), norm(e.infoText), `${name}#${i}: the info rows`);
            const c = books._scrollContent(e.record);
            eq(rejoin(b, 'body'), c ? norm(c.text) : '', `${name}#${i}: the body is the record's ${c?.role ?? 'nothing'}`);
            for (const r of b.rows) {
                const t = r.segs.map((s) => s.text).join('');
                const cells = (r.indent || 0) + rowCells(t, doc.cellsOf, doc.cfg.tabWidth);
                if (cells > cols) { wide++; console.error(`    wide row (${cells} > ${cols}): ${J(t)}`); }
                if (t) {
                    const lay = generateLayout([t], { shaper: chain, metrics: doc.metrics, wrapWidth: 0, tabWidth: doc.cfg.tabWidth });
                    if ((r.indent || 0) * cw + lay.maxRowExtent > cols * cw + 1e-6) { wide++; console.error(`    wide pens: ${J(t)}`); }
                }
            }
            blocks++;
        }
        // Every laid glyph's pen on the cell grid, every row on its row pitch.
        const f32 = doc.bodyField.slotBuffer.f32, n = doc.bodyField.slotBuffer.count, ls = doc.metrics.lineSpacing;
        let off = 0;
        for (let s = 0; s < n; s++) {
            const x = f32[s * SLOT_FLOATS + LANE_POS_X] / cw, y = (doc._bodyY - f32[s * SLOT_FLOATS + LANE_POS_Y]) / ls;
            if (Math.abs(x - Math.round(x)) > 1e-3 || Math.abs(y - Math.round(y)) > 1e-3) off++;
        }
        ok(off === 0, `${name}: every pen on the cell grid (${off} of ${n} off)`);
    }
    ok(blocks > 100, `the corpus composes (${blocks} events)`);
    ok(collapsedSeen > 0, `long outputs collapsed (${collapsedSeen})`);
    ok(wide === 0, `no row wider than the document (${wide} wide)`);
}

// ── a long synthetic run: the corpus's events, again and again, at increasing offsets ──
const RUN = (() => {
    const out = [];
    for (const [, text] of CASES) {
        const r = new AgentEventReader();
        for (const ch of r.push(text).concat(r.end())) if (ch.op === 'add') out.push(ch);
    }
    return out;
})();
/** `n` add changes with distinct ids and increasing `at`. */
function run(n, from = 0) {
    const out = [];
    for (let k = from; k < from + n; k++) {
        const ch = RUN[k % RUN.length];
        const ev = { ...ch.event, id: `${ch.event.id}#${k}`, at: 1000 + k * 100 };
        out.push({ ...ch, event: ev, pos: { at: ev.at, seq: k } });
    }
    return out;
}
const sealed = { read: async () => ({ lines: [] }), sealed: true };

// ── 3. a held document doesn't move ─────────────────────────────────────────────────────
{
    const books = newBooks();
    const id = 'held';
    books.ensure(id, 'claude').book.setForm('scroll');
    books.setHistory(id, sealed);
    books.applyEvents(id, run(120), { agentType: 'claude' });
    flushAll(books);
    const lane = books.lanes.get(id), doc = lane.doc;
    ok(doc.following && lane.book.following, 'a fresh scroll follows the end');
    const end = doc.visibleText();
    books.scrollRows(id, -80);
    flushAll(books);
    const held = doc.visibleText();
    ok(!doc.following && !lane.book.following && J(held) !== J(end), 'scrolling up holds it');
    books.applyEvents(id, run(30, 120), { agentType: 'claude' });
    flushAll(books);
    eq(doc.visibleText(), held, 'a held document does not move when 30 events append');
    eq(lane.newer.length, 30, 'the 30 wait beyond the window');
    ok(doc._title.includes('+30 newer') && doc._title.includes('held'), `the title row says +30 newer (${doc._title})`);
    // An event ABOVE the frame grows: the frame stays on what it shows.
    const topIdx = lane.entries.findIndex((_, i) => String(lane.book.sheets[i].meta.seq) === doc.rowAt(0).id);
    ok(topIdx > 2, 'there are events above the frame');
    const above = lane.entries[1];
    books._replaceRecord(lane, { ...above.record, result: 'grown\n'.repeat(40) + 'end', action: 'bash', target: '' });
    flushAll(books);
    eq(doc.visibleText(), held, 'an event above the frame growing does not move it');
    books.scrollRows(id, 1e6);
    flushAll(books);
    ok(doc.following && lane.newer.length === 0, 'scrolling to the end brings the newer in and follows');
    ok(doc._title.includes('live') && !doc._title.includes('newer'), 'the title row says live');
    // A pointer ray onto a summary row names its event (the click-to-expand gesture's target).
    {
        const blk = doc.blocks.find((b) => b.rows.some((r) => r.src.part === 'summary'));
        let hit = null, k = -1;
        if (blk) {
            doc.setView({ following: false, id: blk.id, row: 0 });
            k = blk.rows.findIndex((r) => r.src.part === 'summary');
            hit = doc.rowAt(k);
        }
        if (hit) {
            doc.updateWorldMatrix(true, false);
            const m = doc.metrics, y = doc.pixelOrigin().y - (1 + doc.cfg.titleGap + k + 0.5) * m.lineSpacing;
            const p = new THREE.Vector3(3 * m.charWidth, y, 0).applyMatrix4(doc.matrixWorld);
            const ray = new THREE.Ray(p.clone().add(new THREE.Vector3(0, 0, 50)), new THREE.Vector3(0, 0, -1));
            const h = books.scrollHit(id, ray);
            ok(h && h.part === 'summary' && h.step === hit.block.seq + (lane.sheetBase || 0) + 1, `a ray onto a summary row names its event (${J(h)})`);
            const before = doc.blocks.find((b) => b.id === hit.id).rows.length;
            books.expand(id, h.step);
            ok(doc.blocks.find((b) => b.id === hit.id).rows.length > before, 'expanding it opens its rows');
            lane.book.pageTo(Infinity);
        } else ok(false, 'a summary row is in the document');
    }
    // Paging by events: book.scroll moves the top to headlines.
    lane.book.scroll(-3);
    const at = doc.rowAt(0);
    ok(at && at.row === 0 && !doc.following, 'book.scroll -3 stands on a headline, held');
    lane.book.pageTo(Infinity);
    ok(doc.following, 'book.page last follows again');
}

// ── 4. a reload restores the top row by (session, at) ──────────────────────────────────
{
    const build = async () => {
        const books = newBooks();
        const lane = books.ensure('r', 'claude');
        lane.sessionId = 'sess-1';
        lane.book.setForm('scroll');
        books.setHistory('r', sealed);
        await books.hydrate('r', run(260).map((c) => eventRecord(c.event, c.pos)), { sessionId: 'sess-1' });
        return books;
    };
    const a = await build();
    flushAll(a);
    a.scrollRows('r', -150);
    flushAll(a);
    const view = a.scrollView('r');
    ok(view && !view.following && view.session === 'sess-1' && Number.isFinite(view.at), `a held view names (session, at) (${J(view)})`);
    const want = a.lanes.get('r').doc.visibleText();
    const b = await build();
    flushAll(b);
    ok(b.applyScrollView('r', view), 'the view is taken');
    flushAll(b);
    eq(b.lanes.get('r').doc.visibleText(), want, 'a reload restores the top row');
    // The event at the top has left the window (the book followed on): it slides back in.
    const c = await build();
    c.cfg.scrollMaxRecords = 40;
    c.applyScales?.();
    c.lanes.get('r').book.setForm('deck'); c.lanes.get('r').book.setForm('scroll');   // the window takes the smaller cap
    flushAll(c);
    const ln = c.lanes.get('r');
    ok(!ln.entries.some((e) => e.record.at === view.at), 'the saved top is out of the window');
    c.applyScrollView('r', view);
    flushAll(c);
    eq(ln.doc.visibleText().slice(0, 3), want.slice(0, 3), 'a saved top in the older buffer slides back in and stands');
    ok(c.applyScrollView('r', { ...view, session: 'other' }) === false, 'a view of another session is ignored');
    // A view handed over before its book opens (a reload restoring the hub's books): the lane takes it when born.
    const d = newBooks();
    ok(d.applyScrollView('r', view), 'a view for a lane not open yet is held');
    const dl = d.ensure('r', 'claude');
    dl.sessionId = 'sess-1';
    dl.book.setForm('scroll');
    d.setHistory('r', sealed);
    await d.hydrate('r', run(260).map((x) => eventRecord(x.event, x.pos)), { sessionId: 'sess-1' });
    flushAll(d);
    eq(dl.doc.visibleText(), want, 'the lane born later stands on it');
}

// ── 5. one book id across registry, attention and tuning ───────────────────────────────
{
    const h = host();
    const books = newBooks(h);
    const lane = books.ensure('one', 'claude');
    feed(books, 'one', CASES[0][1]);
    const gid = lane.groupId;
    eq(gid, 'agent:book:one', 'the registry id');
    const att = new AttentionManager();
    att.set('primary', gid);
    const before = h.reg.get(gid)?.grid;
    lane.book.setForm('scroll');
    flushAll(books);
    ok(h.reg.get(gid)?.grid === before && before === lane.book, 'the same registry entry and object in the scroll form');
    ok(!h.log.some(([op, id]) => op === 'unreg' && id === gid), 'the book id is never unregistered by a form change');
    eq(att.get('primary')?.id, gid, 'attention still holds it');
    ok(h.picks.get(lane.doc._background)?.token === lane.book, "the document's pick token is the book");
    ok(books.resolveLane(gid)?.[1] === lane && books.resolveLane(lane.book)?.[1] === lane, 'every address resolves the one lane');
    const { bookTuneId } = await import('../app/client/tuning.js');
    eq(bookTuneId({ kind: 'agent', books, agentId: 'one' }), gid, "tuning's record id is the same id");
    lane.book.setForm('deck');
    ok(h.reg.get(gid)?.grid === lane.book && !lane.doc, 'back to the deck: same id, the document freed');
    // A plane desk's default: born a scroll, a book's own form wins.
    lane.book.setForm(null);
    lane.book.onDeskMode('plane');
    ok(lane.book.form === 'scroll', 'seated at a plane desk, a book with no form of its own is a scroll');
    lane.book.onDeskMode('ring');
    ok(lane.book.form === 'deck', 'at a ring desk it is a deck again');
    lane.book.setForm('deck');
    lane.book.onDeskMode('plane');
    ok(lane.book.form === 'deck', 'its own form wins over the desk');
    lane.book.setForm(null);
    ok(lane.book.form === 'scroll', "dropping its own form takes the plane desk's default");
    lane.book.onDeskMode(null);
    ok(lane.book.form === 'deck', 'leaving the desk (mode null) it is a deck');
    // Pins like a terminal: metrics + pixelOrigin in the book's frame.
    lane.book.setForm('scroll');
    const m = lane.book.metrics, d = lane.doc;
    ok(Math.abs(m.charWidth - d.metrics.charWidth * d.scale.x) < 1e-9 && lane.book.pixelOrigin() && lane.book.claimsSeat,
        'a scroll book states its column, cell origin and room');
}

// ── 5b. click-to-expand: a click on a summary row is the expand gesture ──────────────
{
    const { resolveGesture } = await import('../app/client/gestureResolver.js');
    const { default: registerBookCommands } = await import('../app/commands/handlers/bookCommands.js');
    const verbs = new Map();
    registerBookCommands({ register: (name, fn) => verbs.set(name, fn) });
    const books = newBooks();
    books.cfg.scrollCollapseRows = 4;
    const lane = books.ensure('click', 'claude');
    lane.book.setForm('scroll');
    books.applyEvents('click', run(30), { agentType: 'claude' });
    books.activity('click', 'claude', { action: 'bash', detail: 'ls -la', result: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), id: 'long-output', at: 1e7 });
    books.applyEvents('click', run(30, 30), { agentType: 'claude' });
    flushAll(books);
    const doc = lane.doc, gid = lane.groupId;
    const blk = doc.blocks.find((b) => b.rows.some((r) => r.src.part === 'summary'));
    ok(!!blk, 'the run has a collapsed output');
    doc.setView({ following: false, id: blk.id, row: 0 });
    const rayAt = (k) => {
        doc.updateWorldMatrix(true, false);
        const m = doc.metrics, y = doc.pixelOrigin().y - (1 + doc.cfg.titleGap + k + 0.5) * m.lineSpacing;
        const p = new THREE.Vector3(4 * m.charWidth, y, 0).applyMatrix4(doc.matrixWorld);
        return new THREE.Ray(p.clone().add(new THREE.Vector3(0, 0, 50)), new THREE.Vector3(0, 0, -1));
    };
    const ctx = { agentBooks: books, holding: { isDocked: () => false } };
    const click = (k) => {
        const ray = rayAt(k), sent = [];
        const env = {
            exec: (cmd) => { sent.push(cmd); if (Array.isArray(cmd) && verbs.has(cmd[0])) verbs.get(cmd[0])(cmd.slice(1), ctx); },
            ctx, context: null, attention: { get: () => null }, placeCaretFromPointer: async () => false,
            scrollHitAt: (entry) => books.scrollHit(entry.id, ray),
        };
        const claimed = resolveGesture({ type: 'click', target: { id: gid, type: 'book', role: 'agent', grid: lane.book }, mods: {} }, env);
        return { claimed, sent };
    };
    const sumRow = blk.rows.findIndex((r) => r.src.part === 'summary');
    const before = doc.blocks.find((b) => b.id === blk.id).rows.length;
    const c1 = click(sumRow);
    ok(c1.claimed && c1.sent.length === 1 && c1.sent[0][0] === 'book.expand' && c1.sent[0][1] === gid,
        `a click on a summary row sends book.expand for that book (${J(c1.sent)})`);
    flushAll(books);
    const open = doc.blocks.find((b) => b.id === blk.id);
    ok(open.rows.length > before && open.rows[sumRow].segs[0].text.startsWith('▾'), 'it opens that output (▾, every line)');
    const c2 = click(sumRow);
    flushAll(books);
    ok(c2.sent[0]?.[0] === 'book.expand' && doc.blocks.find((b) => b.id === blk.id).rows.length === before, 'a second click closes it');
    const c3 = click(0);   // the headline: not a control — the click bubbles to focus
    ok(!c3.sent.some((cmd) => Array.isArray(cmd) && cmd[0] === 'book.expand') && c3.sent.some((cmd) => String(cmd).startsWith('attention.set')),
        `a click elsewhere on the book focuses it as before (${J(c3.sent)})`);
}

// ── 6. the cost at the window cap ───────────────────────────────────────────────────────
const BUDGET_MS = Number(process.env.SCROLL_BUDGET_MS || 4);      // p95 per live batch at the cap
const SCROLL_BUDGET_MS = 0.5;
{
    const measure = (full) => {
        const books = newBooks();
        const id = full ? 'full' : 'tail';
        books.ensure(id, 'claude').book.setForm('scroll');
        books.applyEvents(id, run(books.cfg.scrollMaxRecords), { agentType: 'claude' });
        flushAll(books);
        const doc = books.lanes.get(id).doc;
        const times = [], uploads = [], laid = [];
        let k = books.cfg.scrollMaxRecords;
        for (let b = 0; b < 300; b++) {
            const batch = run(1 + (b % 3), k); k += batch.length;
            const t0 = performance.now();
            books.applyEvents(id, batch, { agentType: 'claude' });
            if (full) doc._full = true;   // the whole-document re-lay every change (the path this replaces)
            const r = doc.flush();
            times.push(performance.now() - t0);
            uploads.push(r.uploaded); laid.push(r.laidSlots);
        }
        const p = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(a.length * q)];
        return { p50: p(times, 0.5), p95: p(times, 0.95), max: Math.max(...times), up95: p(uploads, 0.95), laid95: p(laid, 0.95),
            slots: doc.bodyField.slotBuffer.count, rows: doc.totalRows, full: doc.stats.fullPasses, doc, books, id };
    };
    measure(false);   // warm the JIT
    const tail = measure(false), full = measure(true);
    console.log(`  cost at the cap (${tail.books.cfg.scrollMaxRecords} events, ${tail.rows} rows, ~${tail.slots} slots):`);
    console.log(`    tail-append  p50 ${tail.p50.toFixed(3)} ms  p95 ${tail.p95.toFixed(3)} ms  max ${tail.max.toFixed(2)} ms  upload p95 ${tail.up95} slots  compactions ${tail.doc.stats.compactions || 0}`);
    console.log(`    full re-lay  p50 ${full.p50.toFixed(3)} ms  p95 ${full.p95.toFixed(3)} ms  max ${full.max.toFixed(2)} ms  upload p95 ${full.up95} slots`);
    ok(tail.p95 <= BUDGET_MS, `a live batch at the cap lays out within ${BUDGET_MS} ms p95 (${tail.p95.toFixed(3)})`);
    ok(tail.up95 <= tail.laid95, `it uploads only its new rows (p95 ${tail.up95} ≤ laid ${tail.laid95})`);
    ok(full.p95 > BUDGET_MS && full.p95 > 5 * tail.p95, `teeth: the full re-lay path fails the budget (${full.p95.toFixed(3)} ms)`);
    ok(full.up95 >= full.slots * 0.5, `teeth: the full path uploads the whole document (${full.up95})`);
    // Scrolling: no layout, no upload.
    const { doc, books, id } = tail;
    const st0 = { ...doc.stats };
    const t0 = performance.now();
    for (let s = 0; s < 200; s++) books.scrollRows(id, s % 2 ? 7 : -9);
    const per = (performance.now() - t0) / 200;
    ok(doc.stats.laidSlots === st0.laidSlots && doc.stats.uploadedSlots === st0.uploadedSlots, 'scrolling lays out and uploads nothing');
    ok(per <= SCROLL_BUDGET_MS, `a scroll step costs ≤ ${SCROLL_BUDGET_MS} ms (${per.toFixed(4)})`);
    console.log(`    scroll step  ${per.toFixed(4)} ms, 0 slots laid, 0 uploaded`);
}

// ── 6b. book.cost: a live batch's cost is recorded where the frame lays it ─────────────────────
{
    const books = newBooks();
    books.ensure('c', 'claude').book.setForm('scroll');
    books.applyEvents('c', run(20), { agentType: 'claude' });
    flushAll(books);
    books.scrollCost('c', { reset: true });
    for (let b = 0; b < 5; b++) { books.applyEvents('c', run(2, 20 + 2 * b), { agentType: 'claude' }); books.update(16); }
    books.update(16);   // a frame with no batch records nothing
    const c = books.scrollCost('c');
    ok(c.batches === 5 && c.following === 5 && c.p95 > 0 && c.laid95 > 0, `book.cost: each live batch + the frame's flush is one sample (${JSON.stringify({ batches: c.batches, p95: c.p95, laid95: c.laid95 })})`);
    ok(books.scrollCost('c', { reset: true }).batches === 0 && books.scrollCost('nope') === null, 'reset empties it; a lane that is no scroll has none');
}

// ── 6c. a following book filling its window never grows (the body is reserved for the cap) ──────
{
    const follow = (per) => {
        const books = newBooks();
        books.cfg.scrollReserveSlotsPerEvent = per;
        books.ensure('g', 'claude').book.setForm('scroll');
        books.applyEvents('g', run(10), { agentType: 'claude' });
        flushAll(books);
        const doc = books.lanes.get('g').doc, cap0 = doc.bodyField.slotBuffer.capacity;
        books.scrollCost('g', { reset: true });
        for (let k = 10, b = 0; k < books.cfg.scrollMaxRecords; b++) { const n = 1 + (b % 3); books.applyEvents('g', run(n, k), { agentType: 'claude' }); k += n; books.update(16); }
        const s = books.lanes.get('g').cost.samples;
        return { s, cap0, cap: doc.bodyField.slotBuffer.capacity, slots: doc.bodyField.slotBuffer.count, grows: doc.stats.grows || 0 };
    };
    const kept = follow(newBooks().cfg.scrollReserveSlotsPerEvent), grown = follow(0);
    ok(kept.slots > grown.cap0 && kept.s.length > 50, `the follow fills past the unreserved body's capacity (${kept.slots} slots > ${grown.cap0}; ${kept.s.length} batches)`);
    ok(kept.grows === 0 && kept.cap === kept.cap0 && kept.s.every((x) => !x.grew && x.uploaded <= x.laidSlots),
        `reserved for the cap: no batch grows the body — each uploads only its tail (${kept.grows} grows; max upload ${Math.max(...kept.s.map((x) => x.uploaded))} slots, capacity ${kept.cap0})`);
    const g = grown.s.filter((x) => x.grew);
    console.log(`  follow 10 → ${kept.s.length} batches → the ${newBooks().cfg.scrollMaxRecords}-event cap: reserved ${kept.cap0} slots, ${kept.grows} grows, max upload ${Math.max(...kept.s.map((x) => x.uploaded))}; unreserved ${grown.cap0} → ${grown.cap} slots, ${g.length} grows uploading ${g.map((x) => x.uploaded).join(' / ')}`);
    ok(g.length >= 1 && g.every((x) => x.uploaded > x.laidSlots), `teeth: unreserved, the follow grows the body ${g.length}× and each growth sends the whole body (${g.map((x) => x.uploaded).join(', ')} slots)`);
}

// BEFORE (informational): the deck at its own cap — a sheet of CodeGrid cards per event, every
// card laid out whole as it loads (the cost the scroll form replaces for a plane desk's books).
{
    const books = newBooks();
    books.cfg.maxSheets = 20;
    books.ensure('deck', 'claude');
    books.applyEvents('deck', run(20), { agentType: 'claude' });
    await new Promise((r) => setTimeout(r, 20));
    const times = [];
    let k = 20;
    for (let b = 0; b < 60; b++) {
        const batch = run(1 + (b % 3), k); k += batch.length;
        const t0 = performance.now();
        books.applyEvents('deck', batch, { agentType: 'claude' });
        await new Promise((r) => setTimeout(r, 0));   // the cards' loads land
        times.push(performance.now() - t0);
    }
    const p = (q) => [...times].sort((x, y) => x - y)[Math.floor(times.length * q)];
    console.log(`  before — the deck at its cap (20 sheets): p50 ${p(0.5).toFixed(2)} ms  p95 ${p(0.95).toFixed(2)} ms per live batch (cards built + laid)`);
}

console.log(`scroll-form: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
