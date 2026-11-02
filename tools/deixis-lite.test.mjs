// deixis-lite.test.mjs — pointing, lite (docs/planes/DESIGN.md §3.8; app/client/Deixis.js and
// app/commands/handlers/deixisCommands.js), on a REAL CodeGrid and TerminalGrid line model.
//
//   bun tools/deixis-lite.test.mjs
//
// Locks:
//   - a code glyph resolves to `path:line «token»` (1-based, path relative to the served root) and
//     a terminal glyph — live or in the depth history — to `<terminal> line N «text»` by its
//     running line number, which a line keeps as it scrolls
//   - ONE resolver: the one-line text, a Ref's JSON and a log's `file:line:col` all resolve back
//     to the same place
//   - an anonymous point.show fails loud; an identified one fills ITS line in ITS hue (code: the
//     highlight fill; terminal: a row mark painted into the highlight lane), one live point per
//     agent, an agent clears only its own
//   - THE DOESN'T-STEAL GATE (headless half): camera pose and lens, attention slots and the dock
//     stand-in are identical before and after point.show — teeth: the same comparator catches a
//     point that focuses or flies
//   - point.mark hands `this = <ref>` to the CommandBar's draft listener; point.go runs its nested
//     verbs as the same caller

import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import TerminalGrid from '../packages/glyph3d-core/src/collections/TerminalGrid.js';
import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';
import AttentionManager from '../packages/glyph3d-core/src/services/interaction/AttentionManager.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import Deixis, { resolveRef, refAtSlot, refAtCaret, callerHue } from '../app/client/Deixis.js';
import registerDeixisCommands from '../app/commands/handlers/deixisCommands.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

// ── The world: one code file and one terminal, registered.
const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };
const scene = new THREE.Scene();
const ROOT = '/w';
const FILE = `${ROOT}/src/x.js`;
const lines = ['// head', 'const rec = load();', 'if (rec.meta?.patch) apply(rec.meta.patch);', 'export default rec;'];
const code = new CodeGrid(scene, atlas, { showFilename: false });
await code.loadText(lines.join('\n'));

// A terminal stand-in on the REAL TerminalGrid prototype: 6 cols × 3 rows live, 2 lines in the
// depth history, 10 lines scrolled so far (so the live rows are lines 10, 11, 12; history 9, 8).
const term = Object.create(TerminalGrid.prototype);
const COLS = 6, ROWS = 3;
const row = (s) => { const cp = new Float32Array(COLS).fill(32); [...s].forEach((c, i) => { cp[i] = c.codePointAt(0); }); return cp; };
Object.assign(term, {
    cols: COLS, rows: ROWS, _depthMax: 4, _scrolled: 10, _rowMarks: new Map(), _cursor: { x: 2, y: 1 },
    _codepoints: new Float32Array([...row('$ ls'), ...row('a.js'), ...row('$ go')]),
    _history: [{ cp: row('ok 1') }, { cp: row('ok 0') }],
});
let termWrites = 0;
term._writeToInstanceBuffer = () => { termWrites++; };

const registry = new SceneRegistry();
registry.register(FILE, code, { type: 'grid', sourcePath: FILE, filename: 'x.js' });
registry.register('gx-relay', term, { type: 'terminal' });
const ctx = { registry, fileProvider: { rootInfo: { root: ROOT } } };

// ── Refs from glyphs.
{
    const slot = code.getSlotForChar(2, 6);          // 'rec.meta?.patch)' … the token around col 6
    const r = refAtSlot(ctx, { id: FILE, grid: code }, slot);
    eq(r.kind, 'code', 'a code glyph is a code ref');
    eq(r.durable.path, 'src/x.js', 'its path is relative to the served root');
    eq(r.durable.line, 3, 'its line is 1-based');
    eq(r.durable.col, 7, 'its col is 1-based');
    eq(r.quote, '(rec.meta?.patch)', 'the quote is the token under the glyph');
    eq(r.text, 'src/x.js:3 «(rec.meta?.patch)»', 'the one-line form');
    eq(r.entity, FILE, 'the entity is the registry id');

    const live = refAtSlot(ctx, { id: 'gx-relay', grid: term }, 1 * COLS + 2);   // live row 1
    eq(live.kind, 'terminal', 'a terminal glyph is a terminal ref');
    eq(live.durable.line, 11, 'live row 1 is running line scrolled + 1');
    eq(live.quote, 'a.js', 'its quote is the line text');
    eq(live.text, 'gx-relay line 11 «a.js»', 'the terminal one-line form');
    const hist = refAtSlot(ctx, { id: 'gx-relay', grid: term }, COLS * ROWS + 1 * COLS + 3);   // history h=1
    eq(hist.durable.line, 8, 'a depth-history glyph keeps its running number (scrolled − 1 − h)');
    eq(hist.quote, 'ok 0', 'its quote is that history line');
    const caret = refAtCaret(ctx, { id: 'gx-relay', grid: term });
    eq(caret.durable.line, 11, "a terminal's cursor line (primary/key) is its running number");
    ok('error' in refAtSlot(ctx, { id: 'gx-relay', grid: term }, COLS * ROWS + 3 * COLS), 'a slot past what is drawn is an error');
    // The line keeps its number as the screen scrolls: one line scrolls off, line 11 is now row 0.
    term._history.unshift({ cp: row('$ ls') }); term._scrolled = 11;
    term._codepoints = new Float32Array([...row('a.js'), ...row('$ go'), ...row('')]);
    eq(term.lineOfSlot(0).line, 11, 'after a scroll, the same line has the same number');
    eq(resolveRef(ctx, 'gx-relay line 10').quote, '$ ls', 'and a scrolled-off line still resolves from the depth history');
}

