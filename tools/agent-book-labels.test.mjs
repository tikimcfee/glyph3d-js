// agent-book-labels.test.mjs — behavior lock for agent book NAMEPLATES: the AgentNameplate
// (the session NAME on a palette-hue plate over a live STATUS block) each lane's book wears
// above its cover, and the readout that fills it (hydrate opts.meta / setLaneMeta / live
// activity → readout → nameplateText → AgentNameplate.set).
//
//   bun tools/agent-book-labels.test.mjs
//
// Locks:
//   - ensure() creates a nameplate in the lane's palette hue, parented to the book,
//     named '~<id>', its status naming the lifecycle + harness
//   - Label3D._bake multi-line: '\n' stacks rows (Button3D chrome keeps the baked path;
//     dock-labels.test.mjs stays green as the regression net)
//   - container-fit: a short name stops at labelMaxLineHeight, a longer one shrinks toward
//     labelMinLineHeight, a name too long even there WRAPS (every character kept)
//   - hydrate(..., {meta}) stores lane.meta/lane.cwd and restages the plate ONCE (not per
//     record); a hydrated book's age reads the record's lastTs
//   - live activity restages: status · step · age, the current call, where it runs
//   - setLaneMeta(id, meta) merges and restages; unknown id → false
//   - meta.gomux (an orchestrator's fields) wins the name / status / current call
//   - readout(): the one source the plate, the panel rows (agents()) and the hover read
//   - remove()/_kill disposes the plate with the book
//
// Headless: the shared 2d-canvas stub stands in for the DOM (the plate bake), the
// shaper-less atlas stub feeds the field's mono fallback (real positions, no ink).

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

// Module-scope telemetry (ErrorTracker) wants a window with addEventListener.
globalThis.window ??= { addEventListener() {} };

const { default: Label3D } = await import('../packages/glyph3d-core/src/components/Label3D.js');
const { default: AgentNameplate } = await import('../packages/glyph3d-core/src/collections/AgentNameplate.js');
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

// ── Label3D multi-line bake ──
{
    const fontPx = 44;
    const padX = Math.round(fontPx * 0.72), padY = Math.round(fontPx * 0.42);
    const one = new Label3D({ label: 'hi', height: 2 });
    // Single-line geometry is exactly the old formula (stub measureText: len × 22px).
    const w1 = Math.max(Math.ceil(2 * 22) + padX * 2, fontPx + padY * 2);
    const h1 = fontPx + padY * 2;
    ok(one.material.map.image.width === w1 && one.material.map.image.height === h1,
        `single-line bake unchanged (got ${one.material.map.image.width}×${one.material.map.image.height}, want ${w1}×${h1})`);

    const two = new Label3D({ label: 'hi\nlonger line', height: 2 });
    const lineStep = Math.round(fontPx * 1.2);
    const w2 = Math.ceil(11 * 22) + padX * 2;   // widest line wins ('longer line' = 11 chars)
    const h2 = 2 * lineStep + padY * 2;
    ok(two.material.map.image.width === w2 && two.material.map.image.height === h2,
        `multi-line bake: max line width + one row per line (got ${two.material.map.image.width}×${two.material.map.image.height}, want ${w2}×${h2})`);
    ok(two.material.map.image.height > one.material.map.image.height, 'multi-line plate is taller');

    // Rebake from multi-line back to single-line restores the single-line shape.
    two.setLabel('hi');
    ok(two.material.map.image.width === w1 && two.material.map.image.height === h1,
        'rebake multi→single returns to the single-line bake');
    one.dispose(); two.dispose();
}

// ── nameplate on ensure ──
const books = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
const cfg = books.cfg;
{
    const lane = books.ensure('abc123', 'claude');
    ok(lane.label instanceof AgentNameplate, 'ensure creates an AgentNameplate');
    ok(lane.label.nameText === '~abc123', `initial name is '~<id>' (got "${lane.label.nameText}")`);
    ok(lane.label.statusText === 'active\nclaude',
        `initial status names the lifecycle + harness (got ${JSON.stringify(lane.label.statusText)})`);
    ok(lane.label.nameLabel._plateCfg.color === cfg.palette[0], 'name plate wears the lane palette hue');
    ok(lane.book.nameplate === lane.label && lane.label.parent === lane.book,
        'nameplate is parented to the book (book.setNameplate)');
    ok(lane.label.userData.isMarker === true, 'nameplate is pick-inert');
    ok(lane.label.nameLabel.lineHeight === cfg.labelMaxLineHeight,
        `a short name stops at labelMaxLineHeight (got ${lane.label.nameLabel.lineHeight})`);
    ok(Math.abs(lane.label.statusLabel.lineHeight - cfg.labelMaxLineHeight * cfg.labelStatusRatio) < 1e-9,
        'status rows ride labelStatusRatio × the name');
}

