# Phase 0: Integration Surface Analysis -- Spatial Window Manager

Agent: Integration Surface
Focus: How WindowGroups register, propagate selection, drive color layers, expose commands, and lifecycle with existing services.

---

## 1. Registration Model

**Decision**: Groups are a new registry type `'group'` in SceneRegistry. A group entry's `grid` field points to a lightweight `WindowGroup` object (not a CodeGrid). Membership is tracked by the group, not the registry -- the registry does not need to know which grids belong to which group.

**Decision**: A grid can belong to at most one group. Simplifies everything: no priority resolution, no multi-parent transforms.

```js
// WindowGroup registers itself in SceneRegistry
registry.register('group:workspace-1', windowGroup, {
    type: 'group',
    name: 'workspace-1',
    layout: 'stack',    // 'stack' | 'splay' | 'free'
});

// Member grids keep their existing type:'grid' entries unchanged.
// The group tracks membership internally:
class WindowGroup {
    constructor(id) {
        this.id = id;
        this.memberIds = new Set();  // registry IDs of member grids
        this.layout = 'free';        // 'stack' | 'splay' | 'free'
        this.visible = true;
    }
}
```

**Lookup patterns**:
- `registry.findByType('group')` returns all group entries.
- `registry.findByMeta('groupId', 'workspace-1')` does NOT work for members because group membership is not in the grid's registry meta. Instead, the SpatialWindowManager holds a `Map<gridId, groupId>` reverse index.
- `findByType('grid')` continues to work unchanged -- groups do not pollute the grid type cache.

**Why not put `groupId` in registry meta?** Because SceneRegistry.register() overwrites entries, and grid registration happens in GitHubRepoViewer._createGrid() / windowCommands.js before groups exist. Adding meta later would require a `registry.updateMeta()` method that does not exist. Cleaner to keep membership in the WindowGroup / SpatialWindowManager.

---

## 2. Selection x Groups

**Decision**: Click a grouped window -> select that individual window (not the whole group). Group-level selection is a separate gesture: Shift+click the group header, or `select.group <name>`.

**Decision**: Dragging a selected group member moves the entire group. This is the key UX payoff -- spatial grouping means spatial movement as a unit. Dragging an unselected member first selects it (and the group), then moves.

**Decision**: Z-pop lifts the entire group. SelectionManager currently operates on sourcePath strings. The integration point is SelectionManager's `_applyZPop` -- the SpatialWindowManager listens for `'select'` events and, if the selected grid is in a group, applies the same Z delta to all siblings.

```js
// In SpatialWindowManager, listening to SelectionManager events:
selectionManager.on((eventType, sourcePath, state) => {
    if (eventType !== 'select') return;
    const gridId = this._findGridIdBySourcePath(sourcePath);
    const groupId = this._gridToGroup.get(gridId);
    if (!groupId) return;

    const group = this._groups.get(groupId);
    for (const memberId of group.memberIds) {
        if (memberId === gridId) continue;  // already Z-popped by SelectionManager
        const entry = this._registry.get(memberId);
        if (entry) this._applyGroupZPop(entry.grid);
    }
});
```

**Multi-select across groups**: Works normally. Each selected grid brings its own group along for Z-pop. If grids from two different groups are selected, both groups pop. No merging.

---

## 3. Color Layer for Groups

**Decision**: Register a `'group-tint'` layer in CodeColorManager at priority 5 (below heatmap at 10, below selection at 15). Each group gets a deterministic accent color derived from its name hash.

```js
// Registered once during SpatialWindowManager init:
codeColorManager.registerLayer('group-tint', {
    priority: 5,
    watchProperties: ['groupId'],
    colorFn: (sourcePath, fileProps) => {
        const groupId = fileProps?.groupId;
        if (!groupId) return null;
        return this._groupColors.get(groupId) || null;
    },
});
```

**Integration**: When a grid joins a group, write `groupId` to FileStateManager:
```js
fileStateManager.setProperty(sourcePath, 'groupId', 'workspace-1');
```

This triggers CodeColorManager's `_handlePropertyChanged` because `'groupId'` is in `watchProperties`. The tint applies automatically.

When a grid leaves a group:
```js
fileStateManager.setProperty(sourcePath, 'groupId', null);
```

Color resolves to `null` from group-tint layer, falls through to lower layers or neutral white.

**Color palette**: 8 distinct low-saturation colors (group indices mod 8). Enough contrast to distinguish groups without overwhelming heatmap or selection tints.

---

## 4. Command Surface

### New `group.*` namespace

