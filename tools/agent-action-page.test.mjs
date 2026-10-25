// agent-action-page.test.mjs — behavior lock for how an agent sheet RENDERS its action:
// the verso headline composed at world size (never shrunk by long content) and the recto
// file snapshot framed to the touched range.
//
//   bun tools/agent-action-page.test.mjs
//
// Locks:
//   - actionCall: the headline line (target / the call's first non-empty line / a say's
//     opening line) vs the rest of the call (nothing dropped)
//   - fitTextBlock: holds maxLh while the wrapped text fits, steps down only past the
//     budget, floors at minLh
//   - wrapText: rows ≤ cols, every character kept
//   - snapshotWindow: touched runs ± context, capped, slid inside the file; null when the
//     file fits or windowing is off; a rangeless action frames the top
//   - the VERSO is an ActionPage stating exactly the page rect → Book's fit is 1, so the
//     headline's world line height IS cfg.callLineHeight — the same for a one-word call
//     and a long multi-line command (whose remaining lines ride a body card, wrapped)
//   - the RECTO of a partial read loads just its window, lights the touched lines at
//     their window rows, and names the window in the verso's info rows
//   - cfg changes re-size live headlines (applyScales)
//
// Headless: the shaper-less atlas stub (real positions, no ink).

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };

const { default: AgentBooks, actionCall, snapshotWindow, wrapText } =
    await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { fitTextBlock } = await import('../packages/glyph3d-core/src/collections/ActionPage.js');