// ── placement: syncCover parks the plate just above the cover ──
{
    // A throwaway lane: the bare leaf below is a raw sheet with no entry behind it.
    const lane = books.ensure('place1', 'claude');
    const leaf = new THREE.Object3D();
    leaf.userData.size = { x: 100, y: 200, z: 2 };   // leafBox's bare-object contract
    lane.book.addSheet({ recto: leaf });
    lane.book.update(0.016);
    const c = lane.book.cover;
    ok(lane.label.visible === true, 'nameplate visible once the cover has bounds');
    const topEdge = c.mesh.position.y + c.mesh.scale.y / 2;
    const gap = lane.label.position.y - lane.label.height / 2 - topEdge;
    ok(gap > 0 && gap < lane.label.height, `nameplate sits just above the cover (gap ${gap.toFixed(2)} of plate ${lane.label.height})`);
    const nl = lane.label.nameLabel, sl = lane.label.statusLabel;
    ok(nl.position.y - nl.height / 2 > sl.position.y + sl.height / 2 - 1e-9, 'the name stacks above the status block');
    books.remove('place1');
}

// ── container-fit: shrink toward the minimum, then wrap ──
{
    const W = (2 * cfg.pageW + cfg.gutter) * cfg.labelFit;
    const mid = books.ensure('fit1', 'claude');
    books.setLaneMeta('fit1', { title: 'A considerably longer session title that has to shrink to fit the book' });
    const lh = mid.label.nameLabel.lineHeight;
    ok(lh < cfg.labelMaxLineHeight && lh >= cfg.labelMinLineHeight, `a longer name shrinks within [min,max] (lh ${lh.toFixed(2)})`);
    ok(mid.label.nameLabel.width <= W * 1.15, `…spanning about labelFit of the spread (${mid.label.nameLabel.width.toFixed(0)} vs ${W.toFixed(0)})`);

    const title = 'word '.repeat(60).trim() + ' Supercalifragilisticexpialidociouslylongunbrokentoken'.repeat(3);
    const long = books.ensure('fit2', 'claude');
    books.setLaneMeta('fit2', { title });
    ok(long.label.nameLabel.lineHeight === cfg.labelMinLineHeight, 'a name too long even at the minimum holds the minimum…');
    ok(long.label.nameText.includes('\n'), '…and WRAPS');
    ok(long.label.nameText.replace(/\s+/g, '') === title.replace(/\s+/g, ''), 'wrapping keeps every character (no cut, no ellipsis)');
    books.remove('fit1'); books.remove('fit2');
}

// ── hydrate stores meta + restages once ──
{
    let restages = 0;
    const orig = books._refreshNameplate.bind(books);
    books._refreshNameplate = (l) => { if (l.agentId === 'abc123') restages++; return orig(l); };
    const lastTs = Date.now() - 4 * 60 * 1000;
    await books.hydrate('abc123', [
        { action: 'read', target: 'a.js', detail: '', result: '', meta: { lines: 3 } },
        { action: 'bash', target: '', detail: 'ls -la', result: 'x\n', meta: { lines: 1 } },
        { action: 'say', target: '', detail: '', result: 'Done — the plate reads.\nMore prose.', meta: null },
    ], {
        sessionId: 'sess-1',
        meta: { title: 'Fix the flurbit', cwd: '/home/ivan/dev/glyph3d-js', model: 'claude-opus-4', gitBranch: 'main', lastTs },
    });
    books._refreshNameplate = orig;
    ok(restages === 1, `hydrate restages the plate ONCE, after the batch (got ${restages})`);
    const lane = books.lanes.get('abc123');
    ok(lane.sessionId === 'sess-1', 'hydrate still stores sessionId');
    ok(lane.meta?.title === 'Fix the flurbit' && lane.meta?.model === 'claude-opus-4', 'hydrate stores lane.meta');
    ok(lane.cwd === '/home/ivan/dev/glyph3d-js', 'hydrate stores lane.cwd from meta.cwd');
    ok(lane.label.nameText === 'Fix the flurbit', `the name is the title (got ${JSON.stringify(lane.label.nameText)})`);
    const st = lane.label.statusText;
    ok(st.startsWith('idle · step 3 · 4m ago'), `status row: idle · step · age from the record's lastTs (got ${JSON.stringify(st)})`);
    ok(st.split('\n')[1] === 'say' && !st.includes('Done — the plate reads.'),
        `a say/think's current call is its verb alone — the prose is the open page, not the plate (got ${JSON.stringify(st)})`);
    ok(st.includes('glyph3d-js · claude · claude-opus-4 · main'), 'where it runs: cwd · type · model · branch');
    const row = books.agents().find((a) => a.id === 'abc123');
    ok(row?.meta?.title === 'Fix the flurbit', 'agents() exposes meta per lane');
    ok(row?.name === 'Fix the flurbit' && row?.status === 'idle' && row?.action === 'say  Done — the plate reads.' && row?.wallTs === lastTs,
        `agents() rows carry the readout's name / status / action / wallTs (got ${JSON.stringify([row?.name, row?.status, row?.action])})`);
}

