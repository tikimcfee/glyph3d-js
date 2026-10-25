// agent-events.test.mjs — behavior lock for agent books fed by gomuxai's EVENT STREAM
// (collections/agentEvents.js + AgentBooks.applyEvents), driven from gomuxai's own
// conformance corpus — the exact events each transcript must produce:
//
//   bun tools/agent-events.test.mjs        (GOMUXAI_DIR=<gomuxai checkout>, default ~/dev/gomuxai)
//
// The corpus is gomuxai's internal/transcript/testdata/corpus/**/*.events.jsonl; the test
// FAILS when it is missing (no silent skip). It locks:
//   - the reader: any chunking (bytes split mid-codepoint, lines split across pushes) folds
//     to the same events; one event per id; an update replaces its event and keeps the
//     add's position; the session line; a frame off the contract throws;
//   - one sheet per event (noise hidden unless asked), in stream order, live == hydrated;
//   - prompts of every origin are sheets, tagged by whose words they are, in the prompt hue;
//   - a tool's pending → result update rebuilds its sheet IN PLACE (count, index, head and
//     deck pose unchanged), statuses as info rows, an errored file action shows its error;
//   - a provisional final reply confirmed by its update;
//   - turn ids + indexes on every sheet; headState's turn is the open sheet's;
//   - a stream's events land in its own book (a subagent's stream in the subagent's; an old
//     transcript's sidechain records in a book named by their agent); a redacted thought says so;
//   - the sliding-window history pages back by `at` over `agentEvents/read` windows (the
//     first from the start: exact numbers + a line-start index; later ones windowed by it),
//     and an update for a record waiting in a buffer replaces it there.
// (The open/follow path that feeds books from the relay is tools/session-books.test.mjs.)

import * as THREE from 'three';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
const { default: AgentBooks, AGENT_BOOKS_DEFAULTS } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { AgentEventReader, parseEventSlice, PROMPT_ORIGINS } =
    await import('../packages/glyph3d-core/src/collections/agentEvents.js');
const { ACTION_HUES } = await import('../packages/glyph3d-core/src/collections/toolRegistry.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);

// ── the corpus ──────────────────────────────────────────────────────────────────────
const GOMUXAI = process.env.GOMUXAI_DIR || join(process.env.HOME || '/home/ivan', 'dev/gomuxai');
const CORPUS = join(GOMUXAI, 'internal/transcript/testdata/corpus');
if (!existsSync(CORPUS)) {
    console.error(`agent-events: FAIL — no event corpus at ${CORPUS}.\n  Set GOMUXAI_DIR to a gomuxai checkout (branch events) holding internal/transcript/testdata/corpus.`);
    process.exit(1);
}
const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.events.jsonl') ? [p] : []);
});
const FILES = walk(CORPUS).sort();
const name = (f) => relative(CORPUS, f).replace(/\.events\.jsonl$/, '');
const CASES = new Map(FILES.map((f) => [name(f), readFileSync(f, 'utf8')]));
for (const need of ['claude/basic-turn', 'claude/mid-turn-queued', 'claude/held-delivery', 'claude/notification-and-commands',
    'claude/subagent', 'claude/subagent/subagents/agent-a3f9c2e17b4d5e608', 'claude/tool-results', 'claude/derived-turns',
    'claude/session-meta', 'claude/system-records', 'agy/conversation', 'kimi/interleaved']) {
    if (!CASES.has(need)) { console.error(`agent-events: FAIL — the corpus at ${CORPUS} has no ${need}.events.jsonl`); process.exit(1); }
}
const lines = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const frames = (c) => lines(CASES.get(c));
const evs = (c) => frames(c).filter((f) => f.type === 'event');
const enc = new TextEncoder();

/** Every change a reader yields over a stream fed in `chunk`-byte pieces. */
function readAll(text, chunk) {
    const r = new AgentEventReader();
    const out = [];
    if (!chunk) out.push(...r.push(text));
    else { const b = enc.encode(text); for (let i = 0; i < b.length; i += chunk) out.push(...r.push(b.subarray(i, i + chunk))); }
    out.push(...r.end());
    return { r, changes: out };
}

