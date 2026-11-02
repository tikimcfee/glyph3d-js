// team-channel.test.mjs — a team's CHANNEL (client/TeamChannels.js): every message that crossed between a
// team's agents and the person, one scroll document pinned at the team's desk, from gomuxai's corpus
// through AgentEventReader and the real AgentBooks, cells by the app's real font chain:
//
//   bun tools/team-channel.test.mjs        (GOMUXAI_DIR=<gomuxai checkout>, default ~/dev/gomuxai)
//
// Locks: one block per message prompt (peer / delivered / human / queued) across the members' books, the
// header `from → to · HH:MM:SS` (from = the [from NAME@HOST] prefix, the person for a typed prompt, the
// parent for a subagent's task), the body == the record's text (rejoined from its wrapped rows; nothing
// dropped), no row wider than the channel; merged chronologically; a live message later than the last
// TAIL-APPENDS (only its rows laid out); one out of order re-lays with the view held; a held view survives a
// rebuild (serialize → restore); registered channel:<team> and seated at gomux/<team>.

import * as THREE from 'three';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './headless-canvas.mjs';
import { bootHeadlessFontChain } from './headlessFontChain.mjs';
globalThis.window ??= { addEventListener() {} };
const { deriveCharSize } = await import('../packages/glyph3d-core/src/core/cellMetrics.js');
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { AgentEventReader } = await import('../packages/glyph3d-core/src/collections/agentEvents.js');
const { rowCells } = await import('../packages/glyph3d-core/src/collections/ScrollDocument.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { buildCarrel } = await import('../app/commands/handlers/carrelCommands.js');
const { default: TeamChannels, senderOf, channelId, PERSON } = await import('../app/client/TeamChannels.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);
const quiet = (fn) => { const i = console.info; console.info = () => {}; try { return fn(); } finally { console.info = i; } };

const GOMUXAI = process.env.GOMUXAI_DIR || join(homedir(), 'dev/gomuxai');
const CORPUS = join(GOMUXAI, 'internal/transcript/testdata/corpus');
if (!existsSync(CORPUS)) { console.error(`team-channel: FAIL — no event corpus at ${CORPUS}`); process.exit(1); }
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.events.jsonl') ? [p] : []); });
const CASE = (name) => readFileSync(walk(CORPUS).find((p) => p.endsWith(`${name}.events.jsonl`)), 'utf8');

const { chain } = await bootHeadlessFontChain();
const ATLAS = { getCharSize: () => deriveCharSize(chain, 48), _shaper: chain, _shapeCache: null, _slugData: null, _live: null };

/** A team: lead (claude/basic-turn — a human prompt), helpers fed the subagent, queued and held-delivery streams. */
function world() {
    const registry = new SceneRegistry();
    const ctx = { scene: new THREE.Scene(), atlas: ATLAS, registry, workspace: new WorkspaceModel(), carrels: new Map(), camera: null, world: null,
        cameraDock: null, deltaBooks: null, getSurfaces: () => [], getGrids: () => [] };
    ctx.holding = new Holding(ctx);
    ctx.agentBooks = new AgentBooks(ctx);
    ctx.agentBooks.cfg.maxSheets = 0;
    ctx.gomuxHub = { nodes: new Map([['lead', { name: 'lead', parent: null }], ['sub', { name: 'sub', parent: 'lead' }],
        ['queued', { name: 'queued', parent: 'lead' }], ['held', { name: 'held', parent: 'lead' }], ['other', { name: 'other', parent: null }]]) };
    const feed = (lane, name) => { const r = new AgentEventReader(); ctx.agentBooks.applyEvents(lane, r.push(CASE(name)).concat(r.end()), { agentType: 'claude' }); };
    feed('lead', 'claude/basic-turn');
    feed('sub', 'subagents/agent-a3f9c2e17b4d5e608');
    feed('queued', 'claude/mid-turn-queued');
    feed('held', 'claude/held-delivery');
    feed('other', 'claude/notification-and-commands');   // not in the team
    quiet(() => buildCarrel(ctx, 'gomux/lead', { form: { mode: 'plane' } }));
    return ctx;
}

const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
const rejoin = (b) => {
    const lines = [];
    for (const r of b.rows) {
        if (r.src.part !== 'body') continue;
        const t = r.segs.map((s) => s.text).join('');
        if (r.src.cont) lines[lines.length - 1] += t; else lines.push(t);
    }
    return lines.join('\n');
};

// ── senders ───────────────────────────────────────────────────────────────────────────────────
eq([senderOf({ origin: 'delivered', result: 'A message arrived while you were working:\n\n[from lead@hub] Skip it' }, 'x'),
    senderOf({ origin: 'human', result: 'hello' }, 'x'), senderOf({ origin: 'peer', result: 'do the task' }, 'boss'),
    senderOf({ origin: 'human', result: '[from a person on box] hi' }, 'x'), senderOf({ origin: 'peer', result: '[from w2@h] done' }, 'boss')],
    ['lead', PERSON, 'boss', PERSON, 'w2'], 'the sender: [from NAME@HOST], the person, a subagent\'s parent');
eq(senderOf({ origin: 'human', result: '\n\n<pasted_content id="8798">\n[from lead@host-a] [CF] next task' }, 'x'), 'lead',
    'a [from NAME@HOST] line inside a paste wrapper still names the sender');

// ── 1 + 2. the channel over the corpus ────────────────────────────────────────────────────────
const ctx = world();
const tc = new TeamChannels(ctx);
eq(tc.members('lead'), ['lead', 'sub', 'queued', 'held'], 'the team: its agent and the agents under it (not another team\'s)');
const doc = quiet(() => tc.show('lead'));
const msgs = tc.messages('lead');
const kinds = new Set(msgs.map((m) => m.origin));
ok(msgs.length >= 4 && ['human', 'peer', 'delivered', 'queued'].every((o) => kinds.has(o)), `messages of every origin (${msgs.length}: ${[...kinds].join(', ')})`);
ok(!msgs.some((m) => m.to === 'other'), "another team's book contributes nothing");
eq(doc.blocks.length, msgs.length, 'one block per message');
ok(msgs.every((m, i) => i === 0 || msgs[i - 1].ts <= m.ts), 'merged chronologically');
let textOk = true, wide = 0;
doc.blocks.forEach((b, i) => {
    const m = msgs[i];
    const head = b.rows[0].segs.map((s) => s.text).join('');
    if (!head.startsWith(`${m.from} → ${m.to} · `) || rejoin(b) !== norm(m.text)) { textOk = false; console.error(`    ${J(head)} / ${J(rejoin(b).slice(0, 60))}`); }
    for (const r of b.rows) if ((r.indent || 0) + rowCells(r.segs.map((s) => s.text).join(''), doc.cellsOf) > doc.cfg.cols) wide++;
});
ok(textOk, 'each block: `from → to · time`, then the message text exactly');
ok(wide === 0, `no row wider than the channel (${wide})`);
const held = msgs.find((m) => m.to === 'held' && m.origin === 'delivered');
ok(held?.from === 'lead', `a held delivery is from its [from NAME@HOST] sender (${held?.from})`);
ok(msgs.find((m) => m.to === 'sub')?.from === 'lead', "a subagent's task is from its parent");
ok(ctx.registry.get(channelId('lead'))?.grid === doc && ctx.holding.holderOf(channelId('lead'))?.carrelName === 'gomux/lead', 'registered channel:lead, seated at gomux/lead');

// ── 3. live: a later message tail-appends; an earlier one re-lays, the view held ───────────────
{
    const before = { ...doc.stats }, n = doc.blocks.length;
    const lastSlot = doc.bodyField.slotBuffer.count;
    const ev = (id, ts, text) => ({ type: 'event', id, op: 'add', seq: 9000, at: 900000 + id.length, ts, kind: 'prompt', turn: { id: 't-live', index: 9 },
        prompt: { text, origin: 'delivered' } });
    const r = new AgentEventReader();
    const line = (e) => J(e) + '\n';
    ctx.agentBooks.applyEvents('held', r.push(line(ev('live-1', '2030-01-01T00:00:00Z', '[from lead@hub] a live message, appended'))), { agentType: 'claude' });
    ok(doc.blocks.length === n + 1 && doc.blocks.at(-1).id === 'held:live-1', 'a live message joins at the end');
    ok(doc.stats.fullPasses === before.fullPasses && doc.stats.laidRows - before.laidRows === doc.blocks.at(-1).rows.length,
        `TAIL-APPENDED: only its ${doc.blocks.at(-1).rows.length} rows laid out (laid ${doc.stats.laidRows - before.laidRows}, full passes ${doc.stats.fullPasses - before.fullPasses})`);
    ok(doc.bodyField.slotBuffer.count > lastSlot, 'its glyphs added after the rest');
    doc.setFrame({ rows: 6 });   // shorter than the channel, so scrolling up holds
    doc.flush();
    doc.scrollBy(-10);
    ok(!doc.following, 'scrolled up, the channel holds');
    const top = doc.visibleText()[0];
    ctx.agentBooks.applyEvents('held', r.push(line(ev('early-1', '2000-01-01T00:00:00Z', '[from sub@hub] an old message, arriving late'))), { agentType: 'claude' });
    ok(doc.blocks[0].id === 'held:early-1' && doc.stats.fullPasses === before.fullPasses + 1, 'an out-of-order message re-lays the channel in time order');
    eq(doc.visibleText()[0], top, 'and the held view stays on what it showed');
}

// ── 4. a held view survives a rebuild ─────────────────────────────────────────────────────────
{
    doc.scrollBy(-3);
    const want = doc.visibleText();
    const saved = tc.serialize();
    ok(saved.length === 1 && saved[0].team === 'lead' && saved[0].view.following === false, `serialize: the channel and its held view (${J(saved[0]?.view)})`);
    quiet(() => tc.hide('lead'));
    ok(!ctx.registry.get(channelId('lead')) && !ctx.holding.holderOf(channelId('lead')), 'hide: unregistered, off its desk');
    const tc2 = new TeamChannels(ctx);
    const show = tc2.show.bind(tc2);
    tc2.show = (team) => { const d = show(team); d?.setFrame({ rows: 6 }); d?.flush(); return d; };   // the same frame as saved
    const n = await quiet(() => tc2.restore(saved, { waitMs: 500, everyMs: 20 }));
    ok(n === 1 && tc2.byTeam.get('lead')?.doc.following === false, 'restore stands it back up, held');
    eq(tc2.byTeam.get('lead').doc.visibleText(), want, 'on the same rows');
    ok(ctx.holding.holderOf(channelId('lead'))?.carrelName === 'gomux/lead', 'at its desk again');
}

// ── 5. hues are an identity's, not an opening order's (a reload reshuffles the order) ────────────
{
    const { callerHue } = await import('../app/client/Deixis.js');
    const mk = (order) => {
        const c = { scene: new THREE.Scene(), atlas: ATLAS, registry: new SceneRegistry() };
        c.agentBooks = new AgentBooks(c);
        for (const id of order) c.agentBooks.ensure(id, 'claude');
        return c;
    };
    const names = ['lead', 'sub', 'queued', 'held', 'other', 'x-7'];
    const a = mk(names), b = mk([...names].reverse());
    ok(names.every((n) => J(callerHue(a, n)) === J(callerHue(b, n))), 'a sender\'s hue is the same whatever order the books opened in');
    ok(names.every((n) => a.agentBooks.lanes.get(n).hueIdx === b.agentBooks.lanes.get(n).hueIdx), "a lane's palette slot is its id's (hash), one rule");
}

console.log(`team-channel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
