// dock-labels.test.mjs — headless behavior lock for Label3D (the generalized baked-pill
// plate Button3D now extends) and the CameraDock tile nameplates built on it.
//
//   bun tools/dock-labels.test.mjs
//
// Label3D is the interaction-free extraction of Button3D's pill: a baked CanvasTexture
// plate any Object3D can wear, pick-inert (userData.isMarker), rebakable in place
// (setLabel/setColor). Button3D extends it and re-enables picking for its chrome role.
// The CameraDock gives every docked tile a nameplate wearing the tile's identity hue
// (the "which tiny tile is which" solver), floated above the slot box, hidden while the
// window is framed, rebaked on resize, torn down on release/dismiss.
//
// The bake needs a 2d canvas; the shared headless stub stands in for the DOM (bake runs at
// construction, not import, so the stub is live before any Label3D is made).

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';
import { setPipelineArena } from '../packages/glyph3d-core/src/compute/GlyphLayoutCompute.js';
import { makeSubstrate } from './label-substrate-mock.mjs';
import Label3D from '../packages/glyph3d-core/src/components/Label3D.js';
import Button3D from '../packages/glyph3d-core/src/components/Button3D.js';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';

// The tile nameplates are FieldLabels on the shared substrates — give the dock a
// headless substrate so plate writes (fill bytes) and view alpha are observable.
const SUB = makeSubstrate();
setPipelineArena(SUB.arena);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// ── Label3D: pick-inert plate, rebake in place ──
{
    const label = new Label3D({ label: 'hi', height: 2 });
    ok(label.userData.isMarker === true, 'Label3D is a pick-inert marker');
    const w0 = label.width;
    label.setLabel('a much longer name');
    ok(label.width > w0, `setLabel rebakes wider (got ${label.width} vs ${w0})`);
    const w1 = label.width;
    label.setLabel('a much longer name');
    ok(label.width === w1, 'setLabel with unchanged text is a no-op');
    label.setColor(0xff0000);
    ok(label.color === 0xff0000 && label.width === w1, 'setColor keeps text/width');
    label.dispose();
}

// ── Button3D: extends Label3D, stays a pick target, keeps its state visuals ──
{
    const b = new Button3D({ label: 'Pin', height: 1.5, role: 'pin' });
    ok(b instanceof Label3D, 'Button3D extends Label3D');
    ok(!b.userData.isMarker, 'Button3D re-enables picking (no isMarker)');
    ok(b.name === 'Button3D:pin', `Button3D keeps its chrome name (got ${b.name})`);
    const op0 = b.material.opacity;
    b.setHovered(true);
    ok(b.material.opacity > op0 && b.scale.x > 1, 'hover fades up + pops');
    b.setHovered(false);
    b.setActive(true);
    ok(b.material.opacity > op0, 'active sticks a partial fade');
    b.dispose();
}

// ── CameraDock nameplates ──
const fakeTerminal = (name, cols, rows) => {
    const g = new THREE.Object3D();
    g.name = name;
    g.cols = cols; g.rows = rows;
    g._metrics = { lineSpacing: 0.5 }; // text metrics → the nameplate sizes in cell rows
    g.getBounds = () => new THREE.Box3(new THREE.Vector3(0, -10, 0), new THREE.Vector3(20, 0, 0));
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -10, 0), new THREE.Vector3(20, 0, 0));
    g.setBorder = () => {};
    g.setBorderFlag = () => {};
    g.setControlActive = () => {};
    return g;
};

