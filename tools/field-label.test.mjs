// field-label.test.mjs — headless behavior lock for FieldLabel, the editable glyph-field
// label entity (the "special case of a CodeGrid with labeling primitives").
//
//   bun tools/field-label.test.mjs
//
// FieldLabel's text is a live GlyphField (setText rebuilds synchronously — the edit path
// the label.set/append verbs drive), layered over an optional baked pill plate. The origin
// is the CENTER of the block so callers place it like the baked plates did; width/height
// are the plate dims at scale 1 (the CameraDock placement contract). With the shaper-less
// stub atlas the mono fallback emits exact positions: char advance = charWidth × scale,
// scale = lineHeight / metrics.lineSpacing (8×16px cells → 16-unit pitch at worldScale 1).

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import FieldLabel from '../packages/glyph3d-core/src/collections/FieldLabel.js';
import GlyphField from '../packages/glyph3d-core/src/GlyphField.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const near = (a, b, msg) => ok(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`);

// lineHeight 3 → text scale 3/16 → 1.5 world units per char (mono fallback)
const LH = 3, CHAR = 1.5, PAD_X = 0.72 * LH * 2, PAD_Y = 0.42 * LH * 2;

// ── plated label: text is a field, size tracks text, origin is centered ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'hello', lineHeight: LH, plate: { color: 0xb3d9f5, opacity: 0.85 } });
    ok(l._field instanceof GlyphField, 'text layer is a GlyphField');
    ok(l.children.includes(l._field.instanceMesh), 'the field mesh rides the label');
    near(l.width, 5 * CHAR + PAD_X, 'plate width wraps the text + pad');
    near(l.height, LH + PAD_Y, 'plate height wraps one row + pad');

    l.setText('hello world!!'); // 13 chars
    near(l.width, 13 * CHAR + PAD_X, 'setText rebuilds — width tracks the edit');
    ok(l.text === 'hello world!!', 'text getter reads the edit');

    const b = l.getLocalBounds();
    near(b.min.x, -l.width / 2, 'origin-centered: bounds min.x');
    near(b.max.x, l.width / 2, 'origin-centered: bounds max.x');
    near(b.min.y, -l.height / 2, 'origin-centered: bounds min.y');

    l.setOpacity(0.4);
    near(l._plate.mesh.material.opacity, 0.4, 'setOpacity fades the plate');
    l.setPlateColor(0xff0000);
    ok(l._plateCfg.color === 0xff0000, 'setPlateColor repaints');
    l.dispose();
    ok(l.children.length === 0, 'dispose leaves no children');
}

// ── multi-line: rows stack by lineHeight, the plate grows ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'one\ntwo\nthree!', lineHeight: LH, plate: { color: 0x8899aa } });
    near(l.height, 3 * LH + PAD_Y, 'three rows + pad');
    near(l.width, 6 * CHAR + PAD_X, 'width follows the LONGEST line');
    near(l._field.instanceMesh.position.y, LH, 'line stack recenters on the origin');
    l.setText('one');
    near(l.height, LH + PAD_Y, 'shrinking back to one row');
    l.dispose();
}

// ── plateless: bare text, dims are the text block ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'bare', lineHeight: LH });
    ok(!l._plate, 'no plate without the option');
    near(l.width, 4 * CHAR, 'width is the bare text block');
    near(l.height, LH, 'height is one row');
    l.dispose();
}

// ── idle edits are cheap: unchanged text is a no-op ──
{
    const l = new FieldLabel({ atlas: HEADLESS_ATLAS, text: 'same', lineHeight: LH });
    const f = l._field;
    l.setText('same');
    ok(l._field === f, 'unchanged text keeps the field (no rebuild)');
    l.setText('same!');
    ok(l._field !== f, 'changed text rebuilds');
    l.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