// ── ONE resolver: text, JSON and log spellings all land on the same place.
{
    const a = resolveRef(ctx, 'src/x.js:3 «rec.meta?.patch»');
    eq(a.entity, FILE, 'text → the open grid');
    eq(a.quote, 'rec.meta?.patch', 'a said quote is kept as said');
    eq(a.text, 'src/x.js:3 «rec.meta?.patch»', 'text round-trips');
    const b = resolveRef(ctx, JSON.stringify(a));
    eq(b.text, a.text, 'JSON round-trips');
    const c = resolveRef(ctx, '    at main (x.js:2:7)');
    eq(c.entity, FILE, "a stack trace's bare file:line:col resolves by suffix");
    eq(c.durable.line, 2, '… to its line');
    eq(c.quote, 'rec', '… and reads the token at its column');
    const t = resolveRef(ctx, 'gx-relay line 12 «$ go»');
    eq(t.kind, 'terminal', 'terminal text resolves');
    eq(t.durable.line, 12, '… to its running line');
    ok('error' in resolveRef(ctx, 'nothing here'), 'no reference is an error');
    ok('error' in resolveRef(ctx, 'src/missing.js:3'), 'a file that is not open is an error');
    ok('error' in resolveRef(ctx, '{"kind":"code"}'), 'a malformed Ref is an error');
}

// ── The verbs.
const camera = new THREE.PerspectiveCamera(70, 1.5, 1, 20000);
camera.position.set(3, 4, 500);
const am = new AttentionManager();
am.state.primary = 'gx-relay'; am.state.key = 'gx-relay';
const dock = { rects: [{ id: 'gx-relay', x: 10, y: 20, w: 300, h: 200 }] };
const bag = Object.assign(ctx, { camera, attentionManager: am, dock, sender: null, caller: null, cid: 0, execute: null });
bag.deixis = new Deixis(bag);
const router = new CommandRouter(bag);
registerDeixisCommands(router);
const nestedCalls = [];
router.register('attention.set', (args, c) => { nestedCalls.push({ verb: 'attention.set', caller: c.caller }); c.attentionManager.state[args[0]] = args[1]; return 'OK'; });
router.register('camera.focus', (_args, c) => { nestedCalls.push({ verb: 'camera.focus', caller: c.caller }); c.camera.position.set(0, 0, 50); return 'OK'; });

// Spies on what a point draws.
const drawn = [];
const realRange = code.highlightRange.bind(code), realClear = code.clearLineHighlight.bind(code);
code.highlightRange = (sl, sc, el, ec, color, fill) => { drawn.push({ op: 'fill', line: sl, endCol: ec, color, fill }); return realRange(sl, sc, el, ec, color, fill); };
code.clearLineHighlight = (line) => { drawn.push({ op: 'clear', line }); return realClear(line); };

/** Everything a point must NOT move: the camera's pose and lens, attention, the dock. */
const snapshot = () => JSON.stringify({
    cam: [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov, camera.near, camera.far, camera.zoom],
    attention: am.state, dock: dock.rects,
});
const err = console.error, log = console.log;
const quiet = async (f) => { console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.error = err; console.log = log; } };

