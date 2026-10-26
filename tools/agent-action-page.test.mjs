// agent-action-page.test.mjs — behavior lock for how an agent sheet RENDERS its action:
// the verso composed at world size by the page-text rule and the recto file snapshot
// framed to the touched range.
//
//   bun tools/agent-action-page.test.mjs
//
// Locks:
//   - actionCall: the headline line (target / the call's first non-empty line / a say's
//     opening line) vs the rest of the call (nothing dropped)
//   - fitTextStack (the ONE sizing rule): a block's natural row height is its size; it
//     only ever scales DOWN — natural: a long line shrinks ITS block to the page width;
//     wrap: wraps first, shrinks only when the stack is too tall (re-wrapping wider), as
//     much as it must and no more; short text never grows; ratios hold under a squeeze
//   - wrapText: rows ≤ cols, every character kept
//   - snapshotWindow: touched runs ± context, capped, slid inside the file; null when the
//     file fits or windowing is off; a rangeless action frames the top
//   - the VERSO is an ActionPage stating exactly the page rect → Book's fit is 1, so the
//     headline's world row height IS versoTextSize for a call that fits; a long command
//     on a natural page keeps its first line whole (one row, shrunk to the width), its
//     remaining lines ride a body card
//   - the RECTO of a partial read loads just its window, lights the touched lines at
//     their window rows, and names the window in the verso's info rows
//   - cfg changes re-size live headlines (applyScales)
//
// Headless: the shaper-less atlas stub (real positions, no ink).

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };

const { default: AgentBooks, actionCall, snapshotWindow } =
    await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { fitTextStack, wrapText } = await import('../packages/glyph3d-core/src/collections/ActionPage.js');
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