const newBooks = (opts = {}) => {
    const b = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
    b.cfg.maxSheets = 0;   // unbounded unless a section says otherwise
    Object.assign(b.cfg, opts);
    return b;
};
/** Feed a stream LIVE, one change at a time, into `lane`. */
function live(books, lane, c, { each } = {}) {
    const r = new AgentEventReader();
    for (const ch of r.push(CASES.get(c))) {
        books.applyEvents(lane, [ch], { agentType: 'claude' });
        each?.(ch, r);
    }
    return r;
}
const ids = (lane) => lane.entries.map((e) => e.record.id);
const visibleIds = (c, showNoise = true) => {
    const seen = new Set(), out = [];
    for (const f of evs(c)) {
        if (f.kind === 'tool' && f.tool.action === 'noise' && !showNoise) continue;
        if (!seen.has(f.id)) { seen.add(f.id); out.push(f.id); }
    }
    return out;
};

// ── 1. the reader ───────────────────────────────────────────────────────────────────
{
    let streams = 0;
    for (const [c, text] of CASES) {
        const whole = readAll(text, 0);
        const fs = lines(text);
        const want = [...new Set(fs.filter((f) => f.type === 'event').map((f) => f.id))];
        eq(whole.r.order, want, `${c}: one event per id, in the order their adds arrived`);
        for (const chunk of [1, 7, 64]) {
            const cut = readAll(text, chunk);
            ok(J(cut.r.events()) === J(whole.r.events()) && J(cut.changes) === J(whole.changes),
                `${c}: ${chunk}-byte chunks fold exactly as the whole stream`);
        }
        const firstAt = new Map();
        for (const f of fs) if (f.type === 'event' && !firstAt.has(f.id)) firstAt.set(f.id, f);
        const ups = whole.changes.filter((x) => x.op === 'update');
        ok(ups.length === fs.filter((f) => f.op === 'update').length, `${c}: every update frame is an update change`);
        ok(ups.every((u) => u.pos && u.pos.at === firstAt.get(u.event.id).at && u.pos.seq === firstAt.get(u.event.id).seq),
            `${c}: an update keeps its event's position (the add's at + seq)`);
        const last = new Map();
        for (const f of fs) if (f.type === 'event') last.set(f.id, f);
        ok(whole.r.events().every((e) => J(e) === J(last.get(e.id))), `${c}: each event as it now stands is its last frame (updates replace)`);
        eq(whole.r.session?.session_id, fs[0].session_id, `${c}: the session line`);
        streams++;
    }
    ok(streams >= 13, `the corpus has every stream (${streams})`);
    // A resumed stream (--from the last held `at`) re-sends that line's add: an update in place.
    const r = new AgentEventReader();
    const text = CASES.get('claude/basic-turn');
    r.push(text);
    const lastLine = text.trim().split('\n').at(-1);
    const again = r.push(lastLine + '\n');
    ok(again.length === 1 && again[0].op === 'update' && r.size === new Set(evs('claude/basic-turn').map((f) => f.id)).size,
        'a re-sent add of a held id replaces in place (no second event)');
    // An update of an event the reader never saw added: reported with no position.
    const orphan = new AgentEventReader().push(J(evs('claude/basic-turn').find((f) => f.op === 'update')) + '\n');
    ok(orphan.length === 1 && orphan[0].op === 'update' && orphan[0].pos === null, 'an update with no add held is reported, positionless');
    // Off the contract: loud.
    const throws = (fn) => { try { fn(); return false; } catch { return true; } };
    ok(throws(() => new AgentEventReader().push('{not json\n')), 'a line that is not JSON throws');
    ok(throws(() => new AgentEventReader().push(J({ type: 'event', id: 'x', op: 'add', at: 0, kind: 'dance', dance: {} }) + '\n')), 'an unknown kind throws');
    ok(throws(() => new AgentEventReader().push(J({ type: 'event', id: 'x', op: 'add', kind: 'say', say: { text: 'a' } }) + '\n')), 'an event without `at` throws');
    ok(throws(() => new AgentEventReader().push(J({ type: 'tick' }) + '\n')), 'an unknown frame type throws');
}

// ── 2. one sheet per event, in stream order; live == hydrated ───────────────────────
for (const c of CASES.keys()) {
    if (c.endsWith('.requests')) continue;
    const books = newBooks();
    live(books, 'L', c);
    const all = [...books.lanes.values()];
    const got = all.flatMap(ids);
    eq(got, visibleIds(c), `${c}: one sheet per (visible) event, in stream order`);
    ok(all.every((l) => l.book.sheets.length === l.entries.length && l.book.tabs.length === l.entries.length),
        `${c}: deck, entries and tabs stay parallel`);
    const h = newBooks();
    const slice = parseEventSlice(CASES.get(c));
    const hl = [...books.lanes.keys()][0];
    await h.hydrate(hl, slice.records, { agentType: 'claude' });
    eq(h.lanes.get(hl).entries.map((e) => e.record), books.lanes.get(hl).entries.map((e) => e.record),
        `${c}: a hydrated book holds the same records as one fed live`);
}

