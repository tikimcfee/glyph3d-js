// book-controls.test.mjs — behavior lock for how a person DRIVES a book: the paging
// wheel's detent, the wheel → verb mapping, the book in focus, the book keys, and the
// agent timeline (tabs + turn numbers).
//
//   bun tools/book-controls.test.mjs
//
// The regressions under lock:
//   - every frame carrying any shift+wheel delta turned a page (only the SIGN reached
//     book.scroll), so trackpad momentum turned dozens — the detent notches travel
//     into whole steps and the records pass the step COUNT;
//   - a bare book verb with a focused agent card paged the FIRST lane, never the card's;
//   - agent books had no "where am I" in 3D — a tab per sheet now carries its turn.

import * as THREE from 'three';
import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
globalThis.window ??= { addEventListener() {} };

const { createWheelDetent } = await import('../app/client/wheelDetent.js');
const { wheelPageCommand } = await import('../app/client/surfaceInteractions.js');
const { normalizeWheelDelta, WHEEL_LINE_PX } = await import('../packages/glyph3d-core/src/utils/wheelDelta.js');
const { bookInFocus } = await import('../app/client/bookFocus.js');
const { resolveKeyBinding } = await import('../app/client/keymap.js');
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { default: registerBookCommands } = await import('../app/commands/handlers/bookCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// ── 1. the detent ────────────────────────────────────────────────────────────────
{
    const d = createWheelDetent({ notch: 100, idleMs: 200, lead: 0.25 });
    eq(d.feed(10, 0, 'a'), 0, 'detent: a nudge under the lead turns nothing');
    eq(d.feed(20, 10, 'a'), 1, 'detent: the gesture\'s first page turns once travel passes the lead');
    eq(d.feed(60, 20, 'a'), 0, 'detent: after the lead, a partial notch carries');
    eq(d.feed(60, 30, 'a'), 1, 'detent: …and the carried remainder completes the next notch');
    eq(d.feed(250, 40, 'a'), 2, 'detent: a big travel turns whole notches, the rest carried');
    // momentum: 60 frames of 8 px (480 px) inside one gesture → ~5 pages, not 60.
    const m = createWheelDetent({ notch: 100, idleMs: 200, lead: 0.25 });
    let pages = 0;
    for (let f = 0; f < 60; f++) pages += m.feed(8, f * 16, 'a');
    ok(pages >= 4 && pages <= 6, `detent: a momentum stream of 60 small deltas turns ${pages} pages, not 60`);
    // a mouse click (one 120 px delta) after a quiet spell always turns exactly one.
    const c = createWheelDetent({ notch: 120, idleMs: 180, lead: 0.25 });
    eq([c.feed(120, 0, 'a'), c.feed(120, 1000, 'a'), c.feed(-120, 2000, 'a')], [1, 1, -1],
        'detent: separated mouse clicks turn one page each, either way');
    // reversal and a change of book both start fresh — no stale carry.
    const r = createWheelDetent({ notch: 100, idleMs: 200, lead: 0.25 });
    r.feed(30, 0, 'a'); r.feed(90, 10, 'a');                 // led, carry 90
    eq(r.feed(-30, 20, 'a'), -1, 'detent: a reversal starts a fresh gesture (its own lead)');
    r.feed(30, 30, 'b'); r.feed(90, 40, 'b');                // led on b, carry 90
    eq(r.feed(20, 50, 'c'), 0, 'detent: another book under the cursor drops the carry');
    r.feed(30, 0, 'x'); r.feed(90, 10, 'x');
    eq(r.feed(20, 500, 'x'), 0, 'detent: idle past idleMs drops the carry (the next nudge is a new gesture)');
    let threw = false;
    try { r.configure({ notch: 'wide' }); } catch (_e) { threw = true; }
    ok(threw, 'detent: configure fails loud on a non-number');
}

// ── 2. deltaMode → px ───────────────────────────────────────────────────────────
eq(normalizeWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, () => 800), { dx: 0, dy: 3 * WHEEL_LINE_PX }, 'wheel: line deltas normalize to px');
eq(normalizeWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, () => 800), { dx: 0, dy: 800 }, 'wheel: page deltas normalize to the viewport height');
eq(normalizeWheelDelta({ deltaX: 5, deltaY: 53, deltaMode: 0 }, () => { throw new Error('no'); }), { dx: 5, dy: 53 }, 'wheel: pixel deltas pass through (page size never read)');

// ── 3. the records pass the step COUNT, with each book's reading direction ───────
eq(wheelPageCommand({ role: 'card', meta: { agentId: 'a1' } }, 3), ['book.scroll', 'a1', '-3'], 'wheel: 3 notches down over a card → 3 sheets older');
eq(wheelPageCommand({ id: 'agent:book:a1', role: 'agent' }, -2), ['book.scroll', 'agent:book:a1', '2'], 'wheel: 2 notches up over a cover → 2 sheets newer');
eq(wheelPageCommand({ role: 'volume', meta: { path: 'src' } }, 2), ['book.scroll', 'src', '2'], 'wheel: notches down over a volume → pages forward');
eq(wheelPageCommand({ role: 'delta', meta: { deltaId: 'w' } }, 1), ['book.scroll', 'delta:w', '-1'], 'wheel: a delta cover pages by its delta address');

