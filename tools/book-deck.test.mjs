// book-deck.test.mjs — behavior lock for Book's DECK law: the reading deck, the
// turned block, and the turn as a CUT.
//
//   bun tools/book-deck.test.mjs
//
// The regression under lock: the old slot law was a modular wrap (slot = order·(i−head)
// mod n), so paging back one sheet EASED the newest sheet from the front of the deck to
// its back — through every other translucent page, for over a second. The law now:
//   - the reading deck (the open sheet + those still ahead) recedes from z = 0,
//   - the turned sheets lie pressed in a block at the deck's back (first-turned
//     deepest), inside the same box — the deck's extent never depends on the head,
//   - a sheet changing sides is CUT (set down directly), and the reading deck slides
//     as one rigid body at most deck.slide pitches — so no easing frame ever carries a
//     sheet past another, and a long jump settles like a one-sheet turn.
//
// Teeth: the "no easing frame reorders two sheets" check fails on the wrap law (the
// wrapped sheet's eased flight crosses every sheet between).

import * as THREE from 'three';
const BOOK_PATH = process.env.BOOK_PATH ?? '../packages/glyph3d-core/src/collections/Book.js';
const { default: Book } = await import(BOOK_PATH);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const leaf = () => { const o = new THREE.Object3D(); o.userData = { size: { x: 10, y: 10, z: 1 } }; return o; };
const PITCH = 50;

/** A settled, fitted deck of `n` sheets (order −1 = recency, +1 = page order). */
function deck(n, order = -1) {
    const bk = new Book();
    for (let i = 0; i < n; i++) bk.addSheet({ recto: leaf() });
    bk.deck.zPitch = PITCH;
    bk.deck.order = order;
    bk.fit({ pageW: 20, pageH: 30, surface: false });
    bk.seatAll();
    return bk;
}
const zs = (bk) => bk.sheets.map((s) => s.node.position.z);
const slotZ = (bk, i) => bk._slotFor(i, {}).z;

/** Ease `frames` steps; count the pairs whose z ORDER flips inside an easing step (a
 *  flight through another sheet). Cuts happen in pageTo, outside the steps. */
function easeCountingCrossings(bk, frames = 120) {
    let crossings = 0;
    for (let f = 0; f < frames; f++) {
        const before = zs(bk);
        bk.update(1 / 60);
        const after = zs(bk);
        for (let a = 0; a < before.length; a++) {
            for (let b = a + 1; b < before.length; b++) {
                const s0 = Math.sign(before[a] - before[b]), s1 = Math.sign(after[a] - after[b]);
                if (s0 && s1 && s0 !== s1) crossings++;
            }
        }
    }
    return crossings;
}
const settled = (bk) => bk.sheets.every((s, i) => near(s.node.position.z, slotZ(bk, i), 0.06));
const boxZ = (bk) => { const b = bk.deckBounds(); return [b.min.z, b.max.z]; };

// 1. the slot law — a recency deck (agent book): reading deck spaced, turned block pressed.
{
    const bk = deck(6);
    eq6(zs(bk), [-250, -200, -150, -100, -50, 0], 'live: the newest fronts, older recede one pitch each');
    bk.pageTo(3);
    // reading deck: 3 at 0, 2/1/0 behind; turned: 5 (first-turned) anchored at the back,
    // 4 one pressed step (0.25 pitch) in front of it.
    const want = [-150, -100, -50, 0, -250 + 12.5, -250];
    ok(bk.sheets.every((_, i) => near(slotZ(bk, i), want[i])), `slots under head 3: ${bk.sheets.map((_, i) => slotZ(bk, i))}`);
    // no wrap: the newest is NOT behind the oldest's slot spacing — the block is separated
    // from the reading deck by at least a full pitch.
    ok(slotZ(bk, 0) - slotZ(bk, 4) >= PITCH, 'the turned block sits a full pitch or more behind the reading deck');
    const box0 = boxZ(deck(6));
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    const box1 = boxZ(bk);
    ok(near(box0[0], box1[0], 0.01) && near(box0[1], box1[1], 0.01), `the deck box is head-invariant (${box0} vs ${box1})`);
}

// 2. one turn back: the open sheet is CUT onto the block; the deck slides one pitch; no
//    easing frame carries a sheet past another.
{
    const bk = deck(6);
    bk.pageTo(4);
    ok(near(bk.sheets[5].node.position.z, slotZ(bk, 5)), 'turn back: the turned sheet is set down on the block directly (a cut)');
    ok(near(bk.sheets[4].node.position.z, -PITCH), 'turn back: the new open sheet starts where it was (one pitch back)');
    eq(easeCountingCrossings(bk), 0, 'turn back: no easing frame reorders two sheets');
    ok(settled(bk), 'turn back: the deck settles on its slots');
}

// 3. one turn forward (toward live): the block's front sheet is cut onto the deck, one
//    pitch IN FRONT (it joins the rigid deck at its neighbours' offset) and settles home.
{
    const bk = deck(6);
    bk.pageTo(2);
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    bk.pageTo(3);
    ok(near(bk.sheets[3].node.position.z, PITCH), 'turn forward: the returning sheet joins the deck one pitch in front');
    ok(near(bk.sheets[2].node.position.z, 0), 'turn forward: the old open sheet starts in place');
    eq(easeCountingCrossings(bk), 0, 'turn forward: no easing frame reorders two sheets');
    ok(settled(bk), 'turn forward: settles');
}

