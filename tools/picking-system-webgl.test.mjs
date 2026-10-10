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

// Mock WebGLRenderer sufficient for PickingSystem bookkeeping & material creation
class MockWebGLRenderer {
    constructor() {
        this.domElement = {};
    }
    getSize(vec) {
        vec.set(800, 600);
        return vec;
    }
    getPixelRatio() {
        return 1.0;
    }
    getClearAlpha() {
        return 0;
    }
    getClearColor(c) {
        c.set(0x000000);
        return c;
    }
    setRenderTarget() {}
    setClearColor() {}
    clear() {}
    render() {}
    readRenderTargetPixels(target, x, y, w, h, buf) {
        // Mock reading ID 1
        buf[0] = 0;
        buf[1] = 0;
        buf[2] = 1;
        buf[3] = 0;
    }
}

const renderer = new MockWebGLRenderer();
const ps = new PickingSystem(renderer);

assert(ps !== null, 'PickingSystem constructor accepts WebGL renderer');
assert(ps.renderTarget !== null, 'PickingSystem creates renderTarget');
assert(ps.renderTarget.width === 800, 'RenderTarget width matches');
assert(ps.renderTarget.height === 600, 'RenderTarget height matches');

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

// Test pickAsync with mock
{
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    ps.markDirty();
    ps.setMousePosition(100, 100);
    const hitPromise = ps.pickAsync('glyph', camera, scene);
    assert(hitPromise instanceof Promise, 'pickAsync returns Promise');
    const hit = await hitPromise;
    assert(hit !== null, 'pickAsync returns hit');
}

ps.dispose();
assert(ps.renderTarget === null, 'dispose cleans up renderTarget');

console.log(`\nPickingSystem WebGL2: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
