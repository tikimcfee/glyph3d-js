# Phase 0 — StateController Design

## Problem Statement

Persistence is currently split across three independent systems with no shared contract:

1. **StatePersistence** (`app/StatePersistence.js`) — blob-serializes an in-memory `state` object to a single `glyph3d-viewer-state` key. Every `_save()` call writes the entire blob, even if only one field changed. The `_saveCameraIfDirty()` method must `delete this.state.groups` before writing to avoid clobbering group data with stale state — a textbook ghost-state bug that only works because of a manual workaround.

2. **ViewerCameraController** (`src/services/camera/ViewerCameraController.js`) — owns `glyph3d-camera-settings` independently. Its own `loadSettings()`/`saveSettings()` free functions duplicate the exact same localStorage pattern.

3. **GitHubRepoViewer** (`app/GitHubRepoViewer.js`) — has two direct `localStorage.getItem/setItem` calls for `glyph3d-ws-enabled`, completely outside either persistence system. Also calls `loadState()` at construction time (line 150) independently of the `StatePersistence` instance created later (line 447), meaning there are two deserialization points for the same key.

### The ghost-state problem in detail

`StatePersistence._save()` serializes `this.state` — the entire in-memory object — to one key. If `saveGroups()` writes `groups` into `this.state`, then 5 seconds later `_saveCameraIfDirty()` fires, it would re-persist the now-stale `groups` snapshot alongside the fresh camera position. The current fix is `delete this.state.groups` before the camera save. This is fragile: any new field added to the blob needs its own deletion guard.

The root cause is blob serialization. If camera and groups wrote to separate keys, they could never clobber each other.

---

## StateController API

### Design principles

- **Namespaced keys**: Each subsystem owns a namespace. Writes to `camera.position` cannot affect `repo` or `groups`.
- **Per-field writes**: `set('camera.position', {...})` writes exactly one localStorage key. No in-memory blob re-serialization.
- **Key convention**: All keys are prefixed with `g3d.` to avoid collisions. Namespace separator is `.`. The localStorage key for `set('camera.position', val)` is `g3d.camera.position`.
- **JSON-in, JSON-out**: Values are JSON-serialized on write, JSON-parsed on read. Primitives, arrays, and plain objects only.
- **No caching by default**: Reads go to localStorage. This eliminates stale in-memory state entirely. (localStorage reads are ~0.01ms — cheaper than the complexity of cache invalidation.)

### Namespace map (replacing current keys)

| Namespace key | Replaces | Type |
|---|---|---|
| `repo.url` | `state.repoUrl` | string |
| `repo.branch` | `state.branch` | string |
| `repo.wasLoaded` | `state.wasLoaded` | boolean |
| `repo.loadingInProgress` | `state.loadingInProgress` | boolean |
| `source.mode` | `state.sourceMode` | string |
| `source.localRoot` | `state.localRoot` | string |
| `source.customFileTypes` | `state.customFileTypes` | string[] or null |
| `ui.layout` | `state.activeLayout` | string |
| `ui.gridsScale` | `state.gridsScale` | number |
| `ui.layoutSpacing` | `state.layoutSpacing` | number |
| `ui.wsEnabled` | `glyph3d-ws-enabled` | boolean |
| `camera.position` | `state.cameraPosition` | {x,y,z} |
| `camera.speed` | from camera-settings blob | number |
| `camera.dragSensitivity` | from camera-settings blob | number |
| `camera.scrollSensitivity` | from camera-settings blob | number |
| `camera.invertDragX` | from camera-settings blob | boolean |
| `camera.invertDragY` | from camera-settings blob | boolean |
| `camera.invertScroll` | from camera-settings blob | boolean |
| `camera.dynamicSpeed` | from camera-settings blob | boolean |
| `groups` | `state.groups` | Object[] or null |

### Class sketch

