/**
 * panel-field.test.mjs — the instanced panel field's CPU truths.
 *
 * PanelField turns every window background panel into one instanced draw; these
 * tests lock the parts that don't need a GPU: the slot allocator (alloc/free/
 * reuse/growth with lane preservation), the per-instance lane writes landing at
 * the right offsets in the right encodings, the born-hidden invariant, and the
 * pick-block discipline (register once at capacity, re-register only on growth,
 * caller-owned material). The GPU truths (pose-from-texel, border shader, ID
 * pass) are covered by the live storm/pixel gates.
 *
 * Run: bun tools/panel-field.test.mjs
 */

import * as THREE from 'three';
import PanelField from '../packages/glyph3d-core/src/collections/PanelField.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ok  ${name}`); }
    else { failed++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const scene = new THREE.Scene();
const field = { _groupTexture: null };   // the group-texture owner (resolved per draw)

// ── Allocation ──────────────────────────────────────────────────────────────
{
    const pf = new PanelField({ scene, field, capacity: 4 });
    const a = pf.alloc('rowA', 7);
    const b = pf.alloc('rowB', 9);
    check('slots are distinct and sequential', a === 0 && b === 1);
    check('ownerOf resolves', pf.ownerOf(a) === 'rowA' && pf.ownerOf(b) === 'rowB');
    check('instanceCount tracks high-water', pf.mesh.geometry.instanceCount === 2);

    const aux = pf.mesh.geometry.attributes.panelAux;
    check('born hidden', aux.array[a * 4 + 2] === 0 && aux.array[b * 4 + 2] === 0);
    check('born with the owner group', aux.array[a * 4 + 1] === 7 && aux.array[b * 4 + 1] === 9);

    // ── Lane writes ─────────────────────────────────────────────────────────
    pf.setRect(b, 10, -20, 30, 40, -0.5);
    const rect = pf.mesh.geometry.attributes.panelRect;
    check('rect lands at the slot offset',
        rect.array[b * 4] === 10 && rect.array[b * 4 + 1] === -20 &&
        rect.array[b * 4 + 2] === 30 && rect.array[b * 4 + 3] === 40);
    check('rect z lands in aux', aux.array[b * 4] === -0.5);
    check('rect write does not touch neighbors', rect.array[a * 4 + 2] === 0);

    pf.setFill(b, 0x1a1a2e, 0.92);
    const fill = pf.mesh.geometry.attributes.panelFill;
    check('fill stores exact sRGB display bytes',
        fill.array[b * 4] === 0x1a && fill.array[b * 4 + 1] === 0x1a &&
        fill.array[b * 4 + 2] === 0x2e &&
        fill.array[b * 4 + 3] === Math.round(0.92 * 255));
    check('fill attribute is normalized', fill.normalized === true);

    pf.setVisible(b, true);
    check('visible bit set', aux.array[b * 4 + 2] === 1);

    pf.setFlags(b, 0b10110);
    const flags = pf.mesh.geometry.attributes.panelFlags;
    check('flags land as the whole byte', flags.array[b] === 0b10110);

    pf.setGroup(b, 3);
    check('group re-points', aux.array[b * 4 + 1] === 3);

    // ── Free + reuse ────────────────────────────────────────────────────────
    pf.free(b);
    check('freed slot hides + points at the dead group',
        aux.array[b * 4 + 2] === 0 && aux.array[b * 4 + 1] === 0);
    check('freed slot drops its owner and flags', pf.ownerOf(b) === null && flags.array[b] === 0);
    const c = pf.alloc('rowC', 5);
    check('free list reuses the slot', c === b && pf.ownerOf(c) === 'rowC');
    check('reused slot is born hidden again', aux.array[c * 4 + 2] === 0);
    check('instanceCount unchanged by reuse', pf.mesh.geometry.instanceCount === 2);
}

// ── Growth ──────────────────────────────────────────────────────────────────
{
    const pf = new PanelField({ scene, field, capacity: 2 });
    const s0 = pf.alloc('r0', 1);
    pf.setRect(s0, 1, 2, 3, 4, -9);
    pf.setFill(s0, 0xff0000, 1);
    pf.setFlags(s0, 5);
    pf.setVisible(s0, true);
    pf.alloc('r1', 2);
    const s2 = pf.alloc('r2', 3);   // forces growth past capacity 2
    check('growth: capacity doubled', pf._capacity === 4 && s2 === 2);
    const rect = pf.mesh.geometry.attributes.panelRect;
    const aux = pf.mesh.geometry.attributes.panelAux;
    const fill = pf.mesh.geometry.attributes.panelFill;
    const flags = pf.mesh.geometry.attributes.panelFlags;
    check('growth preserves rect lanes', rect.array[s0 * 4 + 3] === 4 && aux.array[s0 * 4] === -9);
    check('growth preserves fill + flags + visibility',
        fill.array[s0 * 4] === 255 && flags.array[s0] === 5 && aux.array[s0 * 4 + 2] === 1);
    check('growth extends instanceCount', pf.mesh.geometry.instanceCount === 3);
}

// ── Pick-block discipline ───────────────────────────────────────────────────
{
    const calls = [];
    const ps = {
        register(channel, mesh, token, opts) { calls.push({ channel, mesh, token, opts }); return 1; },
        unregister() {},
    };
    const pf = new PanelField({ scene, field, capacity: 2 });
    pf.registerPicking(ps);
    pf.registerPicking(ps);   // idempotent at unchanged capacity
    check('one registration per capacity', calls.length === 1);
    check('registers the grid channel at capacity with its own material',
        calls[0].channel === 'grid' && calls[0].opts.count === 2 &&
        calls[0].opts.material && calls[0].token === pf);
    pf.alloc('a', 1); pf.alloc('b', 1); pf.alloc('c', 1);   // growth while registered
    check('growth re-registers at the new capacity',
        calls.length === 2 && calls[1].opts.count === 4);
    check('pick material is stable across re-registration',
        calls[0].opts.material === calls[1].opts.material);
}

console.log(`\npanel-field: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
