# Phase 0: Scene Annotation Commands — Implementation-Ready Code

## Agent: scene-api

This document contains implementation-ready code for scene annotation WebSocket commands. All code follows the existing patterns in `examples/github-viewer/websocket/commands/` and builds on the existing CodeGrid + Three.js Object3D system.

---

## 1. New File: `annotationCommands.js`

Location: `examples/github-viewer/websocket/commands/annotationCommands.js`

```javascript
/**
 * Annotation commands: label.create, label.remove, label.list,
 * highlight.grid, highlight.clear,
 * camera.animate, camera.lookat.grid,
 * scene.annotate, scene.clear_annotations
 *
 * Labels and annotations are lightweight CodeGrids tracked in ctx.annotations.
 * Highlights are reversible color/scale overrides tracked in ctx.highlights.
 */

import { box, table, kvLines } from '../TUIFormatter.js';
import CodeGrid from '../../../../src/collections/CodeGrid.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerAnnotationCommands(router) {

    // ================================================================
    //  label.create <base64-text> <x> <y> <z> [r g b]
    // ================================================================

    router.register('label.create', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: label.create <base64-text> <x> <y> <z> [r g b]', data: null };
        }

        let text;
        try { text = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // Optional color (defaults to bright white)
        let color = { r: 1.0, g: 1.0, b: 1.0 };
        if (args.length >= 7) {
            const [r, g, b] = args.slice(4, 7).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const id = `label-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: id,
            showBackground: false,
            showFilename: false,
            textColor: color,
            gridScale: 1.0,
        });

        grid.loadText(text);
        grid.position.set(x, y, z);

        // Add to scene directly (not to ctx grids — these are annotations, not content)
        ctx.scene.add(grid);

        // Track in annotations registry
        ctx.annotations.set(id, { type: 'label', grid, text, position: { x, y, z }, color });

        return {
            text: `OK: label "${id}" created at (${x}, ${y}, ${z})`,
            data: { id, position: { x, y, z }, color, text }
        };
    }, {
        description: 'Create a floating text label at a position',
        usage: '<base64-text> <x> <y> <z> [r g b]'
    });

    // ================================================================
    //  label.remove <id>
    // ================================================================

    router.register('label.remove', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: label.remove <id>', data: null };
        }

        const id = args[0];
        const entry = ctx.annotations.get(id);

        if (!entry) {
            return { text: `ERR: no annotation with id "${id}"`, data: null };
        }

        entry.grid.dispose();
        ctx.scene.remove(entry.grid);
        ctx.annotations.delete(id);

        return {
            text: `OK: removed label "${id}"`,
            data: { id }
        };
    }, { description: 'Remove a label by id', usage: '<id>' });

    // ================================================================
    //  label.list
    // ================================================================

    router.register('label.list', (args, ctx) => {
        const entries = [...ctx.annotations.entries()];

        if (entries.length === 0) {
            return {
                text: box('ANNOTATIONS', ['(none)'], 50) + '\nOK: 0 annotations',
                data: { annotations: [], count: 0 }
            };
        }

        const headers = ['id', 'type', 'position', 'text'];
        const rows = entries.map(([id, e]) => {
            const pos = e.position || { x: 0, y: 0, z: 0 };
            const preview = (e.text || '').slice(0, 25);
            return [
                id.length > 20 ? id.slice(0, 19) + '\u2026' : id,
                e.type,
                `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`,
                preview.length < (e.text || '').length ? preview + '\u2026' : preview
            ];
        });

        const data = entries.map(([id, e]) => ({
            id,
            type: e.type,
            position: e.position,
            text: e.text,
        }));

        return {
            text: table(headers, rows) + `\nOK: ${entries.length} annotations`,
            data: { annotations: data, count: entries.length }
        };
    }, { description: 'List all labels and annotations' });

    // ================================================================
    //  highlight.grid <index> [r g b]
    // ================================================================

    router.register('highlight.grid', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) {
            return { text: 'ERR: usage: highlight.grid <index> [r g b]', data: null };
        }

        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        // Default highlight color: bright cyan
        let color = { r: 0.2, g: 1.0, b: 1.0 };
        if (args.length >= 4) {
            const [r, g, b] = args.slice(1, 4).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const grid = grids[idx];

        // Save original state if not already highlighted
        if (!ctx.highlights.has(idx)) {
            ctx.highlights.set(idx, {
                originalScale: grid.scale.clone(),
                originalZ: grid.position.z,
            });
        }

        // Apply highlight: color tint via group color
        const collection = grid.getCollection();
        if (collection && collection.setGroupColor) {
            collection.setGroupColor(0, color);
        }

        // Slight Z-pop: bring grid forward so it stands out
        const saved = ctx.highlights.get(idx);
        grid.position.z = saved.originalZ + 3;

        // Slight scale bump (5%)
        const s = saved.originalScale;
        grid.scale.set(s.x * 1.05, s.y * 1.05, s.z * 1.05);

        return {
            text: `OK: grid #${idx} highlighted with color (${color.r}, ${color.g}, ${color.b})`,
            data: { index: idx, color }
        };
    }, {
        description: 'Visually emphasize a grid with color + Z-pop',
        usage: '<index> [r g b]'
    });

    // ================================================================
    //  highlight.clear [index]
    // ================================================================

    router.register('highlight.clear', (args, ctx) => {
        const grids = ctx.getGrids();

        // If an index is given, clear only that one
        if (args.length >= 1) {
            const idx = parseInt(args[0]);
            if (isNaN(idx)) {
                return { text: 'ERR: index must be a number', data: null };
            }
            const removed = _clearHighlight(ctx, grids, idx);
            if (!removed) {
                return { text: `ERR: grid #${idx} is not highlighted`, data: null };
            }
            return {
                text: `OK: highlight cleared for grid #${idx}`,
                data: { cleared: [idx] }
            };
        }

        // Clear all highlights
        const cleared = [];
        for (const idx of [...ctx.highlights.keys()]) {
            _clearHighlight(ctx, grids, idx);
            cleared.push(idx);
        }

        return {
            text: `OK: cleared ${cleared.length} highlight(s)`,
            data: { cleared }
        };
    }, {
        description: 'Remove highlight from grids (all or by index)',
        usage: '[index]'
    });

    // ================================================================
    //  camera.animate <x> <y> <z> <duration-ms>
    // ================================================================

    router.register('camera.animate', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: camera.animate <x> <y> <z> <duration-ms>', data: null };
        }

        const [x, y, z] = args.slice(0, 3).map(Number);
        const duration = parseInt(args[3]);
        if ([x, y, z, duration].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers and duration must be integer ms', data: null };
        }
        if (duration < 1 || duration > 30000) {
            return { text: 'ERR: duration must be between 1 and 30000 ms', data: null };
        }

        const camera = ctx.camera;
        const startPos = camera.position.clone();
        const startTime = performance.now();

        // Cancel any existing animation
        if (ctx._cameraAnimationId != null) {
            cancelAnimationFrame(ctx._cameraAnimationId);
            ctx._cameraAnimationId = null;
        }

        function easeInOutCubic(t) {
            return t < 0.5
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }

        function tick() {
            const elapsed = performance.now() - startTime;
            const t = Math.min(elapsed / duration, 1.0);
            const eased = easeInOutCubic(t);

            camera.position.set(
                startPos.x + (x - startPos.x) * eased,
                startPos.y + (y - startPos.y) * eased,
                startPos.z + (z - startPos.z) * eased
            );

            if (t < 1.0) {
                ctx._cameraAnimationId = requestAnimationFrame(tick);
            } else {
                ctx._cameraAnimationId = null;
            }
        }

        ctx._cameraAnimationId = requestAnimationFrame(tick);

        // Also reset pitch/yaw so physics-based controller doesn't fight the animation
        if (ctx.cameraController) {
            ctx.cameraController.pitch = ctx.cameraController.pitch || 0;
            ctx.cameraController.yaw = ctx.cameraController.yaw || 0;
        }

        return {
            text: `OK: animating camera to (${x}, ${y}, ${z}) over ${duration}ms`,
            data: { target: { x, y, z }, duration }
        };
    }, {
        description: 'Smoothly animate camera to position (ease-in-out)',
        usage: '<x> <y> <z> <duration-ms>'
    });

    // ================================================================
    //  camera.lookat.grid <index>
    // ================================================================

    router.register('camera.lookat.grid', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: camera.lookat.grid <index>', data: null };
        }

        const grids = ctx.getGrids();
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        const grid = grids[idx];
        const bounds = grid.getBounds();

        // Compute center of the grid's bounding box
        const cx = (bounds.min.x + bounds.max.x) / 2;
        const cy = (bounds.min.y + bounds.max.y) / 2;
        const cz = (bounds.min.z + bounds.max.z) / 2;

        ctx.camera.lookAt(cx, cy, cz);

        // Update CameraController pitch/yaw to match the new orientation
        // so the physics-based controller stays in sync
        if (ctx.cameraController) {
            const euler = ctx.camera.rotation.clone();
            euler.order = 'YXZ';
            ctx.cameraController.pitch = euler.x;
            ctx.cameraController.yaw = euler.y;
        }

        const name = grid.getFilename() || `#${idx}`;
        return {
            text: `OK: camera looking at grid ${name} center (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)})`,
            data: { index: idx, center: { x: cx, y: cy, z: cz } }
        };
    }, {
        description: 'Point camera at a grid\'s center without moving',
        usage: '<index>'
    });

    // ================================================================
    //  scene.annotate <base64-text> <x> <y> <z> [r g b]
    // ================================================================

    router.register('scene.annotate', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: scene.annotate <base64-text> <x> <y> <z> [r g b]', data: null };
        }

        let text;
        try { text = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // Optional color (defaults to amber for annotation text)
        let color = { r: 1.0, g: 0.9, b: 0.5 };
        if (args.length >= 7) {
            const [r, g, b] = args.slice(4, 7).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const id = `annot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: id,
            showBackground: true,
            showFilename: false,
            textColor: color,
            backgroundColor: 0x1a1a2e,
            backgroundOpacity: 0.9,
            backgroundPadding: 1.2,
            gridScale: 1.0,
        });

        grid.loadText(text);
        grid.position.set(x, y, z);

        ctx.scene.add(grid);
        ctx.annotations.set(id, { type: 'annotation', grid, text, position: { x, y, z }, color });

        return {
            text: `OK: annotation "${id}" created at (${x}, ${y}, ${z})`,
            data: { id, position: { x, y, z }, color, text }
        };
    }, {
        description: 'Create a text annotation with background box',
        usage: '<base64-text> <x> <y> <z> [r g b]'
    });

    // ================================================================
    //  scene.clear_annotations
    // ================================================================

    router.register('scene.clear_annotations', (args, ctx) => {
        let count = 0;
        for (const [id, entry] of ctx.annotations) {
            entry.grid.dispose();
            ctx.scene.remove(entry.grid);
            count++;
        }
        ctx.annotations.clear();

        // Also clear all highlights
        const grids = ctx.getGrids();
        for (const idx of [...ctx.highlights.keys()]) {
            _clearHighlight(ctx, grids, idx);
        }
        const highlightCount = ctx.highlights.size;

        return {
            text: `OK: cleared ${count} annotation(s) and ${highlightCount} highlight(s)`,
            data: { annotations: count, highlights: highlightCount }
        };
    }, { description: 'Remove all CLI-created labels, annotations, and highlights' });
}

// ================================================================
//  Helper: restore a single highlighted grid to its original state
// ================================================================

function _clearHighlight(ctx, grids, idx) {
    const saved = ctx.highlights.get(idx);
    if (!saved) return false;

    const grid = grids[idx];
    if (grid) {
        // Restore original scale
        grid.scale.copy(saved.originalScale);
        // Restore original Z
        grid.position.z = saved.originalZ;
        // Reset color to white (identity multiplier)
        const collection = grid.getCollection();
        if (collection && collection.setGroupColor) {
            collection.setGroupColor(0, { r: 1, g: 1, b: 1 });
        }
    }

    ctx.highlights.delete(idx);
    return true;
}
```

---

## 2. Modifications to `websocket/index.js` — Context Bag

Add the `annotations` Map and `highlights` Map to the context bag, plus the `_cameraAnimationId` slot for the animation system.

### Diff (applied to `buildContext` in `websocket/index.js`):

```javascript
// BEFORE — end of buildContext():
        // Window manager (populated after bridge creation)
        windowManager: viewer.windowManager || null,

        // WebSocket bridge (populated after creation)
        wsbridge: null,
    };
}

// AFTER — end of buildContext():
        // Window manager (populated after bridge creation)
        windowManager: viewer.windowManager || null,

        // WebSocket bridge (populated after creation)
        wsbridge: null,

        // Annotation system: labels and scene annotations created via CLI
        annotations: new Map(),

        // Highlight system: tracks original state of highlighted grids
        highlights: new Map(),

        // Camera animation frame ID (for cancellation)
        _cameraAnimationId: null,
    };
}
```

Three new properties:

| Property | Type | Purpose |
|----------|------|---------|
| `annotations` | `Map<string, {type, grid, text, position, color}>` | Tracks all CLI-created labels and annotations for cleanup |
| `highlights` | `Map<number, {originalScale, originalZ}>` | Saves original grid state before highlight so it can be restored |
| `_cameraAnimationId` | `number\|null` | `requestAnimationFrame` ID for smooth camera animation; used to cancel in-flight animations |

---

## 3. Modifications to `commands/index.js` — Registration

### Diff:

```javascript
// BEFORE:
import registerSearchCommands from './searchCommands.js';

export function registerAllCommands(router) {
    registerSystemCommands(router);
    registerCameraCommands(router);
    registerGridCommands(router);
    registerSceneCommands(router);
    registerSelectCommands(router);
    registerLayoutCommands(router);
    registerSearchCommands(router);
}

// AFTER:
import registerSearchCommands from './searchCommands.js';
import registerAnnotationCommands from './annotationCommands.js';

export function registerAllCommands(router) {
    registerSystemCommands(router);
    registerCameraCommands(router);
    registerGridCommands(router);
    registerSceneCommands(router);
    registerSelectCommands(router);
    registerLayoutCommands(router);
    registerSearchCommands(router);
    registerAnnotationCommands(router);
}
```

---

## 4. CLI Encoding Support — `glyph-cli.mjs`

The existing `encodeContentArgs()` in the CLI handles `grid.create` and `grid.text` base64-encoding. The new label/annotation commands also take base64 as their first argument. The CLI needs to be extended to auto-encode for these commands too.

### Additional encoding block to add inside `encodeContentArgs()`:

```javascript
/**
 * Handle label.create and scene.annotate:
 * label.create <text> <x> <y> <z> [r g b]
 * scene.annotate <text> <x> <y> <z> [r g b]
 *
 * First arg is text content, rest are numeric coordinates/color.
 */
const matchAnnotation = cmd.match(/^(label\.create|scene\.annotate)\s+(.+)$/);
if (matchAnnotation) {
    const cmdName = matchAnnotation[1];
    const rest = matchAnnotation[2];
    let text, remaining;

    if (rest.startsWith('"')) {
        const endQuote = rest.indexOf('"', 1);
        if (endQuote > 0) {
            text = rest.slice(1, endQuote);
            remaining = rest.slice(endQuote + 1).trim();
        } else {
            text = rest.slice(1);
            remaining = '';
        }
    } else {
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx > 0) {
            text = rest.slice(0, spaceIdx);
            remaining = rest.slice(spaceIdx + 1).trim();
        } else {
            text = rest;
            remaining = '';
        }
    }

    const b64 = Buffer.from(text).toString('base64');
    return remaining ? `${cmdName} ${b64} ${remaining}` : `${cmdName} ${b64}`;
}
```

This should be inserted inside `encodeContentArgs()` before the `return cmd;` fallthrough at the bottom.

---

## 5. Wire Protocol Examples

All commands go over the existing WebSocket text protocol. The relay forwards string messages from controller to display; display returns JSON `{ response, data }`.

### label.create

```
→  label.create SGVsbG8gV29ybGQ= 10 20 5
←  {"response":"OK: label \"label-1711568123456-a3f2\" created at (10, 20, 5)","data":{"id":"label-1711568123456-a3f2","position":{"x":10,"y":20,"z":5},"color":{"r":1,"g":1,"b":1},"text":"Hello World"}}
```

With optional color (green):

```
→  label.create SGVsbG8= 0 0 0 0 1 0
←  {"response":"OK: label \"label-...\" created at (0, 0, 0)","data":{"id":"label-...","position":{"x":0,"y":0,"z":0},"color":{"r":0,"g":1,"b":0},"text":"Hello"}}
```

### label.remove

```
→  label.remove label-1711568123456-a3f2
←  {"response":"OK: removed label \"label-1711568123456-a3f2\"","data":{"id":"label-1711568123456-a3f2"}}
```

### label.list

```
→  label.list
←  {"response":"id                    type        position     text\n...\nOK: 2 annotations","data":{"annotations":[...],"count":2}}
```

### highlight.grid

```
→  highlight.grid 3
←  {"response":"OK: grid #3 highlighted with color (0.2, 1, 1)","data":{"index":3,"color":{"r":0.2,"g":1,"b":1}}}
```

With custom red highlight:

```
→  highlight.grid 3 1 0.2 0.2
←  {"response":"OK: grid #3 highlighted with color (1, 0.2, 0.2)","data":{"index":3,"color":{"r":1,"g":0.2,"b":0.2}}}
```

### highlight.clear

Clear all:

```
→  highlight.clear
←  {"response":"OK: cleared 3 highlight(s)","data":{"cleared":[0,3,7]}}
```

Clear one:

```
→  highlight.clear 3
←  {"response":"OK: highlight cleared for grid #3","data":{"cleared":[3]}}
```

### camera.animate

```
→  camera.animate 100 -50 200 2000
←  {"response":"OK: animating camera to (100, -50, 200) over 2000ms","data":{"target":{"x":100,"y":-50,"z":200},"duration":2000}}
```

### camera.lookat.grid

```
→  camera.lookat.grid 5
←  {"response":"OK: camera looking at grid index.js center (45.2, -30.1, 0.0)","data":{"index":5,"center":{"x":45.2,"y":-30.1,"z":0}}}
```

### scene.annotate

```
→  scene.annotate VE9ETzogUmVmYWN0b3IgdGhpcw== 50 -10 0
←  {"response":"OK: annotation \"annot-1711568200000-b7c1\" created at (50, -10, 0)","data":{"id":"annot-...","position":{"x":50,"y":-10,"z":0},"color":{"r":1,"g":0.9,"b":0.5},"text":"TODO: Refactor this"}}
```

### scene.clear_annotations

```
→  scene.clear_annotations
←  {"response":"OK: cleared 4 annotation(s) and 2 highlight(s)","data":{"annotations":4,"highlights":2}}
```

---

## 6. Example CLI Sessions

### Session 1: Code Review Annotations

```
$ node glyph-cli.mjs

glyph> grid.list
#  filename            glyphs  lines  position
-- --------            ------  -----  --------
0  src/index.js        2340    89     0,0,0
1  src/utils.js        1560    62     60,0,0
2  src/main.js         4200    156    120,0,0
OK: 3 grids

glyph> highlight.grid 2 1 0.3 0.3
OK: grid #2 highlighted with color (1, 0.3, 0.3)

glyph> camera.focus 2
OK: focusing on grid 2

glyph> scene.annotate "Bug: race condition on line 42" 122 -40 2
OK: annotation "annot-1711568200000-b7c1" created at (122, -40, 2)

glyph> label.create "CRITICAL" 118 -38 4 1 0 0
OK: label "label-1711568201234-x9k2" created at (118, -38, 4)

glyph> camera.animate 125 -45 30 1500
OK: animating camera to (125, -45, 30) over 1500ms

glyph> label.list
id                    type        position     text
----                  ----        --------     ----
label-171156820..     label       118,-38,4    CRITICAL
annot-171156820..     annotation  122,-40,2    Bug: race condition on...
OK: 2 annotations

glyph> scene.clear_annotations
OK: cleared 2 annotation(s) and 1 highlight(s)
```

### Session 2: Guided Tour via Batch

```
$ node glyph-cli.mjs

glyph> batch ["camera.animate 0 0 500 1000", "highlight.grid 0 0 1 0.5", "label.create \"U3RhcnQgaGVyZQ==\" -5 5 1 0.5 1 0.5"]
OK: batch completed (3/3 succeeded)

glyph> camera.lookat.grid 0
OK: camera looking at grid src/index.js center (25.3, -44.1, 0.0)

glyph> highlight.clear 0
OK: highlight cleared for grid #0

glyph> highlight.grid 1 1 1 0
OK: grid #1 highlighted with color (1, 1, 0)

glyph> camera.animate 85 -30 80 2000
OK: animating camera to (85, -30, 80) over 2000ms
```

### Session 3: JSON Mode for Programmatic Use

```
$ node glyph-cli.mjs --json

glyph> .json on
Output: JSON

glyph> label.create "Entry point" 0 5 0
{
  "id": "label-1711568300000-m2p4",
  "position": { "x": 0, "y": 5, "z": 0 },
  "color": { "r": 1, "g": 1, "b": 1 },
  "text": "Entry point"
}

glyph> label.list
{
  "annotations": [
    {
      "id": "label-1711568300000-m2p4",
      "type": "label",
      "position": { "x": 0, "y": 5, "z": 0 },
      "text": "Entry point"
    }
  ],
  "count": 1
}
```

---

## 7. Command Summary Table

| Command | Args | Description |
|---------|------|-------------|
| `label.create` | `<base64-text> <x> <y> <z> [r g b]` | Floating text label (no background) |
| `label.remove` | `<id>` | Remove a specific label by ID |
| `label.list` | | List all labels and annotations |
| `highlight.grid` | `<index> [r g b]` | Color tint + Z-pop + 5% scale on a grid |
| `highlight.clear` | `[index]` | Revert one or all highlights |
| `camera.animate` | `<x> <y> <z> <duration-ms>` | Smooth camera move with ease-in-out cubic |
| `camera.lookat.grid` | `<index>` | Rotate camera to face a grid's center |
| `scene.annotate` | `<base64-text> <x> <y> <z> [r g b]` | Text with dark background panel |
| `scene.clear_annotations` | | Remove all labels + annotations + highlights |

---

## 8. Design Decisions and Rationale

### Labels and annotations are CodeGrids, not custom meshes

CodeGrid already handles text rendering, background panels, positioning, and disposal. A label is just a small CodeGrid with `showBackground: false`. An annotation is a CodeGrid with `showBackground: true`. This reuse means zero new rendering code.

### Annotations tracked separately from content grids

Labels and annotations go into `ctx.annotations` (a Map keyed by generated ID), not into `ctx.getGrids()`. This prevents annotation grids from appearing in `grid.list`, being affected by layout managers, or shifting content grid indices. `scene.clear_annotations` can nuke all annotations without touching content.

### Highlights are reversible

The highlight system saves `originalScale` and `originalZ` before modifying the grid. `highlight.clear` restores these values and resets the group color to white (identity multiplier). This makes highlights non-destructive — you can highlight, review, and clear without losing the original visual state.

### camera.animate uses requestAnimationFrame, not setTimeout

The animation runs on the browser's rAF loop for smooth 60fps interpolation. It uses ease-in-out cubic for natural-feeling motion. Only one animation can be active at a time; starting a new one cancels the in-flight one. The command returns immediately (the animation is fire-and-forget from the WebSocket perspective).

### camera.lookat.grid syncs CameraController pitch/yaw

After calling `camera.lookAt()`, the code extracts the resulting Euler angles and writes them back to `ctx.cameraController.pitch` and `ctx.cameraController.yaw`. Without this, the physics-based camera controller would override the lookAt on the next frame. This is the same pattern used in `focusOnGrid()`.

### Base64 encoding for text content

All text content goes over the wire as base64, matching the existing convention for `grid.create` and `grid.text`. The CLI's `encodeContentArgs()` handles transparent encoding so users can type plain text in the REPL.