// ── 3. prompts of every origin are first-class sheets ───────────────────────────────
{
    const byOrigin = new Map();
    for (const c of CASES.keys()) {
        if (c.endsWith('.requests')) continue;
        const books = newBooks();
        live(books, 'L', c);
        for (const lane of books.lanes.values()) {
            lane.entries.forEach((e, i) => {
                if (e.record.action !== 'prompt') return;
                (byOrigin.get(e.record.origin) ?? byOrigin.set(e.record.origin, []).get(e.record.origin)).push({ e, lane, i, c });
            });
        }
    }
    const origins = [...byOrigin.keys()].sort();
    eq(origins, ['command', 'delivered', 'human', 'peer', 'queued', 'task-notification'], 'the corpus\'s prompt origins all became sheets');
    const prompts = [...byOrigin.values()].flat();
    const promptEvents = [...CASES.entries()].filter(([c]) => !c.endsWith('.requests')).flatMap(([c]) => evs(c).filter((f) => f.kind === 'prompt'));
    ok(prompts.length === promptEvents.length, `every prompt event is a sheet (${prompts.length}/${promptEvents.length})`);
    const lift = (h, t) => ({ r: h.r + (1 - h.r) * t, g: h.g + (1 - h.g) * t, b: h.b + (1 - h.b) * t });
    for (const { e, lane, i, c } of prompts) {
        const ev = promptEvents.find((f) => f.id === e.record.id);
        const tag = PROMPT_ORIGINS[e.record.origin];
        ok(e.call.verb === tag && e.action.filename === `[${tag}]`, `${c}: a ${e.record.origin} prompt's headline is tagged [${tag}] (got [${e.call.verb}])`);
        ok(e.record.result === ev.prompt.text, `${c}: the prompt's words ride whole`);
        ok(lane.book.sheets[i].meta.kind === 'prompt' && lane.book.tabs[i].key === 'prompt', `${c}: a prompt sheet's tab bands as 'prompt'`);
        ok(e.snapshot && e.snapshot.filename === tag && J(e.snapshot.config.textColor) === J(lift(ACTION_HUES.prompt, AGENT_BOOKS_DEFAULTS.promptTextLift)),
            `${c}: the recto sets the words in the prompt hue under whose words they are`);
        ok(e.snapScaleKey === 'messageScale', `${c}: a prompt is prose (message scale)`);
    }
    const cmd = byOrigin.get('command').find((p) => p.e.record.command === '/review');
    ok(cmd && cmd.e.call.head === '/review internal/server', 'a slash command: its command and args head the page');
    const img = prompts.find((p) => p.c === 'claude/session-meta');
    ok(img && /1 image/.test(img.e.infoText), 'a prompt with an image says so');
    const q = byOrigin.get('queued').find((p) => p.c === 'claude/mid-turn-queued' && p.i === 2);
    const first = byOrigin.get('human').find((p) => p.c === 'claude/mid-turn-queued');
    ok(q && first && q.e.record.turn.id === first.e.record.turn.id && q.e.call.verb === 'you · queued',
        'a message queued mid-turn is its own sheet in the current turn');
    ok(!new Set(prompts.map((p) => p.e.call.verb)).has('say'), 'no prompt reads as the agent speaking');
    // The `system` origin (hook context that is not a delivery) — not in the corpus: one event, re-originated.
    const sys = { ...evs('claude/held-delivery').find((f) => f.prompt?.origin === 'delivered') };
    sys.prompt = { ...sys.prompt, origin: 'system', text: 'Hook context.' };
    const b = newBooks();
    b.applyEvents('s', [{ op: 'add', event: sys, pos: null }]);
    eq(b.lanes.get('s').entries[0].call.verb, 'harness', 'a system-origin prompt is the harness\'s words');
}