{
    const dock = new CameraDock({ atlas: HEADLESS_ATLAS });
    const term = fakeTerminal('term-1', 80, 24);
    dock.lock('term-1', term);

    const e = dock.entries.get('term-1');
    ok(!!e.label, 'lock creates a nameplate');
    ok(e.label.text === 'term-1 · 80×24', `nameplate reads name + dims (got "${e.label.text}")`);
    ok(e.label._plateCfg.color === e.identityColor, 'nameplate wears the identity hue');
    ok(e.label.parent === dock, 'nameplate is a dock child (dock-local placement)');
    ok(e.label.visible === true, 'bar tile nameplate is visible');

    // Sizing: the plate rides the tile's own cell size — labelLines × lineSpacing × the
    // tile's rendered contain-fit scale (eff) — NOT a fraction of the slot box. With the
    // default view (viewH 100): box 11.5×10, content 20×10 → eff = min(11.5/20, 10/10) = 0.575.
    const eff = Math.min((100 * dock.boxFrac * dock.boxAspect) / 20, (100 * dock.boxFrac) / 10);
    const wantH = dock.labelLines * term._metrics.lineSpacing * eff;
    const renderedH = e.label.height * e.label.scale.x;
    ok(Math.abs(renderedH - wantH) < 1e-9, `nameplate height = ${dock.labelLines} cell rows at eff (got ${renderedH}, want ${wantH})`);
    ok(renderedH < (100 * dock.boxFrac) * 0.25, `nameplate is small next to the slot box (${renderedH} vs box ${100 * dock.boxFrac})`);

    // Frame it (spotlight → sole pane): the ghost holds the slot, the nameplate hides.
    dock.spotlight('term-1');
    ok(dock.isFramed('term-1'), 'spotlight frames the tile');
    ok(e.label.visible === false, 'framed tile hides its nameplate');
    dock.spotlight('term-1');
    ok(!dock.isFramed('term-1') && e.label.visible === true, 'unframe returns the nameplate');

    // Resize → reflowTile rebakes the live info.
    term.cols = 120; term.rows = 40;
    dock.reflowTile('term-1');
    ok(e.label.text === 'term-1 · 120×40', `resize rebakes the nameplate (got "${e.label.text}")`);

    // Release tears the nameplate down.
    const lbl = e.label;
    dock.release('term-1');
    ok(e.label === null, 'release clears the entry nameplate');
    ok(lbl.parent === null && !dock.children.includes(lbl), 'release lifts the nameplate out of the dock');

    // Dismiss (window closed while docked) tears down too.
    const term2 = fakeTerminal('term-2', 80, 24);
    dock.lock('term-2', term2);
    const e2 = dock.entries.get('term-2');
    dock.dismiss('term-2');
    ok(e2.label === null && !dock.children.some((c) => c.name === 'dock-label:term-2'), 'dismiss disposes the nameplate');

    // A non-terminal window (no cols/rows) gets a bare-name plate.
    const grid = new THREE.Object3D();
    grid.name = 'src/main.js';
    grid.getBounds = () => new THREE.Box3(new THREE.Vector3(0, -10, 0), new THREE.Vector3(20, 0, 0));
    grid.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -10, 0), new THREE.Vector3(20, 0, 0));
    dock.lock('file-1', grid);
    ok(dock.entries.get('file-1').label.text === 'src/main.js', 'plain window gets a bare-name plate');

    dock.dispose();
    ok(!dock.children.some((c) => c.name?.startsWith('dock-label:')), 'dock.dispose leaves no nameplates');
}

// ── placement: the plate hugs the CONTENT bottom edge, close under the tile ──
{
    const dock = new CameraDock({ atlas: HEADLESS_ATLAS, layout: 'linear' });
    const term = fakeTerminal('term-9', 80, 24);
    dock.lock('term-9', term);
    const e = dock.entries.get('term-9');
    const camera = { fov: 70, aspect: 1.6, quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };
    dock.update(1, camera); // park + finish the slide (duration 0.167 << 1s)
    dock.update(1, camera); // second tick: labels' position tween also lands

    const eff = Math.min((dock._viewH * dock.boxFrac * dock.boxAspect) / 20, (dock._viewH * dock.boxFrac) / 10);
    const lh = dock.labelLines * term._metrics.lineSpacing * eff;
    const rowY = -dock._viewH * 0.5 * dock.bottomFrac;
    const wantY = rowY - ((10 * eff) / 2 + lh * 0.8); // content bottom − gap − half the plate
    ok(Math.abs(e.label.position.y - wantY) < 1e-6, `nameplate hugs the content bottom (got y=${e.label.position.y.toFixed(3)}, want ${wantY.toFixed(3)})`);
    const gap = (rowY - (10 * eff) / 2) - e.label.position.y - lh / 2;
    ok(gap < lh && gap > 0, `gap under the tile is under one plate height (got ${gap.toFixed(3)} of plate ${lh.toFixed(3)})`);
    dock.dispose();
}

