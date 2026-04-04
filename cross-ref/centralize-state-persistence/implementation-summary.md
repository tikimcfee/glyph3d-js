# Centralized State Persistence -- Implementation Summary

## What Changed

Three independent persistence systems (blob, camera blob, inline ws flag) replaced with a single `StateController` that writes one localStorage key per field under the `g3d.*` prefix.

## Files Created

| File | Purpose |
|------|---------|
| `src/services/state/StateController.js` | Core class: `get()`, `set()`, `delete()`, `clearNamespace()`, `clearAll()`, `listAll()`. Singleton exported as `stateController`. Dispatches `state-changed` CustomEvent on every write. |
| `app/components/StatePanel.js` | State Inspector UI panel. Collapsible namespace cards, per-key JSON preview with size badges, export/import JSON, clear-all with 2-click confirm. Event-driven refresh (no polling). |

## Files Modified

| File | Changes |
|------|---------|
| `src/services/state/index.js` | Added `StateController` and `stateController` exports to barrel. |
| `app/StatePersistence.js` | Complete rewrite. Removed `loadState()`, `saveState()`, `STORAGE_KEY`, `DEFAULTS` blob, `this.state` in-memory object, `_save()`, `_debouncedSave()`. Each `on*Changed()` now writes its specific `g3d.*` key via `stateController.set()`. `restoreUI()` reads each field individually. Camera dirty-check compares position to last saved (not every-frame flag). Added `clearLoadingFlag()` and `getState()` public methods. Exports `STATE_DEFAULTS` map and `resetAllAndReload()`. |
| `src/services/camera/ViewerCameraController.js` | Removed `STORAGE_KEY`, `loadSettings()`, `saveSettings()` free functions. Constructor reads each setting individually from `stateController.get('camera.*', default)`. `_persistSettings()` writes each field individually. |
| `app/GitHubRepoViewer.js` | Removed `loadState` import. Added `stateController` import. Constructor reads `source.mode` and `source.localRoot` from stateController instead of `loadState()`. WS toggle reads/writes `ui.wsEnabled` via stateController. `statePersistence.state.gridsScale` replaced with `stateController.get('ui.gridsScale', 1.0)`. Error handlers call `statePersistence.clearLoadingFlag()` instead of mutating `.state` and calling `._save()`. |
| `app/ide.html` | Added `stateController` import. Added activity-bar button for state panel (`data-panel="state"`). Added `#sp-state` sidebar panel div. Wires `StatePanel` after `viewer.init()`. Crash guard uses `stateController.get/set` instead of `statePersistence.state.*`. |
| `app/IDEShell.js` | Added `'state': 'STATE INSPECTOR'` to `PANEL_TITLES`. |
| `app/ide.css` | Added ~50 lines of `.state-*` CSS styles for the State Inspector panel. |

## Key Design Decisions

1. **No in-memory cache**: `stateController.get()` always reads from localStorage. Eliminates ghost-state structurally.
2. **Per-field writes**: `stateController.set('camera.position', {...})` writes exactly one `g3d.camera.position` key. Camera saves can never clobber groups.
3. **No migration code**: Old keys (`glyph3d-viewer-state`, `glyph3d-camera-settings`, `glyph3d-ws-enabled`) are simply ignored. User clears them manually.
4. **Camera dirty check**: Compares `{x, y, z}` to last saved position. Skips write if camera hasn't actually moved, even though `markCameraDirty()` fires every frame.
5. **`state-changed` event**: Dispatched on every `set()`, `delete()`, `clearNamespace()`, `clearAll()`. State Inspector panel refreshes via this event + `storage` (cross-tab). No polling.

## Namespace Map

| Key | Type | Replaces |
|-----|------|----------|
| `g3d.repo.url` | string | blob `.repoUrl` |
| `g3d.repo.branch` | string | blob `.branch` |
| `g3d.repo.wasLoaded` | boolean | blob `.wasLoaded` |
| `g3d.repo.loadingInProgress` | boolean | blob `.loadingInProgress` |
| `g3d.source.mode` | string | blob `.sourceMode` |
| `g3d.source.localRoot` | string | blob `.localRoot` |
| `g3d.source.customFileTypes` | string[] | blob `.customFileTypes` |
| `g3d.ui.layout` | string | blob `.activeLayout` |
| `g3d.ui.gridsScale` | number | blob `.gridsScale` |
| `g3d.ui.layoutSpacing` | number | blob `.layoutSpacing` |
| `g3d.ui.wsEnabled` | boolean | `glyph3d-ws-enabled` |
| `g3d.camera.position` | {x,y,z} | blob `.cameraPosition` |
| `g3d.camera.speed` | number | camera blob `.cameraSpeed` |
| `g3d.camera.dragSensitivity` | number | camera blob |
| `g3d.camera.scrollSensitivity` | number | camera blob |
| `g3d.camera.invertDragX` | boolean | camera blob |
| `g3d.camera.invertDragY` | boolean | camera blob |
| `g3d.camera.invertScroll` | boolean | camera blob |
| `g3d.camera.dynamicSpeed` | boolean | camera blob |
| `g3d.groups` | Object[] | blob `.groups` |

## Problems Resolved

- **Ghost-state write-back**: Structurally impossible -- no blob, no `this.state`, no `delete this.state.groups` hack needed.
- **Groups persistence broken**: `saveGroups()` now writes `g3d.groups` independently. Camera saves never touch it.
- **`loadingInProgress` leak**: Written/cleared as its own key, never accumulates in a blob.
- **`glyph3d-ws-enabled` survives reset**: Now under `g3d.ui.wsEnabled`, cleared by `stateController.clearAll()`.
- **Three independent systems**: All converged to single `stateController` API.
- **External `._save()` calls**: Replaced with `clearLoadingFlag()` method -- no encapsulation violation.
- **Double deserialization at boot**: Constructor reads individual keys from stateController, no separate `loadState()` call needed.