// ── fitTextStack — the one sizing rule ──
{
    const o = { innerW: 288, innerH: 388, advPerLh: 0.5 };
    const fit1 = (b) => fitTextStack([b], o)[0];
    const height = (out, gap = 0) => out.filter(Boolean).reduce((h, s) => h + s.rows * s.lh, 0) + gap * (out.filter(Boolean).length - 1);

    // natural: only the text's own lines; a long line shrinks its block to the width.
    const short = fit1({ text: 'rg -n foo', size: 18, brk: 'natural', extraRows: 1.5 });
    ok(short.lh === 18 && short.cols === 0 && short.rows === 2.5, `natural: a short line sits at its size, unwrapped (got ${JSON.stringify(short)})`);
    const long = fit1({ text: 'x'.repeat(200), size: 18, brk: 'natural' });
    ok(near(long.lh, 288 / (200 * 0.5)) && long.rows === 1 && long.cols === 0,
        `natural: a long line shrinks to the page width, still one row (got ${JSON.stringify(long)})`);
    const two = fit1({ text: 'short\n' + 'y'.repeat(100), size: 18, brk: 'natural' });
    ok(near(two.lh, 288 / (100 * 0.5)) && two.rows === 2, 'natural: the widest line sets the block');
    const tall = fit1({ text: Array.from({ length: 100 }, () => 'z').join('\n'), size: 18, brk: 'natural' });
    ok(near(tall.lh, 388 / 100, 1e-6) && tall.rows === 100, `natural: too many lines shrink to the page height (got ${tall.lh})`);

    // wrap: wraps to the page width at its size; shrinks only if still too tall.
    const w1 = fit1({ text: 'rg -n foo', size: 18, brk: 'wrap', words: true });
    ok(w1.lh === 18 && w1.cols === Math.floor(288 / (0.5 * 18)), `wrap: a short call sits at its size; cols = the page width in cells (got ${JSON.stringify(w1)})`);
    const w2 = fit1({ text: 'word '.repeat(60), size: 18, brk: 'wrap', words: true });
    ok(w2.lh === 18 && w2.rows > 1 && w2.rows * w2.lh <= 388, `wrap: text that wraps and still fits keeps its size (got ${JSON.stringify(w2)})`);
    const big = 'word '.repeat(3000);
    const w3 = fit1({ text: big, size: 18, brk: 'wrap', words: true });
    ok(w3.lh < 18 && w3.rows * w3.lh <= 388, `wrap: too tall even wrapped, it scales down to fit (got ${JSON.stringify(w3)})`);
    ok(w3.cols > w1.cols && w3.rows === wrapText(big, w3.cols).split('\n').length, 'wrap: a shrunk block re-wraps wider, rows counted by the real word wrap');
    const nudge = fitTextStack([{ text: big, size: 18 * (w3.lh / 18) * 1.02, brk: 'wrap', words: true }], o)[0];
    ok(nudge.lh < 18 * (w3.lh / 18) * 1.02, 'wrap: it shrinks as much as it must — 2% larger no longer fits');

    // never grows; ratios hold under a squeeze; a natural long line shrinks only its block.
    ok([short, long, two, tall, w1, w2, w3].every((s) => s.lh <= 18), 'no block is ever set larger than its size');
    const stack = fitTextStack([
        { text: 'head', size: 18, brk: 'wrap', words: true },
        { text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), size: 9, brk: 'wrap', words: true },
        { text: '3 lines', size: 9, brk: 'wrap' },
    ], { ...o, gap: 10 });
    ok(near(stack[0].lh / stack[1].lh, 2) && near(stack[1].lh, stack[2].lh), `a squeezed stack keeps its ratios (got ${stack.map((s) => s.lh.toFixed(2))})`);
    ok(height(stack, 10) <= 388 + 1e-6 && stack[0].lh < 18, 'and fits the page');
    const mixed = fitTextStack([
        { text: 'x'.repeat(300), size: 18, brk: 'natural' },
        null,
        { text: 'lines 3', size: 9, brk: 'natural' },
    ], { ...o, gap: 10 });
    ok(mixed[1] === null && mixed[0].lh < 9 && mixed[2].lh === 9, 'natural: a long headline shrinks alone — its neighbours keep their size; a null block is absent');

    let threw = false;
    try { fitTextStack([{ text: 'a', size: 9, brk: 'wrap' }], { ...o, advPerLh: 0 }); } catch { threw = true; }
    ok(threw, 'a missing cell metric fails loud');
    threw = false;
    try { fitTextStack([{ text: 'a', size: 0, brk: 'wrap' }], o); } catch { threw = true; }
    ok(threw, 'a zero size fails loud');
}