// ── 4. a tool's pending → result rebuilds its sheet in place ────────────────────────
{
    const books = newBooks();
    const seen = [];
    live(books, 'T', 'claude/tool-results', {
        each: (ch) => {
            if (!ch.event) return;   // the session line
            const lane = books.lanes.get('T');
            seen.push({ op: ch.op, id: ch.event.id, n: lane.entries.length, idx: ids(lane).indexOf(ch.event.id),
                node: lane.book.sheets[ids(lane).indexOf(ch.event.id)]?.node, rev: lane.entries[ids(lane).indexOf(ch.event.id)]?.rev });
        },
    });
    const lane = books.lanes.get('T');
    const ups = seen.filter((s) => s.op === 'update');
    ok(ups.length === evs('claude/tool-results').filter((f) => f.op === 'update').length, 'every result update reached the book');
    ok(ups.every((u) => {
        const add = seen.find((s) => s.op === 'add' && s.id === u.id);
        const before = seen[seen.indexOf(u) - 1];
        return u.n === before.n && u.idx === add.idx && u.node === add.node && u.rev >= 1;
    }), 'an update keeps the sheet count, the sheet\'s index and its deck node; it is a new revision');
    const multi = lane.entries.find((e) => e.record.name === 'MultiEdit');
    ok(multi.record.status === 'ok' && J(multi.record.meta.ranges) === J([[4, 4], [9, 9]]) && /L4, 9/.test(multi.infoText),
        'the edit\'s result update brings the patch ranges (the add carried only +/−)');
    const read = lane.entries.find((e) => e.record.name === 'Read');
    ok(J(read.record.meta.range) === J([5, 10]) && read.snapshot?.name === 'agent:spin_test.go', 'a partial read: its range arrives with the result; the file is the content');
    const build = lane.entries.find((e) => e.record.detail.startsWith('go build'));
    ok(build.record.status === 'error' && /error/.test(build.infoText) && /Exit code 1/.test(build.record.result) && build.snapshot,
        'a failed call says error and shows its output');
    const intr = lane.entries.find((e) => e.record.detail.startsWith('go test'));
    ok(intr.record.status === 'interrupted' && /interrupted/.test(intr.infoText), 'an interrupted call says so');
    ok(ids(lane).length === visibleIds('claude/tool-results').length, `no sheet was added for an update (${ids(lane).length})`);

    // A book opened from one read, followed by a NEW reader (the follow resumes `--from`
    // past the open): that reader never saw the call added, but the book holds it — the
    // update lands in place, and the sheet keeps the place it was added at.
    {
        const evts = evs('claude/tool-results');
        const cut = evts.findIndex((f) => f.op === 'update' && f.tool?.name === 'Read');
        const opened = parseEventSlice([frames('claude/tool-results')[0], ...evts.slice(0, cut)].map(J).join('\n') + '\n');
        const bo = newBooks();
        await bo.hydrate('R', opened.records, { agentType: 'claude' });
        const follow = new AgentEventReader();
        const chs = follow.push(evts.slice(cut).map(J).join('\n') + '\n');
        ok(chs[0].op === 'update' && chs[0].pos === null, 'the resumed reader reports the result as a positionless update');
        bo.applyEvents('R', chs);
        const lr = bo.lanes.get('R');
        eq(ids(lr), visibleIds('claude/tool-results'), 'open + resumed follow: one sheet per event, in order');
        const rdAdd = evts.find((f) => f.op === 'add' && f.tool?.name === 'Read');
        const rdSheet = lr.entries.find((e) => e.record.id === rdAdd.id);
        ok(rdSheet.record.status === 'ok' && rdSheet.record.at === rdAdd.at, 'the held call took its result in place and kept the add\'s at');
    }
    // A pending Bash has no content page; its result gives it one.
    const b2 = newBooks();
    const r2 = new AgentEventReader();
    const chs = r2.push(CASES.get('claude/basic-turn'));
    const bashAdd = chs.findIndex((c) => c.event?.tool?.name === 'Bash' && c.op === 'add');
    b2.applyEvents('B', chs.slice(0, bashAdd + 1));
    const l2 = b2.lanes.get('B');
    const pend = l2.entries.at(-1);
    ok(pend.record.status === 'pending' && !pend.snapshot && /pending/.test(pend.infoText), 'a pending call: no output yet, it says pending');
    // Held away from the live end: an update to the open sheet leaves the head where it is.
    l2.book.pageTo(l2.entries.length - 1);
    const head = l2.book.head;
    l2.book.pageTo(head - 1);
    const held = { head: l2.book.head, following: l2.book.following };
    b2.applyEvents('B', [chs[bashAdd + 1]]);
    ok(l2.entries.at(-1).record.status === 'ok' && l2.entries.at(-1).snapshot && /check:/.test(l2.entries.at(-1).record.result),
        'the result update gives the sheet its output page');
    eq({ head: l2.book.head, following: l2.book.following }, held, 'an update while held leaves the head and live-follow alone');
    // Errored FILE action: its error is the content, not a snapshot of the file.
    const rd = evs('claude/tool-results').find((f) => f.op === 'update' && f.tool.name === 'Read');
    const bad = { ...rd, tool: { ...rd.tool, result: { status: 'error', output: 'File does not exist.' }, meta: undefined } };
    const b3 = newBooks();
    b3.applyEvents('E', [{ op: 'add', event: { ...rd, op: 'add', tool: { ...rd.tool, result: { status: 'pending' } } }, pos: null }]);
    ok(b3.lanes.get('E').entries[0].snapshot?.name === 'agent:spin_test.go', 'a pending read shows its file');
    b3.applyEvents('E', [{ op: 'update', event: bad, pos: null }]);
    const e3 = b3.lanes.get('E').entries[0];
    ok(e3.snapshot?.name === 'agent:output' && e3.record.result === 'File does not exist.', 'a read that failed shows the error instead of the file');
    // Background → the notification completes it; the Agent call names the subagent it started.
    const b4 = newBooks();
    live(b4, 'N', 'claude/notification-and-commands');
    const srv = b4.lanes.get('N').entries.find((e) => e.record.detail === 'make serve');
    ok(srv.record.status === 'ok' && !/background/.test(srv.infoText), 'a background call completed by its task notification reads ok');
    const b5 = newBooks();
    live(b5, 'P', 'claude/subagent');
    const ag = b5.lanes.get('P').entries.find((e) => e.record.name === 'Agent');
    ok(J(ag.record.subSessions) === J(['agent-a3f9c2e17b4d5e608']) && /started agent-a3f9c2e17b4d5e608/.test(ag.infoText) && /41\.\ds/.test(ag.infoText),
        'the Agent call names the subagent session it started and carries its usage');
}

