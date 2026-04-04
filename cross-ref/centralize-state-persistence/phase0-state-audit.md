# Phase 0: State Persistence Audit

## 1. Complete localStorage Key Inventory

| Key | Shape | Owner (writes) | Readers | Write triggers |
|-----|-------|-----------------|---------|----------------|
| `glyph3d-viewer-state` | JSON blob (see below) | `StatePersistence._save()` | `loadState()` at boot | 11 distinct call sites (enumerated in S3) |
| `glyph3d-camera-settings` | JSON blob: `{ cameraSpeed, dragSensitivity, scrollSensitivity, invertDragX/Y, invertScroll, dynamicSpeed }` | `ViewerCameraController._persistSettings()` | `loadSettings()` in VCC constructor | Slider changes, `setSpeed()`, `toggleDynamicSpeed()`, `resetSettings()` (6 sites) |
| `glyph3d-ws-enabled` | String `'true'`/`'false'` | Inline in `GitHubRepoViewer._createWSSettings()` | Same method, on page load | WS checkbox `change` event |

### `glyph3d-viewer-state` blob fields

DEFAULTS defines: `repoUrl`, `branch`, `wasLoaded`, `activeLayout`, `gridsScale`, `layoutSpacing`, `cameraPosition`, `sourceMode`, `localRoot`, `customFileTypes`, `groups`.

Fields added at runtime beyond DEFAULTS:
- `loadingInProgress` -- set by `onRepoLoadStarted()`, cleared by `onRepoLoaded()` and crash-guard paths. Not in DEFAULTS, so it persists as a stale extra field once set.

## 2. `glyph3d-viewer-state` -- Write Sites

All writes funnel through `saveState(this.state)` which calls `localStorage.setItem(STORAGE_KEY, JSON.stringify(state))`. The critical detail: **every write serializes the entire `this.state` object**. Any field present on `this.state` -- whether from DEFAULTS, runtime mutation, or a previous deserialization -- is written back.

| Call site | Trigger | What it mutates on `this.state` before writing |
|-----------|---------|------------------------------------------------|
| `restoreUI()` crash guard (line 104) | Boot, if `loadingInProgress` was true | `wasLoaded = false`, `loadingInProgress = false` |
| `onRepoLoadStarted()` (line 203) | User clicks Load | `loadingInProgress = true` |
| `onRepoLoaded()` (line 212) | Successful repo load | `repoUrl`, `branch`, `wasLoaded = true`, `loadingInProgress = false` |
| `onSourceModeChanged()` (line 225) | Source selector change | `sourceMode`, optionally `localRoot` |
| `onFileTypesChanged()` (line 235) | Custom file type filter | `customFileTypes` |
| `onLayoutChanged()` (line 241) | Layout dropdown change | `activeLayout` |
| `onGridsScaleChanged()` (line 253) | Scale slider (debounced 500ms) | `gridsScale` |
| `onLayoutSpacingChanged()` (line 259) | Spacing slider (debounced 500ms) | `layoutSpacing` |
| `_saveCameraIfDirty()` (line 308) | 5s interval timer OR visibilitychange=hidden | `cameraPosition`; **deletes** `groups` |
| `saveGroups()` (line 321) | **Never called** (dead code) | `groups` |
| External: `ide.html` (line 355) | Boot crash guard for URL auto-load | `loadingInProgress = false` |
| External: `GitHubRepoViewer` catch blocks (lines 1292, 1487) | Repo load failure | `loadingInProgress = false` |

## 3. The Ghost-State Write-Back Loop

This is the central bug pattern: **deleting a localStorage key does not delete the corresponding field from `this.state`, so the next `_save()` call re-persists it.**

### Chain of events

1. User manually clears `glyph3d-viewer-state` from DevTools, or calls `localStorage.removeItem(STORAGE_KEY)`.
2. `this.state` in the living `StatePersistence` instance still holds the full object -- it was populated at construction from `loadState()` and mutated in-place throughout the session.
3. Within 5 seconds, `_saveCameraIfDirty()` fires (from the `setInterval`). Since `markCameraDirty()` is called **every animation frame** (line 2045 of GitHubRepoViewer), `_cameraDirty` is always true.
4. `_saveCameraIfDirty()` writes `this.state.cameraPosition`, then calls `this._save()`, which writes the **entire** `this.state` blob back to localStorage.
5. The deleted key reappears with all its prior fields intact.

### Why the interval is always armed

`markCameraDirty()` is called inside `animate()` -- the `requestAnimationFrame` loop -- on **every frame**. This means `_cameraDirty` is permanently true while the page is visible. The 5-second interval will therefore always find it dirty and always write.

### The `delete this.state.groups` anomaly

`_saveCameraIfDirty()` contains `delete this.state.groups` (line 315) to avoid overwriting group data on camera ticks. But because `saveGroups()` is never called from anywhere, groups are:
1. Loaded from localStorage into `this.state.groups` at boot
2. Deserialized into SpatialWindowManager in `restoreCamera()`
3. Deleted from `this.state` on the very first camera-dirty tick (within 5s)
4. Never written back -- groups are lost after one session