```javascript
/**
 * StateController — namespaced localStorage persistence.
 *
 * Each key maps to exactly one localStorage entry: `g3d.{key}`.
 * No in-memory blob. No ghost-state. Reads always hit storage.
 */
const PREFIX = 'g3d.';

export class StateController {
    /**
     * Read a value by namespaced key.
     * @param {string} key — e.g. 'camera.position', 'repo.url'
     * @param {*} [fallback] — returned if key is absent or corrupt
     * @returns {*}
     */
    get(key, fallback = undefined) {
        try {
            const raw = localStorage.getItem(PREFIX + key);
            return raw !== null ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }

    /**
     * Write a value by namespaced key.
     * @param {string} key
     * @param {*} value — must be JSON-serializable
     */
    set(key, value) {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch { /* quota / private mode */ }
    }

    /**
     * Delete a single key.
     * @param {string} key
     */
    delete(key) {
        localStorage.removeItem(PREFIX + key);
    }

    /**
     * Delete all keys under a namespace prefix.
     * clearNamespace('camera') removes camera.position, camera.speed, etc.
     * @param {string} ns
     */
    clearNamespace(ns) {
        const target = PREFIX + ns + '.';
        const exact = PREFIX + ns;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k === exact || k.startsWith(target)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
    }

    /**
     * Delete every g3d.* key.
     */
    clearAll() {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(PREFIX)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
    }

    /**
     * List all keys (without prefix) under a namespace.
     * @param {string} ns
     * @returns {string[]}
     */
    listNamespace(ns) {
        const target = PREFIX + ns + '.';
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(target)) keys.push(k.slice(PREFIX.length));
        }
        return keys;
    }

    /**
     * Read all keys under a namespace as a flat object.
     * getNamespace('camera') -> { 'camera.position': {...}, 'camera.speed': 100, ... }
     * @param {string} ns
     * @returns {Object}
     */
    getNamespace(ns) {
        const target = PREFIX + ns + '.';
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(target)) {
                try {
                    result[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
                } catch { /* skip corrupt */ }
            }
        }
        return result;
    }
}
```

That is 75 lines. No dependencies. No imports. Pure localStorage wrapper.

---

## Migration Path

### Step 1: Add StateController, keep StatePersistence alive

Create `src/services/state/StateController.js` with the class above. Export a singleton:

```javascript
export const stateController = new StateController();
```

Add it to `src/index.js` exports. StatePersistence continues to work unchanged.

### Step 2: Migrate one-off localStorage calls first

**GitHubRepoViewer.js** lines 549/567 (`glyph3d-ws-enabled`):
```javascript
// Before
const savedWsEnabled = localStorage.getItem('glyph3d-ws-enabled');
localStorage.setItem('glyph3d-ws-enabled', checkbox.checked ? 'true' : 'false');

// After
const savedWsEnabled = stateController.get('ui.wsEnabled', false);
stateController.set('ui.wsEnabled', checkbox.checked);
```

Two-line change, zero risk.

### Step 3: Migrate ViewerCameraController

Replace `loadSettings()` / `saveSettings()` free functions. Each setting becomes its own key:

```javascript
// Before (blob)
const settings = loadSettings();  // reads one key, parses entire blob

// After (per-field)
this.cameraSpeed = stateController.get('camera.speed', 100);
this.dragSensitivity = stateController.get('camera.dragSensitivity', 1.0);
// ...etc

// Save individual field on change:
stateController.set('camera.speed', this.cameraSpeed);
```

Remove the `STORAGE_KEY` constant and both free functions. The DEFAULTS object stays as inline fallback arguments to `get()`.

### Step 4: Decompose StatePersistence blob

This is the core migration. Replace `loadState()`/`saveState()` with per-field reads/writes:

```javascript
// Before: _save() writes everything
_save() { saveState(this.state); }

// After: each event handler writes only its fields
onRepoLoaded(url, branch) {
    stateController.set('repo.url', url);
    stateController.set('repo.branch', branch);
    stateController.set('repo.wasLoaded', true);
    stateController.set('repo.loadingInProgress', false);
}

onLayoutChanged(layout) {
    stateController.set('ui.layout', layout);
}

_saveCameraIfDirty() {
    if (!this._cameraDirty) return;
    this._cameraDirty = false;
    const pos = this.viewer.camera?.position;
    if (pos) {
        stateController.set('camera.position', { x: pos.x, y: pos.y, z: pos.z });
        // No 'delete this.state.groups' needed — camera and groups are separate keys
    }
}

saveGroups() {
    stateController.set('groups', this.viewer.spatialManager?.serialize() ?? null);
}
```

The `this.state` in-memory blob disappears entirely. `restoreUI()` reads each field independently:

```javascript
restoreUI() {
    const repoUrl = stateController.get('repo.url', '');
    const sourceMode = stateController.get('source.mode', 'github');
    // ...each field read individually with its own default
}
```

### Step 5: Remove legacy blob code

Delete `loadState()`, `saveState()`, `DEFAULTS`, `STORAGE_KEY` from StatePersistence.js. The `resetAllAndReload()` function becomes:

