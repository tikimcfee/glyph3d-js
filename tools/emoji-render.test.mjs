// emoji-render.test.mjs — verify emoji pipeline: shader, InstancedField, and CodeGrid.
import * as THREE from 'three';
import { createGlyphMaterial } from '../packages/glyph3d-core/src/core/glyphMaterial.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import { generateLayout } from '../packages/glyph3d-core/src/core/LayoutGenerator.js';
import LiveSlugAtlas from '../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js';

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

console.log('Testing Emoji WebGL2 Pipeline...');

// 1. Shader uniforms & varyings in glyphMaterial.js
{
    const dummyCanvas = { width: 128, height: 128 };
    const dummyTexture = new THREE.CanvasTexture(dummyCanvas);
    const mat = createGlyphMaterial({
        emojiTexture: dummyTexture,
        emojiCols: 16,
        emojiRows: 16,
    });

    assert(mat.uniforms.emojiTexture?.value === dummyTexture, 'emojiTexture uniform is wired');
    assert(mat.uniforms.emojiCols?.value === 16, 'emojiCols uniform is 16');
    assert(mat.uniforms.emojiRows?.value === 16, 'emojiRows uniform is 16');

    // Check vertex shader
    assert(mat.vertexShader.includes('flat out int vEmojiCell;'), 'vertex shader exports vEmojiCell varying');
    assert(mat.vertexShader.includes('vEmojiCell  = int(info.w);'), 'vertex shader extracts emoji cell from glyphMapTexture');
    assert(mat.vertexShader.includes('float quadW = (vMode == 1) ? aExtent.y : aExtent.x;'), 'vertex shader uses square quad for emoji');

    // Check fragment shader
    assert(mat.fragmentShader.includes('uniform sampler2D emojiTexture;'), 'fragment shader declares emojiTexture');
    assert(mat.fragmentShader.includes('flat in int vEmojiCell;'), 'fragment shader declares vEmojiCell varying');
    assert(mat.fragmentShader.includes('if (vMode == 1) {'), 'fragment shader contains vMode == 1 emoji branch');
    assert(mat.fragmentShader.includes('texture(emojiTexture, atlasUV)'), 'fragment shader samples emojiTexture at atlasUV');
    assert(mat.fragmentShader.includes('if (vCurveCount == 0 && vFillAmount <= 0.0 && vBgColor.a <= 0.0) discard;'), '0-curve discard only applies to vector branch');

    mat.dispose();
}

// 2. InstancedField plumbing with emoji atlas and LiveSlugAtlas
{
    const fakeEmojiTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const fakeEmojiAtlas = {
        cols: 16,
        rows: 16,
        getTexture: () => fakeEmojiTexture,
    };

    let fieldRefreshed = false;
    const fakeLive = {
        registerField: (f) => {},
        unregisterField: (f) => {},
        ensureCodepoints: (cps, cache) => {},
    };

    const atlas = {
        _emojiAtlas: fakeEmojiAtlas,
        _live: fakeLive,
        getCharSize: () => ({ width: 10, height: 20 }),
    };

    const scene = new THREE.Scene();
    const field = new InstancedField(scene, atlas);

    assert(field.emojiAtlas === fakeEmojiAtlas, 'field resolves emojiAtlas getter');
    assert(field.material.uniforms.emojiTexture.value === fakeEmojiTexture, 'field material has emoji texture from emojiAtlas');
    assert(field.material.uniforms.emojiCols.value === 16, 'field material has emojiCols 16');

    // Simulate emoji atlas growth to 32x32
    fakeEmojiAtlas.cols = 32;
    fakeEmojiAtlas.rows = 32;
    const newEmojiTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    fakeEmojiAtlas.getTexture = () => newEmojiTexture;

    field.setEmojiTexture();
    assert(field.material.uniforms.emojiTexture.value === newEmojiTexture, 'setEmojiTexture updates material texture');
    assert(field.material.uniforms.emojiCols.value === 32, 'setEmojiTexture updates emojiCols to 32');
    assert(field.material.uniforms.emojiRows.value === 32, 'setEmojiTexture updates emojiRows to 32');

    field.dispose();
}