// 4. a LONG jump is a cut plus a one-notch settle — never every sheet flying through
//    every other. Both directions; the visible slide is capped at deck.slide pitches.
for (const [from, to] of [[19, 0], [0, 19], [17, 3]]) {
    const bk = deck(20);
    bk.pageTo(from);
    for (let s = 0; s < 200; s++) bk.update(1 / 60);
    bk.pageTo(to);
    const worst = Math.max(...bk.sheets.map((s, i) => Math.abs(s.node.position.z - slotZ(bk, i))));
    ok(worst <= PITCH + 1e-6, `jump ${from}→${to}: every sheet starts within one pitch of its slot (worst ${worst})`);
    eq(easeCountingCrossings(bk), 0, `jump ${from}→${to}: no easing frame reorders two sheets`);
    bk.deck.slide = 0;
    bk.pageTo(from);
    ok(settled(bk), `jump with slide 0: a pure cut — already on its slots`);
}

// 5. rapid turns (a wheel flick landing one notch per frame) never fly a sheet either.
{
    const bk = deck(12);
    let crossings = 0;
    for (let k = 0; k < 10; k++) { bk.scroll(-1); crossings += easeCountingCrossings(bk, 2); }
    for (let k = 0; k < 10; k++) { bk.scroll(+1); crossings += easeCountingCrossings(bk, 2); }
    crossings += easeCountingCrossings(bk, 120);
    eq(crossings, 0, 'rapid turns: no easing frame ever reorders two sheets');
    ok(bk.following && settled(bk), 'rapid turns: back at live, settled');
}

// 6. a PAGE-ORDER deck (a library volume, order +1): turned pages press onto the block
//    page 1 deepest; the reading deck is the open page and the pages after it.
{
    const bk = deck(5, +1);
    bk.pageTo(0);
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    eq6(zs(bk), [0, -50, -100, -150, -200], 'volume at page 1: pages recede in order');
    bk.pageTo(2);
    const want = [-200, -200 + 12.5, 0, -50, -100];
    ok(bk.sheets.every((_, i) => near(slotZ(bk, i), want[i])), `volume at page 3: ${bk.sheets.map((_, i) => slotZ(bk, i))}`);
    eq(easeCountingCrossings(bk), 0, 'volume turn: no easing frame reorders two sheets');
}

// 7. live growth while HELD: a new newest sheet lands on the block's back; nothing on
//    the reading deck moves.
{
    const bk = deck(4);
    bk.pageTo(1);
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    const reading = [0, 1].map((i) => bk.sheets[i].node.position.z);
    bk.addSheet({ recto: leaf() });
    eq(bk.headState(), { head: 1, count: 5, following: false }, 'held growth: the head holds');
    ok(near(bk.sheets[4].node.position.z, -4 * PITCH), 'held growth: the newest seats at the back of the block');
    ok([0, 1].every((i, k) => near(bk.sheets[i].node.position.z, reading[k])), 'held growth: the reading deck does not move');
    eq(easeCountingCrossings(bk), 0, 'held growth: the block re-anchors without crossings');
}

// 8. splay is untouched by the cut: paging only moves the lift.
{
    const bk = deck(4);
    bk.setForm('splay', { cols: 2, gapX: 4, gapY: 6, lift: 8 });
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    bk.pageTo(0);
    for (let s = 0; s < 120; s++) bk.update(1 / 60);
    ok(near(bk.sheets[0].node.position.z, 8, 0.06) && near(bk.sheets[3].node.position.z, 0, 0.06), 'splay: the lift moved to the new head');
}

function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`); }
function eq6(a, b, m) { ok(a.length === b.length && a.every((v, i) => near(v, b[i], 0.01)), `${m} (got ${a.map((v) => Math.round(v * 100) / 100)})`); }

// ---- an ASIDE rides beside the book: right of the cover, height-fit, in the seat box ----
{
    const bk = deck(3);
    bk.bindCover({ pad: 2 });
    const win = new THREE.Object3D();
    win.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -10, -1), new THREE.Vector3(40, 0, 1));   // 40×10, top-anchored
    const away = new THREE.Group();
    away.add(win);
    bk.setAside(win, { gap: 5 });
    ok(win.parent === bk, 'setAside parents the window to the book');
    const lb = bk.layoutBounds();
    const coverH = lb.max.y - lb.min.y + 4;
    near(win.scale.x, coverH / 10, 1e-6) ? pass++ : (fail++, console.log(`  ✗ aside height fits the cover (scale ${win.scale.x}, want ${coverH / 10})`));
    const wb = win.getLocalBounds().clone().applyMatrix4(win.matrix.compose(win.position, win.quaternion, win.scale));
    ok(near(wb.min.x, lb.max.x + 2 + 5, 1e-6), `aside starts gap past the cover's right edge (x ${wb.min.x})`);
    ok(near((wb.min.y + wb.max.y) / 2, (lb.min.y + lb.max.y) / 2, 1e-6), 'aside is centered on the book vertically');
    const seat = bk.getSeatBounds();
    ok(seat.max.x >= wb.max.x - 1e-6, 'the seat box holds the aside');
    ok(bk.getLocalBounds().max.x === lb.max.x, 'framing keeps the page box');
    // docked away: untouched, and out of the seat
    away.attach(win);
    win.position.set(123, 4, 5);
    bk.syncCover();
    ok(win.position.x === 123, 'a window docked away is left alone');
    ok(bk.getSeatBounds().max.x < wb.max.x, 'and the seat box lets it go');
    // dispose hands a riding aside back to the book's parent
    bk.attach(win);
    const shelf = new THREE.Group();
    shelf.add(bk);
    bk.dispose();
    ok(win.parent === shelf, "dispose hands the aside to the book's parent, never disposes it");
}

console.log(`\nbook-deck.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
