// book-held-content.test.mjs — a Book poses a sheet's content only while the content sits in its
// own mount (collections/Book.js release / _fitSheet). Content a holder has taken — a desk seat, the
// camera dock — is posed by that holder, and a tree relayout (which releases and re-fits every book)
// must not move it.
//
//   bun tools/book-held-content.test.mjs
//
// The regression: Book.release and the fit re-seated every sheet's content at the origin, held or
// not; a tree relayout after a desk seated a file put the file at the desk's origin (outside a plane
// desk's depth slab: blank). Locks:
//   - content in its mount: release and fit re-seat it at the origin, as before (the fit measures
//     the content's own form) — teeth for the guard below: a pose left on mounted content is cleared
//   - content held elsewhere: release and fit leave its position, rotation and parent alone
//   - the held side keeps the fit it had (scale, size, its mount's transform) through release + fit
//     — the content comes home to a fit page; a side never fitted while held stands without a fit
//     (no NaN, no face)
//   - the content coming home (back in its mount) fits again from its own form

import * as THREE from 'three';
import Book from '../packages/glyph3d-core/src/collections/Book.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const leaf = (w = 10, h = 8) => { const o = new THREE.Object3D(); o.userData = { size: { x: w, y: h, z: 1 } }; return o; };
const OPTS = { pageW: 20, pageH: 30, surface: false };

// ── Mounted content: re-seated by release and fit.
{
    const bk = new Book();
    const c = leaf();
    bk.addSheet({ recto: c });
    c.position.set(5, 6, 7); c.rotation.set(0.1, 0.2, 0.3);
    bk.release();
    ok(c.position.length() === 0 && c.rotation.x === 0 && c.rotation.z === 0, 'mounted content: release re-seats it at the origin');
    c.position.set(1, 2, 3);
    bk.fit(OPTS);
    ok(c.position.length() === 0, 'mounted content: the fit re-seats it before measuring');
    ok(bk.sheets[0].fit.recto && Number.isFinite(bk.sheets[0].fit.recto.scale), 'and fits it');
}

// ── Held content (a desk took it): release and fit leave it where the holder put it.
{
    const bk = new Book();
    const c = leaf();
    bk.addSheet({ recto: c });
    bk.fit(OPTS);
    const fitBefore = { ...bk.sheets[0].fit.recto };
    const mountScale = bk.sheets[0].rectoMount.scale.x;
    const desk = new THREE.Group();
    desk.add(c);                                   // seated: parent is the desk, the book still names it
    c.position.set(-173, -1.72, -240); c.rotation.set(0, 0.5, 0);
    bk.release();
    ok(c.parent === desk && c.position.x === -173 && c.position.z === -240 && c.rotation.y === 0.5, `held content: release leaves its pose alone (${c.position.toArray()})`);
    bk.fit(OPTS);
    ok(c.parent === desk && c.position.x === -173 && c.position.z === -240 && c.rotation.y === 0.5, `held content: the fit leaves its pose alone (${c.position.toArray()})`);
    const f = bk.sheets[0].fit.recto;
    ok(f && f.scale === fitBefore.scale && f.contentW === fitBefore.contentW, 'held content: the side keeps the fit it had');
    ok(bk.sheets[0].rectoMount.scale.x === mountScale, `held content: its mount keeps its fit through release + fit (${bk.sheets[0].rectoMount.scale.x} vs ${mountScale})`);

    // Home again: fits from its own form.
    bk.sheets[0].rectoMount.add(c);
    c.position.set(9, 9, 9);
    bk.fit(OPTS);
    ok(c.position.length() === 0 && bk.sheets[0].fit.recto.scale === fitBefore.scale, 'home again: re-seated and fit as before');
}

// ── Held before it was ever fitted: no fit, no NaN.
{
    const bk = new Book();
    const c = leaf();
    bk.addSheet({ recto: c });
    new THREE.Group().add(c);
    c.position.set(3, 4, 5);
    bk.fit(OPTS);
    ok(c.position.x === 3 && !bk.sheets[0].fit.recto, 'held, never fitted: untouched, no fit for the side');
    const m = bk.sheets[0].rectoMount;
    ok([m.position.x, m.position.y, m.position.z, m.scale.x].every(Number.isFinite), 'and nothing NaN');
}

console.log(`${fails ? 'FAIL' : 'ok'} book-held-content: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
