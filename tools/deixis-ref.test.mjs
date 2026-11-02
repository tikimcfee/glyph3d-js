// deixis-ref.test.mjs — pointing, FULL (docs/planes/DESIGN.md §3.8 / slice 9): a point follows its
// words through edits, and agents' points wait while the person types (app/client/Deixis.js), on a
// REAL CodeGrid (its text listener, its loadText and its edit funnel).
//
//   bun tools/deixis-ref.test.mjs
//
// Locks:
//   - re-anchor: lines inserted above → the point moves with its line ('line'); its own line edited
//     but its quote kept → it stays on that line ('near'); its words moved far → found ('far');
//     its line deleted → ORPHAN (unfilled, still listed); the fill always sits on the line it names
//   - an edit through the grid's own edit funnel (editInsert) re-anchors too
//   - resolved-by-edit: a suggest point --with its proposed text resolves when an edit puts that
//     text where it pointed; an unrelated edit above, with that text already nearby, does NOT
//   - TEETH: with re-anchoring off (no text listener) the same edit leaves the point naming the
//     wrong words
//   - the noise gate: three agents point while keys land every 100 ms → nothing drawn; once the
//     keys pause for point.breakpointIdleMs → all three drawn
//   - the verb: point.show --kind suggest --with …, point.list shows each status

import './headless-canvas.mjs';
import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import Deixis, { resolveRef } from '../app/client/Deixis.js';
import registerDeixisCommands from '../app/commands/handlers/deixisCommands.js';
import { getSetting } from '../app/client/settings.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const quiet = async (fn) => { const i = console.info; console.info = () => {}; try { return await fn(); } finally { console.info = i; } };

const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };
const ROOT = '/w';
const FILE = `${ROOT}/src/x.js`;
const BASE = ['// head', 'const rec = load();', 'if (rec.meta?.patch) apply(rec.meta.patch);', 'export default rec;'];

/** A world: one open code file, a spy on the fill, a Deixis over it. */
async function world() {
    const scene = new THREE.Scene();
    const code = new CodeGrid(scene, atlas, { showFilename: false });
    await code.loadText(BASE.join('\n'));
    const filled = new Map();   // line0 → opacity (what the fill shows now)
    const hl = code.highlightRange.bind(code), clr = code.clearLineHighlight.bind(code);
    code.highlightRange = (l0, c0, l1, c1, color, op) => { filled.set(l0, op); return hl(l0, c0, l1, c1, color, op); };
    code.clearLineHighlight = (l0) => { filled.delete(l0); return clr(l0); };
    const registry = new SceneRegistry();
    registry.register(FILE, code, { type: 'grid', sourcePath: FILE, filename: 'x.js' });
    const ctx = { registry, fileProvider: { rootInfo: { root: ROOT } }, sender: null, caller: null, cid: 0, execute: null };
    ctx.deixis = new Deixis(ctx);
    return { code, filled, ctx, d: ctx.deixis };
}
const point = (w, who, text, opts = {}) => {
    const r = resolveRef(w.ctx, text, who);
    if ('error' in r) throw new Error(r.error);
    return w.d.show(who, r, { fill: 0.3, now: -1e9, ...opts });   // long after any key: drawn at once
};
const load = (w, lines) => quiet(() => w.code.loadText(lines.join('\n')));

// ── re-anchoring ──
{
    const w = await world();
    const p = point(w, 'agent-a', 'src/x.js:3 «rec.meta?.patch»');
    eq([...w.filled.keys()], [2], 'the point fills its line');
    await load(w, ['// new 1', '// new 2', '// new 3', ...BASE]);
    eq([p.ref.durable.line, p.moved, p.status], [6, 'line', 'shown'], 'three lines inserted above: it moves with its line');
    eq([...w.filled.keys()], [5], '… and the fill moved with it (only there)');
    eq(p.ref.text, 'src/x.js:6 «rec.meta?.patch»', '… and its text names the new line');
    // its own line edited, the quote kept
    const L = ['// new 1', '// new 2', '// new 3', '// head', 'const rec = load();', 'if (rec.meta?.patch && ok) apply(rec.meta.patch);', 'export default rec;'];
    await load(w, L);
    eq([p.ref.durable.line, p.moved], [6, 'near'], 'its own line edited, its quote kept: it stays, found by the quote');
    // its words move far (past the window)
    const far = [...Array(200).fill('// pad'), 'if (rec.meta?.patch && ok) apply(rec.meta.patch);'];
    await load(w, far);
    eq([p.ref.durable.line, p.moved], [201, 'line'], 'its line moved 195 lines away: found by its text, wherever');
    await load(w, [...Array(200).fill('// pad'), 'const x = rec.meta?.patch;']);
    eq([p.ref.durable.line, p.moved], [201, 'near'], 'line rewritten around the quote: near');
    await load(w, ['rec.meta?.patch', ...Array(200).fill('// pad')]);
    eq([p.ref.durable.line, p.moved], [1, 'far'], 'the quote now 200 lines off: found anywhere (far)');
    // deleted
    await load(w, ['// nothing', '// here']);
    eq([p.status, w.filled.size], ['orphan', 0], 'its words gone: an ORPHAN, its fill gone');
    ok(w.d.list().some((x) => x.id === 'agent-a' && x.status === 'orphan'), 'an orphan stays listed');
}