// ── wrapText ──
{
    const src = 'alpha beta gamma delta epsilon zetazetazetazetazeta eta';
    const w = wrapText(src, 12);
    ok(w.split('\n').every((r) => [...r].length <= 12), 'rows fit the column count');
    ok(w.replace(/\s+/g, '') === src.replace(/\s+/g, ''), 'every character kept');
    ok(w.split('\n')[0] === 'alpha beta', `breaks at whitespace when it can (got ${JSON.stringify(w.split('\n')[0])})`);

    // A path longer than a row breaks after its separators, never mid-name; it starts on
    // the row it stands on when its first piece fits.
    const say = "I've written the report to `/home/user/dev/gomuxai-wt/survey/REPORT.md`. The notes are in `/home/user/dev/gomuxai-wt/survey/notes/`.";
    const rows = wrapText(say, 38).split('\n');
    ok(rows.every((r) => [...r].length <= 38), 'path rows fit the column count');
    ok(rows.join('').replace(/\s+/g, '') === say.replace(/\s+/g, ''), 'every character of the paths kept');
    ok(!rows.some((r) => /surve$|^y\//.test(r)), `a path never splits mid-name (got ${JSON.stringify(rows)})`);
    ok(rows.every((r, i) => i === rows.length - 1 || !/[A-Za-z0-9]$/.test(r) || /\s/.test(say[say.indexOf(r) + r.length] ?? ' ')),
        `every row ends at a space or after a separator (got ${JSON.stringify(rows)})`);
    ok(rows[0].startsWith("I've written the report to `/"), `the path starts where it stands (got ${JSON.stringify(rows[0])})`);
    ok(wrapText('see fooo/barr', 10) === 'see\nfooo/barr', 'a word that fits a row still moves whole');
    ok(wrapText('abcdefghijklmnop', 6) === 'abcdef\nghijkl\nmnop', 'a run with no separator still breaks at the column');
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
    ok(cfg.versoBreak === 'natural', 'the left page keeps the text\'s own lines by default');
    ok(near(worldLh(short.action), cfg.versoTextSize), `a short call's headline sits at versoTextSize (got ${worldLh(short.action).toFixed(3)})`);
    ok(long.body && long.body.content.includes('echo step 11'), 'the command\'s remaining lines ride the body card — nothing dropped');
    const first = longCmd.split('\n')[0];
    ok(long.action.content === first && long.action.getLayout().wrapWidth === 0,
        'natural: the headline holds the WHOLE first line on one row (not cut, not wrapped)');
    ok(worldLh(long.action) < cfg.versoTextSize && near(worldLh(long.action) * 0.5 * [...first].length, cfg.pageW - 2 * cfg.pageMargin, 1e-3),
        `natural: the long first line shrinks its headline to the page width (got ${worldLh(long.action).toFixed(2)})`);
    ok(near(worldLh(short.info), cfg.versoTextSize * cfg.versoInfoRatio), 'the info rows keep their share of the left page text size');
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

// ── the recto from the event's file text; a disk read against the session's cwd ──
{
    const reads = [];
    const fb = new AgentBooks({ ...ctx, scene: new THREE.Scene(), fileProvider: { getFile: async (p) => {
        reads.push(p);
        throw new Error(`path escapes reachable roots: ${p}`);
    } } });
    const slice = Array.from({ length: 21 }, (_, i) => `const line${300 + i} = ${300 + i};`).join('\n') + '\n';
    const whole = 'a\nb changed\nc\n';
    await fb.hydrate('x1', [
        { action: 'read', target: 'src/big.js', detail: '', result: '', meta: { lines: 21, range: [300, 320] },
          file: { text: slice, start: 300, total: 600 } },
        { action: 'edit', target: 'src/e.js', detail: '', result: '', meta: { added: 1, removed: 1, ranges: [[2, 2]] },
          file: { text: whole, start: 1, total: 3 } },
        { action: 'read', target: 'src/gone.js', detail: '', result: '', meta: { lines: 3 } },
    ], { meta: { cwd: '/elsewhere/proj' } });
    await tick(60);
    const [r, ed, gone] = fb.lanes.get('x1').entries;
    ok(r.snapshot.content.startsWith('const line300 ') && r.snapshot.content.includes('const line320 '),
        `a read shows the lines it read, from the event (got ${JSON.stringify(r.snapshot.content.slice(0, 20))})`);
    ok(r.window?.first === 299 && r.window.last === 319 && r.window.total === 600 && r.infoText.includes('shown L300–320 of 600'),
        `the slice is named in the file's lines (got ${JSON.stringify(r.window)})`);
    ok(ed.snapshot.content === whole && !ed.window, 'an edit shows the file it left, whole');
    ok(reads.length === 1 && reads[0] === '/elsewhere/proj/src/gone.js',
        `only the call without file text reads disk, at its target against the session's cwd (read ${reads})`);
    ok(gone.snapshot.content.includes('could not load /elsewhere/proj/src/gone.js: path escapes reachable roots'),
        `a refused read says why on the page (got ${JSON.stringify(gone.snapshot.content)})`);
    fb.dispose();
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
    books.cfg.versoTextSize = 30;
    books.applyScales();
    await tick(60);
    const e = books.lanes.get('a1').entries[0];
    ok(near(worldLh(e.action), 30), `applyScales re-sizes a live headline (got ${worldLh(e.action).toFixed(3)})`);
    books.dispose();
}

console.log(`\nagent-action-page.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
