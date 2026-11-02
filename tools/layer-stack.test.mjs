// layer-stack.test.mjs — DEPTH AS TIME, slice 10a step 1: a member's layers (collections/LayerStack.js)
// registered on its own cell grid, from every source (app/client/layerSources.js), with the app's REAL
// font chain:
//
//   bun tools/layer-stack.test.mjs        (GOMUXAI_DIR=<gomuxai checkout> for the agent corpus)
//
// It locks:
//   1. REGISTRATION: a suggest strip over a code grid's lines lays EXACTLY the member's slots for those
//      lines when it proposes the same text (x, y, glyph — f32-equal), and on the member's row pitch +
//      cell grid when it proposes other text; a registered (rise 0) history page row r sits on member row r;
//   2. ORDER: suggest strips in front (z > 0, nearest first), the member at 0, history behind
//      (rank 1 nearest, z = −rank·pitch, raised rank·rise rows); front(id) brings one to z = 0 (registered,
//      its backing in front of the member's glyphs) and front(null) puts it back; the `now` backing sits
//      between the member's own backdrop and the first history page;
//   3. OPAQUE BACKS: every page (and the member's `now` backing) is opaque and covers the member's frame;
//   4. SOURCES: a file's revisions (newest first, leading copies of what's shown skipped, text exact);
//      an agent book's scroll by turn (newest turn first, the document's own rows; registered on the
//      document's frame rows); a terminal's scrollback by screen (oldest line of a page on top).