// ── 5. a provisional final reply, confirmed ──────────────────────────────────────────
{
    const evts = evs('claude/held-delivery');
    const say = evts.find((f) => f.kind === 'say');
    const books = newBooks();
    const r = new AgentEventReader();
    const before = evts.slice(0, evts.indexOf(say));
    books.applyEvents('V', r.push(before.map(J).join('\n') + '\n'));
    books.applyEvents('V', r.push(J({ ...say, say: { ...say.say, provisional: true } }) + '\n'));
    const lane = books.lanes.get('V');
    const n = lane.entries.length, i = n - 1;
    ok(lane.entries[i].record.provisional && /final reply · provisional/.test(lane.entries[i].infoText), 'a provisional final reply is marked so');
    books.applyEvents('V', r.push(J({ ...say, op: 'update', at: say.at + 900, ts: '2026-10-20T11:00:06.300Z' }) + '\n'));
    ok(lane.entries.length === n && lane.entries[i].record.id === say.id && !lane.entries[i].record.provisional
        && /final reply/.test(lane.entries[i].infoText) && !/provisional/.test(lane.entries[i].infoText), 'the transcript\'s copy confirms it in place');
    ok(lane.entries[i].record.at === say.at, 'the confirmed reply keeps its place (the add\'s at), not the confirming line\'s');
}

// ── 6. turns ─────────────────────────────────────────────────────────────────────────
{
    for (const c of ['claude/mid-turn-queued', 'claude/derived-turns', 'claude/notification-and-commands', 'agy/conversation', 'kimi/interleaved']) {
        const books = newBooks();
        live(books, 'U', c);
        const lane = books.lanes.get('U');
        const last = new Map(evs(c).map((f) => [f.id, f]));
        ok(lane.entries.every((e) => J(e.record.turn) === J({ id: last.get(e.record.id).turn.id, index: last.get(e.record.id).turn.index, derived: !!last.get(e.record.id).turn.derived })),
            `${c}: every sheet carries its event's turn (id, index, derived)`);
        ok(lane.entries.every((e) => e.infoText.split('\n').includes(`turn ${e.record.turn.index}${e.record.turn.derived ? ' (derived)' : ''}`)),
            `${c}: every sheet's info names its turn`);
        for (const k of [0, Math.floor(lane.entries.length / 2), lane.entries.length - 1]) {
            lane.book.pageTo(k);
            const hs = books.headState('U');
            ok(hs.turn === lane.entries[k].record.turn.index && hs.turnId === lane.entries[k].record.turn.id && hs.sheet === k + 1,
                `${c}: headState at sheet ${k + 1} reads that sheet's turn (${hs.turn})`);
        }
    }
    const d = newBooks();
    live(d, 'D', 'claude/derived-turns');
    const dl = d.lanes.get('D');
    eq([...new Set(dl.entries.map((e) => e.record.turn.index))], [1, 2, 3], 'derived turns count prompts from 1');
    ok(dl.entries.every((e) => e.record.turn.derived) && (dl.book.pageTo(0), d.headState('D').turnDerived), 'derived turns are marked derived');
    const n = newBooks();
    live(n, 'N', 'claude/notification-and-commands');
    const note = n.lanes.get('N').entries.find((e) => e.record.origin === 'task-notification');
    const human = n.lanes.get('N').entries.find((e) => e.record.origin === 'human');
    ok(note.record.turn.id !== human.record.turn.id && note.record.turn.index === human.record.turn.index,
        'a notification opens its own turn id at the human prompt\'s index');
}