// ── the edit funnel (the person typing in the grid) re-anchors too ──
{
    const w = await world();
    const p = point(w, 'agent-a', 'src/x.js:3 «rec.meta?.patch»');
    w.code.enterEdit();
    w.code.setCursor(0, 0);
    await quiet(async () => { w.code.editSplitLine(); });
    for (let i = 0; i < 20 && p.ref.durable.line === 3; i++) await new Promise((r) => setTimeout(r, 5));
    eq(p.ref.durable.line, 4, 'a line split above through editSplitLine: the point moves down one');
}

// ── resolved-by-edit ──
{
    const w = await world();
    const p = point(w, 'agent-s', 'src/x.js:2 «load()»', { kind: 'suggest', replace: 'const rec = await load();' });
    await load(w, ['// head', 'const rec = await load();', 'if (rec.meta?.patch) apply(rec.meta.patch);', 'export default rec;']);
    eq([p.status, p.ref.durable.line], ['resolved', 2], 'the edit made the suggestion: resolved, at its line');
    eq(w.filled.size, 0, 'a resolved point is unfilled');

    // an unrelated edit above, the proposed text already present nearby: NOT resolved
    const w2 = await world();
    await load(w2, ['// head', 'const rec = load();', '// const rec = await load();  (an old note)', 'export default rec;']);
    const q = point(w2, 'agent-s', 'src/x.js:2 «load()»', { kind: 'suggest', replace: 'const rec = await load();' });
    await load(w2, ['// inserted', '// head', 'const rec = load();', '// const rec = await load();  (an old note)', 'export default rec;']);
    eq([q.status, q.ref.durable.line, q.moved], ['shown', 3, 'line'], 'an unrelated edit shifts it; the proposed text already nearby does not resolve it');
    let threw = null;
    try { w2.d.show('agent-x', q.ref, { fill: 0.3, replace: 'x' }); } catch (e) { threw = e.message; }
    ok(!!threw, '--with on a look point is refused');
}

// ── TEETH: without the text listener the point names the wrong words ──
{
    const w = await world();
    const p = point(w, 'agent-a', 'src/x.js:3 «rec.meta?.patch»');
    for (const off of w.d._watch.values()) off();   // re-anchoring off
    w.d._watch.clear();
    await load(w, ['// new 1', '// new 2', '// new 3', ...BASE]);
    ok(p.ref.durable.line === 3 && !w.code.lines[2].includes('rec.meta?.patch'), 'teeth: un-anchored, the point still says line 3, which no longer holds its words');
}

// ── the noise gate ──
{
    const w = await world();
    const idle = Number(getSetting('point.breakpointIdleMs'));
    ok(idle > 200, `point.breakpointIdleMs is born above a keystroke gap (${idle})`);
    let t = 1000;
    w.d.noteKey(t);
    const pts = ['agent-a', 'agent-b', 'agent-c'].map((who, i) => point(w, who, `src/x.js:${i + 1}`, { now: t + 10 + i }));
    for (let k = 0; k < 10; k++) { t += 100; w.d.noteKey(t); w.d.flush(t); }
    eq([pts.map((p) => p.status), w.filled.size], [['held', 'held', 'held'], 0], 'three agents point while keys land every 100 ms: nothing drawn');
    clearTimeout(w.d._flushTimer);
    const n = await quiet(() => w.d.flush(t + idle + 1));
    eq([n, pts.map((p) => p.status), w.filled.size], [3, ['shown', 'shown', 'shown'], 3], 'the keys pause for the idle: all three drawn');
    clearTimeout(w.d._flushTimer);
}

// ── the verbs ──
{
    const w = await world();
    const router = new CommandRouter(w.ctx);
    registerDeixisCommands(router);
    const r = await quiet(() => router.execute(['point.show', 'src/x.js:2', '--kind', 'suggest', '--with', 'const rec = await load();'], { caller: 'agent-v' }));
    ok(r.text.startsWith('OK') && r.data.replace === 'const rec = await load();', `point.show --with (${r.text})`);
    const bad = await quiet(() => router.execute(['point.show', 'src/x.js:2', '--with', 'x'], { caller: 'agent-v' }));
    ok(bad.text.startsWith('ERR'), `--with without --kind suggest fails loud (${bad.text})`);
    await load(w, ['// head', 'const rec = await load();', 'x', 'y']);
    const list = await router.execute(['point.list']);
    ok(/agent-v \[suggest · resolved\] src\/x\.js:2/.test(list.text), `point.list shows the status (${list.text})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} deixis-ref: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