// ── setParam: the nameplate knobs behind the Settings panel's Dock dials ──
{
    const dock = new CameraDock({ atlas: HEADLESS_ATLAS, layout: 'linear' });
    const term = fakeTerminal('term-cfg', 80, 24);
    dock.lock('term-cfg', term);
    const e = dock.entries.get('term-cfg');
    const camera = { fov: 70, aspect: 1.6, quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };
    const settle = () => { dock.update(1, camera); dock.update(1, camera); };
    settle();

    const eff = Math.min((dock._viewH * dock.boxFrac * dock.boxAspect) / 20, (dock._viewH * dock.boxFrac) / 10);
    const rowY = -dock._viewH * 0.5 * dock.bottomFrac;

    // size: the plate re-tracks the new cell-row count
    ok(dock.setParam('labelLines', 5), 'setParam labelLines accepted');
    settle();
    const lh5 = 5 * term._metrics.lineSpacing * eff;
    ok(Math.abs(e.label.height * e.label.scale.x - lh5) < 1e-9, `labelLines resizes the plate (got ${e.label.height * e.label.scale.x}, want ${lh5})`);

    // position: 'above' parks it over the content top edge
    ok(dock.setParam('labelPosition', 'above'), 'setParam labelPosition accepted');
    settle();
    const wantAbove = rowY + (10 * eff) / 2 + lh5 * (0.5 + dock.labelGap);
    ok(Math.abs(e.label.position.y - wantAbove) < 1e-6, `above parks over the tile (got ${e.label.position.y.toFixed(3)}, want ${wantAbove.toFixed(3)})`);

    // gap: widens the standoff, still above
    ok(dock.setParam('labelGap', 1.0), 'setParam labelGap accepted');
    settle();
    const wantGap = rowY + (10 * eff) / 2 + lh5 * (0.5 + 1.0);
    ok(Math.abs(e.label.position.y - wantGap) < 1e-6, `labelGap widens the standoff (got ${e.label.position.y.toFixed(3)}, want ${wantGap.toFixed(3)})`);

    // opacity pushes to the live label: the view alpha carries v, the fill resets
    // to 1 so the NET plate opacity is exactly v (the substrate contract)
    ok(dock.setParam('labelOpacity', 0.4), 'setParam labelOpacity accepted');
    const labelView = SUB.mega.views.find((v) => v.node === e.label._anchor);
    ok(labelView && Math.abs(labelView.alpha - 0.4) < 1e-9, 'opacity pushes to the view alpha lane');
    const fillA = SUB.panels.mesh.geometry.attributes.panelFill.array[e.label._panelSlot * 4 + 3];
    ok(fillA === 255, 'plate fill alpha resets to 1 (net plate = v)');

    // format rebakes live; 'off' hides; restoring brings it back
    ok(dock.setParam('labelFormat', 'name'), 'setParam labelFormat name accepted');
    ok(e.label.text === 'term-cfg', `format name rebakes (got "${e.label.text}")`);
    dock.setParam('labelFormat', 'dims');
    ok(e.label.text === '80×24', `format dims rebakes (got "${e.label.text}")`);
    dock.setParam('labelFormat', 'off');
    ok(e.label.visible === false, 'format off hides the plate');
    dock.setParam('labelFormat', 'name+dims');
    ok(e.label.visible === true && e.label.text === 'term-cfg · 80×24', 'format restored');

    // rejects: bad enum, NaN, unknown key
    ok(!dock.setParam('labelPosition', 'left'), 'bad enum rejected');
    ok(!dock.setParam('labelLines', NaN), 'NaN rejected');
    ok(!dock.setParam('nope', 1), 'unknown key rejected');
    dock.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
