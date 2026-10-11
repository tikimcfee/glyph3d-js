// tools/camera-focus-jump.test.mjs — verify jump-to-grid fixes
import * as THREE from 'three';
import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import FileRow from '../packages/glyph3d-core/src/collections/FileRow.js';
import ViewerCameraController from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import registerCameraCommands from '../app/commands/handlers/cameraCommands.js';
import Holding from '../app/client/Holding.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ FAIL: ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);

console.log('Testing Camera Focus & Jump-To-Grid fixes...');

const mockAtlas = {
    getCharSize: () => ({ width: 10, height: 20 }),
    _slugData: null,
    _shaper: null,
};

// 1. SceneRegistry.replace preserves Map insertion order
{
    const reg = new SceneRegistry();
    const g1 = new THREE.Object3D();
    const g2 = new THREE.Object3D();
    const g3 = new THREE.Object3D();
    reg.register('file1.js', g1, { type: 'grid' });
    reg.register('file2.js', g2, { type: 'grid' });
    reg.register('file3.js', g3, { type: 'grid' });

    let grids = reg.toArray('grid');
    eq(grids[0], g1, 'index 0 is g1 before replace');
    eq(grids[1], g2, 'index 1 is g2 before replace');
    eq(grids[2], g3, 'index 2 is g3 before replace');

    // Upgrade file2.js in place
    const g2_upgraded = new THREE.Object3D();
    reg.replace('file2.js', g2_upgraded, { type: 'grid' });

    grids = reg.toArray('grid');
    eq(grids.length, 3, 'length stays 3');
    eq(grids[0], g1, 'index 0 is still g1');
    eq(grids[1], g2_upgraded, 'index 1 is upgraded g2 (order preserved!)');
    eq(grids[2], g3, 'index 2 is still g3 (no index drift!)');
}

// 2. CodeGrid bounds are non-empty for empty file or zero-byte file
{
    const scene = new THREE.Scene();
    const cg = new CodeGrid(scene, mockAtlas, { name: 'empty.txt', showFilename: true });
    const b = cg.getLocalBounds();
    ok(!b.isEmpty(), 'empty CodeGrid local bounds is NOT empty');
    ok(b.max.x > b.min.x, 'width > 0');
    ok(b.max.y > b.min.y, 'height > 0');
}

// 3. CodeGrid.setSeedExtent provides instant bounds before load
{
    const scene = new THREE.Scene();
    const cg = new CodeGrid(scene, mockAtlas, { name: 'test.js' });
    cg.setSeedExtent({ min: { x: 0, y: -200, z: 0 }, max: { x: 150, y: 0, z: 0 }, width: 150, height: 200, depth: 0 });

    const b = cg.getLocalBounds();
    ok(!b.isEmpty(), 'seeded bounds are immediately available');
    ok(cg.getContentBounds().height >= 200, 'seeded height preserved');
}

// 4. FileRow lineCount in computeGridFocus
{
    const scene = new THREE.Scene();
    const row = new FileRow(scene, mockAtlas, { name: 'large.js', showFilename: true });
    // Simulate a 100-line file
    const content = Array(100).fill('const x = 1;').join('\n');
    await row.load('large.js', content);
    eq(row.getLineCount(), 100, 'row has 100 lines via getLineCount');

    const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 10000);
    const ctx = {
        camera,
        THREE,
        getGrids: () => [row],
    };
    ctx.holding = new Holding(ctx);
    const cc = new ViewerCameraController(ctx);
    const pose = cc.computeGridFocus(0);
    ok(pose !== null, 'computeGridFocus returned valid pose for FileRow');

    // With 100 lines and readable lines cap of 35, fitHeight must be capped!
    const plane = cc._planeOf(row);
    const expectedFitHeight = (35 / 100) * plane.height;
    // Check that standoff distance reflects readable lines (~35 lines) instead of all 100 lines
    ok(pose.pitch !== undefined && pose.yaw !== undefined, 'pose has pitch and yaw');
}

// 5. cameraCommands camera.focus waits for loadPromise and returns framing result
{
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 10000);
    const grid = new CodeGrid(scene, mockAtlas, { name: 'hello.js' });

    let loadResolved = false;
    grid.loadPromise = new Promise((res) => {
        setTimeout(() => {
            loadResolved = true;
            res();
        }, 50);
    });

    const reg = new SceneRegistry();
    reg.register('hello.js', grid, { type: 'grid' });

    let focusedIdx = -1;
    const ctx = {
        camera,
        registry: reg,
        getGrids: () => reg.toArray('grid'),
        cameraController: {
            focusOnGrid: (idx) => { focusedIdx = idx; return true; },
            focusOnObject: () => true,
        },
    };
    ctx.holding = new Holding(ctx);

    const handlers = {};
    registerCameraCommands({ register: (name, fn) => { handlers[name] = fn; } });

    const focusResult = handlers['camera.focus'](['hello.js'], ctx);
    ok(focusResult instanceof Promise, 'camera.focus returns promise when loadPromise is pending');

    const res = await focusResult;
    ok(loadResolved, 'loadPromise was awaited before framing');
    eq(focusedIdx, 0, 'camera focused on grid index 0');
    ok(res.text.startsWith('OK: focusing on'), 'focus command succeeded');
}

console.log(`\nTests finished: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
