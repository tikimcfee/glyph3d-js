/**
 * Picking System Test — examples/picking-test/main.js
 *
 * Loads GlyphRenderer.js source as the text payload, renders it with CodeGrid,
 * and validates the full picking pipeline.
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
import GlyphAtlas from '../../src/GlyphAtlas.js';
import { CodeGrid } from '../../src/collections/index.js';
import { PickingSystem } from '../../src/picking/PickingSystem.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SAMPLE_TEXT = `// GlyphRenderer picking test
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
// DOM elements
// ---------------------------------------------------------------------------
const resultsEl = document.getElementById('results');
const hoverEl   = document.getElementById('hover-info');

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
// Three.js setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(5, -3, 15);
camera.lookAt(5, -3, 0);

// ---------------------------------------------------------------------------
// Atlas + Collection
// ---------------------------------------------------------------------------
const atlas = new GlyphAtlas({ fontSize: 24 });
await atlas.generate();

const grid = new CodeGrid(scene, atlas, {
    showFilename: true,
    showBackground: true,
    textColor: { r: 0.6, g: 1.0, b: 0.6 }
});

// Wire picking system BEFORE loading so flush() auto-registers
const pickingSystem = new PickingSystem(renderer, { resolutionScale: 1.0 });
const collection = grid.getCollection();
collection.setPickingSystem(pickingSystem);

grid.loadFile('picking-test.js', SAMPLE_TEXT);
scene.add(grid);

const glyphRenderer = collection.getRenderer();

// ---------------------------------------------------------------------------
// Mouse wiring
// ---------------------------------------------------------------------------
let lastHoverId = 0;
let lastHoverSlot = -1;

renderer.domElement.addEventListener('mousemove', e => {
    const rect = renderer.domElement.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    pickingSystem.setMousePosition(cssX, cssY);
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
// Debug picking texture overlay (Three.js fullscreen quad)
// ---------------------------------------------------------------------------
let pickingDebugVisible = false;

// Orthographic camera for debug quad overlay (NDC: -1 to +1)
const debugCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// Quarter-size thumbnail in bottom-right corner
const debugQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshBasicMaterial({
        map: pickingSystem.renderTarget.texture,
        depthTest: false,
        depthWrite: false,
    })
);
debugQuad.position.set(0.55, -0.55, 0); // bottom-right corner
const debugScene = new THREE.Scene();
debugScene.add(debugQuad);

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
    requestAnimationFrame(animate);

    // Run picking pass and read result
    const hoverId = pickingSystem.renderAndRead(camera);

    // Update hover info
    if (hoverId !== lastHoverId) {
        // Clear previous highlight
        if (lastHoverSlot >= 0 && glyphRenderer) {
            glyphRenderer.setGlyphHighlight(lastHoverSlot, null);
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
                // Highlight hovered glyph
                hit.renderer.setGlyphHighlight(hit.slotIndex, { r: 0.4, g: 0.4, b: 0.0 });
            }
        } else {
            lastHoverSlot = -1;
            hoverEl.innerHTML = 'Hover: <em>none</em>';
        }
    }

    // Render main scene
    renderer.render(scene, camera);

    // Render debug overlay on top if visible
    if (pickingDebugVisible) {
        renderer.autoClear = false;
        renderer.render(debugScene, debugCamera);
        renderer.autoClear = true;
    }
}

animate();

// ---------------------------------------------------------------------------
// Self-tests
// ---------------------------------------------------------------------------

function testPhase1() {
    clearResults();
    logResult('=== Test 1: instancePickingId sequential validation ===');

    const gr = collection.getRenderer();
    if (!gr) { logResult('FAIL: no renderer (flush first)', true); return; }

    const geom = gr.instanceMesh.geometry;
    const attr = geom.attributes.instancePickingId;
    if (!attr) { logResult('FAIL: instancePickingId attribute missing', true); return; }
    logResult(`PASS instancePickingId attribute exists (length=${attr.array.length})`);

    const reg = pickingSystem._registry.find(e => e.renderer === gr);
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

    logResult(`PASS addedColor attribute exists: ${!!geom.attributes.instanceAddedColor}`);
}

function testPhase2() {
    clearResults();
    logResult('=== Test 2: Hover readback (move mouse over glyphs) ===');
    logResult('Move mouse over text — picked ID will be logged here.');

    const prev = renderer.domElement.onmousemove;
    let testCount = 0;
    const logHover = () => {
        const id = pickingSystem.renderAndRead(camera);
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

    const gr = collection.getRenderer();
    if (!gr) { logResult('FAIL: no renderer', true); return; }

    const count = gr.instanceMesh.geometry.instanceCount;
    logResult(`Sweeping ${count} glyphs with highlight band...`);

    const BAND = 20;
    const DELAY_MS = 16;

    for (let i = 0; i <= count; i++) {
        // Light up band [i, i+BAND), clear behind
        if (i > 0) {
            gr.setGlyphHighlight(i - 1, null);
        }
        for (let j = i; j < Math.min(i + BAND, count); j++) {
            gr.setGlyphHighlight(j, { r: 0.5, g: 0.0, b: 0.5 });
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Clear all highlights
    for (let i = 0; i < count; i++) gr.setGlyphHighlight(i, null);
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
            const gr = collection.getRenderer();
            if (gr) {
                const count = gr.instanceMesh.geometry.instanceCount;
                for (let i = 0; i < count; i++) gr.setGlyphHighlight(i, null);
            }
            lastHoverSlot = -1;
            logResult('Cleared all highlights');
            break;
        }
    }
});
