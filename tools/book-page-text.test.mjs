// book-page-text.test.mjs — behavior lock for an agent book's PAGE TEXT: each side's text
// size and line break, as a deck-wide default (Settings ▸ Agent Books → AgentBooks.cfg) and
// a per-book override (book.set → the Tuning component → AgentBooks.tuneText).
//
//   bun tools/book-page-text.test.mjs
//
// Locks:
//   - the recto sizes by the ONE rule: prose at rectoTextSize, a file / an output at its
//     ratio; never set larger (a short say is NOT upscaled to fill its page); wrap wraps to
//     the page and shrinks only if still too tall; natural keeps a long line whole and
//     shrinks the card to the page width
//   - a file snapshot wraps in the FOLD (its lines stay the file's) — natural turns it off
//   - per-side defaults: the verso and recto take their own sizes and breaks
//   - a per-book override wins, re-fits only that book (sheets re-fit in place), is recorded
//     as the book's own (tuneOf / book.get *), and 'default' hands it back to the deck
//   - changing a deck default (setSetting) re-fits books without an override and leaves an
//     overriding book alone
//   - capture/restore round trip: SessionStore.capture saves the book's own values
//     (`tunings`); restored, a book that registers later is projected wearing them
//   - a delta book has no page-text knobs (readBook omits them; book.set refuses)
//
// Real AgentBooks + tuning + book verbs + WorkspaceModel + SessionStore over a mock
// registry; the shaper-less atlas stub (real positions, no ink). GPU-free.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

