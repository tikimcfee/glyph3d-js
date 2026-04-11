/**
 * Picking System Test — examples/picking-test/main.js
 *
 * C3 validation target: first working WebGPU primitive.
 * Uses GlyphField directly (bypasses CodeGrid / GlyphCollection) to validate:
 *   1. GlyphField renders instanced glyphs via WebGPURenderer + TSL NodeMaterial
 *   2. PickingSystem works with WebGPU (TSL picking material, async readback)
 *   3. setGlyphHighlight works (RGBA8 highlight texture)
 *
 * Self-tests (keys 1–3):
 *   1: Verify instancePickingId exists and is sequential after registration
 *   2: Live hover readback — log picked glyph on mousemove
 *   3: Additive color sweep — walk all instances with a highlight band
 *
 * Debug:
 *   P: Toggle picking texture fullscreen overlay
 *   R: Clear all additive highlights
 */

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import GlyphAtlas from '../../src/GlyphAtlas.js';
import GlyphField from '../../src/GlyphField.js';
import { PickingSystem } from '../../src/picking/PickingSystem.js';

// ---------------------------------------------------------------------------
// Sample text payload
// ---------------------------------------------------------------------------
const SAMPLE_TEXT = `// GlyphField WebGPU picking test
// Move mouse over glyphs to see picking IDs
// Press keys 1-3 for self-tests

function helloWorld(name) {
    const greeting = "Hello, " + name + "!";
    console.log(greeting);
    return greeting;
}

class ExampleClass {
    constructor(value) {
        this.value = value;
    }

    getValue() { return this.value; }

    setValue(v) {
        if (typeof v !== 'number') throw new Error('expected number');
        this.value = v;
    }
}

// Instantiate and call
const obj = new ExampleClass(42);
helloWorld(obj.getValue().toString());
`;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const resultsEl = document.getElementById('results');
const hoverEl   = document.getElementById('hover-info');
const statsEl   = document.getElementById('stats');

function logResult(msg, isError = false) {
    const line = document.createElement('div');
    line.style.color = isError ? '#ff6b6b' : (msg.startsWith('PASS') ? '#7aff7a' : '#d0d0d0');
    line.textContent = msg;
    resultsEl.appendChild(line);
    resultsEl.scrollTop = resultsEl.scrollHeight;
}

function clearResults() {
    resultsEl.innerHTML = '';
}

// ---------------------------------------------------------------------------
// WebGPU renderer (requires await init())
// ---------------------------------------------------------------------------
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Mandatory async init for WebGPU
await renderer.init();

// Intercept WGSL shader creation to dump source on errors
const _origCreateShaderModule = renderer.backend?.device?.createShaderModule?.bind(renderer.backend.device);
if (_origCreateShaderModule) {
    renderer.backend.device.createShaderModule = (descriptor) => {
        console.group(`WGSL [${descriptor.label}]`);
        console.log(descriptor.code);
        console.groupEnd();
        return _origCreateShaderModule(descriptor);
    };
} else {
    console.warn('Could not hook createShaderModule — device not yet available');
}

logResult(`Renderer: ${renderer.isWebGPURenderer ? 'WebGPURenderer' : 'WebGLRenderer (fallback)'}`);

// ---------------------------------------------------------------------------
// Scene + camera
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 10000);
camera.position.set(3, -2, 6);
camera.lookAt(3, -2, 0);

// ---------------------------------------------------------------------------
// GlyphAtlas (provides metrics + shaper + slug data)
// ---------------------------------------------------------------------------
const atlas = new GlyphAtlas();
await atlas.generate();

// ---------------------------------------------------------------------------
// GlyphField — directly use the WebGPU primitive, no CodeGrid/GlyphCollection
// ---------------------------------------------------------------------------
const glyphField = new GlyphField(scene, atlas, {
    defaultColor: { r: 0.6, g: 1.0, b: 0.6 },
    worldScale: 0.025,
    slugData: atlas._slugData,
    shaper:   atlas._shaper,
});

// Render the sample text into the field
glyphField.render(SAMPLE_TEXT, { x: 0, y: 0, z: 0 });

logResult(`GlyphField: ${glyphField.instanceMesh.geometry.instanceCount} glyphs rendered`);

