# Phase 0: Rewire Commands from Index-Based to Registry-Based Lookup

## Summary

Every command that resolves a grid currently calls either `resolveGrid(grids, arg)` (index-only)
or does inline `parseInt` + array bounds checking. The existing `resolveGridByIdOrIndex(ctx, arg)`
already handles registry-first, index-fallback. This phase rewires all call sites to use it.

Numeric indices still work. No breaking changes.

---

## 1. spatialHelpers.js -- no changes needed

`resolveGridByIdOrIndex` already exists at lines 43-64. It tries `ctx.registry.get(arg)` first,
falls back to numeric index. Returns `{ grid, idx, registryId }`.

The old `resolveGrid(grids, arg)` stays as-is for any callers that genuinely have no ctx.

---

## 2. gridCommands.js -- 7 handlers to rewrite

### 2a. grid.list -- add registryId column

```js
router.register('grid.list', (args, ctx) => {
    const grids = ctx.getGrids();
    if (grids.length === 0) {
        return {
            text: box('GRIDS', ['(no grids loaded)'], 50) + '\nOK: 0 grids',
            data: { grids: [], count: 0 }
        };
    }

    const headers = ['#', 'id', 'filename', 'glyphs', 'lines', 'position'];
    const rows = grids.map((g, i) => {
        const regId = ctx.registry.getIdByGrid(g) || '';
        const name = g.getFilename() || g.getSourcePath() || '(unnamed)';
        const pos = g.position;
        return [
            String(i),
            regId.length > 20 ? regId.slice(0, 19) + '\u2026' : regId,
            name.length > 25 ? '\u2026' + name.slice(-24) : name,
            String(g.getGlyphCount()),
            String(g.getLineCount()),
            `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`
        ];
    });

    const gridData = grids.map((g, i) => ({
        index: i,
        registryId: ctx.registry.getIdByGrid(g) || null,
        filename: g.getFilename(),
        sourcePath: g.getSourcePath(),
        glyphs: g.getGlyphCount(),
        lines: g.getLineCount(),
    }));

    return {
        text: table(headers, rows) + `\nOK: ${grids.length} grids`,
        data: { grids: gridData, count: grids.length }
    };
}, { description: 'List all loaded grids' });
```

### 2b. grid.info -- use resolveGridByIdOrIndex, show registryId

