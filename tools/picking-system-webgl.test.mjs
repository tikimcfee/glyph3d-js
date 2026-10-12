#!/usr/bin/env bun
import * as THREE from 'three';
import { PickingSystem } from '../packages/glyph3d-core/src/picking/PickingSystem.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
    }
}

console.log('Testing WebGL2 PickingSystem...');

// Mock WebGLRenderer sufficient for PickingSystem bookkeeping, material creation, and a pick:
// it records each pass (which target column, which layer, which camera view) and answers the
// readback with an id per column from `idForLayer`.
class MockWebGLRenderer {
    constructor() {
        this.domElement = {};
        this.passes = [];
        this.clears = [];
        this.reads = [];
        this.idForLayer = new Map();
        this._target = null;
    }
    getSize(vec) {
        vec.set(800, 600);
        return vec;
    }
    getPixelRatio() {
        return 1.0;
    }
    getClearAlpha() {
        return 0.5;
    }
    getClearColor(c) {
        c.set(0x336699);
        return c;
    }
    getRenderTarget() { return this._target; }
    setRenderTarget(t) { this._target = t; }
    setClearColor(c, a) { this.lastClear = [typeof c === 'number' ? c : c.getHex(), a]; }
    clear() { this.clears.push(this._target.viewport.x); }
    render(scene, camera) {
        const layer = Math.log2(camera.layers.mask);
        this.passes.push({
            column: this._target.viewport.x, layer, view: { ...camera.view },
            sceneAutoMW: scene.matrixWorldAutoUpdate,
        });
    }
    async readRenderTargetPixelsAsync(target, x, y, w, h, buf) {
        this.reads.push({ x, y, w, h });
        for (const p of this.passes) {
            const id = this.idForLayer.get(p.layer) ?? 0;
            const o = 4 * p.column;
            buf[o] = (id >> 16) & 0xff; buf[o + 1] = (id >> 8) & 0xff; buf[o + 2] = id & 0xff; buf[o + 3] = (id >> 24) & 0xff;
        }
        return buf;
    }
}

const renderer = new MockWebGLRenderer();
const ps = new PickingSystem(renderer);

assert(ps !== null, 'PickingSystem constructor accepts WebGL renderer');
assert(ps.renderTarget === null, 'no ID target until the first pick');

// Test decodePickingId
{
    const pixel = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const id = PickingSystem.decodePickingId(pixel);
    const expected = 0x78 * 0x1000000 + ((0x12 << 16) | (0x34 << 8) | 0x56);
    assert(id === expected, 'decodePickingId decodes correctly');
}

// Test Flat Channel Registration
{
    const geo = new THREE.PlaneGeometry(10, 10);
    const mesh1 = new THREE.Mesh(geo);
    const mesh2 = new THREE.Mesh(geo);

    const token1 = { name: 'grid1' };
    const token2 = { name: 'grid2' };

    const id1 = ps.register('grid', mesh1, token1);
    assert(id1 === 1, `Mesh1 got id 1 (got ${id1})`);
    assert(mesh1.userData.pickStartId === 1, 'mesh1 userData.pickStartId set');

    const id2 = ps.register('grid', mesh2, token2);
    assert(id2 === 2, `Mesh2 got id 2 (got ${id2})`);
    assert(mesh2.userData.pickStartId === 2, 'mesh2 userData.pickStartId set');

    // Test resolve
    const hit1 = ps.resolve('grid', 1);
    assert(hit1 && hit1.token === token1 && hit1.slotIndex === 0, 'resolve resolves id 1');

    const hit2 = ps.resolve('grid', 2);
    assert(hit2 && hit2.token === token2 && hit2.slotIndex === 0, 'resolve resolves id 2');

    const hitMiss = ps.resolve('grid', 999);
    assert(hitMiss === null, 'resolve returns null for unallocated id');

    // Unregister and reuse
    ps.unregister('grid', mesh1);
    const mesh3 = new THREE.Mesh(geo);
    const token3 = { name: 'grid3' };
    const id3 = ps.register('grid', mesh3, token3);
    assert(id3 === 1, `First-fit reused slot 1 for mesh3 (got ${id3})`);

    // Verify distinct material instances for entries (no shared uniform overwrite!)
    const ch = ps._channels.get('grid');
    const entry2 = ch.entries.find(e => e.mesh === mesh2);
    const entry3 = ch.entries.find(e => e.mesh === mesh3);
    assert(entry2.material !== entry3.material, 'Grid entries have distinct material instances');
    assert(entry2.material.uniforms.uBasePickingId.value === 2, 'Entry2 uniform is 2');
    assert(entry3.material.uniforms.uBasePickingId.value === 1, 'Entry3 uniform is 1');
}

