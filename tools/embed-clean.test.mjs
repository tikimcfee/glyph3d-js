// embed-clean.test.mjs — verify clean exports, headless embedding, line normalization, and resource disposal.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import * as Glyph3D from '../packages/glyph3d-core/src/index.js';
import * as CoreExports from '../packages/glyph3d-core/src/core/index.js';
import EmojiAtlas from '../packages/glyph3d-core/src/EmojiAtlas.js';
import FontChain from '../packages/glyph3d-core/src/shaping/FontChain.js';
import HarfBuzzShaper from '../packages/glyph3d-core/src/shaping/HarfBuzzShaper.js';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';

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

console.log('Testing @glyph3d/core Embeddability & Refactoring Cleanups...');

// 1. Root and Core Exports
{
    assert(typeof Glyph3D.InstancedField === 'function', 'InstancedField exported from root');
    assert(typeof Glyph3D.GlyphField === 'function', 'GlyphField alias exported from root');
    assert(typeof Glyph3D.InstancedSlotBuffer === 'function', 'InstancedSlotBuffer exported from root');
    assert(typeof Glyph3D.generateLayout === 'function', 'generateLayout exported from root');
    assert(typeof Glyph3D.FontChain === 'function', 'FontChain exported from root');
    assert(typeof Glyph3D.LiveSlugAtlas === 'function', 'LiveSlugAtlas exported from root');
    assert(typeof Glyph3D.loadSlugCore === 'function', 'loadSlugCore exported from root');
    assert(typeof Glyph3D.CodeGrid === 'function', 'CodeGrid exported from root');

    // Check core exports
    assert(typeof CoreExports.InstancedSlotBuffer === 'function', 'core exports InstancedSlotBuffer');
    assert(typeof CoreExports.generateLayout === 'function', 'core exports generateLayout');
    assert(typeof CoreExports.createGlyphMaterial === 'function', 'core exports createGlyphMaterial');
    assert(typeof CoreExports.computeCellMetrics === 'function', 'core exports computeCellMetrics');
    assert(typeof CoreExports.RENDER_ORDER === 'object', 'core exports RENDER_ORDER');
    assert(typeof CoreExports.LAYER_BAND === 'object', 'core exports LAYER_BAND');
}

// 2. CodeGrid Line-Ending Normalization (\r\n and \r -> \n)
{
    const dummyAtlas = {
        getCharSize: () => ({ width: 10, height: 20 }),
        _slugData: null,
        _shaper: null,
        _live: null,
    };
    const grid = new CodeGrid(null, dummyAtlas, { showBackground: false });

    // CRLF input
    grid._beginLoad('line 1\r\nline 2\r\nline 3');
    assert(grid.content === 'line 1\nline 2\nline 3', 'CRLF normalized to LF in content');
    assert(grid.lines.length === 3, 'CRLF produces 3 lines');
    assert(grid.lines[0] === 'line 1' && grid.lines[1] === 'line 2', 'line contents match without \\r');

    // CR-only input
    grid._beginLoad('line A\rline B\rline C');
    assert(grid.content === 'line A\nline B\nline C', 'CR normalized to LF in content');
    assert(grid.lines.length === 3, 'CR produces 3 lines');

    // Null/undefined input
    grid._beginLoad(null);
    assert(grid.content === '' && grid.lines.length === 1 && grid.lines[0] === '', 'null text handled safely');

    grid.dispose();
}

// 3. EmojiAtlas Headless / Injected Canvas Support
{
    let created = 0;
    const mockCanvas = {
        width: 1024,
        height: 1024,
        getContext: () => ({
            fillStyle: '',
            font: '',
            fillRect: () => {},
            clearRect: () => {},
            fillText: () => {},
            measureText: () => ({ width: 16 }),
        }),
    };

    const atlas = new EmojiAtlas({
        cellSize: 64,
        cols: 16,
        rows: 16,
        createCanvas: () => {
            created++;
            return mockCanvas;
        },
    });

    assert(created === 1, 'EmojiAtlas invoked injected createCanvas without DOM document');
    const slot = atlas.ensure(0x1F680);
    assert(slot >= 0, 'Allocated emoji cell in headless canvas');
    atlas.dispose();
}

// 4. FontChain In-Memory Buffer Support
{
    // Read Cousine-Regular.ttf from packages/glyph3d-core/src/fonts
    const fontPath = path.resolve('packages/glyph3d-core/src/fonts/Cousine-Regular.ttf');
    const wasmPath = path.resolve('packages/glyph3d-core/src/shaping/vendor/hb.wasm');

    if (fs.existsSync(fontPath) && fs.existsSync(wasmPath)) {
        const fontBytes = fs.readFileSync(fontPath);
        const wasmBytes = fs.readFileSync(wasmPath);

        const chain = new FontChain();
        await chain.init([
            {
                name: 'Cousine',
                buffer: fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
            }
        ], {
            wasmBinary: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
        });

        assert(chain.ready, 'FontChain ready using in-memory font buffer and wasmBinary');
        assert(chain.primaryShaper !== null, 'FontChain has primary shaper');
        assert(chain.primaryShaper.glyphCount > 0, `Primary font loaded ${chain.primaryShaper.glyphCount} glyphs`);
        assert(chain.routeCodepoint(65) === 0, 'Codepoint 65 (A) routed to font 0');
    } else {
        console.warn('Skipping FontChain font loading test (assets not found on disk)');
    }
}

// 5. InstancedField Scene / Parent Group Disposal
{
    const dummyAtlas = {
        getCharSize: () => ({ width: 10, height: 20 }),
        _slugData: null,
        _shaper: null,
        _live: null,
    };
    const parentGroup = new THREE.Group();
    const field = new InstancedField(null, dummyAtlas, {});

    parentGroup.add(field.instanceMesh);
    assert(field.instanceMesh.parent === parentGroup, 'field instanceMesh added to parentGroup');

    field.dispose();
    assert(field.instanceMesh.parent === null, 'field.dispose() detaches instanceMesh from parent group');
}

console.log(`\nembed-clean.test: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
