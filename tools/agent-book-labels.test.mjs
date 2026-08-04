// agent-book-labels.test.mjs — behavior lock for agent book NAMEPLATES: the FieldLabel
// (glyph-field text over a palette-hue plate) each lane's book wears above its cover, and
// the provenance metadata flow that fills it (hydrate opts.meta / setLaneMeta →
// provenanceText → setText).
//
//   bun tools/agent-book-labels.test.mjs
//
// Locks:
//   - ensure() creates a nameplate in the lane's palette hue, parented to the book,
//     initial text '~<id> · <agentType>'
//   - Label3D._bake multi-line: '\n' stacks rows (Button3D chrome keeps the baked path;
//     dock-labels.test.mjs stays green as the regression net)
//   - hydrate(..., {meta}) stores lane.meta/lane.cwd and rebuilds the plate text
//   - setLaneMeta(id, meta) merges and rebuilds; unknown id → false
//   - provenanceText: title/slug/~id · basename(cwd)+type · model+branch, lines omitted
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
const { default: FieldLabel } = await import('../packages/glyph3d-core/src/collections/FieldLabel.js');
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
{
    const lane = books.ensure('abc123', 'claude');
    ok(lane.label instanceof FieldLabel, 'ensure creates a FieldLabel nameplate');
    ok(lane.label.text === '~abc123 · claude', `initial text is '~<id> · <type>' (got "${lane.label.text}")`);
    ok(lane.label._plateCfg.color === books.cfg.palette[0], 'nameplate wears the lane palette hue');
    ok(lane.book.nameplate === lane.label && lane.label.parent === lane.book,
        'nameplate is parented to the book (book.setNameplate)');
    ok(lane.label.userData.isMarker === true, 'nameplate is pick-inert');

    // syncCover parks it just above the cover box, re-anchored per update(). The cover
    // only has bounds once the book holds a sheet (a sheetless book's bounds are empty).
    const leaf = new THREE.Object3D();
    leaf.userData.size = { x: 100, y: 200, z: 2 };   // leafBox's bare-object contract
    lane.book.addSheet({ recto: leaf });
    lane.book.update(0.016);
    const c = lane.book.cover;
    ok(lane.label.visible === true, 'nameplate visible once the cover has bounds');
    const topEdge = c.mesh.position.y + c.mesh.scale.y / 2;
    const gap = lane.label.position.y - lane.label.height / 2 - topEdge;
    ok(gap > 0 && gap < lane.label.height, `nameplate sits just above the cover (gap ${gap.toFixed(2)} of plate ${lane.label.height})`);
}

// ── hydrate stores meta + rebakes ──
{
    await books.hydrate('abc123', [], {
        sessionId: 'sess-1',
        meta: { title: 'Fix the flurbit', cwd: '/home/ivan/dev/glyph3d-js', model: 'claude-opus-4', gitBranch: 'main' },
    });
    const lane = books.lanes.get('abc123');
    ok(lane.sessionId === 'sess-1', 'hydrate still stores sessionId');
    ok(lane.meta?.title === 'Fix the flurbit' && lane.meta?.model === 'claude-opus-4', 'hydrate stores lane.meta');
    ok(lane.cwd === '/home/ivan/dev/glyph3d-js', 'hydrate stores lane.cwd from meta.cwd');
    ok(lane.label.text === 'Fix the flurbit\nglyph3d-js · claude\nclaude-opus-4 · main',
        `hydrate rebakes the full provenance (got ${JSON.stringify(lane.label.text)})`);
    const row = books.agents().find((a) => a.id === 'abc123');
    ok(row?.meta?.title === 'Fix the flurbit', 'agents() exposes meta per lane');
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

// ── setLaneMeta merges + rebakes; provenance omits absent lines ──
{
    ok(books.setLaneMeta('abc123', { model: 'kimi-k2' }) === true, 'setLaneMeta returns true for a live lane');
    const lane = books.lanes.get('abc123');
    ok(lane.meta.model === 'kimi-k2' && lane.meta.title === 'Fix the flurbit', 'setLaneMeta merges over existing meta');
    ok(lane.label.text === 'Fix the flurbit\nglyph3d-js · claude\nkimi-k2 · main',
        `setLaneMeta rebakes the plate (got ${JSON.stringify(lane.label.text)})`);
    ok(books.setLaneMeta('phantom', { model: 'x' }) === false, 'setLaneMeta on an unknown lane is false');

    // A sparse lane: only a slug — no cwd line, no model/branch line.
    const lane2 = books.ensure('def456', 'kimi');
    books.setLaneMeta('def456', { slug: 'quiet-session' });
    ok(lane2.label.text === 'quiet-session\nkimi',
        `provenance omits absent lines (got ${JSON.stringify(lane2.label.text)})`);
    ok(books.provenanceText(lane2) === lane2.label.text, 'provenanceText is the plate\'s source of truth');

    // A bare lane falls back to '~<id>' on line 1.
    const lane3 = books.ensure('zzz', 'agent');
    ok(books.provenanceText(lane3) === '~zzz\nagent',
        `no meta → '~<id>' + harness only (got ${JSON.stringify(books.provenanceText(lane3))})`);
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