import * as THREE from 'three';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './headless-canvas.mjs';
import { bootHeadlessFontChain } from './headlessFontChain.mjs';
const { deriveCharSize } = await import('../packages/glyph3d-core/src/core/cellMetrics.js');
const { default: CodeGrid } = await import('../packages/glyph3d-core/src/collections/CodeGrid.js');
const { default: LayerStack, layerFrameOf, textRows } = await import('../packages/glyph3d-core/src/collections/LayerStack.js');
const { terminalPageLayers } = await import('../packages/glyph3d-core/src/collections/terminalDepthHistory.js');
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { AgentEventReader } = await import('../packages/glyph3d-core/src/collections/agentEvents.js');
const { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_GLYPH_ID } = await import('../packages/glyph3d-core/src/core/InstancedSlotBuffer.js');
const { getBandDistance, LAYER_BAND } = await import('../packages/glyph3d-core/src/core/layerBands.js');
const { revisionLayers } = await import('../app/client/layerSources.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);

const { chain } = await bootHeadlessFontChain();
const ATLAS = { getCharSize: () => deriveCharSize(chain, 48), _shaper: chain, _shapeCache: null, _slugData: null, _live: null };
const slotsOf = (field) => {
    const f32 = field.slotBuffer.f32, out = [];
    for (let s = 0; s < field.slotBuffer.count; s++) {
        const b = s * SLOT_FLOATS;
        out.push([f32[b + LANE_POS_X], f32[b + LANE_POS_Y], f32[b + LANE_GLYPH_ID]]);
    }
    return out;
};
const rowsText = (rows) => rows.map((r) => (r.segs || []).map((s) => s.text).join('')).join('\n');

const SOURCE = [
    'export function add(a, b) {',
    '\treturn a + b;   // sum',
    '}',
    '',
    'const table = { "α": 1, "β": 2, "emoji": "🎉" };',
    'for (let i = 0; i < 10; i++) console.log(i * i);',
    '// the end',
].join('\n');

// ── 1 + 2 + 3. a code grid's stack ──────────────────────────────────────────────────────
const scene = new THREE.Scene();
const grid = new CodeGrid(scene, ATLAS, { name: 'probe.js', showFilename: true, showBackground: true });
await grid.loadFile('probe.js', SOURCE);
const { frame, parent } = layerFrameOf(grid);
ok(parent === grid && frame.originY === grid._layoutOriginY && frame.rows === grid.getTotalVisualRows(), `a code grid's frame (${J({ originY: frame.originY, rows: frame.rows, cols: frame.cols })})`);
const m = grid.metrics, ls = m.lineSpacing;
// The member's own slots, by line.
const memberSlots = slotsOf(grid._renderer);
const lineSlots = (ln) => {
    const lines = SOURCE.split('\n');
    let start = 0;
    for (let i = 0; i < ln; i++) start += Array.from(lines[i]).length;
    return memberSlots.slice(start, start + Array.from(lines[ln]).length);
};
{
    const stack = new LayerStack(ATLAS, frame, { riseRows: 0 });
    grid.add(stack);
    const same = textRows(SOURCE.split('\n').slice(4, 6).join('\n'));
    const other = textRows('const table = new Map();\nfor (const [k, v] of table) console.log(k, v);');
    const prev = textRows(SOURCE.replace('// sum', '// the sum of a and b'));
    stack.setLayers([
        { id: 'rev1', kind: 'history', rows: prev.rows },
        { id: 'rev2', kind: 'history', rows: textRows('export function add(a, b) {}').rows },
        { id: 'same', kind: 'suggest', rows: same.rows, row0: 4 },
        { id: 'other', kind: 'suggest', rows: other.rows, row0: 4 },
    ]);
    eq(slotsOf(stack.layer('same').field), [...lineSlots(4), ...lineSlots(5)], 'a suggest strip proposing the same lines lays EXACTLY the member\'s slots (x, y, glyph)');
    ok(stack.layer('same').group.position.y === 0, 'a suggest strip is not raised (registered when flat)');
    {   // teeth: a frame off by a hair registers nothing
        const off = new LayerStack(ATLAS, { ...frame, originY: frame.originY + 1e-3 }, { riseRows: 0 });
        off.setLayers([{ id: 'same', kind: 'suggest', rows: same.rows, row0: 4 }]);
        ok(J(slotsOf(off.layer('same').field)) !== J([...lineSlots(4), ...lineSlots(5)]), 'teeth: a frame 0.001 off does not register');
        off.dispose();
    }
    const ys = new Set(memberSlots.map((s) => s[1]));
    const o = slotsOf(stack.layer('other').field);
    ok(o.length > 0 && o.every((s) => ys.has(s[1]) && Math.abs(s[0] / m.charWidth - Math.round(s[0] / m.charWidth)) < 1e-4)
        && o.every((s) => s[1] === lineSlots(4)[0][1] || s[1] === lineSlots(5)[0][1]),
        'a strip with other text lies on the member\'s rows 4–5 and its cell grid');
    // A registered history page: row r on member row r (riseRows 0).
    const p = slotsOf(stack.layer('rev1').field);
    eq(p.slice(0, lineSlots(0).length), lineSlots(0), 'a registered history page lays row 0 on the member\'s row 0');
    // Every page states its extent: three culls an instanced field by the box it's told (it sees only the
    // base quad), and the far-LOD pass hides a field whose rows measure nothing.
    for (const l of stack.pages) {
        const f = l.field, bs = f.geometry.boundingSphere, rows = l.rows.length;
        ok(f.rowHeight > 0 && bs && bs.radius >= (rows * ls) / 2 - 1e-6, `${l.id}: states its extent (row ${f.rowHeight.toFixed(3)}, sphere r ${bs?.radius.toFixed(2)} for ${rows} rows)`);
    }
    // ORDER.
    const ord = stack.order();
    eq(ord.map((x) => x.id), ['other', 'same', 'now', 'rev1', 'rev2'], 'front to back: strips (nearest first), the member, history (newest first)');
    const bg = getBandDistance(LAYER_BAND.GRID_BACKGROUND), pitch = Math.max(ls, 3 * bg);
    ok(Math.abs(stack.layer('rev1').group.position.z + pitch) < 1e-9 && Math.abs(stack.layer('rev2').group.position.z + 2 * pitch) < 1e-9
        && Math.abs(stack.layer('same').group.position.z - pitch) < 1e-9, 'history at z = −rank·pitch, strips at +k·pitch');
    // The now backing: behind the member's own backdrop (−bg), in front of history page 1's backing (−pitch − bg).
    const nowZ = stack._now.back.position.z;
    ok(nowZ < -bg && nowZ > -pitch, `the member's opaque backing sits between its backdrop and the first history page (${nowZ})`);
    // OPAQUE BACKS covering the member's frame.
    const W = frame.cols * m.charWidth, H = frame.rows * ls;
    for (const l of [...stack.pages.filter((x) => x.kind === 'history'), stack._now]) {
        const b = l.back;
        ok(b.material.opacity === 1 && b.scale.x >= W && b.scale.y >= H, `${l.id ?? 'now'}: opaque, covers the member's frame (${b.material.opacity}, ${b.scale.x.toFixed(2)}×${b.scale.y.toFixed(2)} ≥ ${W.toFixed(2)}×${H.toFixed(2)})`);
    }
    ok(stack.layer('same').back.scale.y < H, 'a strip\'s backing covers only its rows');
    // FRONT: registered at z = 0+, its backing in front of the member's glyphs; back again.
    ok(stack.front('rev2'), 'front(rev2)');
    const r2 = stack.layer('rev2').group.position, rb = stack.layer('rev2').back.position.z;
    ok(r2.x === 0 && r2.y === 0 && r2.z === 0, `a fronted layer stands registered at exactly z = 0 (${r2.x}, ${r2.y}, ${r2.z})`);
    ok(rb > -bg && rb < 0, `its backing sits between the member's backdrop (−bg) and the text plane (${rb})`);
    ok(grid._renderer.instanceMesh.visible === false, "the member's glyphs hide while a page stands in their place");
    ok(!stack.front('nope'), 'front of an unknown layer refuses');
    stack.front(null);
    ok(Math.abs(stack.layer('rev2').group.position.z + 2 * pitch) < 1e-9 && stack.layer('rev2').back.position.z === -bg, 'front(null) returns it to its rank');
    ok(grid._renderer.instanceMesh.visible === true, "and the member's glyphs show again");
    stack.front('rev1'); stack.dispose();
    ok(grid._renderer.instanceMesh.visible === true, "disposing a stack with a fronted page shows the member's glyphs");
    stack.setFrame(frame); stack._now = null; stack._layNow();
    stack.dispose(); grid.remove(stack);
}
{
    // RISE: each history page raised rank rows, so its top row shows over the page in front.
    const stack = new LayerStack(ATLAS, frame, { riseRows: 1 });
    stack.setLayers([1, 2, 3].map((k) => ({ id: `r${k}`, kind: 'history', rows: textRows(SOURCE).rows })));
    ok([1, 2, 3].every((k) => Math.abs(stack.layer(`r${k}`).group.position.y - k * ls) < 1e-9), 'history page k stands k rows up');
    stack.dispose();
}

// ── 4a. a file's revisions ──────────────────────────────────────────────────────────────
{
    const commits = [
        { sha: 'a'.repeat(40), time: Date.UTC(2026, 10, 1), subject: 'now', path: 'x.js', text: SOURCE },
        { sha: 'b'.repeat(40), time: Date.UTC(2026, 9, 30), subject: 'older', path: 'x.js', text: 'one\ntwo' },
        { sha: 'c'.repeat(40), time: Date.UTC(2026, 9, 29), subject: 'big', path: 'x.js', textOmitted: true },
        { sha: 'd'.repeat(40), time: Date.UTC(2026, 9, 28), subject: 'oldest', path: 'w.js', text: 'one' },
    ];
    const r = revisionLayers(commits, SOURCE, { n: 5 });
    eq(r.layers.map((l) => l.sha[0]), ['b', 'd'], 'revisions newest first, the copy of what\'s shown skipped, a textless one skipped');
    eq(r.omitted, 1, 'the textless revision is counted');
    ok(r.layers.every((l) => rowsText(l.rows) === l.text), 'each revision page holds its text exactly');
    ok(r.layers[0].label.startsWith('bbbbbbb 2026-10-30 older'), `a revision's label (${r.layers[0].label})`);
    eq(revisionLayers(commits, 'something else', { n: 1 }).layers.map((l) => l.sha[0]), ['a'], 'n caps; a differing HEAD is layer 1');
    const wrapped = textRows('abcdefghij\nxy', { wrapWidth: 4 });
    eq([wrapped.rows.map((x) => x.segs[0]?.text ?? ''), wrapped.lineStartRow], [['abcd', 'efgh', 'ij', 'xy'], [0, 3]], 'rows wrap as the grid wraps (every wrapWidth codepoints)');
}

// ── 4b. an agent book's scroll by turn ──────────────────────────────────────────────────
{
    const GOMUXAI = process.env.GOMUXAI_DIR || join(homedir(), 'dev/gomuxai');
    const CORPUS = join(GOMUXAI, 'internal/transcript/testdata/corpus');
    if (!existsSync(CORPUS)) { console.error(`layer-stack: FAIL — no event corpus at ${CORPUS}`); process.exit(1); }
    const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.events.jsonl') ? [p] : []); });
    let multi = 0;
    for (const f of walk(CORPUS)) {
        const books = new AgentBooks({ scene: new THREE.Scene(), atlas: ATLAS, registry: null });
        books.cfg.maxSheets = 0;
        const lane = books.ensure('t', 'claude');
        lane.book.setForm('scroll');
        const r = new AgentEventReader();
        books.applyEvents('t', r.push(readFileSync(f, 'utf8')).concat(r.end()), { agentType: 'claude' });
        books.update(0);
        const layers = books.turnLayers('t');
        const turnsSeen = [];
        for (const e of lane.entries) { const k = e.record.turn?.id; if (!turnsSeen.length || turnsSeen.at(-1) !== k || k == null) turnsSeen.push(k); }
        if (layers.length !== turnsSeen.length) { ok(false, `${f}: one layer per turn (${layers.length} vs ${turnsSeen.length})`); continue; }
        // Newest turn first; together the pages are the document's rows, in order.
        const all = layers.slice().reverse().flatMap((l) => l.rows.map((x) => (x.segs || []).map((s) => s.text).join('')));
        const doc = lane.doc.blocks.flatMap((b) => b.rows.map((x) => (x.segs || []).map((s) => s.text).join('')));
        if (J(all) !== J(doc)) { ok(false, `${f}: the turn pages are the document's rows`); continue; }
        if (layers.length > 1) multi++;
        pass++;
    }
    ok(multi > 0, `streams with several turns fan into several pages (${multi})`);
    // Registered on the document's frame: page row j on the frame's row j (the body row at the top + j).
    const books = new AgentBooks({ scene: new THREE.Scene(), atlas: ATLAS, registry: null });
    const lane = books.ensure('reg', 'claude');
    lane.book.setForm('scroll');
    const rd = new AgentEventReader();
    books.applyEvents('reg', rd.push(readFileSync(walk(CORPUS).find((p) => p.includes('derived-turns')), 'utf8')).concat(rd.end()), { agentType: 'claude' });
    books.update(0);
    const doc = lane.doc;
    const lf = layerFrameOf(lane.book);
    ok(lf.parent === doc && lf.frame.originY === doc._bodyY && lf.frame.rows === doc.cfg.rows, 'a scroll book\'s frame is its document\'s body');
    const stack = new LayerStack(ATLAS, lf.frame, { riseRows: 0, clipToFrame: true });
    doc.add(stack);
    const tl = books.turnLayers('reg');
    stack.setLayers(tl);
    const page = stack.layer(tl[0].id);
    const top = doc.rowAt(0);
    doc.scrollBy(-1e6);   // the document's first row on the frame's top row
    const firstY = doc.bodyField.slotBuffer.f32[LANE_POS_Y] + doc.bodyField._groupData[1];
    const pageFirst = stack.layer(tl.at(-1).id);
    ok(Math.abs(pageFirst.field.slotBuffer.f32[LANE_POS_Y] - firstY) < 1e-4, `the oldest turn's page row 0 sits on the document's top frame row (${pageFirst.field.slotBuffer.f32[LANE_POS_Y]} vs ${firstY})`);
    ok(page.field._groupData[4 * 4 + 2] === 1, 'a turn page is clipped to the document\'s frame');
    ok(top !== undefined, 'the document had a top row');
}

// ── 4c. a terminal's scrollback by screen ────────────────────────────────────────────────
{
    const rowOf = (s) => ({ cp: Float32Array.from([...s.padEnd(10, ' ')].map((c) => c.codePointAt(0))), r: new Float32Array(10).fill(0.9), g: new Float32Array(10).fill(0.9), b: new Float32Array(10).fill(0.9) });
    const history = Array.from({ length: 7 }, (_, i) => rowOf(`line ${i}`));   // index 0 = the newest scrolled off
    const pages = terminalPageLayers(history, 3, 5);
    eq(pages.map((p) => p.id), ['page-1', 'page-2', 'page-3'], 'a page per screen of history, newest first');
    eq(rowsText(pages[0].rows).split('\n'), ['line 2', 'line 1', 'line 0'], 'a page reads oldest at the top, as it stood on screen');
    eq(rowsText(pages[2].rows).split('\n'), ['', '', 'line 6'], 'the last page holds what\'s left, at its bottom');
    history[1].r[0] = 0.2;
    eq(terminalPageLayers(history, 3, 1)[0].rows[1].segs.map((s) => s.text), ['l', 'ine 1'], 'a colour change is a new run');
}

// ── 5. the verbs (layerCommands.js) over a fake relay ───────────────────────────────────
{
    const { default: registerLayerCommands } = await import('../app/commands/handlers/layerCommands.js');
    const verbs = new Map();
    registerLayerCommands({ register: (name, fn) => verbs.set(name, fn) });
    const run = (name, ...args) => verbs.get(name)(args, ctx);
    const g2 = new CodeGrid(new THREE.Scene(), ATLAS, { name: 'v.js', showFilename: false });
    await g2.loadFile('v.js', SOURCE);
    g2.setSourcePath('file:///repo/v.js');
    const commits = [
        { sha: '1'.repeat(40), time: 0, subject: 'head', path: 'v.js', text: SOURCE },
        { sha: '2'.repeat(40), time: 0, subject: 'two', path: 'v.js', text: 'two\n' },
        { sha: '3'.repeat(40), time: 0, subject: 'three', path: 'v.js', text: 'three\n' },
    ];
    const asked = [];
    const reg = new Map([['grid:v', { id: 'grid:v', type: 'grid', grid: g2 }]]);
    const ctx = { atlas: ATLAS, registry: { get: (id) => reg.get(id) ?? null },
        fileProvider: { gitLog: async (p) => { asked.push(p); return { root: '/repo', path: 'v.js', commits }; } } };
    const r1 = await run('layer.show', 'grid:v');
    ok(r1.text.startsWith('OK: grid:v — 2 layer(s)') && asked[0]?.uri === 'file:///repo/v.js' && asked[0]?.text === true, `layer.show reads the file's revisions (${r1.text.split('\n')[0]})`);
    const stack = ctx.layerStacks.get('grid:v');
    ok(stack && stack.parent === g2, 'the stack rides the grid');
    const r2 = await run('pane.layer', 'grid:v', '2');
    ok(r2.text.includes('at z = 0') && stack.frontId === stack.pages.find((l) => l.rank === 2).id, 'pane.layer 2 fronts the second revision back');
    await run('pane.layer', 'grid:v', 'now');
    ok(stack.frontId === null, 'pane.layer now is the member again');
    ok((await run('pane.layer', 'grid:v', 'nope')).text.startsWith('ERR'), 'an unknown layer is refused');
    const r3 = run('pane.blink', 'grid:v', 'now', '1');
    ok(r3.text.includes('blinking') && ctx.layerStacks.byId.get('grid:v').blink, 'pane.blink alternates');
    run('pane.blink', 'grid:v', 'off');
    ok(!ctx.layerStacks.byId.get('grid:v').blink, 'pane.blink off stops');
    const r4 = await run('grid.history', 'grid:v', '--at', '1');
    ok(r4.text.includes('2 revision(s)') && r4.data.front === stack.pages.find((l) => l.rank === 1).id, `grid.history --at 1 fronts the newest past revision (${r4.text.split('\n')[0]})`);
    // Durable: serialize → a fresh LayerStacks restores the stack and its front layer once the member stands up.
    await run('pane.layer', 'grid:v', '1');
    const saved = ctx.layerStacks.serialize();
    eq(saved, [{ id: 'grid:v', n: 5, front: stack.pages.find((l) => l.rank === 1).id }], 'serialize: the member, its depth, its front layer');
    const { default: LayerStacks } = await import('../app/client/LayerStacks.js');
    const reg2 = new Map();
    const ctx2 = { ...ctx, registry: { get: (id) => reg2.get(id) ?? null }, layerStacks: null };
    const fresh = new LayerStacks(ctx2);
    const pending = fresh.restore(saved, { waitMs: 2000, everyMs: 20 });
    const g3 = new CodeGrid(new THREE.Scene(), ATLAS, { name: 'v.js', showFilename: false });
    await g3.loadFile('v.js', SOURCE); g3.setSourcePath('file:///repo/v.js');
    setTimeout(() => reg2.set('grid:v', { id: 'grid:v', type: 'grid', grid: g3 }), 60);   // the member stands up later
    eq(await pending, 1, 'restore waits for the member, then stands its stack back up');
    ok(fresh.get('grid:v')?.frontId === saved[0].front && g3._renderer.instanceMesh.visible === false, 'with its saved layer at z = 0');
    eq(await new LayerStacks(ctx2).restore([{ id: 'nobody' }], { waitMs: 60, everyMs: 20 }), 0, 'a member that never comes back is given up (warned)');
    ok(run('layer.hide', 'grid:v').text.startsWith('OK') && !ctx.layerStacks.get('grid:v') && !g2.children.some((c) => c.name === 'layers:grid:v'), 'layer.hide frees it');
    ok((await run('layer.show', 'ghost')).text.startsWith('ERR'), 'a member that isn\'t there is refused');
}

console.log(`layer-stack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
