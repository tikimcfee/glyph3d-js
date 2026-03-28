# Phase 0 Commands: Registry as Source of Truth

Previous convergence kept `viewer.grids` as truth with registry alongside. That is reversed. The registry IS the truth. The grids array becomes a derived view.

## Core Principle

Every command that creates, removes, finds, or iterates grids goes through the registry. `ctx.getGrids()` returns a derived array from `registry.findByType('grid')`. No command handler touches `viewer.grids` directly.

---

## 1. SceneRegistry gains an ordered type query

```js
// SceneRegistry.js -- add insertion-order index per type

register(id, grid, { type, ...meta }) {
    if (this._entries.has(id)) {
        const existing = this._entries.get(id);
        this._gridToId.delete(existing.grid);
    }
    const entry = { id, grid, type, meta };
    this._entries.set(id, entry);
    this._gridToId.set(grid, id);
    return entry;
}

/**
 * Ordered array of grids (type='grid') -- replaces viewer.grids.
 * Insertion order from the Map guarantees stable indices.
 * @returns {Object[]} array of CodeGrid instances
 */
grids() {
    const result = [];
    for (const entry of this._entries.values()) {
        if (entry.type === 'grid') result.push(entry.grid);
    }
    return result;
}
```

Map iteration order in JS is insertion order. This gives us stable indices that match the old `viewer.grids` array as long as registration order matches push order.

---

## 2. Context bag rewire

```js
// websocket/index.js -- buildContext()

function buildContext(viewer) {
    const registry = new SceneRegistry();

    return {
        scene: viewer.scene,
        camera: viewer.camera,
        renderer: viewer.renderer,
        atlas: viewer.atlas,
        registry,

        // DERIVED VIEW -- not a data store
        getGrids: () => registry.grids(),

        // Registry-first grid mutation
        addGrid(grid, opts = {}) {
            const sourcePath = grid.getSourcePath?.() || null;
            const filename = grid.getFilename?.() || grid.name || null;
            const id = opts.id || sourcePath || filename
                || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

            registry.register(id, grid, {
                type: opts.type || 'grid',
                sourcePath,
                filename,
                ...opts.meta,
            });
            viewer.scene.add(grid);
            return id;
        },

        removeGrid(idOrIndex) {
            // Accept registry ID (string) or numeric index
            let entry;
            if (typeof idOrIndex === 'number') {
                const grids = registry.grids();
                if (idOrIndex < 0 || idOrIndex >= grids.length) return null;
                const grid = grids[idOrIndex];
                const regId = registry.getIdByGrid(grid);
                if (!regId) return null;
                entry = registry.unregister(regId);
            } else {
                entry = registry.unregister(idOrIndex);
            }
            if (!entry) return null;
            entry.grid.dispose();
            viewer.scene.remove(entry.grid);
            return entry;
        },

        // ... rest unchanged (cameraController, selectionManager, etc.)
    };
}
```

Key changes:
- `getGrids()` derives from registry, not `viewer.grids`
- `addGrid` registers first, scene-adds second. Returns registry ID.
- `removeGrid` accepts string ID or numeric index. No more index-shift bugs from `splice`.
- `viewer.grids` is never read or written by command code.

---

## 3. resolveGridByIdOrIndex -- integer-first, registry-backed

```js
// spatialHelpers.js

export function resolveGridByIdOrIndex(ctx, arg, label = 'grid') {
    // 1. Integer-first guard: if arg is purely numeric, treat as index
    if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg);
        const grids = ctx.getGrids();  // derived from registry
        if (idx < 0 || idx >= grids.length) {
            return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
        }
        const registryId = ctx.registry.getIdByGrid(grids[idx]) || null;
        return { grid: grids[idx], idx, registryId };
    }

    // 2. Registry lookup by string ID
    const entry = ctx.registry.get(arg);
    if (entry) {
        const grids = ctx.getGrids();
        const idx = grids.indexOf(entry.grid);
        return { grid: entry.grid, idx, registryId: entry.id };
    }

    // 3. Not found
    const grids = ctx.getGrids();
    return { error: `ERR: no ${label} found for "${arg}" (not a registry ID or valid index 0-${grids.length - 1})` };
}
```

