// panel-material-check.mjs — the window panel material (fill + in-shader border) constructs and
// restyles without a GPU. This is a PLUMBING check: it proves the node material builds, the
// transparent flag tracks opacity, and the setters don't throw. The actual border PIXELS
// (distance-to-edge → rim) are a fragment shader — verified live in the dev loop, not here.
//
//   bun tools/panel-material-check.mjs

import { createPanelMaterial } from '../packages/glyph3d-core/src/collections/panelMaterial.js';

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
  glass.setBorder({ color: 0x8ee6a8, width: 1.5, strength: 1 }); // width in screen pixels
  glass.setBorder({ strength: 0 });           // clear
  glass.setFill(0x000000);                     // color only
} catch (e) { threw = true; console.log('  threw:', e?.message); }
ok(!threw, 'setBorder / color-only setFill all run clean');

console.log(failures === 0 ? '\nPASS — panel material builds + restyles headless (border pixels verified live)'
                           : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