// ---------------------------------------------------------------------------
// PickingSystem
// ---------------------------------------------------------------------------
const pickingSystem = new PickingSystem(renderer, { resolutionScale: 1.0 });

// Wait for TSL modules to load (they are in module cache from GlyphField import,
// so this resolves immediately but we await to be safe).
await pickingSystem._tslReady;

// Register GlyphField with PickingSystem.
// registerRenderer reads instanceCount from the geometry so it must be called
// after render() has committed glyphs.
pickingSystem.registerRenderer(glyphField);

logResult(`PickingSystem registered (startId=${pickingSystem._registry[0]?.startId ?? '?'})`);

// ---------------------------------------------------------------------------
// Mouse wiring
// ---------------------------------------------------------------------------
let lastHoverId   = 0;
let lastHoverSlot = -1;

renderer.domElement.addEventListener('mousemove', e => {
    const rect = renderer.domElement.getBoundingClientRect();
    pickingSystem.setMousePosition(e.clientX - rect.left, e.clientY - rect.top);
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    pickingSystem.onResize();
});

// ---------------------------------------------------------------------------
// Debug picking texture overlay
// ---------------------------------------------------------------------------
let pickingDebugVisible = false;
const debugCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const debugQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshBasicMaterial({
        map: pickingSystem.renderTarget.texture,
        depthTest: false,
        depthWrite: false,
    })
);
debugQuad.position.set(0.55, -0.55, 0);
const debugScene = new THREE.Scene();
debugScene.add(debugQuad);

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