```javascript
export function resetAllAndReload() {
    stateController.clearAll();
    window.location.reload();
}
```

### Step 6: Fix the double-load in GitHubRepoViewer

Line 150 currently calls `loadState()` at construction to read `sourceMode` and `localRoot` before `StatePersistence` is constructed at line 447. With `StateController`, this becomes:

```javascript
this._sourceMode = urlSource || stateController.get('source.mode', 'github');
this._localRoot = stateController.get('source.localRoot', '.');
```

No duplicate deserialization. No separate `StatePersistence` instance needed for early reads.

---

## Write Discipline

The ghost-state problem is eliminated structurally, not by convention:

1. **No blob**: There is no in-memory object that accumulates fields. Each `set()` writes exactly one key.
2. **No cross-contamination**: `set('camera.position', ...)` cannot possibly affect `groups` because they are separate localStorage entries.
3. **No stale reads**: `get()` reads directly from localStorage. No in-memory cache to drift.
4. **No deletion guards**: The `delete this.state.groups` hack becomes unnecessary because camera saves never touch the `groups` key.

Rule for all future code: **call `stateController.set(key, value)` with exactly the key you intend to write**. If a subsystem only changes camera position, it only writes `camera.position`. Period.

---

## Backward Compatibility

On first load after migration, old keys (`glyph3d-viewer-state`, `glyph3d-camera-settings`, `glyph3d-ws-enabled`) will exist but no `g3d.*` keys will. A one-time migration function handles this:

```javascript
export function migrateFromLegacy(sc) {
    // Already migrated?
    if (sc.get('_migrated')) return;

    // Migrate viewer state blob
    try {
        const raw = localStorage.getItem('glyph3d-viewer-state');
        if (raw) {
            const s = JSON.parse(raw);
            if (s.repoUrl) sc.set('repo.url', s.repoUrl);
            if (s.branch) sc.set('repo.branch', s.branch);
            if (s.wasLoaded) sc.set('repo.wasLoaded', true);
            if (s.activeLayout) sc.set('ui.layout', s.activeLayout);
            if (s.gridsScale != null) sc.set('ui.gridsScale', s.gridsScale);
            if (s.layoutSpacing != null) sc.set('ui.layoutSpacing', s.layoutSpacing);
            if (s.cameraPosition) sc.set('camera.position', s.cameraPosition);
            if (s.sourceMode) sc.set('source.mode', s.sourceMode);
            if (s.localRoot) sc.set('source.localRoot', s.localRoot);
            if (s.customFileTypes) sc.set('source.customFileTypes', s.customFileTypes);
            if (s.groups) sc.set('groups', s.groups);
        }
    } catch { /* corrupt — skip */ }

    // Migrate camera settings blob
    try {
        const raw = localStorage.getItem('glyph3d-camera-settings');
        if (raw) {
            const s = JSON.parse(raw);
            for (const [k, v] of Object.entries(s)) {
                sc.set(`camera.${k}`, v);
            }
        }
    } catch { /* skip */ }

    // Migrate ws-enabled
    const ws = localStorage.getItem('glyph3d-ws-enabled');
    if (ws !== null) sc.set('ui.wsEnabled', ws === 'true');

    // Mark done, remove old keys
    sc.set('_migrated', true);
    localStorage.removeItem('glyph3d-viewer-state');
    localStorage.removeItem('glyph3d-camera-settings');
    localStorage.removeItem('glyph3d-ws-enabled');
}
```

Call `migrateFromLegacy(stateController)` once at app startup before any reads. After migration, old keys are removed. Users who have never visited the app get clean `g3d.*` keys from the start.

---

## Summary

| What | Current | After |
|---|---|---|
| localStorage keys | 3 (two blobs + one bare) | ~20 individual `g3d.*` keys |
| In-memory blob | `this.state` object (full re-serialize) | None |
| Ghost-state risk | `delete this.state.groups` hack | Structurally impossible |
| Camera settings | Separate file, separate pattern | Same `StateController` |
| WS enabled flag | Raw `localStorage` in viewer | `stateController.get('ui.wsEnabled')` |
| Double load | `loadState()` at line 150 + StatePersistence at 447 | Single `stateController.get()` calls |
| Reset | Remove two hardcoded keys | `stateController.clearAll()` |
| Migration | N/A | One-time `migrateFromLegacy()` |
| New subsystem onboarding | Add field to DEFAULTS blob, add deletion guard | `stateController.set('myns.mykey', val)` |
