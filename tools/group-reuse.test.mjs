// group-reuse.test.mjs — the group-texel id lifecycle: reuse, reset, the dead group.
//
//   bun tools/group-reuse.test.mjs
//
// Group ids used to retire forever; a long session's relayout churn (library
// volumes rebuild fresh each pass) marched the id space to the 16k texture wall,
// where createGroup silently returned 0 — THE DEAD GROUP. Every exhausted view
// then wrote pose/alpha into row 0, resurrecting every tombstoned range in the
// field: covers/pages flapping alpha 0↔1, dead glyph masses popping in at random
// poses, frame collapse. These tests lock the fix: released ids RECYCLE (row
// reset to fresh defaults, dark while free), exhaustion fails LOUD and returns
// 0, and 0 is a universal no-op sink for every writer.

import './headless-canvas.mjs';
import * as THREE from 'three';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import GlyphField, { GROUP_COLS } from '../packages/glyph3d-core/src/GlyphField.js';
import { MegaFieldView } from '../packages/glyph3d-core/src/MegaGlyphField.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const host = new THREE.Object3D();
const field = new GlyphField(host, HEADLESS_ATLAS, { maxInstances: 64, maxGroups: 8 });
const row = (g, col, lane) => field._groupData[(g * GROUP_COLS + col) * 4 + lane];

// ── release → reuse, reset, dark-while-free ──
{
    const a = field.createGroup();
    const b = field.createGroup();
    ok(a > 0 && b > 0 && a !== b, 'live ids are distinct and never 0');

    field.setGroupOffset(a, { x: 9, y: 9, z: 9 });
    field.setGroupAlpha(a, 0.5);
    field.releaseGroup(a);
    ok(row(a, 2, 3) === 0, 'a released row goes dark (alpha 0) while free');
    ok(row(a, 0, 0) === 0, 'a released row drops its pose');

    const c = field.createGroup();
    ok(c === a, 'the released id is reused before the counter advances');
    ok(row(c, 2, 3) === 1 && row(c, 3, 0) === 1 && row(c, 1, 3) === 1,
        'a reused row starts fresh (color a=1, scale 1, quat identity)');

    field.releaseGroup(c);
    field.releaseGroup(c);   // double release
    ok(field.createGroup() === c && field.createGroup() !== c,
        'double-release hands the id out ONCE');

    field.releaseGroup(0);
    ok(field.createGroup() !== 0, 'group 0 is never releasable, never handed out');
}

// ── exhaustion: loud, returns the dead group, counter stops marching ──
{
    const f2 = new GlyphField(new THREE.Object3D(), HEADLESS_ATLAS, { maxInstances: 64, maxGroups: 4 });
    f2._growGroupTexture = () => {};   // pin the wall where it stands
    const got = [];
    for (let i = 0; i < 8; i++) got.push(f2.createGroup());
    ok(got.slice(0, 3).every((g) => g > 0 && g < 4), 'ids hand out to the wall');
    ok(got.slice(3).every((g) => g === 0), 'past the wall every claim is the dead group');
    ok(f2._groupExhaustionNoted === true, 'exhaustion is LOUD (noted once)');
    ok(f2._groupCount === 4, 'the counter stops at the wall (no march to Infinity)');
    f2.releaseGroup(2);
    ok(f2.createGroup() === 2, 'a release un-exhausts: the freed id serves the next claim');
}

// ── the view lifecycle: dispose recycles, dead writers no-op on 0 ──
{
    const tombstones = [];
    const mega = {
        field,
        views: [],
        arena: { markFarDirty() {} },
        _tombstone(v) { tombstones.push(v); v.slotBase = -1; v.byteCount = 0; },
    };
    const v1 = new MegaFieldView(mega, new THREE.Object3D(), { r: 1, g: 1, b: 1 });
    mega.views.push(v1);
    const id1 = v1.groupId;
    ok(id1 > 0, 'a view claims a live group');

    v1.dispose();
    ok(tombstones[0] === v1, 'dispose tombstones the range BEFORE the id recycles');
    ok(v1.groupId === 0, 'a disposed view holds the dead group');

    field.setGroupAlpha(0, 0);                    // the dead group's resting truth
    v1.setGroupAlpha(0, 1);                       // a stale writer after dispose
    v1.setGroupColor(0, { r: 1, g: 0, b: 0 });
    v1.setClipYRange(1, 2);
    ok(row(0, 2, 3) === 0, 'stale writes from a disposed view CANNOT resurrect group 0');

    const v2 = new MegaFieldView(mega, new THREE.Object3D(), { r: 1, g: 1, b: 1 });
    ok(v2.groupId === id1, "the disposed view's id serves the next view");
    ok(row(v2.groupId, 2, 3) === 1, 'and its row is fresh, not the corpse');
}

console.log(`\ngroup-reuse: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
