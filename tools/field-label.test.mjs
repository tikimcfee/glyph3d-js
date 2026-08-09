// field-label.test.mjs — headless behavior lock for FieldLabel on the SHARED substrates.
//
//   bun tools/field-label.test.mjs
//
// FieldLabel's text is an arena item + mega-field view; its plate is a PanelField slot.
// These tests lock the CPU truths: the synchronous measure contract (.width/.height answer
// in the construction tick — CameraDock/Book read them same-tick), the anchor transform
// that maps stage space (metrics pitch, rows down from y=0) onto the centered-origin
// contract, the staging calls into the arena, the plate slot's lanes, and Tab3D's state
// writes. The GPU truths (glyphs land on flush, pose sweep, visibility mirror) are live
// gates. With no arena the mono fallback measures: 8×16px cells at worldScale 0.025 →
// lineSpacing 0.4, so lineHeight 3 → scale 7.5 → 1.5 world units per char.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import { setPipelineArena } from '../packages/glyph3d-core/src/compute/GlyphLayoutCompute.js';
import { makeSubstrate } from './label-substrate-mock.mjs';
import FieldLabel from '../packages/glyph3d-core/src/collections/FieldLabel.js';
import Tab3D from '../packages/glyph3d-core/src/components/Tab3D.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const near = (a, b, msg) => ok(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`);

// lineHeight 3 → text scale 3/0.4 = 7.5 → 1.5 world units per char (mono fallback)
const LH = 3, CHAR = 1.5, PAD_X = 0.72 * LH * 2, PAD_Y = 0.42 * LH * 2;

// ── measure contract, NO substrate (the sync guarantee stands alone) ──
{
    setPipelineArena(null);
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'hello', lineHeight: LH, plate: { color: 0xb3d9f5, opacity: 0.85 } });
    near(l.width, 5 * CHAR + PAD_X, 'plate width wraps the text + pad');
    near(l.height, LH + PAD_Y, 'plate height wraps one row + pad');
    l.setText('hello world!!'); // 13 chars
    near(l.width, 13 * CHAR + PAD_X, 'setText re-measures synchronously');
    ok(l.text === 'hello world!!', 'text getter reads the edit');
    const b = l.getLocalBounds();
    near(b.min.x, -l.width / 2, 'origin-centered: bounds min.x');
    near(b.max.x, l.width / 2, 'origin-centered: bounds max.x');
    near(b.min.y, -l.height / 2, 'origin-centered: bounds min.y');

    const bare = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'ab\ncdef', lineHeight: LH });
    near(bare.width, 4 * CHAR, 'plateless width = longest line');
    near(bare.height, 2 * LH, 'plateless height = rows × lineHeight');
    ok(l._staged === false, 'no substrate → measured but unstaged');
}

// ── staging through the substrate ──
{
    const { arena, mega, panels } = makeSubstrate();
    setPipelineArena(arena);
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'hello', lineHeight: LH, plate: { color: 0x1a2a3e, opacity: 0.8 } });

    ok(arena.staged.length === 1, 'construction stages the text');
    const p = arena.staged[0].params;
    ok(p.wrapWidth === 0 && p.zStep === 0 && p.page === null, 'labels stage wrap-0, unpaged');
    near(p.lineHeight, 0.4, 'staged at the metrics pitch');
    ok(p.field === mega.views[0], 'staged onto the label view');
    ok(arena.flushes === 1, 'flush requested (not awaited)');

    // Anchor: stage block 'hello' = wu 1.0, one row → cx 0.5, cy 0.2, s 7.5.
    near(l._anchor.scale.x, 7.5, 'anchor scales metrics pitch → lineHeight');
    near(l._anchor.position.x, -3.75, 'anchor centers the block (x)');
    near(l._anchor.position.y, -1.5, 'anchor centers the block (y)');

    // Plate slot lanes (stage units): rect (0.5, 0.2, 1.576, 0.736), pill radius.
    const slot = l._panelSlot;
    ok(slot != null && panels.ownerOf(slot) === null, 'plate slot allocated, pick-inert');
    const rect = panels.mesh.geometry.attributes.panelRect;
    const aux = panels.mesh.geometry.attributes.panelAux;
    near(rect.array[slot * 4], 0.5, 'plate rect center x');
    near(rect.array[slot * 4 + 1], 0.2, 'plate rect center y');
    near(rect.array[slot * 4 + 2], 1.576, 'plate rect width');
    near(rect.array[slot * 4 + 3], 0.736, 'plate rect height');
    ok(aux.array[slot * 4 + 1] === mega.views[0].groupId, 'plate rides the view group texel');
    near(aux.array[slot * 4 + 3], 0.736 * 0.23, 'pill corner radius = 0.23 × plate height');
    ok(aux.array[slot * 4 + 2] === 1, 'plate visible');
    const fill = panels.mesh.geometry.attributes.panelFill;
    ok(fill.array[slot * 4 + 3] === Math.round(0.8 * 255), 'plate fill alpha = plate opacity');

    // setText restages: old item disposed, same view + slot reused.
    l.setText('hi');
    ok(arena.staged[0].disposed && arena.staged.length === 2, 'restage disposes the old item');
    ok(arena.staged[1].params.field === mega.views[0] && mega.views.length === 1, 'the view is rented once');
    ok(l._panelSlot === slot, 'the plate slot is rented once');

    // setOpacity fades text and plate to exactly v (fill resets to 1, group carries v).
    l.setOpacity(0.4);
    near(mega.views[0].alpha, 0.4, 'setOpacity drives the view alpha lane');
    ok(fill.array[slot * 4 + 3] === 255, 'setOpacity moves the plate fade onto the group lane');

    l.setPlateColor(0xff0000);
    ok(fill.array[slot * 4] === 255 && fill.array[slot * 4 + 2] === 0, 'setPlateColor rewrites the fill bytes');

    // Empty text keeps the pill (min width), clears the view range.
    l.setText('');
    ok(mega.views[0].cleared === 1, 'empty text clears the view');
    near(rect.array[slot * 4 + 2], Math.max(2 * 0.72 * 0.4, 0.4), 'empty pill keeps the min width');

    l.dispose();
    ok(arena.staged[1].disposed, 'dispose releases the arena item');
    ok(mega.views[0].dead, 'dispose retires the view');
    ok(l._panelSlot === null, 'dispose frees the plate slot');
    setPipelineArena(null);
}