```js
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

router.register('grid.info', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: grid.info <id|index>', data: null };

    const resolved = resolveGridByIdOrIndex(ctx, args[0]);
    if (resolved.error) return { text: resolved.error, data: null };

    const { grid: g, idx, registryId } = resolved;
    const pos = g.position;

    const data = {
        'index': String(idx),
        'registryId': registryId || '(none)',
        'filename': g.getFilename() || '(none)',
        'sourcePath': g.getSourcePath() || '(none)',
        'glyphs': String(g.getGlyphCount()),
        'lines': String(g.getLineCount()),
        'maxWidth': String(g.getMaxLineWidth()),
        'position': `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
        'visible': String(g.visible),
    };

    const label = registryId || `#${idx}`;
    return {
        text: box(`GRID ${label}`, kvLines(data), 50) + '\nOK: grid info',
        data: {
            index: idx, registryId,
            filename: g.getFilename(), sourcePath: g.getSourcePath(),
            glyphs: g.getGlyphCount(), lines: g.getLineCount(),
            position: { x: pos.x, y: pos.y, z: pos.z }, visible: g.visible,
        }
    };
}, { description: 'Show grid details', usage: '<id|index>' });
```

### 2c. grid.color, grid.visibility, grid.text, grid.position, grid.scale -- same pattern

All six follow identical refactoring. Replace the inline `parseInt` + bounds check with
`resolveGridByIdOrIndex`. Example for grid.color:

```js
router.register('grid.color', (args, ctx) => {
    if (args.length < 4) return { text: 'ERR: usage: grid.color <id|index> <r> <g> <b>', data: null };

    const resolved = resolveGridByIdOrIndex(ctx, args[0]);
    if (resolved.error) return { text: resolved.error, data: null };

    const [r, g, b] = args.slice(1, 4).map(Number);
    if ([r, g, b].some(isNaN)) return { text: 'ERR: r, g, b must be numbers (0-1)', data: null };

    const collection = resolved.grid.getCollection();
    if (collection && collection.setGroupColor) {
        collection.setGroupColor(0, { r, g, b });
    }
    const label = resolved.registryId || `#${resolved.idx}`;
    return {
        text: `OK: grid ${label} color set to (${r}, ${g}, ${b})`,
        data: { index: resolved.idx, registryId: resolved.registryId, color: { r, g, b } }
    };
}, { description: 'Set grid text color', usage: '<id|index> <r> <g> <b>' });
```

Apply the same `resolveGridByIdOrIndex(ctx, args[0])` replacement to:
- `grid.visibility` (args[0] is the id/index)
- `grid.text` (args[0] is the id/index)
- `grid.position` (args[0] is the id/index)
- `grid.scale` (args[0] is the id/index)

### 2d. grid.remove -- accept id or index, unregister

```js
router.register('grid.remove', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: grid.remove <id|index>', data: null };

    const resolved = resolveGridByIdOrIndex(ctx, args[0]);
    if (resolved.error) return { text: resolved.error, data: null };

    const { grid, idx, registryId } = resolved;
    const name = grid.getFilename() || grid.name || '(unnamed)';

    // ctx.removeGrid handles registry unregister + scene removal
    ctx.removeGrid(idx);

    const label = registryId || `#${idx}`;
    return {
        text: `OK: removed grid ${label} "${name}"`,
        data: { removedIndex: idx, registryId, name, remaining: ctx.getGrids().length }
    };
}, { description: 'Remove a grid from the scene', usage: '<id|index>' });
```

### 2e. grid.create -- already registers, no change needed

Already calls `ctx.registry.register()` and `ctx.addGrid()`. No migration needed.

### Import needed at top of gridCommands.js

```js
import { resolveGridByIdOrIndex } from './spatialHelpers.js';
```

---

## 3. cameraCommands.js -- camera.focus

Replace inline index/name search with registry-aware lookup:

```js
router.register('camera.focus', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: camera.focus <id|index|name>', data: null };
    const target = args.join(' ');
    const grids = ctx.getGrids();

    // 1. Try registry ID first
    if (ctx.registry) {
        const entry = ctx.registry.get(target);
        if (entry) {
            const idx = grids.indexOf(entry.grid);
            if (idx >= 0) {
                ctx.cameraController.focusOnGrid(idx);
                return {
                    text: `OK: focusing on ${entry.id} (grid #${idx})`,
                    data: { index: idx, registryId: entry.id }
                };
            }
        }
    }

    // 2. Try as numeric index
    const idx = parseInt(target);
    if (!isNaN(idx) && idx >= 0 && idx < grids.length) {
        ctx.cameraController.focusOnGrid(idx);
        return {
            text: `OK: focusing on grid #${idx}`,
            data: { index: idx }
        };
    }

    // 3. Fall back to filename substring match
    const matchIdx = grids.findIndex(g => {
        const name = g.getFilename() || g.getSourcePath() || '';
        return name.toLowerCase().includes(target.toLowerCase());
    });
    if (matchIdx >= 0) {
        const name = grids[matchIdx].getFilename();
        return {
            text: `OK: focusing on grid #${matchIdx} (${name})`,
            data: { index: matchIdx, name }
        };
    }

    return { text: `ERR: no grid matching '${target}'`, data: null };
}, { description: 'Focus camera on grid by id, index, or name', usage: '<id|index|name>' });
```

---

## 4. compositionCommands.js -- grid.align, grid.attach, grid.stack

Change import from `resolveGrid` to `resolveGridByIdOrIndex`, update all call sites.

### Import change

```diff
-import { resolveGrid, getWorldBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
+import { resolveGridByIdOrIndex, getWorldBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
```

### grid.align (line 127-129)

```diff
-const srcRes = resolveGrid(grids, args[0], 'source');
+const srcRes = resolveGridByIdOrIndex(ctx, args[0], 'source');
-const tgtRes = resolveGrid(grids, args[1], 'target');
+const tgtRes = resolveGridByIdOrIndex(ctx, args[1], 'target');
```

Remove the `const grids = ctx.getGrids();` line (resolveGridByIdOrIndex gets grids internally).

### grid.attach (line 213-216) -- same pattern

```diff
-const srcRes = resolveGrid(grids, args[0], 'source');
+const srcRes = resolveGridByIdOrIndex(ctx, args[0], 'source');
-const tgtRes = resolveGrid(grids, args[1], 'target');
+const tgtRes = resolveGridByIdOrIndex(ctx, args[1], 'target');
```

### grid.stack (line 333)

```diff
-const res = resolveGrid(grids, raw, 'grid');
+const res = resolveGridByIdOrIndex(ctx, raw, 'grid');
```

Note: `resolved[i].idx` still works because `resolveGridByIdOrIndex` returns `{ grid, idx, registryId }`.
The `idx` may be -1 for registry-only objects not in grids array -- callers that use `idx` for
bounds/position are fine since they operate on `resolved.grid` directly, not `grids[idx]`.

---

## 5. spatialCommands.js -- grid.bounds, grid.anchor, grid.distance, grid.overlap, grid.bounds.union

### Import change

```diff
-import { resolveGrid, getWorldBounds, getWorldBox3, unionBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
+import { resolveGridByIdOrIndex, getWorldBounds, getWorldBox3, unionBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
```

### All resolveGrid calls become resolveGridByIdOrIndex(ctx, ...)

```diff
 // grid.bounds
-const resolved = resolveGrid(grids, args[0]);
+const resolved = resolveGridByIdOrIndex(ctx, args[0]);

 // grid.anchor
-const resolved = resolveGrid(grids, args[0]);
+const resolved = resolveGridByIdOrIndex(ctx, args[0]);

 // grid.distance
-const r1 = resolveGrid(grids, args[0]);
-const r2 = resolveGrid(grids, args[1]);
+const r1 = resolveGridByIdOrIndex(ctx, args[0]);
+const r2 = resolveGridByIdOrIndex(ctx, args[1]);

 // grid.overlap
-const r1 = resolveGrid(grids, args[0]);
-const r2 = resolveGrid(grids, args[1]);
+const r1 = resolveGridByIdOrIndex(ctx, args[0]);
+const r2 = resolveGridByIdOrIndex(ctx, args[1]);

 // grid.bounds.union
-const resolved = resolveGrid(grids, arg);
+const resolved = resolveGridByIdOrIndex(ctx, arg);
```

Remove `const grids = ctx.getGrids()` from each handler (no longer needed at top level,
though `unionBounds` still needs the grids array -- pass `ctx.getGrids()` to it directly).

---

## 6. navigationCommands.js -- camera.frame, tour.stop, tour.play

### Import change

```diff
-import { resolveGrid, getWorldBounds, unionBounds, ... } from './spatialHelpers.js';
+import { resolveGridByIdOrIndex, getWorldBounds, unionBounds, ... } from './spatialHelpers.js';
```

### camera.frame (line 148)

```diff
-const resolved = resolveGrid(grids, args[i]);
+const resolved = resolveGridByIdOrIndex(ctx, args[i]);
```

### tour.stop (line 309)

```diff
-const resolved = resolveGrid(grids, args[1], 'grid');
+const resolved = resolveGridByIdOrIndex(ctx, args[1], 'grid');
```

### tour.play (line 390) -- internal re-validation

```diff
-const resolved = resolveGrid(grids, String(stop.gridIndex));
+const resolved = resolveGridByIdOrIndex(ctx, String(stop.gridIndex));
```

---

## 7. sceneCommands.js -- scene.info

Add registry counts alongside grid count:

```js
router.register('scene.info', (args, ctx) => {
    const grids = ctx.getGrids();
    let totalGlyphs = 0;
    for (const g of grids) totalGlyphs += g.getGlyphCount();

    const winCount = ctx.windowManager ? ctx.windowManager.count : 0;
    const typeCounts = ctx.registry.typeCounts();

    const data = {
        'grids': String(grids.length),
        'glyphs': totalGlyphs.toLocaleString(),
        'windows': String(winCount),
        'registry': String(ctx.registry.size),
        'registry types': Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(' '),
        'scene children': String(ctx.scene.children.length),
    };
    // ... rest unchanged
});
```

---

## 8. searchCommands.js / selectCommands.js -- minimal changes

**searchCommands.js**: Iterates `ctx.getGrids()` for filename matching. No index resolution.
Optionally enrich results with `registryId`:

```diff
 results.push({ path, type: 'filename', line: null });
+const regId = ctx.registry.getIdByGrid(g);
+results.push({ path, type: 'filename', line: null, registryId: regId });
```

**selectCommands.js**: Uses `grids.find()` by sourcePath. No index resolution needed.
No changes required.

---

## 9. index.js (context bag) -- getGrids() stays as-is

`getGrids: () => viewer.grids` returns the live array. This is fine -- the registry is the
authoritative source of identity, but the array remains the ordered iteration source.
No change needed here; `removeGrid(index)` already calls `registry.unregister()`.

---

## File-level change summary

| File | Lines changed (est.) | Nature |
|------|---------------------|--------|
| `gridCommands.js` | ~40 | Add import, rewrite 7 handlers to use resolveGridByIdOrIndex |
| `cameraCommands.js` | ~15 | Rewrite camera.focus with registry-first lookup |
| `compositionCommands.js` | ~8 | Swap import + 5 call sites |
| `spatialCommands.js` | ~12 | Swap import + 7 call sites |
| `navigationCommands.js` | ~6 | Swap import + 3 call sites |
| `sceneCommands.js` | ~4 | Add registry counts to scene.info |
| `searchCommands.js` | ~2 | Enrich results with registryId (optional) |
| `selectCommands.js` | 0 | No changes needed |
| `spatialHelpers.js` | 0 | No changes needed |
| `index.js` | 0 | No changes needed |

Total: ~87 lines changed across 7 files. Zero new files. Zero breaking changes.