// Test Glyph Channel Registration
{
    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.instanceCount = 50;
    const mesh = new THREE.Mesh(instGeo);
    const token = { name: 'field' };

    const startId = ps.register('glyph', mesh, token);
    assert(startId === 1, `Glyph mesh got startId 1 (got ${startId})`);

    const hitSlot0 = ps.resolve('glyph', 1);
    assert(hitSlot0 && hitSlot0.token === token && hitSlot0.slotIndex === 0, 'Glyph slot 0 resolved');

    const hitSlot25 = ps.resolve('glyph', 26);
    assert(hitSlot25 && hitSlot25.token === token && hitSlot25.slotIndex === 25, 'Glyph slot 25 resolved');

    const hitSlot49 = ps.resolve('glyph', 50);
    assert(hitSlot49 && hitSlot49.token === token && hitSlot49.slotIndex === 49, 'Glyph slot 49 resolved');

    const hitSlotOOB = ps.resolve('glyph', 51);
    assert(hitSlotOOB === null, 'Glyph slot 50+ out of bounds is null');
}

// pick(): one pixel per channel, one readback, a 1×1 view offset at the point
{
    const camera = new THREE.PerspectiveCamera();
    camera.layers.set(0);
    const scene = new THREE.Scene();
    const gridMesh = [...ps._channels.get('grid').entries].find((e) => e.startId === 2).mesh;
    const gridMat = gridMesh.material;
    renderer.idForLayer.set(8, 2);    // grid layer → mesh2's id
    renderer.idForLayer.set(7, 26);   // glyph layer → slot 25

    const hits = await ps.pick(['grid', 'handle', 'glyph'], camera, scene, 100.25, 40);
    assert(renderer.passes.length === 2, `two passes: the empty handle channel draws nothing (got ${renderer.passes.length})`);
    assert(renderer.clears.join() === '0,1,2', `every column is cleared, the empty one too (got ${renderer.clears})`);
    assert(renderer.passes[0].column === 0 && renderer.passes[0].layer === 8, 'grid renders into column 0 on its layer');
    assert(renderer.passes[1].column === 2 && renderer.passes[1].layer === 7, 'glyph renders into column 2 on its layer');
    const v = renderer.passes[0].view;
    assert(v.enabled && v.fullWidth === 800 && v.fullHeight === 600 && v.width === 1 && v.height === 1,
        'the pass camera sees one canvas pixel of the full view');
    assert(v.offsetX === 99.75 && v.offsetY === 39.5, `the pixel is centered on the point (got ${v.offsetX},${v.offsetY})`);
    assert(renderer.passes.every((p) => p.sceneAutoMW === false), 'passes reuse the drawn frame\'s matrices');
    assert(renderer.reads.length === 1 && renderer.reads[0].w === 3 && renderer.reads[0].h === 1, 'one readback of all three pixels');
    assert(ps.renderTarget.width === 3 && ps.renderTarget.height === 1, 'the ID target is one pixel per channel');
    assert(hits.grid?.token?.name === 'grid2' && hits.grid.slotIndex === 0, 'grid hit resolves to mesh2');
    assert(hits.handle === null, 'empty channel → null');
    assert(hits.glyph?.slotIndex === 25, 'glyph hit resolves to slot 25');
    assert(camera.view === null && camera.layers.mask === 1, 'the view camera is untouched');
    assert(scene.matrixWorldAutoUpdate === true, 'scene auto-update restored');
    assert(gridMesh.material === gridMat, 'pick materials swapped back');
    assert(renderer.getRenderTarget() === null && renderer.lastClear[0] === 0x336699 && renderer.lastClear[1] === 0.5,
        'render target + clear color restored');

    renderer.passes = []; renderer.reads = [];
    const off = await ps.pick(['grid', 'glyph'], camera, scene, 900, 40);
    assert(off.grid === null && off.glyph === null && renderer.passes.length === 0 && renderer.reads.length === 0,
        'a point off the canvas picks nothing and draws nothing');
}

ps.dispose();
assert(ps.renderTarget === null, 'dispose cleans up renderTarget');

console.log(`\nPickingSystem WebGL2: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