The old `resolveGrid(grids, arg)` is retired. Every call site migrates to `resolveGridByIdOrIndex(ctx, arg)`.

---

## 4. grid.list -- registry IDs as primary identifiers

```js
// gridCommands.js

router.register('grid.list', (args, ctx) => {
    const entries = ctx.registry.findByType('grid');
    if (entries.length === 0) {
        return {
            text: box('GRIDS', ['(no grids loaded)'], 50) + '\nOK: 0 grids',
            data: { grids: [], count: 0 }
        };
    }

    const headers = ['#', 'id', 'filename', 'glyphs', 'lines'];
    const rows = entries.map((e, i) => {
        const g = e.grid;
        const name = g.getFilename() || g.getSourcePath() || '(unnamed)';
        return [
            String(i),
            e.id.length > 35 ? '\u2026' + e.id.slice(-34) : e.id,
            name.length > 25 ? '\u2026' + name.slice(-24) : name,
            String(g.getGlyphCount()),
            String(g.getLineCount()),
        ];
    });

    const gridData = entries.map((e, i) => ({
        index: i,
        id: e.id,
        filename: e.grid.getFilename(),
        sourcePath: e.grid.getSourcePath(),
        glyphs: e.grid.getGlyphCount(),
        lines: e.grid.getLineCount(),
    }));

    return {
        text: table(headers, rows) + `\nOK: ${entries.length} grids`,
        data: { grids: gridData, count: entries.length }
    };
});
```

Index is display convenience. ID is what you copy-paste into commands.

---

## 5. grid.create -- single registration path

