// field-label.test.mjs — headless behavior lock for FieldLabel on WebGL2 instanced rendering.
//
//   bun tools/field-label.test.mjs
//
// FieldLabel's text is a live InstancedField, layered over an optional panel-material pill plate.
// These tests lock the CPU truths: synchronous measure contract (.width/.height answer
// in the construction tick — CameraDock/Book read them same-tick), the anchor transform
// that maps text layout onto the centered-origin contract, plate styling, Tab3D states,
// and Book tab diffing.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import FieldLabel from '../packages/glyph3d-core/src/collections/FieldLabel.js';
import Tab3D from '../packages/glyph3d-core/src/components/Tab3D.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const near = (a, b, msg) => ok(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`);

// lineHeight 3 → text scale 3/0.4 = 7.5 → 1.5 world units per char (mono fallback)
const LH = 3, CHAR = 1.5, PAD_X = 0.72 * LH * 2, PAD_Y = 0.42 * LH * 2;

// ── measure contract & construction ──
{
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
    ok(l._staged === true, 'plated label is staged');
    ok(l.userData.isMarker === true, 'label is pick-inert marker');
    l.dispose();
    bare.dispose();
}

// ── WebGL2 instanced rendering structure & updates ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'hello', lineHeight: LH, plate: { color: 0x1a2a3e, opacity: 0.8 } });

    ok(l._instancedField instanceof InstancedField, 'text layer is an InstancedField');
    ok(l._anchor.children.includes(l._instancedField.instanceMesh), 'instanced field mesh rides anchor');
    ok(l._plateMesh != null, 'plate mesh created');
    ok(l._anchor.children.includes(l._plateMesh), 'plate mesh rides anchor');

    // Anchor: centers text block
    near(l._anchor.scale.x, 7.5, 'anchor scales metrics pitch → lineHeight');
    near(l._anchor.position.x, -3.75, 'anchor centers the block (x)');
    near(l._anchor.position.y, 1.5, 'anchor centers the block (y)');
    near(l._anchor.position.y + l._plateMesh.position.y * l._anchor.scale.y, 0, 'plate centered at y=0');
    near(l._instancedField.instanceMesh.position.z * l._anchor.scale.z, 1.0, 'text sits +1 unit in front of plate');

    // Plate geometry
    near(l._plateMesh.scale.x, 1.576, 'plate width');
    near(l._plateMesh.scale.y, 0.736, 'plate height');
    near(l._plateAlpha, 0.8, 'plate initial opacity');

    // setText restages in place
    l.setText('hi');
    ok(l.text === 'hi', 'text updated');
    near(l._plateMesh.scale.x, 0.976, 'plate width shrunk for shorter text');

    // setOpacity fades text and plate
    l.setOpacity(0.4);
    near(l._plateAlpha, 0.4, 'setOpacity drives plate opacity');

    // setPlateColor
    l.setPlateColor(0xff0000);
    ok(l._plateCfg.color === 0xff0000, 'setPlateColor rewrites plate color');

    // setTextColor
    l.setTextColor({ r: 0.9, g: 0.1, b: 0.1 });
    ok(l.textColor.r === 0.9, 'setTextColor updates text color');

    // Empty text clears field, keeps min-width plate
    l.setText('');
    ok(l._instancedField.getGlyphCount() === 0, 'empty text clears glyphs');
    near(l._plateMesh.scale.x, Math.max(2 * 0.72 * 0.4, 0.4), 'empty pill keeps min width');

    // Dispose
    l.dispose();
    ok(l._instancedField === null, 'dispose cleans up instanced field');
    ok(l._plateMesh === null, 'dispose cleans up plate mesh');
}

// ── hairline opt-out ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'plain', lineHeight: LH, plate: { color: 0x333333, opacity: 0.8, hairline: false } });
    ok(l._platePanel.getBorderFlags() === 0, 'hairline: false leaves border flags clear');
    l.dispose();
}

// ── Tab3D: state changes ──
{
    const t = new Tab3D({ atlas: HEADLESS_ATLAS, text: 'src', lineHeight: LH, activeColor: 0x6ee7a0 });
    ok(t._plateMesh != null, 'a tab is always plated');
    ok(t.userData.isTab === true, 'tab marker');
    near(t._plateAlpha, 0.85, 'resting plate opacity');

    t.setHovered(true);
    near(t.scale.x, 1.08, 'hover pops node scale');
    ok(t._plateAlpha > 0.85, 'hover boosts plate opacity');
    t.setHovered(false);
    near(t.scale.x, 1, 'hover release restores scale');
    near(t._plateAlpha, 0.85, 'hover release restores opacity');

    const restCol = t._plateCfg.color;
    t.setActive(true);
    ok(t._plateCfg.color === 0x6ee7a0, 'active recolors plate to active hue');
    ok(t._plateAlpha > 0.85, 'active strengthens plate opacity');
    t.setActive(false);
    ok(t._plateCfg.color === restCol, 'deactivate restores resting hue');
    t.dispose();
}

// ── Book.bindTabs is a DIFF: re-binds keep tabs ──
{
    const { default: Book } = await import('../packages/glyph3d-core/src/collections/Book.js');
    const THREE = await import('three');
    const leafOf = (name) => { const o = new THREE.Object3D(); o.userData.name = name; return o; };
    const book = new Book(leafOf('alpha.js'));
    book.addSheet({ recto: leafOf('beta.js') });

    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH });
    const [tA, tB] = book.tabs.map((t) => t.tab);

    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH * 2 });   // per-relayout re-bind
    ok(book.tabs[0].tab === tA && book.tabs[1].tab === tB, 're-bind reuses Tab3D per sheet');
    near(tA.lineHeight, LH * 2, 're-bind re-pitches in place');

    let tBDisposed = false;
    const origDispose = tB.dispose.bind(tB);
    tB.dispose = () => { tBDisposed = true; origDispose(); };

    book.removeSheet(1);
    book.bindTabs({ atlas: HEADLESS_ATLAS, lineHeight: LH * 2 });
    ok(book.tabs.length === 1 && book.tabs[0].tab === tA, 'removed sheet drops only its own tab');
    ok(tBDisposed, 'dropped tab is disposed');
}

console.log(`\nfield-label: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