This means group persistence is broken: groups survive exactly one page load, then vanish.

## 4. In-Memory State Lifetime

```
Construction:
  this.state = loadState()
    = { ...DEFAULTS, ...JSON.parse(localStorage['glyph3d-viewer-state']) }

Throughout session:
  Various on*() methods mutate this.state.* fields
  Every 5s + visibilitychange: _saveCameraIfDirty() writes entire blob
  Debounced slider changes write entire blob

Key property:
  this.state is a SINGLE MUTABLE OBJECT shared by all callers.
  Every _save() serializes ALL fields, not just the one that changed.
  Fields accumulate -- loadingInProgress is never cleaned up from DEFAULTS,
  so once set, it persists in the blob forever (even when false).
```

### Stale field accumulation

Because `loadState()` merges `{ ...DEFAULTS, ...stored }`, any field ever written to localStorage that is not in DEFAULTS survives across sessions. `loadingInProgress` is the known case. If the schema evolves and a field is removed from DEFAULTS, the old value in localStorage still gets loaded and re-persisted indefinitely.

## 5. `glyph3d-camera-settings` -- Separate Island

ViewerCameraController manages its own localStorage key independently:
- Reads at construction (`loadSettings()` in module scope)
- Writes on any settings slider change, speed change, dynamic-speed toggle, or settings reset
- `resetAllAndReload()` in StatePersistence knows about this key and removes it
- No other code reads or writes this key

This key is completely disconnected from the `glyph3d-viewer-state` blob. The two persistence systems do not coordinate.

## 6. `glyph3d-ws-enabled` -- Inline Orphan

The WebSocket enabled flag is read/written directly in `GitHubRepoViewer._createWSSettings()` (lines 549, 567). It is:
- Not part of StatePersistence
- Not cleaned up by `resetAllAndReload()` -- survives a full state reset
- A string (`'true'`/`'false'`), not a JSON blob

## 7. Hidden Persistence

- **sessionStorage**: Not used anywhere in `src/` or `app/`.
- **IndexedDB**: Not used in production code. Discussed in `cross-ref/content-cache-virtual-memory/` design docs as a future addition.
- **Cookies**: Not used.
- **URL query params**: `?source=local` overrides `sourceMode` at boot (read-only, not persisted to URL).

## 8. Race Conditions

### 8a. Debounced save vs. camera interval

`onGridsScaleChanged()` and `onLayoutSpacingChanged()` use `_debouncedSave()` (500ms timeout). `_saveCameraIfDirty()` uses a 5s interval. Both write the same `this.state` object. Since they share the same mutable object and localStorage is synchronous, there is no data-loss race -- but the debounced save can write a stale `cameraPosition` (camera moved since last 5s tick but hasn't been captured yet), and the camera save can write a stale slider value (slider changed but debounce hasn't fired yet).

In practice this is benign because both write the same `this.state` reference, but it means the blob content is not deterministic from the trigger event alone.

### 8b. External direct mutation

`GitHubRepoViewer` and `ide.html` both reach into `statePersistence.state.loadingInProgress` and call `statePersistence._save()` directly (lines 1292-1293, 1487-1488, ide.html line 355). This bypasses all method encapsulation. If the 5s camera timer fires between the external mutation and the external `_save()`, the camera save could overwrite the flag state. In practice the timing is unlikely but the pattern is fragile.

### 8c. Constructor double-read

`GitHubRepoViewer` constructor calls `loadState()` directly (line 150) to read `sourceMode` and `localRoot` before `StatePersistence` is constructed. `StatePersistence` constructor calls `loadState()` again (line 85). This is a redundant read but not a race -- both reads happen synchronously in the same call stack, before any writes.

## 9. Summary of Problems

| Problem | Severity | Root Cause |
|---------|----------|------------|
| Ghost-state write-back (deleted keys reappear) | High | `this.state` is never re-read from localStorage; `_save()` writes entire blob |
| `groups` persistence is broken | High | `saveGroups()` is dead code; `_saveCameraIfDirty()` deletes groups from state |
| `loadingInProgress` field leaks into blob permanently | Low | Not in DEFAULTS but added at runtime; never cleaned |
| `glyph3d-ws-enabled` survives full reset | Low | Not managed by StatePersistence; not in `resetAllAndReload()` |
| `markCameraDirty()` called every frame | Low | Camera is marked dirty even when it hasn't moved; wastes a JSON.stringify every 5s |
| Three independent persistence systems with no coordination | Medium | Organic growth; each feature added its own storage |
| External code mutates `this.state` and calls `_save()` directly | Medium | No encapsulation boundary; `_save()` is nominally private but used externally |

## 10. Files Touched

| File | Role |
|------|------|
| `app/StatePersistence.js` | Primary blob persistence (key 1) |
| `src/services/camera/ViewerCameraController.js` | Camera settings persistence (key 2) |
| `app/GitHubRepoViewer.js` | WS flag persistence (key 3) + external state mutation |
| `app/ide.html` | Crash guard external state mutation |
| `src/services/spatial/SpatialWindowManager.js` | serialize/deserialize for groups (no direct localStorage) |