const { computeCellMetrics } = await import('../packages/glyph3d-core/src/core/cellMetrics.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── actionCall ──
{
    const t = actionCall({ action: 'edit', target: 'src/a.js', detail: 'replace_all' });
    ok(t.verb === 'edit' && t.head === 'src/a.js' && t.rest === 'replace_all', 'a target action heads with its path; detail is the rest');
    const b = actionCall({ action: 'bash', detail: '\n  cd x && make\n  ./run --flag\n' });
    ok(b.head === '  cd x && make' && b.rest === '  ./run --flag', `a command heads with its first non-empty line (got ${JSON.stringify(b)})`);
    const s = actionCall({ action: 'say', result: '\n\nFirst line here.\nSecond.' });
    ok(s.head === 'First line here.' && s.rest === '', 'a say heads with its opening line (its prose is the recto)');
    ok(actionCall({ action: 'bash' }).head === '', 'an empty call heads with nothing');
}

// ── fitTextBlock ──
{
    const o = { innerW: 288, availH: 170, maxLh: 18, minLh: 8, advPerLh: 0.5 };
    const one = fitTextBlock('rg -n foo', { ...o, extraRows: 1 });
    ok(one.lh === 18 && one.rows === 2, `a short call holds maxLh (got ${JSON.stringify(one)})`);
    ok(one.cols === Math.floor(288 / (0.5 * 18)), 'cols = the page width in cells at that line height');
    const long = fitTextBlock('x'.repeat(2000), { ...o, extraRows: 1 });
    ok(long.lh === 8, `a call too long for the budget floors at minLh (got ${long.lh})`);
    const mid = fitTextBlock('y'.repeat(400), { ...o, extraRows: 1 });
    ok(mid.lh < 18 && mid.lh >= 8 && mid.rows * mid.lh <= 170, `a medium call steps down just enough to fit (got ${JSON.stringify(mid)})`);
    let threw = false;
    try { fitTextBlock('a', { ...o, advPerLh: 0 }); } catch { threw = true; }
    ok(threw, 'a missing cell metric fails loud');
}

// ── wrapText ──
{
    const src = 'alpha beta gamma delta epsilon zetazetazetazetazeta eta';
    const w = wrapText(src, 12);
    ok(w.split('\n').every((r) => [...r].length <= 12), 'rows fit the column count');
    ok(w.replace(/\s+/g, '') === src.replace(/\s+/g, ''), 'every character kept');
    ok(w.split('\n')[0] === 'alpha beta', `breaks at whitespace when it can (got ${JSON.stringify(w.split('\n')[0])})`);
}

// ── snapshotWindow ──
{
    const o = { context: 8, maxRows: 60 };
    ok(snapshotWindow({ range: [10, 20] }, 50, o) === null, 'a file that fits shows whole');
    ok(snapshotWindow({ range: [300, 320] }, 600, { ...o, maxRows: 0 }) === null, 'maxRows 0 turns windowing off');
    const r = snapshotWindow({ range: [300, 320] }, 600, o);
    ok(r.first === 291 && r.last === 327, `a partial read: the slice ± context (got ${JSON.stringify(r)})`);
    const e = snapshotWindow({ ranges: [[100, 102], [110, 111]] }, 600, o);
    ok(e.first === 91 && e.last === 118, `an edit: the runs' span ± context (got ${JSON.stringify(e)})`);
    const big = snapshotWindow({ range: [100, 900] }, 1000, o);
    ok(big.first === 91 && big.last === 150, `a span taller than the window anchors on its start (got ${JSON.stringify(big)})`);
    const top = snapshotWindow({ range: [1, 3] }, 600, o);
    ok(top.first === 0 && top.last === 18, `slid inside the top, window height kept (got ${JSON.stringify(top)})`);
    const end = snapshotWindow({ range: [598, 600] }, 600, o);
    ok(end.last === 599 && end.first === 581, `slid inside the end, window height kept (got ${JSON.stringify(end)})`);
    const whole = snapshotWindow({ lines: 600 }, 600, o);
    ok(whole.first === 0 && whole.last === 59, `a rangeless action frames the top (got ${JSON.stringify(whole)})`);
}

// ── the verso: an ActionPage at world size ──
const file = Array.from({ length: 600 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
const ctx = {
    scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null,
    fileProvider: { getFile: async () => file },
};
const books = new AgentBooks(ctx);
const cfg = books.cfg;
const ls = computeCellMetrics(HEADLESS_ATLAS.getCharSize(), 0.025).lineSpacing;
const worldLh = (card) => card.scale.y * ls;   // a card's world row pitch (its gridScale × the cell)
{
    const longCmd = [
        'cd /home/someone/dev/project && GLYPH_FLAG=1 bun tools/some-long-running-check.mjs --with many --flags here --and-more-flags-still --until the line is far wider than any page could hold',
        ...Array.from({ length: 12 }, (_, i) => `  && echo step ${i} of a heredoc-ish command that keeps going`),
    ].join('\n');
    await books.hydrate('a1', [
        { action: 'bash', target: '', detail: 'ls', result: 'a\nb\n', meta: { lines: 2 } },
        { action: 'bash', target: '', detail: longCmd, result: 'ok\n', meta: { lines: 1 } },
        { action: 'read', target: 'src/big.js', detail: '', result: '', meta: { lines: 21, range: [300, 320] } },
    ], {});
    await tick(60);
    const lane = books.lanes.get('a1');
    const [short, long, read] = lane.entries;
    ok(short.verso.userData.isActionPage && long.verso.userData.isActionPage, 'every verso is an ActionPage');
    ok(near(worldLh(short.action), cfg.callLineHeight), `a short call's headline rides callLineHeight (got ${worldLh(short.action).toFixed(3)})`);
    ok(worldLh(long.action) >= cfg.callMinLineHeight && worldLh(long.action) > worldLh(long.body) - 1e-9,
        `a long command's headline stays ≥ callMinLineHeight and ≥ its body (head ${worldLh(long.action).toFixed(2)}, body ${worldLh(long.body).toFixed(2)})`);
    ok(long.body && long.body.content.includes('echo step 11'), 'the command\'s remaining lines ride the body card — nothing dropped');
    ok(long.action.content.replace(/\s+/g, '') === longCmd.split('\n')[0].replace(/\s+/g, '') && long.action.content.includes('\n'),
        'the headline holds the WHOLE first line, word-wrapped (not cut)');
    const cols = long.action.getLayout().wrapWidth;
    ok(cols > 0 && cols * (worldLh(long.action) * 0.5) <= cfg.pageW - 2 * cfg.pageMargin + 1e-6,
        `the headline wraps to the page width (wrapWidth ${cols})`);
    const sheet = lane.book.sheets[1];
    ok(near(sheet.fit.verso.scale, 1), `the verso fits at scale 1 — the page states its rect (got ${sheet.fit.verso.scale})`);
    const box = long.verso.layoutBounds();
    ok(near(box.max.x - box.min.x, cfg.pageW) && near(box.max.y - box.min.y, cfg.pageH), 'the ActionPage box is the page rect');
    const top = cfg.pageH / 2 - cfg.pageMargin;
    const ab = long.action.layoutBounds().applyMatrix4(long.action.matrix);
    ok(near(ab.max.y, top, 1e-3) && near(ab.min.x, -cfg.pageW / 2 + cfg.pageMargin, 1e-3), 'the headline sits at the page\'s top-left margin');

    // ── the recto: a partial read framed to its slice ──
    ok(read.window && read.window.first === 291 && read.window.last === 327 && read.window.total === 600,
        `the snapshot frames the read slice ± context (got ${JSON.stringify(read.window)})`);
    ok(read.snapshot.content.split('\n').length === 37 && read.snapshot.content.startsWith('const line292 '),
        'the snapshot loads just its window');
    ok(read.infoText.includes('L300–320') && read.infoText.includes('shown L292–328 of 600'),
        `the verso's info rows name the window (got ${JSON.stringify(read.infoText)})`);
    ok(read.info && read.info.content === read.infoText, 'the info card re-loaded with the window note');
}

// ── decoration lands at window rows ──
{
    const lit = [];
    const grid = { highlightRange: (l0) => lit.push(l0), getLineCount: () => 37, getLineSlotCount: () => 5 };
    books._decorateSnapshot(grid, { action: 'read', meta: { range: [300, 320] } }, 291);
    ok(lit[0] === 8 && lit[lit.length - 1] === 28 && lit.length === 21, `touched lines shift by the window's first line (got ${lit[0]}…${lit[lit.length - 1]})`);
}

// ── live cfg re-sizes the headline ──
{
    books.cfg.callLineHeight = 30;
    books.applyScales();
    await tick(60);
    const e = books.lanes.get('a1').entries[0];
    ok(near(worldLh(e.action), 30), `applyScales re-sizes a live headline (got ${worldLh(e.action).toFixed(3)})`);
    books.dispose();
}

console.log(`\nagent-action-page.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