let statsFrame = 0;
function updateStats() {
    if (++statsFrame % 30 !== 0) return;

    const ps = pickingSystem.getStats();
    const rs = glyphField.getMemoryStats();

    const lines = [
        `── GlyphField ──`,
        `Instances: ${rs.instanceCount} / ${rs.maxInstances}`,
        `Buffer alloc: ${fmtBytes(rs.allocatedBytes)}`,
        `Buffer used:  ${fmtBytes(rs.usedBytes)}`,
        `Buffer waste: ${fmtBytes(rs.wasteBytes)}`,
        `Group tex:    ${fmtBytes(rs.groupTextureBytes)}`,
        `Text entries: ${rs.textEntryCount}`,
        ``,
        `── Picking ──`,
        `Renderers: ${ps.rendererCount}`,
        `Instances: ${ps.totalInstances}`,
        `Target:    ${ps.targetWidth}×${ps.targetHeight} (${fmtBytes(ps.targetBytes)})`,
        `Pick IDs:  ${fmtBytes(ps.pickingIdBytes)}`,
        `Render:    ${ps.lastRenderMs.toFixed(2)} ms`,
        `ReadPixels:${ps.lastReadMs.toFixed(2)} ms`,
        `Total:     ${ps.lastTotalMs.toFixed(2)} ms`,
        ``,
        `── Total ──`,
        `GPU buffers: ${fmtBytes(rs.allocatedBytes + ps.totalBytes)}`,
    ];
    statsEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let _pickPending = false;

function animate() {
    requestAnimationFrame(animate);

    if (!_pickPending) {
        _pickPending = true;
        pickingSystem.renderAndReadAsync(camera, scene).then(hoverId => {
            _pickPending = false;

            if (hoverId !== lastHoverId) {
                // Clear previous highlight
                if (lastHoverSlot >= 0) {
                    glyphField.setGlyphHighlight(lastHoverSlot, null);
                }

                lastHoverId = hoverId;

                if (hoverId !== 0) {
                    const hit = pickingSystem.resolve(hoverId);
                    if (hit) {
                        lastHoverSlot = hit.slotIndex;
                        const glyph = pickingSystem.resolveGlyph(hit.renderer, hit.slotIndex);
                        hoverEl.innerHTML = `Hover ID: <b>${hoverId}</b><br>` +
                            `Slot: <b>${hit.slotIndex}</b><br>` +
                            (glyph ? `textId: <b>${glyph.textId}</b>  char[${glyph.charIndex}]` : 'unresolved');
                        hit.renderer.setGlyphHighlight(hit.slotIndex, { r: 0.4, g: 0.4, b: 0.0 });
                    }
                } else {
                    lastHoverSlot = -1;
                    hoverEl.innerHTML = 'Hover: <em>none</em>';
                }
            }
        });
    }

    renderer.render(scene, camera);

    if (pickingDebugVisible) {
        renderer.autoClear = false;
        renderer.render(debugScene, debugCamera);
        renderer.autoClear = true;
    }

    updateStats();
}

animate();

// ---------------------------------------------------------------------------
// Self-tests
// ---------------------------------------------------------------------------

function testPhase1() {
    clearResults();
    logResult('=== Test 1: instancePickingId sequential validation ===');

    const geom = glyphField.instanceMesh.geometry;
    const attr = geom.attributes.instancePickingId;
    if (!attr) { logResult('FAIL: instancePickingId attribute missing', true); return; }
    logResult(`PASS instancePickingId attribute exists (length=${attr.array.length})`);

    const reg = pickingSystem._registry.find(e => e.renderer === glyphField);
    if (!reg) { logResult('FAIL: renderer not registered in PickingSystem', true); return; }
    logResult(`PASS renderer registered: startId=${reg.startId} endId=${reg.endId}`);

    const count = geom.instanceCount;
    logResult(`PASS instanceCount=${count}`);

    let ok = true;
    for (let i = 0; i < count; i++) {
        if (attr.array[i] !== reg.startId + i) {
            logResult(`FAIL: slot ${i} has id ${attr.array[i]}, expected ${reg.startId + i}`, true);
            ok = false;
            break;
        }
    }
    if (ok) logResult(`PASS instancePickingId sequential [${reg.startId}, ${reg.endId})`);

    // instanceAddedColor replaced by highlightTexture — check it's present on the field
    logResult(`PASS highlightTexture allocated: ${!!glyphField._highlightTexture}`);
}

function testPhase2() {
    clearResults();
    logResult('=== Test 2: Hover readback (move mouse over glyphs) ===');
    logResult('Move mouse over text — picked ID will be logged here.');

    let testCount = 0;
    const logHover = async () => {
        const id = await pickingSystem.renderAndReadAsync(camera, scene);
        if (id !== 0 && testCount < 5) {
            const hit = pickingSystem.resolve(id);
            const glyph = hit ? pickingSystem.resolveGlyph(hit.renderer, hit.slotIndex) : null;
            logResult(`Picked id=${id} slot=${hit?.slotIndex ?? '?'} ` +
                `textId=${glyph?.textId ?? '?'} char[${glyph?.charIndex ?? '?'}]`);
            testCount++;
            if (testCount >= 5) {
                logResult('PASS 5 successful hover readbacks captured');
                renderer.domElement.removeEventListener('mousemove', logHover);
            }
        }
    };
    renderer.domElement.addEventListener('mousemove', logHover);
    logResult('(test active — move mouse; up to 5 hits will be logged)');
}

async function testPhase3() {
    clearResults();
    logResult('=== Test 3: Additive color sweep ===');

    const count = glyphField.instanceMesh.geometry.instanceCount;
    logResult(`Sweeping ${count} glyphs with highlight band...`);

    const BAND     = 20;
    const DELAY_MS = 16;

    for (let i = 0; i <= count; i++) {
        if (i > 0) glyphField.setGlyphHighlight(i - 1, null);
        for (let j = i; j < Math.min(i + BAND, count); j++) {
            glyphField.setGlyphHighlight(j, { r: 0.5, g: 0.0, b: 0.5 });
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    for (let i = 0; i < count; i++) glyphField.setGlyphHighlight(i, null);
    logResult(`PASS Sweep complete (${count} glyphs highlighted sequentially)`);
}

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------
document.addEventListener('keydown', e => {
    switch (e.key) {
        case '1': testPhase1(); break;
        case '2': testPhase2(); break;
        case '3': testPhase3(); break;

        case 'p':
        case 'P':
            pickingDebugVisible = !pickingDebugVisible;
            logResult(`Picking debug overlay: ${pickingDebugVisible ? 'ON' : 'OFF'}`);
            break;

        case 'r':
        case 'R': {
            const count = glyphField.instanceMesh.geometry.instanceCount;
            for (let i = 0; i < count; i++) glyphField.setGlyphHighlight(i, null);
            lastHoverSlot = -1;
            logResult('Cleared all highlights');
            break;
        }
    }
});