// ── 7. a stream's events are its own book's; old sidechains are another agent's ──────
{
    // A subagent's own stream (its events carry `agent` = the Claude agentId, which is not
    // its session id `agent-<id>`) feeds the subagent's own book — the one its session is.
    const SUB = 'agent-a3f9c2e17b4d5e608';
    const books = newBooks();
    live(books, 'parent', 'claude/subagent');
    live(books, SUB, `claude/subagent/subagents/${SUB}`);
    const sub = books.lanes.get(SUB), par = books.lanes.get('parent');
    ok(!!sub && books.lanes.size === 2, `the subagent's stream fed its own book, and no other (${[...books.lanes.keys()]})`);
    eq(ids(sub), visibleIds(`claude/subagent/subagents/${SUB}`), 'every subagent event is a sheet in ITS book');
    eq(ids(par), visibleIds('claude/subagent'), 'the parent\'s book holds only the parent\'s events');
    ok(sub.entries.every((e) => e.record.agent === 'a3f9c2e17b4d5e608'), 'the subagent\'s records know whose they are');
    ok(sub.meta?.parentSession?.session_id === par.meta?.sessionId && sub.sessionId === SUB,
        'the subagent\'s session line describes its book, linked to the parent\'s session');
    eq(sub.entries[0].call.verb, 'peer', 'the subagent\'s task is its parent\'s words (a peer prompt)');
    ok(par.meta?.title == null && par.meta?.cwd === '/home/user/src/widget', 'the parent\'s session line is the parent\'s meta');
    // An old main transcript still holding a subagent's records (sidechains with an
    // agentId): on the PARENT's stream, those events are another agent's book.
    const old = newBooks();
    const r = new AgentEventReader();
    const side = evs(`claude/subagent/subagents/${SUB}`).map((f) => ({ ...f, id: `side-${f.id}` }));
    old.applyEvents('main', r.push([frames('claude/subagent')[0], ...evs('claude/subagent'), ...side].map(J).join('\n') + '\n'));
    eq(ids(old.lanes.get('a3f9c2e17b4d5e608')), visibleIds(`claude/subagent/subagents/${SUB}`).map((id) => `side-${id}`),
        'sidechain events on a main stream land in a book named by their agent');
    eq(ids(old.lanes.get('main')), visibleIds('claude/subagent'), 'the main stream\'s book keeps its own events');
}