{
    const anon = await router.execute('point.show src/x.js:3');
    ok(anon.text.startsWith('ERR:') && /identified caller/.test(anon.text), `an anonymous point.show fails loud (${anon.text})`);
    ok(bag.deixis.points.size === 0 && drawn.length === 0, 'and draws nothing');

    const before = snapshot();
    const shown = await router.execute(['point.show', 'src/x.js:3', '«rec.meta?.patch»', '--say', 'this branch is never taken'], { sender: 'ctrl-7', caller: 'agent-a' });
    ok(shown.text.startsWith('OK: agent-a points at src/x.js:3'), `an identified point.show (${shown.text})`);
    eq(snapshot(), before, "THE DOESN'T-STEAL GATE: camera pose + lens, attention and the dock are untouched");
    const fill = drawn.find((d) => d.op === 'fill');
    ok(fill && fill.line === 2 && fill.endCol === lines[2].length, `the point fills line 3 end to end (${JSON.stringify(fill)})`);
    const hue = callerHue(bag, 'agent-a');
    ok(fill && fill.color.r === hue.r && fill.color.g === hue.g && fill.color.b === hue.b, "in the caller's hue");
    ok(fill && fill.fill > 0, 'as a background fill (opacity > 0), not a tint');
    eq(shown.data.say, 'this branch is never taken', 'the say line rides the point');

    // One live point per agent: a second point clears the first line.
    drawn.length = 0;
    await router.execute('point.show src/x.js:1 --kind suggest', { caller: 'agent-a' });
    ok(drawn.some((d) => d.op === 'clear' && d.line === 2) && drawn.some((d) => d.op === 'fill' && d.line === 0), 'a new point replaces the agent\'s last (line 3 cleared, line 1 filled)');
    eq(bag.deixis.points.size, 1, 'one live point per agent');
    eq(bag.deixis.points.get('agent-a').kind, 'suggest', '--kind suggest');

    // A terminal point: a row mark, painted into the highlight lane at that line's slots.
    const tw = termWrites;
    await router.execute('point.show gx-relay line 12', { caller: 'agent-b' });
    const mark = term._rowMarks.get('point:agent-b');
    ok(mark && mark.line === 12 && termWrites > tw, `a terminal point is a row mark on line 12, re-written (${JSON.stringify(mark)})`);
    const hl = new Uint8Array((COLS * ROWS + COLS * 4) * 4);
    term._paintRowMarks(hl);
    const at = (12 - term._scrolled) * COLS;   // line 12 is live row 1 now
    const hb = callerHue(bag, 'agent-b');
    ok(hl[at * 4] === ((hb.r * 255 + 0.5) | 0) && hl[(at + COLS - 1) * 4 + 3] > 0 && hl[(at + COLS) * 4 + 3] === 0, 'the row mark fills exactly that row, in agent-b\'s hue');
    eq(snapshot(), before, "the doesn't-steal gate holds for a terminal point too");

    // Teeth: the same comparator catches a point that moves the person.
    router.register('point.bad', async (_args, c) => { await c.execute(['camera.focus', 'gx-relay']); return 'OK'; });
    const b2 = snapshot();
    await router.execute('point.bad', { caller: 'agent-c' });
    ok(snapshot() !== b2, "teeth: a point that flies the camera fails the doesn't-steal comparator");
    camera.position.set(3, 4, 500);

    // list / clear: an agent clears only its own; the person clears any or all.
    const listed = await router.execute('point.list');
    ok(listed.data.length === 2 && listed.data[0].id === 'agent-b', `point.list, newest first (${listed.text})`);
    const forbid = await router.execute('point.clear agent-b', { caller: 'agent-a' });
    ok(forbid.text.startsWith('ERR:'), 'an agent cannot clear another agent\'s point');
    await router.execute('point.clear', { caller: 'agent-b' });
    ok(!term._rowMarks.has('point:agent-b'), 'an agent clears its own (the row mark goes)');
    await router.execute('point.clear all');
    eq(bag.deixis.points.size, 0, 'the person clears all');

    // point.go: the person's verb — its nested verbs run as the same call.
    await router.execute('point.show src/x.js:2', { caller: 'agent-a' });
    nestedCalls.length = 0;
    const go = await router.execute('point.go agent-a', { sender: 'local', caller: null });
    ok(go.text.startsWith('OK:') && am.state.primary === FILE, `point.go focuses the point's surface (${go.text})`);
    ok(nestedCalls.length === 2 && nestedCalls.every((n) => n.caller === null), 'its nested verbs run as the same (anonymous) caller');
    camera.position.set(3, 4, 500);

    // point.mark → the CommandBar's draft.
    const drafts = [];
    const off = bag.deixis.onDraft((t) => drafts.push(t));
    const m = await router.execute('point.mark gx-relay line 11');
    eq(drafts[0], 'this = gx-relay line 11 «a.js»', 'point.mark hands `this = <ref>` to the CommandBar');
    ok(m.data.told === 1, 'one listener told');
    off();
    const bad = await quiet(() => router.execute('point.show nowhere.js:3', { caller: 'agent-a' }));
    ok(bad.text.startsWith('ERR:'), 'a point at a file that is not open fails loud');
}

console.log(`${fails ? 'FAIL' : 'ok'} deixis-lite: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
