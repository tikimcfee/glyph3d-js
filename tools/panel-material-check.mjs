// panel-material-check.mjs — the window panel material (fill + in-shader border) constructs and
// restyles without a GPU. This is a PLUMBING check: it proves the node material builds, the
// transparent flag tracks opacity, and the setters don't throw. The actual border PIXELS
// (distance-to-edge → rim) are a fragment shader — verified live in the dev loop, not here.
//
//   bun tools/panel-material-check.mjs

import { createPanelMaterial, BORDER_FLAGS, setPanelStateColorDefaults } from '../packages/glyph3d-core/src/collections/panelMaterial.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// Opaque fill → solid panel (occludes dock stacks), border nodes present.
const opaque = createPanelMaterial({ color: 0x101020, opacity: 1, depthWrite: true });
ok(opaque.material.constructor.name === 'MeshBasicNodeMaterial', 'builds a MeshBasicNodeMaterial');
ok(opaque.material.transparent === false, 'opacity 1 → not transparent (genuinely solid)');
ok(opaque.material.depthWrite === true, 'depthWrite preserved (occludes content behind it)');
ok(!!opaque.material.colorNode && !!opaque.material.opacityNode, 'fill + border live in colorNode/opacityNode');

// Translucent fill → transparent so the rim alpha can blend on a docked tile.
const glass = createPanelMaterial({ color: 0x101020, opacity: 0.9 });
ok(glass.material.transparent === true, 'opacity < 1 → transparent');

// Setters don't throw and the transparent flag follows live opacity.
glass.setFill(0x223355, 1);
ok(glass.material.transparent === false, 'setFill(opacity 1) → flips back to solid');
glass.setFill(null, 0.6);
ok(glass.material.transparent === true, 'setFill(opacity 0.6) → transparent again');

let threw = false;
try {
  glass.setBorder({ color: 0x8ee6a8, width: 1.5, intensity: 1 }); // width in screen pixels
  glass.setFill(0x000000);                     // color only
} catch (e) { threw = true; console.log('  threw:', e?.message); }
ok(!threw, 'setBorder / color-only setFill run clean');

// Flag bit-set: each subsystem owns its own bits; flips are independent.
glass.setBorderFlag(BORDER_FLAGS.DOCKED, true);
ok(glass.getBorderFlags() === BORDER_FLAGS.DOCKED, 'setBorderFlag(DOCKED) → only that bit');
glass.setBorderFlag(BORDER_FLAGS.HOVERED, true);
ok(glass.getBorderFlags() === (BORDER_FLAGS.DOCKED | BORDER_FLAGS.HOVERED), 'flags OR together (no clobber)');
glass.setBorderFlag(BORDER_FLAGS.DOCKED, false);
ok(glass.getBorderFlags() === BORDER_FLAGS.HOVERED, 'clearing one bit leaves the others');

// State colors: the shared focus/hover/input vocabulary. Per-panel live restyle takes on THIS panel.
glass.setStateColors({ focus: 0x112233, hover: 0x445566, input: 0x778899 });
const sc = glass.getStateColors();
ok(sc.focus === 0x112233 && sc.hover === 0x445566 && sc.input === 0x778899, 'setStateColors → all three uniforms updated');

// The module default is what a panel is BORN with — set it, and a NEW panel inherits it; existing
// panels keep their own (each owns its uniform, no shared mutation).
setPanelStateColorDefaults({ focus: 0x6ee7a0, hover: 0x9fd2ff, input: 0xf0b45a }); // restore canonical defaults
const born = createPanelMaterial({ color: 0x101020 });
const bc = born.getStateColors();
ok(bc.focus === 0x6ee7a0 && bc.hover === 0x9fd2ff && bc.input === 0xf0b45a, 'new panel born with the current module defaults');
ok(glass.getStateColors().focus === 0x112233, 'setPanelStateColorDefaults does NOT mutate existing panels');

console.log(failures === 0 ? '\nPASS — panel material builds + restyles headless (border pixels verified live)'
                           : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