// ── 8. thinking, redacted and not; system; noise ─────────────────────────────────────
{
    const books = newBooks();
    live(books, 'K', 'claude/basic-turn');
    const lane = books.lanes.get('K');
    const [red, said] = lane.entries.filter((e) => e.record.action === 'think');
    ok(red.record.redacted && red.call.head === 'redacted' && /redacted \(signature only\)/.test(red.infoText) && !red.snapshot,
        'a redacted thought is a sheet that says it is redacted');
    ok(!said.record.redacted && said.snapshot && said.call.head.startsWith('The warning'), 'a thought with text shows it');
    const fin = lane.entries.filter((e) => e.record.action === 'say');
    ok(!fin[0].record.final && fin[1].record.final && /final reply/.test(fin[1].infoText), 'the closing reply is marked final');
    const td = lane.entries.find((e) => e.record.action === 'system');
    ok(td.call.verb === 'system' && td.call.head === 'turn_duration' && /"durationMs": 18234/.test(td.record.result), 'a system record: its subtype heads, its data is the content');
    const ts = lane.entries.filter((e) => e.record.name === 'ToolSearch');
    ok(ts.length === 1 && ts[0].record.status === 'ok', 'noise is shown by default: one sheet, its update in place');
    const ti = lane.entries.indexOf(ts[0]);
    ok(ts[0].call.verb === 'ToolSearch' && ts[0].call.head === 'select:WebFetch', 'a noise sheet heads with its tool\'s name');
    ok(lane.book.sheets[ti].meta.kind === 'noise' && lane.book.tabs[ti].key === 'noise', 'a noise sheet bands as noise');
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const bash = lane.entries.find((e) => e.record.name === 'Bash');
    ok(lum(ts[0].action.config.textColor) < lum(bash.action.config.textColor) * 0.6
        && lum(ts[0].info.config.textColor) < lum(bash.info.config.textColor) * 0.6,
        'a noise sheet is set quieter than a real call (headline and info rows)');
    const noisy = { ...evs('claude/basic-turn').find((f) => f.op === 'update' && f.tool?.action === 'noise') };
    noisy.tool = { ...noisy.tool, result: { status: 'ok', output: 'WebFetch' } };
    const nb = newBooks();
    nb.applyEvents('O', [{ op: 'add', event: noisy, pos: null }]);
    const ne = nb.lanes.get('O').entries[0];
    const nh = ACTION_HUES.noise, t = AGENT_BOOKS_DEFAULTS.noiseTextLift;
    const quiet = { r: nh.r + (1 - nh.r) * t, g: nh.g + (1 - nh.g) * t, b: nh.b + (1 - nh.b) * t };
    ok(ne.snapshot && J(ne.snapshot.config.textColor) === J(quiet) && lum(ne.snapshot.config.textColor) < lum(bash.snapshot.config.textColor) * 0.75,
        'a noise call\'s output is set in the dim noise hue, quieter than a real call\'s');
    const hidden = newBooks({ showNoise: false });
    live(hidden, 'K', 'claude/basic-turn');
    ok(!hidden.lanes.get('K').entries.some((e) => e.record.name === 'ToolSearch'), 'showNoise off: noise calls (and their updates) make no sheet');
    eq(ids(hidden.lanes.get('K')), visibleIds('claude/basic-turn', false), 'showNoise off: every other event is still a sheet, in order');
    const sr = newBooks();
    live(sr, 'S', 'claude/system-records');
    eq(sr.lanes.get('S').entries.filter((e) => e.record.action === 'system').map((e) => e.call.head),
        ['compact_boundary', 'compact_summary', 'stop_hook_summary', 'turn_duration', 'api_error', 'turn_duration'], 'every harness record is a system sheet');
    const k = newBooks();
    live(k, 'I', 'kimi/interleaved');
    eq(k.lanes.get('I').entries.map((e) => e.record.action), ['prompt', 'think', 'read', 'say', 'think', 'bash', 'say'], 'interleaved thinking, tools and text stay in stream order');
}

