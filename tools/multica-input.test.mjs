// multica-input.test.mjs — behavior lock for the controller input and the board layout.
//
//   bun tools/multica-input.test.mjs
//
// Two primitives, both headless. AgentPrompt is the canvas-side input field: submit
// semantics, history recall, and the guards that stop a held Enter from fanning out
// duplicate messages to an agent. boardLayout is the roster scheme: stable column
// order, no dropped books, empty columns taking no space.
//
// AgentPrompt is exercised against a CodeGrid stub — the real one needs a WebGPU
// device and an atlas, and none of the behavior under test is about glyphs.

import boardLayout from '../packages/glyph3d-core/src/collections/layouts/boardLayout.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// ── AgentPrompt over a CodeGrid stub ─────────────────────────────────────────
// Stub the module the class imports, so the class under test is the real one.
const { default: AgentPrompt } = await import('../packages/glyph3d-core/src/collections/AgentPrompt.js');

/** Minimal CodeGrid stand-in implementing exactly the surface AgentPrompt uses. */
class GridStub {
    constructor() { this.lines = ['']; this.position = { set(){} }; this.edits = 0; }
    async loadFile(_name, body) { this.lines = String(body).split('\n'); }
    enterEdit() { this.entered = true; }
    exitEdit() { this.entered = false; }
    editEnd() {}
    editInsert(ch) { this.edits++; this.lines[this.lines.length - 1] += ch; }
    editDeleteBackward() { const l = this.lines.length - 1; this.lines[l] = this.lines[l].slice(0, -1); }
    editDeleteForward() {}
    editMoveCursor() {}
    editHome() {}
    editSplitLine() { this.lines.push(''); }
    dispose() { this.disposed = true; }
}

/** Build a prompt over the stub via the injection seam. */
function makePrompt(onSubmit) {
    return new AgentPrompt(
        { scene: {}, atlas: {} },
        { id: 'p1', agentId: 'a1', label: 'Cartographer', onSubmit, createGrid: () => new GridStub() },
    );
}

// typing accumulates, submit sends the trimmed text and clears
{
    const sent = [];
    const p = makePrompt(async (t) => { sent.push(t); });
    for (const ch of 'hello there') p.insert(ch);
    ok(p.text === 'hello there', `buffer accumulates (got "${p.text}")`);

    const did = await p.submit();
    ok(did === true && sent[0] === 'hello there', 'submit hands the text to onSubmit');
    ok(p.text === '', 'buffer clears after a send');
}

// empty / whitespace-only submits are not sent
{
    const sent = [];
    const p = makePrompt(async (t) => { sent.push(t); });
    ok(await p.submit() === false, 'an empty buffer does not send');
    for (const ch of '   ') p.insert(ch);
    ok(await p.submit() === false, 'a whitespace-only buffer does not send');
    ok(sent.length === 0, 'nothing reached the transport');
}

// a held Enter must not fan out duplicates while a send is in flight
{
    let inFlight = 0, peak = 0;
    const p = makePrompt(async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
    });
    for (const ch of 'ping') p.insert(ch);
    const results = await Promise.all([p.submit(), p.submit(), p.submit()]);
    ok(peak === 1, `only one send in flight at a time (peak ${peak})`);
    ok(results.filter(Boolean).length === 1, 'exactly one of three concurrent submits sent');
}

// a failing send must not wedge the field
{
    let calls = 0;
    const p = makePrompt(async () => { calls++; if (calls === 1) throw new Error('network down'); });
    for (const ch of 'first') p.insert(ch);
    await p.submit().catch(() => {});
    ok(p.sending === false, 'the in-flight guard clears even when onSubmit throws');
    for (const ch of 'second') p.insert(ch);
    ok(await p.submit() === true, 'the field still sends after a failed send');
}

// history recall walks back and returns to the fresh line
{
    const p = makePrompt(async () => {});
    for (const ch of 'one') p.insert(ch);
    await p.submit();
    for (const ch of 'two') p.insert(ch);
    await p.submit();
    ok(p.history.length === 2, 'submissions are recorded');

    await p.recall(-1);
    ok(p.text === 'two', `up recalls the newest (got "${p.text}")`);
    await p.recall(-1);
    ok(p.text === 'one', `up again recalls the older (got "${p.text}")`);
    await p.recall(1);
    ok(p.text === 'two', 'down walks forward');
    await p.recall(1);
    ok(p.text === '', 'walking past the newest returns to an empty line');
}

// ── boardLayout ──────────────────────────────────────────────────────────────
/** A book stand-in: layoutBounds is the measured contract leafBox prefers. */
const book = (name, state, w = 100, h = 200) => ({
    name,
    visible: true,
    userData: { name, state },
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    layoutBounds: () => ({
        isEmpty: () => false,
        getSize: (v) => { v.x = w; v.y = h; v.z = 0; return v; },
    }),
});

{
    const root = { children: [book('c', 'idle'), book('a', 'active'), book('b', 'active')] };
    const { columns } = boardLayout(root, { columnGap: 50, rowGap: 10 });
    ok(columns.length === 2, `two occupied columns (got ${columns.length})`);
    ok(columns[0].key === 'active' && columns[0].count === 2, 'active column comes first and holds two');
    ok(columns[1].key === 'idle', 'idle follows active — declared order, not insertion order');

    const [c, a, b] = root.children;
    ok(a.position.x === b.position.x, 'books in one column share an x');
    ok(a.position.x !== c.position.x, 'a different state means a different column');
    ok(a.position.y > b.position.y, 'sorted by name, descending down the column');
}
{
    // an unknown state must not vanish — an invisible agent is worse than a misplaced one
    const root = { children: [book('x', 'weird'), book('y', 'active')] };
    const { columns } = boardLayout(root);
    ok(columns.some(c => c.key === 'other' && c.count === 1), 'an unlisted state lands in overflow');
}
{
    // empty columns must not leave a gap
    const root = { children: [book('a', 'active'), book('d', 'done')] };
    const { columns } = boardLayout(root, { columnGap: 40 });
    ok(columns.length === 2 && columns[0].key === 'active' && columns[1].key === 'done',
        'stalled/idle being empty does not reserve space');
}
{
    const { columns } = boardLayout({ children: [] });
    ok(columns.length === 0, 'an empty shelf lays out to nothing');
}
{
    // grouping is data: a binding can supply its own axis
    const withGroup = (name, group) => ({
        ...book(name, 'idle'),
        userData: { name, meta: { group } },
    });
    const root = { children: [withGroup('a', 's1'), withGroup('b', 's2')] };
    const { columns } = boardLayout(root, { groupBy: 'meta.group', columns: ['s1', 's2'] });
    ok(columns.length === 2 && columns[0].key === 's1', 'groupBy walks a dotted userData path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