| Command | Args | Description |
|---------|------|-------------|
| `group.create` | `<name> [id1 id2 ...]` | Create group, optionally with initial members |
| `group.add` | `<group> <id\|path>` | Add grid to group (removes from previous group) |
| `group.remove` | `<group> <id\|path>` | Remove grid from group |
| `group.dissolve` | `<group>` | Remove group, ungroup all members |
| `group.stack` | `<group>` | Arrange members in vertical stack |
| `group.splay` | `<group> [angle]` | Fan members out from center |
| `group.free` | `<group>` | Remove layout constraints, keep membership |
| `group.hide` | `<group>` | Hide all members (set visible=false on grids) |
| `group.show` | `<group>` | Show all members |
| `group.list` | | List all groups with member counts |
| `group.info` | `<group>` | Show group details: members, layout, bounds |
| `group.move` | `<group> <x> <y> <z>` | Move group centroid to position |

### Interaction with existing `window.*` commands

- `window.move` on a grouped window: moves the entire group (offset-preserving). The SpatialWindowManager intercepts the position change.
- `window.close` on a grouped window: removes from group first, then closes. If last member, auto-dissolves group.
- `window.list` unchanged -- groups are a separate concern.

### Interaction with `select.*` commands

- `select.group <name>`: new command, selects all members of a group additively.
- `select.clear` continues to work -- groups just observe deselection events.

### Handler file

New file: `app/commands/handlers/groupCommands.js`, registered in `handlers/index.js`.

```js
// app/commands/handlers/groupCommands.js (sketch)
export default function registerGroupCommands(router) {
    router.register('group.create', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: group.create <name> [id...]', data: null };
        const name = args[0];
        const memberIds = args.slice(1);

        const manager = ctx.spatialManager;
        if (!manager) return { text: 'ERR: spatial manager not initialized', data: null };

        const group = manager.createGroup(name);
        for (const id of memberIds) {
            const resolved = resolveGridByIdOrIndex(ctx, id);
            if (!resolved.error) {
                manager.addToGroup(name, resolved.entry.id);
            }
        }

        return {
            text: `OK: group '${name}' created (${group.memberIds.size} members)`,
            data: { name, members: [...group.memberIds] },
        };
    }, { description: 'Create a window group', usage: '<name> [id1 id2 ...]' });

    // ... remaining commands follow same pattern
}
```

---

## 5. SceneContext Extension

**Decision**: Add `ctx.spatialManager` to the command context bag. NOT on SceneContext itself -- SceneContext is a lightweight ref container for core subsystems. The spatial manager is an app-level concern.

```js
// In app/commands/index.js buildContext():
function buildContext(viewer) {
    return {
        // ...existing fields...
        spatialManager: viewer.spatialManager || null,
    };
}
```

**Decision**: `viewer.spatialManager` is a `SpatialWindowManager` instance, created in `GitHubRepoViewer.init()` after FileStateManager and SelectionManager exist.

```js
// In GitHubRepoViewer.init(), after selectionManager creation:
this.spatialManager = new SpatialWindowManager({
    registry: this.registry,
    selectionManager: this.selectionManager,
    fileStateManager: this.fileStateManager,
    codeColorManager: this.codeColorManager,
    scene: this.scene,
});
```

---

## 6. Lifecycle

### Grid disposal while in a group

SpatialWindowManager listens to `registry._onChange`:
```js
registry._onChange = (type) => {
    if (type === 'grid') this._reconcileMembers();
};
```

`_reconcileMembers()` walks all groups, checks if each member ID still exists in the registry. Removes stale IDs. If a group becomes empty, auto-dissolves it (unregisters the group entry).

**Caveat**: `registry._onChange` is a single callback slot, not an event bus. Either convert it to an array of callbacks, or have the SpatialWindowManager poll on each reconcile. **Recommendation**: Convert `_onChange` to a `Set<Function>` -- minimal change, same pattern as FileStateManager._listeners.

```js
// SceneRegistry modification (minimal):
constructor() {
    // ...existing...
    this._changeListeners = new Set();
}

_invalidateCache(type) {
    this._typeCache.delete(type);
    for (const cb of this._changeListeners) {
        try { cb(type); } catch (e) { console.error('[registry] onChange error:', e); }
    }
    // Keep _onChange for backward compat during transition
    if (this._onChange) { try { this._onChange(type); } catch (e) {} }
}

onChange(fn) { this._changeListeners.add(fn); }
offChange(fn) { this._changeListeners.delete(fn); }
```

### Repo clear

`GitHubRepoViewer.clearGrids()` calls `registry.unregisterByType('grid')`. This triggers `_onChange('grid')` which triggers `_reconcileMembers()`, which auto-dissolves all groups. Then:

```js
// In clearGrids(), add:
if (this.spatialManager) this.spatialManager.clear();
```

This is belt-and-suspenders: reconcile handles it reactively, `clear()` handles it imperatively.

### Persistence

**Decision**: Yes, persist group state to localStorage. Groups are user-created organizational structures that should survive reload.

```js
// Serialized shape:
{
    groups: [
        { name: 'workspace-1', layout: 'stack', memberPaths: ['src/foo.js', 'src/bar.js'] }
    ]
}
```

Keyed by `memberPaths` (sourcePaths), not registry IDs, because IDs are regenerated each load. On restore, match by sourcePath to find the grid's registry ID.

Integration with existing `StatePersistence.js`: add a `groups` field to the saved state object. `StatePersistence.save()` reads from `viewer.spatialManager.serialize()`. `StatePersistence.restore()` calls `viewer.spatialManager.deserialize(data.groups)` after grids are loaded.

---

## 7. Code Sketch: SpatialWindowManager

```js
// src/services/spatial/SpatialWindowManager.js

export class SpatialWindowManager {
    constructor({ registry, selectionManager, fileStateManager, codeColorManager, scene }) {
        this._registry = registry;
        this._selection = selectionManager;
        this._fileState = fileStateManager;
        this._colorManager = codeColorManager;
        this._scene = scene;

        /** @type {Map<string, WindowGroup>} groupName -> WindowGroup */
        this._groups = new Map();

        /** @type {Map<string, string>} gridRegistryId -> groupName */
        this._gridToGroup = new Map();

        /** @type {Map<string, {r,g,b}>} groupName -> accent color */
        this._groupColors = new Map();

        // Register color layer
        this._colorManager.registerLayer('group-tint', {
            priority: 5,
            watchProperties: ['groupId'],
            colorFn: (sourcePath, fileProps) => {
                const gid = fileProps?.groupId;
                return gid ? (this._groupColors.get(gid) || null) : null;
            },
        });

        // Listen for registry changes to reconcile membership
        this._registry.onChange(() => this._reconcileMembers());

        // Listen for selection to apply group Z-pop
        this._selection.on(this._onSelectionChange.bind(this));
    }

    createGroup(name) { /* ... */ }
    addToGroup(groupName, gridId) { /* ... */ }
    removeFromGroup(groupName, gridId) { /* ... */ }
    dissolveGroup(name) { /* ... */ }
    setLayout(groupName, layout) { /* ... */ }
    moveGroup(groupName, x, y, z) { /* ... */ }
    hideGroup(name) { /* ... */ }
    showGroup(name) { /* ... */ }
    getGroupForGrid(gridId) { return this._gridToGroup.get(gridId) || null; }

    serialize() { /* -> { groups: [...] } */ }
    deserialize(data) { /* restore from saved state */ }
    clear() { /* dissolve all groups */ }
    dispose() { /* unsubscribe everything */ }

    _reconcileMembers() { /* remove stale grid IDs from all groups */ }
    _onSelectionChange(eventType, sourcePath, state) { /* group Z-pop */ }
    _assignGroupColor(name) { /* deterministic hash -> palette index */ }
}
```

---

## 8. Integration Wiring Summary

| System | Touch Point | Nature of Change |
|--------|------------|------------------|
| SceneRegistry | New `'group'` type; `onChange()` listener API | Additive (new type + multi-listener) |
| SelectionManager | SpatialWindowManager listens via `.on()` | Read-only observation |
| CodeColorManager | New `'group-tint'` layer at priority 5 | Additive (new layer) |
| FileStateManager | Writes `groupId` property per grid | Additive (new property) |
| CommandRouter | New `group.*` namespace (12 commands) | Additive (new handler file) |
| buildContext() | Add `spatialManager` field | One-line addition |
| GitHubRepoViewer | Create SpatialWindowManager in init(), clear in clearGrids() | Two insertion points |
| StatePersistence | Add `groups` to saved/restored state | Additive field |
| ShortcutManager | Optional: `G` to group selected, `U` to ungroup | Additive registrations |

**Files to create**:
- `src/services/spatial/SpatialWindowManager.js` -- core manager
- `src/services/spatial/WindowGroup.js` -- group data structure
- `app/commands/handlers/groupCommands.js` -- command handlers

**Files to modify**:
- `src/services/SceneRegistry.js` -- add multi-listener `onChange()`/`offChange()`
- `app/commands/handlers/index.js` -- import + register group commands
- `app/commands/index.js` -- add `spatialManager` to context bag
- `app/GitHubRepoViewer.js` -- create manager, wire cleanup
- `app/StatePersistence.js` -- serialize/deserialize group state