// ── late substrate: born without one, staged on scene arrival ──
{
    setPipelineArena(null);
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'late', lineHeight: LH, plate: { color: 0x8899aa, opacity: 0.85 } });
    ok(!l._staged, 'unstaged without an arena');
    const { arena, scene } = makeSubstrate();
    setPipelineArena(arena);
    scene.add(l);   // 'added' fires → restage finds the substrate
    ok(l._staged && arena.staged.length === 1, 'scene arrival stages through the live substrate');
    setPipelineArena(null);
}

// ── Tab3D: state = lane writes ──
{
    const { arena, panels } = makeSubstrate();
    setPipelineArena(arena);
    const t = new Tab3D({ atlas: HEADLESS_ATLAS, text: 'src', lineHeight: LH, activeColor: 0x6ee7a0 });
    const slot = t._panelSlot;
    const fill = panels.mesh.geometry.attributes.panelFill;
    ok(slot != null, 'a tab is always plated');
    ok(t.userData.isTab === true, 'tab marker');
    ok(fill.array[slot * 4 + 3] === Math.round(0.85 * 255), 'resting plate opacity');

    t.setHovered(true);
    near(t.scale.x, 1.08, 'hover pops the node scale (the pose sweep carries it)');
    ok(fill.array[slot * 4 + 3] === 255, 'hover boosts the fill alpha byte');
    t.setHovered(false);
    near(t.scale.x, 1, 'hover release restores scale');
    ok(fill.array[slot * 4 + 3] === Math.round(0.85 * 255), 'hover release restores opacity');

    const restR = fill.array[slot * 4];
    t.setActive(true);
    ok(fill.array[slot * 4] !== restR, 'active recolors the fill to the active hue');
    ok(fill.array[slot * 4 + 3] === 255, 'active strengthens the plate');
    t.setActive(false);
    ok(fill.array[slot * 4] === restR, 'deactivate restores the resting hue');
    setPipelineArena(null);
}

// ── Book.bindTabs is a DIFF: re-binds keep tabs (texel rentals survive relayouts) ──
{
    const { default: Book } = await import('../packages/glyph3d-core/src/collections/Book.js');
    const THREE = await import('three');
    const { arena, mega } = makeSubstrate();
    setPipelineArena(arena);
    const leafOf = (name) => { const o = new THREE.Object3D(); o.userData.name = name; return o; };
    const book = new Book(leafOf('alpha.js'));
    book.addSheet({ recto: leafOf('beta.js') });

    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH });
    const [tA, tB] = book.tabs.map((t) => t.tab);
    const viewsAfterBind = mega.views.length;

    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH * 2 });   // the per-relayout re-bind
    ok(book.tabs[0].tab === tA && book.tabs[1].tab === tB, 're-bind reuses the Tab3D per sheet');
    ok(mega.views.length === viewsAfterBind, 're-bind rents no new views');
    near(tA.lineHeight, LH * 2, 're-bind re-pitches in place');

    book.removeSheet(1);
    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH * 2 });
    ok(book.tabs.length === 1 && book.tabs[0].tab === tA, 'a removed sheet drops only its own tab');
    ok(mega.views.find((v) => v.node === tB._anchor)?.dead === true, "the dropped tab's view retires");
    setPipelineArena(null);
}

console.log(`\nfield-label: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