// ── 4. the book in focus + the bare verbs ───────────────────────────────────────
const books = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
for (let k = 0; k < 6; k++) books.activity('first', 'claude', { action: 'say', result: `hello ${k}` });
for (let k = 0; k < 6; k++) books.activity('second', 'claude', { action: k % 2 ? 'read' : 'bash', detail: `cmd ${k}`, result: 'ok' });
const second = books.lanes.get('second');
const card = second.entries[2].action;   // a card riding sheet 2 of the SECOND lane
{
    const slots = { primary: null, hover: null };
    const registry = new Map([['card-2', { grid: card }], ['cover-2', { grid: second.book }]]);
    const ctx = {
        agentBooks: books,
        attentionManager: { get: (s) => (slots[s] ? { id: slots[s] } : null) },
        registry: { get: (id) => registry.get(id) ?? null },
    };
    ok(bookInFocus(ctx) === null, 'focus: nothing focused or hovered → no book in focus');
    slots.hover = 'cover-2';
    eq(bookInFocus(ctx)?.agentId, 'second', 'focus: a hovered cover is the book in focus');
    slots.primary = 'card-2';
    slots.hover = null;
    eq(bookInFocus(ctx)?.agentId, 'second', 'focus: a focused CARD resolves its own lane (walks up through mounts + sheet)');

    const handlers = {};
    registerBookCommands({ register: (name, fn) => { handlers[name] = fn; } });
    let r = handlers['book.page'](['prev'], ctx);
    ok(r.text.startsWith('OK') && second.book.head === 4 && books.lanes.get('first').book.head === 5,
        `bare book.page prev pages the FOCUSED card's book, not the first lane (${r.text})`);
    r = handlers['book.scroll'](['-3'], ctx);
    eq(second.book.head, 1, 'bare book.scroll -3 turns the focused book three sheets');
    ok(/turn ~2\/6/.test(r.text), `the verb reports the open sheet's turn in the run, ~ for a floor (${r.text})`);
    handlers['book.page'](['last'], ctx);
    ok(second.book.following, 'book.page last resumes live-follow');
    slots.primary = null;
    handlers['book.page'](['first'], ctx);
    eq(books.lanes.get('first').book.head, 0, 'no focus: the bare verb still falls to the first lane');
}

// ── 5. the book keys ────────────────────────────────────────────────────────────
const key = (k, extra = {}) => resolveKeyBinding({ key: k, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...extra });
eq([key(','), key('.'), key('<'), key('>')], [['book.page', 'prev'], ['book.page', 'next'], ['book.page', 'first'], ['book.page', 'last']],
    'keys: , . < > are the bare book.page lines');
eq(key('.', { repeat: true }), ['book.page', 'next'], 'keys: a held . keeps flipping');
eq(key('>', { repeat: true }), null, 'keys: a held > jumps once');
eq(key('h', { repeat: true }), null, 'keys: nav keys still ignore auto-repeat');
eq(key('.', { ctrlKey: true }), null, 'keys: a modified chord is not a book key');

// ── 6. the timeline: a tab per sheet, numbered by turn, hued by kind ─────────────
{
    const tabs = second.book.tabs;
    eq(tabs?.length, second.book.sheets.length, 'timeline: one tab per sheet, bound at birth');
    eq(tabs.map((t) => t.tab.text), ['1', '2', '3', '4', '5', '6'], 'timeline: each tab reads its turn number');
    eq(tabs.map((t) => t.key), ['run', 'read', 'run', 'read', 'run', 'read'], 'timeline: tabs band by action kind');
    const before = tabs.map((t) => t.tab);
    books.activity('second', 'claude', { action: 'say', result: 'more' });
    ok(second.book.tabs.slice(0, 6).every((t, i) => t.tab === before[i]), 'timeline: a new record adds one tab, the rest are kept (no rebind)');
    books.setLimit('second', 4);
    eq(second.book.tabs.map((t) => t.tab.text), ['4', '5', '6', '7'], 'timeline: shed sheets take their tabs; turn numbers stay absolute');
    second.book.pageTo(1);
    second.book.update(1 / 60);
    const lifted = second.book.tabs[1].tab.position.y, rest = second.book.tabs[0].tab.position.y;
    ok(lifted > rest, 'timeline: the open sheet\'s tab stands raised');
    const hs = books.headState('second');
    eq([hs.turn, hs.turns, hs.exact], [5, 7, false], 'headState: the open sheet\'s turn; a live-born lane\'s count is a floor');
}

// ── 7. hydration numbers turns from the run's start ─────────────────────────────
{
    const b2 = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
    const recs = Array.from({ length: 3 }, (_, k) => ({ action: 'say', result: `r${k}` }));
    await b2.hydrate('h', recs, { seqBase: 40, seqExact: false });
    eq(b2.lanes.get('h').book.tabs.map((t) => t.tab.text), ['41', '42', '43'], 'hydrate: tabs count from the skipped tail');
    const hs = b2.headState('h');
    eq([hs.turn, hs.turns, hs.exact], [43, 43, false], 'hydrate: a tail read reports a floor (exact false)');
    await b2.hydrate('w', recs, { seqBase: 0, seqExact: true });
    eq(b2.headState('w').exact, true, 'hydrate: a whole-record read is exact');
}

console.log(`\nbook-controls.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