// ── hydrate accepts pre-normalized records (the codec's output shape) ──
{
    const added = await books.hydrate('rec999', [
        { action: 'say', target: '', detail: '', result: 'already normalized prose', meta: null },
        { action: 'bash', target: '', detail: 'ls', result: 'out\n', meta: { lines: 1 } },
    ], {});
    ok(added === 2, `hydrate builds sheets straight from records (added ${added})`);
    const lane = books.lanes.get('rec999');
    ok(lane?.entries.length === 2, 'record sheets landed in the lane');
    ok(lane?.entries[1]?.record?.action === 'bash', 'the record rides the entry verbatim');
}

// ── live activity restages the status ──
{
    books.activity('abc123', 'claude', { action: 'bash', target: '', detail: 'rg -n foo src/\n  | head -5', result: 'hit\n', meta: { lines: 1 } });
    const lane = books.lanes.get('abc123');
    const st = lane.label.statusText;
    ok(st.startsWith('active · step 4 · now'), `live activity: active · step · now (got ${JSON.stringify(st)})`);
    ok(st.includes('bash  rg -n foo src/'), 'the current call is the new command\'s first line');
    const r = books.readout('abc123', lane.entries[0].sheetId);
    ok(r.page.count === lane.entries.length && r.page.following === true, 'readout carries the book\'s page state');
    ok(r.sheet?.verb === 'read' && r.sheet?.head === 'a.js', `readout(…, sheetId) describes that sheet (got ${JSON.stringify(r.sheet)})`);
    ok(books.readout('agent:book:abc123')?.agentId === 'abc123' && books.readout(lane.book)?.agentId === 'abc123',
        'readout resolves group ids and the Book itself (the hover paths)');
    ok(books.readout('phantom') === null, 'readout of an unknown ref is null');
    books.request('abc123', 'pick a branch');
    ok(lane.label.statusText.split('\n')[0].endsWith('needs you: pick a branch'), 'a raised hand rides the status row');
}

// ── setLaneMeta merges + restages; gomux wins ──
{
    ok(books.setLaneMeta('abc123', { model: 'kimi-k2' }) === true, 'setLaneMeta returns true for a live lane');
    const lane = books.lanes.get('abc123');
    ok(lane.meta.model === 'kimi-k2' && lane.meta.title === 'Fix the flurbit', 'setLaneMeta merges over existing meta');
    ok(lane.label.statusText.includes('claude · kimi-k2 · main'), `setLaneMeta restages the plate (got ${JSON.stringify(lane.label.statusText)})`);
    ok(books.setLaneMeta('phantom', { model: 'x' }) === false, 'setLaneMeta on an unknown lane is false');

    books.setLaneMeta('abc123', { gomux: { name: 'builder-2', parent: 'lead', backend: 'claude-code', status: 'waiting on review', detail: 'go test ./...', tool: 'bash', session: 's-9' } });
    const st = lane.label.statusText;
    ok(lane.label.nameText === 'builder-2', `gomux.name wins the name (got ${lane.label.nameText})`);
    ok(st.startsWith('waiting on review · '), `gomux.status wins the status (got ${JSON.stringify(st)})`);
    ok(st.includes('bash  go test ./...'), 'gomux tool + detail win the current call');
    const flat = st.replace(/\s+/g, ' ');   // the plate wraps its rows to the book's width
    ok(flat.includes('claude-code') && flat.includes('parent lead'), 'gomux backend + parent join where it runs');

    // A sparse lane: only a slug.
    const lane2 = books.ensure('def456', 'kimi');
    books.setLaneMeta('def456', { slug: 'quiet-session' });
    ok(lane2.label.nameText === 'quiet-session', 'slug names a session with no title');
    ok(lane2.label.statusText === 'active\nkimi', `a bare lane's status: lifecycle + harness only (got ${JSON.stringify(lane2.label.statusText)})`);
    const t = books.nameplateText(lane2);
    ok(t.name === lane2.label.nameText && t.status === lane2.label.statusText, 'nameplateText is the plate\'s source of truth');
}

// ── _kill disposes the nameplate ──
{
    const lane = books.lanes.get('abc123');
    const lbl = lane.label;
    let disposed = 0;
    const orig = lbl.dispose.bind(lbl);
    lbl.dispose = () => { disposed++; orig(); };
    books.remove('abc123');
    ok(disposed === 1, '_kill disposes the nameplate exactly once');
    ok(lbl.parent === null && !lane.book.children.includes(lbl), 'nameplate lifted out of the book');
    ok(lane.label === null, 'lane label ref cleared');
    books.dispose();
}

console.log(`\nagent-book-labels.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