```js
router.register('grid.create', (args, ctx) => {
    if (args.length < 1) {
        return { text: 'ERR: usage: grid.create <base64-text> [name]', data: null };
    }
    let text;
    try { text = atob(args[0]); } catch { return { text: 'ERR: invalid base64 content', data: null }; }
    const name = args[1] || null;

    const grid = new CodeGrid(ctx.scene, ctx.atlas, {
        name: name || `cli-grid-${Date.now()}`,
        showBackground: true,
        showFilename: !!name,
    });
    if (name) grid.filename = name;
    grid.loadText(text);

    // Single registration via addGrid -- no double-register
    const registryId = ctx.addGrid(grid, { id: name || undefined });

    const idx = ctx.getGrids().length - 1;
    return {
        text: `OK: created grid #${idx} "${registryId}" (${grid.getGlyphCount()} glyphs)`,
        data: { index: idx, registryId, glyphs: grid.getGlyphCount(), lines: grid.getLineCount() }
    };
});
```

---

## 6. grid.remove -- by ID or index, no splice

```js
router.register('grid.remove', (args, ctx) => {
    if (args.length < 1) return { text: 'ERR: usage: grid.remove <id|index>', data: null };

    const resolved = resolveGridByIdOrIndex(ctx, args[0]);
    if (resolved.error) return { text: resolved.error, data: null };

    const name = resolved.grid.getFilename?.() || resolved.registryId || '(unnamed)';
    const removedEntry = ctx.removeGrid(resolved.registryId || resolved.idx);
    if (!removedEntry) return { text: 'ERR: removal failed', data: null };

    return {
        text: `OK: removed "${name}" (was #${resolved.idx})`,
        data: { removedId: resolved.registryId, removedIndex: resolved.idx, name }
    };
});
```

---

## 7. Commands that iterate grids: use registry.findByType

### scene.info

```js
router.register('scene.info', (args, ctx) => {
    const gridEntries = ctx.registry.findByType('grid');
    let totalGlyphs = 0;
    for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

    const counts = ctx.registry.typeCounts();
    const data = {
        'grids': String(gridEntries.length),
        'glyphs': totalGlyphs.toLocaleString(),
        'windows': String(counts.window || 0),
        'annotations': String((counts.annotation || 0) + (counts.label || 0)),
        'registry total': String(ctx.registry.size),
    };
    // ... renderer info same as before
    return { text: box('SCENE', kvLines(data), 50) + '\nOK', data: { ... } };
});
```

### search -- iterate registry entries, not raw array

```js
router.register('search', (args, ctx) => {
    const query = args.join(' ').toLowerCase();
    const entries = ctx.registry.findByType('grid');
    const results = [];
    for (const e of entries) {
        const path = e.grid.getSourcePath() || e.grid.getFilename() || e.id;
        if (path.toLowerCase().includes(query)) {
            results.push({ id: e.id, path, type: 'filename' });
        }
    }
    // ... format same as before but include registry ID in output
});
```

### select -- find by path via registry

```js
router.register('select', (args, ctx) => {
    if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };
    const path = args.join(' ');
    const entries = ctx.registry.findByType('grid');
    const entry = entries.find(e => {
        const sp = e.grid.getSourcePath() || '';
        return sp === path || sp.endsWith(path);
    });
    if (!entry) return { text: `ERR: file not found: ${path}`, data: null };
    // ... rest uses entry.grid
});
```

---

## 8. Spatial/composition commands: swap resolveGrid -> resolveGridByIdOrIndex

All 8 call sites in spatialCommands.js, all 5 in compositionCommands.js, and the 2 in navigationCommands.js change from:

```js
const resolved = resolveGrid(grids, args[0]);
```

to:

```js
const resolved = resolveGridByIdOrIndex(ctx, args[0]);
```

The return shape is compatible (`{ grid, idx, registryId }` vs old `{ grid, idx }`). The `registryId` field is additive. No other handler logic changes.

For `unionBounds` calls that take an array of grids, pass `ctx.getGrids()` -- which now derives from registry.

---

## 9. scene.reset -- registry-driven cleanup

```js
router.register('scene.reset', (args, ctx) => {
    // 1. Clear annotations via registry
    const annotTypes = ['annotation', 'label', 'tour-annotation'];
    for (const type of annotTypes) {
        for (const entry of ctx.registry.findByType(type)) {
            entry.grid.dispose();
            ctx.scene.remove(entry.grid);
            ctx.registry.unregister(entry.id);
        }
    }
    ctx.annotations.clear();

    // 2. Restore highlights
    restoreAllGridStates(ctx);

    // 3. Cancel camera animation
    ctx._cancelCameraAnimation?.();

    // 4. --windows flag: remove agent+window types via registry
    let agentCount = 0;
    if (args.includes('--windows')) {
        for (const type of ['agent', 'window']) {
            for (const entry of ctx.registry.findByType(type)) {
                entry.grid.dispose();
                ctx.scene.remove(entry.grid);
                ctx.registry.unregister(entry.id);
                agentCount++;
            }
        }
    }

    return { text: `OK: scene reset`, data: { agentCount } };
});
```

No index math. No reverse-order iteration to avoid shift bugs. Just iterate by type and unregister.

---

## 10. tour.stop -- store registryId for stable replay

```js
router.register('tour.stop', (args, ctx) => {
    // ... parse args same as before
    const resolved = resolveGridByIdOrIndex(ctx, args[1], 'grid');
    if (resolved.error) return { text: resolved.error, data: null };

    tour.stops.push({
        gridIndex: resolved.idx,
        registryId: resolved.registryId,  // stable across add/remove
        annotation,
        duration,
        annotationId: null,
    });
    // ...
});
```

In `tour.play`, resolve each stop with:

```js
const stopRef = stop.registryId || String(stop.gridIndex);
const resolved = resolveGridByIdOrIndex(ctx, stopRef);
if (resolved.error) continue;
```

---

## 11. camera.focus -- registry as third lookup

```js
router.register('camera.focus', (args, ctx) => {
    const target = args.join(' ');
    const grids = ctx.getGrids();

    // 1. Numeric index
    const idx = parseInt(target);
    if (!isNaN(idx) && idx >= 0 && idx < grids.length) {
        ctx.cameraController.focusOnGrid(idx);
        return { text: `OK: focusing on grid ${idx}`, data: { index: idx } };
    }

    // 2. Registry ID (exact match, non-numeric strings)
    if (ctx.registry.has(target)) {
        const entry = ctx.registry.get(target);
        const regIdx = grids.indexOf(entry.grid);
        if (regIdx >= 0) ctx.cameraController.focusOnGrid(regIdx);
        return { text: `OK: focusing on "${target}"`, data: { registryId: target, index: regIdx } };
    }

    // 3. Filename substring fallback
    const matchIdx = grids.findIndex(g => {
        const name = g.getFilename() || g.getSourcePath() || '';
        return name.toLowerCase().includes(target.toLowerCase());
    });
    if (matchIdx >= 0) {
        ctx.cameraController.focusOnGrid(matchIdx);
        return { text: `OK: focusing on grid ${matchIdx}`, data: { index: matchIdx } };
    }

    return { text: `ERR: no grid matching '${target}'`, data: null };
});
```

---

## 12. findAgentGrids -- registry-only, drop fallback

```js
function findAgentGrids(ctx) {
    const entries = [
        ...ctx.registry.findByType('agent'),
        ...ctx.registry.findByType('window'),
    ];
    return entries.map(entry => ({
        grid: entry.grid,
        label: entry.meta.label || entry.meta.windowId || entry.id,
        registryId: entry.id,
    }));
}
```

No more name-prefix scanning. No more `grids.indexOf()` for an index we never needed. The `index` field is dropped from the agent descriptor -- layout commands position grids directly, they don't need array indices.

If `layout.focus` needs to pass an index to `cameraController.focusOnGrid()`, it computes it on demand: `ctx.getGrids().indexOf(target.grid)`.

---

## Migration checklist

| File | resolveGrid calls | getGrids iteration | addGrid/removeGrid | Status |
|---|---|---|---|---|
| spatialHelpers.js | rewrite resolveGridByIdOrIndex | n/a | n/a | |
| websocket/index.js | n/a | rewrite getGrids + addGrid + removeGrid | primary target | |
| gridCommands.js | 8 sites -> resolveGridByIdOrIndex | grid.list -> findByType | create/remove | |
| spatialCommands.js | 8 sites -> resolveGridByIdOrIndex | bounds.union | n/a | |
| compositionCommands.js | 5 sites -> resolveGridByIdOrIndex | n/a | n/a | |
| navigationCommands.js | 3 sites -> resolveGridByIdOrIndex | tour.play iteration | n/a | |
| cameraCommands.js | camera.focus special case | camera.fitall | n/a | |
| sceneCommands.js | n/a | scene.info -> findByType | n/a | |
| searchCommands.js | n/a | search -> findByType | n/a | |
| selectCommands.js | n/a | select -> findByType | n/a | |
| annotationCommands.js | highlight.grid, camera.lookat.grid | scene.reset -> findByType | n/a | |
| agentLayoutCommands.js | n/a | findAgentGrids rewrite | n/a | |
| orchestrationCommands.js | n/a | window.track gridIdx validation | n/a | |
| windowCommands.js | n/a | n/a | n/a (already registry-based) | |
| registryCommands.js | n/a | already registry-native | n/a | |

## Migration order

1. `SceneRegistry.js` -- add `grids()` method
2. `spatialHelpers.js` -- integer-first guard in resolveGridByIdOrIndex, remove old resolveGrid
3. `websocket/index.js` -- rewrite context bag (getGrids derives from registry, addGrid/removeGrid are registry ops)
4. All command files in any order -- they all depend on (1-3) being done

## What this eliminates

- **viewer.grids array**: no longer read or written by any command code
- **Index-shift bugs**: removeGrid by ID, no splice
- **Double registration**: addGrid is the single path
- **Name-prefix scanning**: findAgentGrids uses registry types, not string matching
- **Dual access patterns**: one way to find things -- the registry
