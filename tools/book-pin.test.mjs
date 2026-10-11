// book-pin.test.mjs — behavior lock for USER-PLACED (pinned) books in the agent cluster,
// and for which surfaces drag at all (surfaceInteractions.moveVerbFor).
//
//   bun tools/book-pin.test.mjs
//
// Locks:
//   - a pinned book keeps its LIVE position across a cluster relayout (a drag in flight is
//     not yanked back to its last pinnedPos)
//   - a pinned book has no say in the floor rest: a lone book lifted off the shelf and
//     pinned mid-air stays mid-air (it used to drop to the floor)
//   - moveVerbFor: a plain grid → grid.move; a page riding a library volume, an agent card,
//     a volume cover → no drag; agent/delta books → book.move; terminals → terminal.move
//
// Headless: the 2d-canvas stub stands in for the DOM; AgentBooks runs scene-only.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };
const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { moveVerbFor } = await import('../app/client/surfaceInteractions.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m} (got ${a}, want ${b}±${eps})`);

// ── pinned books are user-placed ──
{
    const scene = new THREE.Scene();
    const books = new AgentBooks({ scene, atlas: HEADLESS_ATLAS, registry: null });
    const lane = books.ensure('pin1', 'claude');
    books.activity('pin1', 'claude', { action: 'Read', target: '/p/a.js', detail: 'a page so the book has extent' });
    books._relayout();
    ok(!new THREE.Box3().setFromObject(lane.book).isEmpty(), 'precondition: the book has extent (else floor rest is a no-op)');
    books.moveGroup('pin1', 30, 400, -5);              // pinned mid-air, the only root book
    books.root.updateMatrixWorld(true);
    const w0 = lane.book.getWorldPosition(new THREE.Vector3());
    books._relayout();
    const w1 = lane.book.getWorldPosition(new THREE.Vector3());
    near(lane.book.position.y, 400, 1e-6, 'pinned: position survives the relayout');
    near(w1.y, w0.y, 1e-6, 'pinned: no floor rest pulls a lone pinned book down');

    lane.book.position.set(55, 410, -5);                // a drag in flight writes the live position
    books._relayout();
    near(lane.book.position.x, 55, 1e-6, 'pinned: a relayout mid-drag keeps the live position');
    books.dispose?.();
}

// ── which surfaces drag ──
{
    const vol = new THREE.Group();
    vol.userData = { isVolume: true, path: '/p' };
    const page = new THREE.Object3D();
    vol.add(page);
    const loose = new THREE.Object3D();
    ok(moveVerbFor({ type: 'grid', grid: loose }) === 'grid.move', 'a plain grid drags (grid.move)');
    ok(moveVerbFor({ type: 'grid', grid: page }) === null, 'a library volume page does not drag');
    ok(moveVerbFor({ type: 'grid', role: 'card', grid: loose }) === null, 'an agent card does not drag');
    ok(moveVerbFor({ type: 'book', role: 'volume', grid: vol }) === null, 'a volume cover does not drag');
    ok(moveVerbFor({ type: 'book', role: 'agent', grid: loose }) === 'book.move', 'an agent book drags (book.move)');
    ok(moveVerbFor({ type: 'book', role: 'delta', grid: loose }) === 'book.move', 'a delta book drags (book.move)');
    ok(moveVerbFor({ type: 'terminal', grid: loose }) === 'terminal.move', 'a terminal drags (terminal.move)');
    ok(moveVerbFor({ type: 'frame', grid: loose }) === 'grid.move', 'an image frame drags as a grid');
}

console.log(`\nbook-pin.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