// ── 9. history: the sliding window pages back by `at` over an event stream ───────────
{
    // A long stream: the tool-results case repeated K times, each copy shifted past the last
    // (ids and turn ids made unique per copy) — corpus events, at corpus offsets.
    const base = frames('claude/tool-results');
    const size = base[0].size;
    const K = 8;
    let seq = 0;
    const stream = [base[0]];
    for (let k = 0; k < K; k++) {
        for (const f of base.slice(1)) {
            stream.push({ ...f, id: `${f.id}~${k}`, seq: seq++, at: f.at + k * size, line: f.line + k * 100,
                turn: { ...f.turn, id: `${f.turn.id}~${k}`, index: f.turn.index + 2 * k } });
        }
    }
    const full = new AgentEventReader();
    full.push(stream.map(J).join('\n') + '\n');
    const all = full.records();
    const end = K * size;
    // The relay's agentEvents/read (gomuxai's `agent transcript --from --until` window): the
    // lines AFTER the line at `from`, before byte `until`; `tail`: the lines at or after
    // size - tail. The session line opens every window.
    const reads = [];
    const read = ({ from, until, tail } = {}) => {
        reads.push({ from, until, tail });
        let lo = -1, hi = end;
        if (tail > 0) lo = Math.max(-1, end - tail - 1);
        if (from != null) lo = from;
        if (until != null) hi = Math.min(end, until);
        const out = [stream[0], ...stream.slice(1).filter((f) => f.at > lo && f.at < hi)];
        return Promise.resolve({ lines: out.map(J), size: end });
    };
    const books = newBooks({ maxSheets: 6, historyOverlapBytes: 2500, historyTurns: 6, historyLead: 2 });
    const tail = await read({ tail: 2 * size });
    const first = parseEventSlice(tail.lines, { cap: 6 });
    await books.hydrate('h', first.records, { agentType: 'claude', seqBase: all.length - 6, seqExact: false });
    books.setHistory('h', { read });
    const lane = books.lanes.get('h');
    const settle = async () => { for (let i = 0; i < 400 && lane.history.loading; i++) await lane.history.loading; };
    const window = () => lane.entries.map((e) => e.record);
    eq(window(), all.slice(-6), 'opened at the tail: the newest six events');
    reads.length = 0;
    const edge = lane.entries[0].record.at;
    lane.book.pageTo(1);
    await settle();
    ok(lane.older.length > 0 && lane.entries.length === 6, `paging near the oldest sheet prefetches older records (buffer ${lane.older.length})`);
    ok(lane.seqExact && books.headState('h').sheets === all.length, 'the first page back counts the sheets before it: exact');
    ok(reads.length === 1 && reads[0].from === undefined && reads[0].until === edge + 2500,
        `the first page back reads from the transcript's start to historyOverlapBytes past the window (${J(reads)})`);
    ok(Array.isArray(lane.history.starts) && lane.history.starts.length > 0, 'and leaves an index of the line starts before the window');
    // An update for a record that waits in the OLDER buffer replaces it there.
    const waiting = lane.older.at(-1).record;
    const upd = { type: 'event', id: waiting.id, op: 'update', seq: 9999, at: end + 10, line: 9999, ts: '2026-10-21T00:00:00.000Z',
        turn: { id: waiting.turn.id, index: waiting.turn.index }, kind: 'system', system: { subtype: 'marker', text: 'replaced while buffered' } };
    books.applyEvents('h', [{ op: 'update', event: upd, pos: null }]);
    ok(lane.older.at(-1).record.result === 'replaced while buffered' && lane.older.at(-1).record.at === waiting.at,
        'an update for a buffered record replaces it, keeping its position');
    lane.book.pageTo(0);
    lane.book.scroll(-1);
    ok(lane.entries[0].record.result === 'replaced while buffered', 'sliding back materializes the replaced record');
    all[all.findIndex((r) => r.id === waiting.id)] = lane.entries[0].record;
    // All the way back: every window record is the full stream's (a call cut at a slice
    // edge paired with its result through the overlap read).
    reads.length = 0;
    lane.book.scroll(-500);
    await settle();
    eq(window().map((r) => r.id), all.slice(0, 6).map((r) => r.id), 'slid back to the stream\'s first events');
    ok(reads.length > 1 && reads.slice(0, -1).every((w) => Number.isFinite(w.from) && Number.isFinite(w.until)),
        `later pages read windows by the line-start index, not from the start (${reads.length} reads)`);
    ok(lane.history.done && books.headState('h').sheet === 1, 'the start: history done, sheet 1');
    const seen = [];
    for (let guard = 0; guard < 200; guard++) {
        seen.push(lane.entries[lane.book.head].record);
        if (lane.book.head === lane.entries.length - 1 && !lane.newer.length) break;
        lane.book.scroll(+1);
    }
    eq(seen.map((r) => r.id), all.map((r) => r.id), 'paging forward from the start visits every event once, in order');
    ok(seen.every((r, i) => J(r) === J(all[i])), 'every paged record is the full stream\'s (results paired, nothing pending that landed)');
    // Held: a live add waits in the newer buffer; its update replaces it there.
    lane.book.pageTo(0);
    const liveAdd = { type: 'event', id: 'live-1', op: 'add', seq: 1, at: end, line: 9000, ts: '2026-10-21T00:00:01.000Z',
        turn: { id: 't-live', index: 99 }, kind: 'say', say: { text: 'live while held' } };
    books.applyEvents('h', [{ op: 'add', event: liveAdd, pos: { at: end, line: 9000, seq: 1 } }]);
    ok(lane.newer.at(-1)?.record.id === 'live-1' && lane.book.head === 0, 'a live event while held waits beyond the window');
    books.applyEvents('h', [{ op: 'update', event: { ...liveAdd, op: 'update', say: { text: 'live, confirmed', final: true } }, pos: { at: end, line: 9000, seq: 1 } }]);
    ok(lane.newer.at(-1).record.result === 'live, confirmed' && lane.newer.length === 1, 'its update replaces it in the newer buffer');
    lane.book.pageTo(Infinity);
    ok(lane.entries.at(-1).record.result === 'live, confirmed' && lane.book.following, '`live` slides to it, confirmed');
}

console.log(`agent-events: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