const store = new Map();
globalThis.localStorage ??= {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
globalThis.window.dispatchEvent ??= () => {};

const { default: AgentBooks, AGENT_BOOKS_DEFAULTS } = await import('@glyph3d/core/collections/AgentBooks.js');
const { default: Book } = await import('@glyph3d/core/collections/Book.js');
const { computeCellMetrics } = await import('@glyph3d/core/core/cellMetrics.js');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { default: SessionStore } = await import('../app/client/SessionStore.js');
const { default: registerBookCommands } = await import('../app/commands/handlers/bookCommands.js');
const { setSetting, resetSetting } = await import('../app/client/settings.js');
const { tuneOf, readBook, tuneBook } = await import('../app/client/tuning.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const verbs = new Map();
registerBookCommands({ register: (name, fn) => verbs.set(name, fn) });
const run = (ctx, name, ...args) => verbs.get(name)(args.map(String), ctx);

const FILE = Array.from({ length: 30 }, (_, i) => `const v${i} = ${'1 + '.repeat(i * 3)}0;   // line ${i + 1}`).join('\n');
const PROSE = Array.from({ length: 400 }, (_, i) => `word${i % 10}`).join(' ');
const LONG_OUT = 'out:' + '='.repeat(400);

function makeWorld() {
    const scene = new THREE.Scene();
    const entries = new Map();
    const listeners = new Set();
    const registry = {
        setPickable() {},
        register(id, grid, meta = {}) { entries.set(id, { id, grid, ...meta }); for (const fn of listeners) fn(); },
        unregister(id) { const e = entries.get(id); entries.delete(id); for (const fn of listeners) fn(); return e; },
        get: (id) => entries.get(id) || null,
        has: (id) => entries.has(id),
        getIdByGrid: (g) => { for (const e of entries.values()) if (e.grid === g) return e.id; return null; },
        list: () => [...entries.values()],
        findByType: (t) => [...entries.values()].filter((e) => e.type === t),
        addChangeListener: (fn) => listeners.add(fn),
        removeChangeListener: (fn) => listeners.delete(fn),
    };
    const ctx = {
        scene, atlas: HEADLESS_ATLAS, registry, deltaBooks: null,
        world: { register() {}, unregister() {}, relayout() {} },
        carrels: new Map(), workspace: new WorkspaceModel(),
        cameraDock: null, camera: null,
        fileProvider: { getFile: async () => FILE },
        getSurfaces: () => [...entries.values()].map((e) => e.grid),
        getGrids: () => [],
    };
    ctx.holding = new Holding(ctx);
    ctx.agentBooks = new AgentBooks(ctx);
    return ctx;
}

const RECORDS = [
    { action: 'say', result: 'Done.' },                                               // 0 short prose
    { action: 'say', result: PROSE },                                                 // 1 long prose
    { action: 'bash', detail: 'cat build.log', result: LONG_OUT },                    // 2 one long output line
    { action: 'read', target: 'src/a.js', meta: { lines: 30 } },                      // 3 a file snapshot
    { action: 'bash', detail: 'cd /very/long/path && ' + 'run --flag '.repeat(30), result: 'ok' }, // 4 long call
];
const open = async (ctx, id) => { await ctx.agentBooks.hydrate(id, RECORDS, {}); await tick(); return ctx.agentBooks.lanes.get(id); };

const ls = computeCellMetrics(HEADLESS_ATLAS.getCharSize(), 0.025).lineSpacing;
const adv = 0.5;   // the stub atlas: an 8 × 16 cell
/** A card's world row height on its page: its gridScale × the cell × the page's fit. */
const lhOf = (lane, i, side = 'recto') => {
    const e = lane.entries[i];
    const card = side === 'recto' ? e.snapshot : e.action;
    return card.scale.y * ls * lane.book.sheets[i].fit[side].scale;
};
const cfg = AGENT_BOOKS_DEFAULTS;
const innerW = cfg.pageW - 2 * cfg.pageMargin;
const innerH = cfg.pageH - 2 * cfg.pageMargin;

// ── the deck defaults, per side ──────────────────────────────────────────────────────
const ctx = makeWorld();
const books = ctx.agentBooks;
const p = await open(ctx, 'p');
const q = await open(ctx, 'q');
{
    ok(cfg.rectoBreak === 'wrap' && cfg.versoBreak === 'natural', 'defaults: the right page wraps, the left keeps the text\'s own lines');
    ok(near(lhOf(p, 0), cfg.rectoTextSize), `a short say sits at rectoTextSize (got ${lhOf(p, 0).toFixed(3)})`);
    ok(near(p.book.sheets[0].fit.recto.scale, 1), 'and is never upscaled to fill its page');
    const prose = p.entries[1].snapshot;
    ok(prose.content.includes('\n') && prose.content.replace(/\s+/g, '') === PROSE.replace(/\s+/g, ''), 'long prose wraps to the page — every word kept');
    ok(lhOf(p, 1) <= cfg.rectoTextSize + 1e-9 && p.book.sheets[1].fit.recto.contentH <= cfg.pageH + 1e-6, 'and fits its page, never past its size');
    ok(near(lhOf(p, 2), cfg.rectoTextSize * cfg.rectoFileRatio), `an output keeps its share of the right page size (got ${lhOf(p, 2).toFixed(3)})`);
    ok(p.entries[2].snapshot.content.includes('\n'), 'wrap: the long output line wraps');
    const snap = p.entries[3].snapshot;
    ok(near(lhOf(p, 3), cfg.rectoTextSize * cfg.rectoFileRatio), 'a file snapshot keeps its share too');
    ok(snap.getLayout().wrapWidth === Math.floor(innerW / (adv * cfg.rectoTextSize * cfg.rectoFileRatio) + 1e-9) && snap.content === FILE,
        'a file snapshot wraps in the fold at the page width — its text (and line numbers) stay the file\'s');
    ok(near(lhOf(p, 0, 'verso'), cfg.versoTextSize), 'a short call\'s headline sits at versoTextSize');
    ok(lhOf(p, 4, 'verso') < cfg.versoTextSize && !p.entries[4].action.content.includes('\n'), 'natural verso: a long call stays one line, shrunk to fit');
}

// ── a per-book override wins, re-fits only that book ─────────────────────────────────
{
    let r = run(ctx, 'book.set', 'p', 'rectoBreak', 'natural');
    ok(r.text.startsWith('OK') && r.data.own, `book.set takes a page break (got ${r.text})`);
    await tick();
    const out = p.entries[2].snapshot;
    ok(out.content === LONG_OUT && out.getLayout().wrapWidth === 0, 'natural: the long output line stays whole, unwrapped (re-fit in place)');
    ok(near(lhOf(p, 2), innerW / ([...LONG_OUT].length * adv), 1e-6), `natural: it shrinks to the page width (got ${lhOf(p, 2).toFixed(3)})`);
    ok(p.entries[3].snapshot.getLayout().wrapWidth === 0, 'natural: the file snapshot\'s fold wrap is off');
    ok(q.entries[2].snapshot.content.includes('\n') && near(lhOf(q, 2), cfg.rectoTextSize * cfg.rectoFileRatio), 'the other book still wraps');

    r = run(ctx, 'book.set', 'p', 'rectoTextSize', 14);
    await tick();
    ok(r.text.startsWith('OK') && near(lhOf(p, 0), 14) && near(lhOf(q, 0), cfg.rectoTextSize), 'a book\'s own right page size wins — only there');
    ok(tuneOf(ctx, 'agent:book:p').rectoTextSize === 14 && tuneOf(ctx, 'agent:book:p').rectoBreak === 'natural', 'recorded as the book\'s own (the Tuning component)');
    const g = run(ctx, 'book.get', 'p');
    ok(/\*rectoTextSize = 14/.test(g.text) && / versoTextSize = 18/.test(g.text), `book.get marks it own (got ${JSON.stringify(g.text)})`);

    r = run(ctx, 'book.set', 'q', 'versoBreak', 'wrap');
    await tick();
    const head = q.entries[4].action;
    ok(head.content.includes('\n') && near(lhOf(q, 4, 'verso'), cfg.versoTextSize), 'wrap verso: the long call wraps at the full headline size');
    ok(!p.entries[4].action.content.includes('\n'), '…and only on that book');

    ok(run(ctx, 'book.set', 'p', 'rectoTextSize', 0).text.startsWith('ERR'), 'a zero size is refused');
    ok(run(ctx, 'book.set', 'p', 'versoBreak', 'sideways').text.startsWith('ERR'), 'an unknown break is refused');
}

// ── a deck default reaches only the books without their own ──────────────────────────
{
    setSetting(ctx, 'book.rectoTextSize', 12);
    await tick();
    ok(near(lhOf(q, 0), 12), `the deck default re-fits a book without an override (got ${lhOf(q, 0).toFixed(3)})`);
    ok(near(lhOf(p, 0), 14), 'and leaves the overriding book alone');
    setSetting(ctx, 'book.versoTextSize', 24);
    await tick();
    ok(near(lhOf(p, 0, 'verso'), 24) && near(lhOf(q, 0, 'verso'), 24), 'a verso default reaches both (neither overrides its size)');
    let r = run(ctx, 'book.set', 'p', 'rectoTextSize', 'default');
    await tick();
    ok(r.text.startsWith('OK') && !r.data.own && near(lhOf(p, 0), 12) && !('rectoTextSize' in tuneOf(ctx, 'agent:book:p')),
        "'default' hands it back to the deck's current default");
    resetSetting(ctx, 'book.rectoTextSize');
    resetSetting(ctx, 'book.versoTextSize');
    await tick();
    ok(near(lhOf(q, 0), cfg.rectoTextSize) && near(lhOf(q, 0, 'verso'), cfg.versoTextSize), 'resetting the defaults re-fits back');
    r = run(ctx, 'book.set', 'p', 'rectoTextSize', 14);
}

// ── capture → restore round trip ─────────────────────────────────────────────────────
{
    const saved = new SessionStore({ ctx, router: null, bridge: null }).capture();
    const rec = saved.tunings.find((t) => t.id === 'agent:book:p');
    ok(rec && rec.tune.rectoTextSize === 14 && rec.tune.rectoBreak === 'natural', `the snapshot saves the book's own page text (got ${JSON.stringify(rec)})`);

    const w2 = makeWorld();
    const s2 = new SessionStore({ ctx: w2, router: null, bridge: null });
    s2._restoreTunings(saved);          // before the book exists (reload: tunings come first)
    const p2 = await open(w2, 'p');
    s2._projectSurfaces();              // the registry-change projector
    await tick();
    ok(w2.agentBooks.textOf('p').own.rectoTextSize === 14 && near(lhOf(p2, 0), 14), 'restored, the book wears its own size');
    ok(p2.entries[2].snapshot.content === LONG_OUT, '…and its own break');
    const q2 = await open(w2, 'q');
    s2._projectSurfaces();
    await tick();
    ok(near(lhOf(q2, 0), cfg.rectoTextSize) && q2.entries[2].snapshot.content.includes('\n'), 'a book without a record takes the deck defaults');
    const r = readBook(w2, { kind: 'agent', books: w2.agentBooks, agentId: 'p', book: p2.book });
    ok(r.kind === 'agent' && r.values.rectoTextSize === 14 && r.own.rectoTextSize === 14, 'readBook reads the live page text and which is own');
    w2.agentBooks.dispose();
}

// ── delta books have no page text ────────────────────────────────────────────────────
{
    const book = new Book();
    const hit = { kind: 'delta', deltas: { sets: new Map([['d1', { groupId: 'delta:book:d1' }]]) }, setId: 'd1', book };
    const r = readBook(ctx, hit);
    ok(!('rectoTextSize' in r.values) && 'zPitch' in r.values, 'a delta book reads its deck knobs only');
    ok(!tuneBook(ctx, hit, 'rectoTextSize', 12).ok, 'and refuses a page-text knob');
}

books.dispose();
console.log(`book-page-text.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