// 3. LayoutGenerator + LiveSlugAtlas mapping
{
    // Mock shaper where slot 600 is emoji
    const shaper = {
        upem: 2048,
        glyphOutline: () => [],
        glyphAdvance: () => 1228.8,
        isBitmapSlot: (id) => id >= 600,
        emojiCellOf: (id) => id >= 600 ? (id - 600) : -1,
        describeSlot: (id) => id >= 600
            ? { font: '<emoji-atlas>', gid: 0, name: `cell ${id - 600}` }
            : { font: 'DejaVu Sans', gid: id, name: `glyph${id}` },
        lookup: (cp) => {
            if (cp === 0x1F600) return { g: 600, ax: 2457.6 }; // 😀
            if (cp === 0x1F680) return { g: 601, ax: 2457.6 }; // 🚀
            return { g: cp, ax: 1228.8 };
        },
    };

    const live = new LiveSlugAtlas({ atlas: {}, shaper, initialGlyphIds: [65, 66] });
    // Encode the emoji codepoints
    const res = live.ensureCodepoints([0x1F600, 0x1F680], shaper);
    assert(res.grew === true, 'LiveSlugAtlas grows when emoji codepoints are ensured');

    // Check glyphMap entry
    const mapTex = live.slugData.glyphMapTexture;
    assert(mapTex != null, 'LiveSlugAtlas provides glyphMapTexture');
    const mapData = mapTex.image.data;
    // Slot 600: [0, 0, mode=1, cell=0]
    const idx600 = 600 * 4;
    assert(mapData[idx600 + 2] === 1, 'slot 600 mode is 1 (bitmap emoji)');
    assert(mapData[idx600 + 3] === 0, 'slot 600 emojiCell is 0');

    // Slot 601: [0, 0, mode=1, cell=1]
    const idx601 = 601 * 4;
    assert(mapData[idx601 + 2] === 1, 'slot 601 mode is 1 (bitmap emoji)');
    assert(mapData[idx601 + 3] === 1, 'slot 601 emojiCell is 1');

    // Generate layout with emoji
    const layout = generateLayout('Hi 😀 !', { shaper, worldScale: 0.025 });
    assert(layout.glyphCount === 6, 'layout generated 6 slots'); // H, i, space, 😀, space, !
    const slots = layout.buffer;

    // Check that emoji slot received slot id 600
    const slot3 = slots.getSlot(3);
    assert(slot3.glyphId === 600, `slot 3 has emoji glyph ID 600 (got ${slot3.glyphId})`);
    assert(slot3.advance > 0.025, `emoji has double-width advance (got ${slot3.advance})`);
}

// 4. CodeGrid loading text with emoji fixture
{
    const scene = new THREE.Scene();
    const ensuredCps = [];
    const shaper = {
        upem: 2048,
        isBitmapSlot: (id) => id >= 600,
        emojiCellOf: (id) => id >= 600 ? (id - 600) : -1,
        lookup: (cp) => {
            if (cp >= 0x1F000) return { g: 600 + (cp - 0x1F000), ax: 2457.6 };
            return { g: cp, ax: 1228.8 };
        },
    };

    const atlas = {
        _shapeCache: shaper,
        _shaper: shaper,
        _emojiAtlas: {
            cols: 16,
            rows: 16,
            getTexture: () => new THREE.DataTexture(new Uint8Array(4), 1, 1),
        },
        _live: {
            registerField: () => {},
            unregisterField: () => {},
            ensureCodepoints: (cps, cache) => {
                ensuredCps.push(...cps);
                return { grew: true, added: cps.length, total: cps.length };
            },
        },
        getCharSize: () => ({ width: 10, height: 20 }),
    };

    const grid = new CodeGrid(scene, atlas, {
        filename: 'probe.txt',
    });

    const probeSample = '😀 😃 😄\n🚀 🛸 🚁';
    await grid.loadText(probeSample);

    assert(ensuredCps.length > 0, 'CodeGrid._ensureGlyphsEncoded forwarded codepoints to live atlas');
    assert(ensuredCps.includes(0x1F600), 'ensuredCps includes 😀 (0x1F600)');
    assert(ensuredCps.includes(0x1F680), 'ensuredCps includes 🚀 (0x1F680)');

    assert(grid.getGlyphCount() > 0, 'grid has rendered glyph count');

    grid.dispose();
}

console.log(`\nEmoji Render Test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
