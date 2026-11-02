// agent-edits.test.mjs — an agent's edit LANDS in an open file without moving your place
// (app/client/AgentEdits.js).
//
//   bun tools/agent-edits.test.mjs
//
// Locks: the anchor-shift rule (lines above the edit keep their index, below shift by the line delta,
// inside stay); a framed grid's top visible row stays the top row across an edit that adds lines
// above it (teeth: without the shift it scrolls); a grid with a caret in it is left alone; an edit to a
// file that isn't open, a non-edit call, and an identical text are no-ops.

import { anchorShift, landAgentEdit } from '../app/client/AgentEdits.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const lines = (n, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n');
const before = lines(50);
const after = before.split('\n').toSpliced(5, 0, 'NEW a', 'NEW b', 'NEW c').join('\n');   // +3 at line 5
ok(anchorShift(before, after, 2) === 0, 'a line above the edit keeps its index');
ok(anchorShift(before, after, 30) === 3, 'a line below the edit shifts by the added lines');
const removed = before.split('\n').toSpliced(10, 4).join('\n');                            // −4 at line 10
ok(anchorShift(before, removed, 40) === -4, 'removing lines above shifts up');
ok(anchorShift(before, removed, 11) === 0, 'a line inside the change stays');

// A framed grid at /p/x.js scrolled to row 20: an edit adds 3 lines at line 5 → it stays on its row.
function grid(text, { frame = 10, scroll = 20, cursor = null } = {}) {
    return {
        content: text, _cursor: cursor, _scroll: scroll, metrics: { lineSpacing: 1.36 },
        getFrameRows: () => frame, getScrollOffset() { return this._scroll; },
        async setScrollOffset(r) { this._scroll = r; return this; },
        async loadText(t) { this.content = t; return this; },
    };
}
const ctxWith = (g) => ({ registry: { get: (id) => (id === '/p/x.js' ? { grid: g } : null) }, cameraController: null });
const rec = (text, extra = {}) => ({ action: 'edit', target: 'x.js', file: { text, start: 1 }, ...extra });

{
    const g = grid(before);
    const r = await landAgentEdit(ctxWith(g), rec(after), '/p');
    ok(g.content === after, 'the edit lands: the open grid shows the file as the call left it');
    ok(r?.shift === 3 && g._scroll === 23, `the top visible line stays on top: scroll 20 → ${g._scroll}`);
}
{
    const g = grid(before, { cursor: { line: 3 } });
    ok(await landAgentEdit(ctxWith(g), rec(after), '/p') === null && g.content === before, 'a grid you are editing is left alone');
}
{
    const g = grid(before);
    ok(await landAgentEdit(ctxWith(g), { ...rec(after), target: 'other.js' }, '/p') === null, 'a file that is not open: no-op');
    ok(await landAgentEdit(ctxWith(g), { ...rec(after), action: 'read' }, '/p') === null, 'a non-edit call: no-op');
    ok(await landAgentEdit(ctxWith(g), rec(before), '/p') === null && g._scroll === 20, 'identical text: no-op');
}

console.log(`${fails ? 'FAIL' : 'ok'} agent-edits: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
