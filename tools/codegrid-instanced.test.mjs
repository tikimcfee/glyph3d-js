// codegrid-instanced.test.mjs — verify CodeGrid rewiring with InstancedField
import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import LayoutDescription from '../packages/glyph3d-core/src/core/LayoutDescription.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ FAIL: ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);

// Mock GlyphAtlas
const mockAtlas = {
    getCharSize: () => ({ width: 28, height: 55 }),
    _slugData: null,
    _shaper: null,
};

const scene = new THREE.Scene();

console.log('Testing CodeGrid with InstancedField...');

// 1. Instantiation
const grid = new CodeGrid(scene, mockAtlas, {
    showFilename: true,
    textColor: { r: 0.2, g: 0.9, b: 0.3 },
});

ok(grid !== null, 'CodeGrid instantiates');
ok(grid.metrics.charWidth > 0, 'Cell metrics computed');

// 2. Load text
await grid.loadText('function hello() {\n  return 42;\n}');

eq(grid.getLineCount(), 3, 'Line count is 3');
ok(grid.getGlyphCount() > 0, `Glyphs rendered: ${grid.getGlyphCount()}`);
ok(grid.getRenderer() instanceof InstancedField, 'Renderer is InstancedField');
ok(grid.getRenderer().instanceMesh instanceof THREE.Mesh, 'instanceMesh is THREE.Mesh');
ok(grid._layout instanceof LayoutDescription, 'Layout is LayoutDescription');

const bounds = grid.getLocalBounds();
ok(bounds.max.x > bounds.min.x, 'Local bounds width > 0');
ok(bounds.max.y > bounds.min.y, 'Local bounds height > 0');

// 3. Forward & inverse coordinate queries
const s0 = grid.getSlotForChar(0, 0);
eq(s0, 0, 'Slot for (0,0) is 0');

const sLine1 = grid.getSlotForChar(1, 0);
ok(sLine1 > 0, `Slot for (1,0) is positive: ${sLine1}`);

const char0 = grid.getCharForSlot(0);
eq(char0.line, 0, 'Char for slot 0 line is 0');
eq(char0.col, 0, 'Char for slot 0 col is 0');

const charL1 = grid.getCharForSlot(sLine1);
eq(charL1.line, 1, 'Char for line 1 start line is 1');
eq(charL1.col, 0, 'Char for line 1 start col is 0');

const caretPos = grid._resolveCaretWorldPosition(0, 4);
ok(caretPos !== null, 'Caret position resolved');
ok(typeof caretPos.x === 'number' && typeof caretPos.y === 'number', 'Caret has valid x, y');

// 4. Filename label
grid.setFilenameLabel('test.js');
await grid.loadText('const x = 1;');
ok(grid._filenameField instanceof InstancedField, 'Filename field is InstancedField');
ok(grid._filenameField.instanceMesh.visible, 'Filename field is visible');

// 5. Highlighting
grid.highlightRange(0, 0, 0, 5, { r: 1, g: 0.5, b: 0.2 });
ok(grid._renderer._highlightTexture !== null, 'Highlight texture created');
grid.clearAllHighlights();

// 6. In-grid editing
grid.enterEdit();
ok(grid._cursor !== null, 'Edit mode entered');
grid.setCursor(0, 5);
eq(grid.getCursor().line, 0, 'Cursor line is 0');
eq(grid.getCursor().col, 5, 'Cursor col is 5');

grid.editInsert('// comment\n');
ok(grid.lines.some(l => l.includes('// comment')), 'Inserted text into grid lines');
await new Promise(r => setTimeout(r, 20));
ok(grid.content.includes('// comment'), 'Inserted text into grid content after relayout');
ok(grid.isModified(), 'Grid marked modified');
grid.markSaved();
ok(!grid.isModified(), 'Grid marked saved');

grid.exitEdit();
eq(grid.getCursor(), null, 'Edit mode exited');

// 7. Windowing and frame clipping
await grid.setWindow(40, 10);
ok(grid.isWindowed(), 'Grid is windowed');
await grid.scrollLines(1);

await grid.setFrameRows(5);
eq(grid.getFrameRows(), 5, 'Frame rows is 5');

// 8. Picking integration
{
    const registrations = [];
    const unregistrations = [];
    const mockPS = {
        register: (channel, mesh, token, opts) => {
            registrations.push({ channel, mesh, token, opts });
            return 1;
        },
        unregister: (channel, mesh) => {
            unregistrations.push({ channel, mesh });
        },
    };

    grid.setPickingSystem(mockPS);
    ok(registrations.some(r => r.channel === 'grid' && r.mesh === grid._background), 'Background registered in grid channel');
    ok(registrations.some(r => r.channel === 'glyph' && r.mesh === grid._renderer.instanceMesh), 'Renderer registered in glyph channel');

    await grid.loadText('new text for picking');
    ok(registrations.some(r => r.channel === 'glyph' && r.opts?.count === grid.getGlyphCount()), 'Glyph count updated on layout');

    const bgMesh = grid._background;
    grid.dispose();
    ok(unregistrations.some(u => u.channel === 'grid' && u.mesh === bgMesh), 'Background unregistered on dispose');
    ok(unregistrations.some(u => u.channel === 'glyph'), 'Renderer unregistered on dispose');
}

eq(grid._renderer, null, 'Renderer disposed');
eq(grid._filenameField, null, 'Filename field disposed');

console.log(`\nCodeGrid InstancedField: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
