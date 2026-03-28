# TUI Window System -- Implementation Summary

Implementer: display perspective agent
Date: 2026-03-27

## Files Created

### 1. `examples/github-viewer/websocket/TUIWindow.js`
Core window class with all converged API:
- Unbounded `_history` + `scrollOffset` viewport
- ANSI strip on ingest (`\x1b[...` regex removal in `_pushWrapped`)
- Cursor contract: `setCursor(row, col)`, `getCursor()` -- single source of truth
- Character-level editing: `getLine(row)`, `setLine(row, text)`, `insertChar(row, col, char)`, `deleteChar(row, col)`, `splitLine(row, col)`
- `markDirty()` -- rAF-coalesced public render trigger (replaces direct `_render()` calls)
- Dirty flag + content comparison to skip redundant `loadFile()` GPU uploads
- `scrollUp(n)`, `scrollDown(n)`, `scrollToBottom()`
- Bulk ops: `write(text)`, `appendLine(text)`, `clear()`

### 2. `examples/github-viewer/websocket/TUIWindowManager.js`
Lifecycle manager -- unchanged from Phase 0 design:
- `create(id, options)`, `get(id)`, `remove(id)`, `list()`, `clearAll()`
- Auto-position: vertical stack, wraps to next column
- Lazy-created via `getOrCreateManager(ctx)` in windowCommands

### 3. `examples/github-viewer/websocket/commands/windowCommands.js`
10 WebSocket commands:
- `window.create <id> [cols] [rows] [title]`
- `window.write <id> <base64>`, `window.append <id> <base64>`
- `window.clear <id>`, `window.close <id>`
- `window.list`
- `window.resize <id> <cols> <rows>`, `window.move <id> <x> <y> <z>`
- `window.scroll <id> <up|down|bottom> [n]`

Content uses `atob()` for base64 decoding, matching `gridCommands.js` pattern.

### 4. `examples/github-viewer/websocket/TUIFocusManager.js`
Rewritten against TUIWindow's public API (zero `win.buffer` or `win._render()` references):
- Click-to-focus via raycasting on `_background` meshes
- Character hit testing using CHAR_DIMENSIONS + `grid.worldToLocal()`
- Keystroke routing: focused window captures all non-modifier keys, Escape blurs
- Cursor reads/writes exclusively through `win.setCursor()` / `win.getCursor()` / `win.getLine()`
- Editing: `win.insertChar()`, `win.deleteChar()`, `win.splitLine()` -- no raw buffer access
- Scroll: PageUp/PageDown keys + mouse wheel when focused
- Home/End/Delete key support
- Cursor mesh: PlaneGeometry bar, 530ms blink, reparented to focused grid
- Disables CameraController when focused, restores on blur
- Saves/restores background color + opacity on focus/blur (no collision with tracking)
- Sends `window.input` events via WebSocket for remote agents
- `stopImmediatePropagation()` on click to prevent SelectionManager conflicts

### 5. `examples/github-viewer/websocket/commands/orchestrationCommands.js`
3 commands for agent-to-code tracking:
- `window.track <window-id> <grid-index>` -- positions agent grid adjacent to target, highlights via `_background.material.color` (not `setGroupColor`), saves/restores original color
- `window.untrack <window-id>` -- restores original background, clears tracking
- `window.track.list` -- lists all active tracking pairs
- Uses `getWorldBounds()` from spatialHelpers (not the undefined function from Phase 0)

## Files Modified

### 6. `examples/github-viewer/websocket/commands/index.js`
Added imports and registration calls for `windowCommands` and `orchestrationCommands`.

## No Changes Needed

- `examples/github-viewer/websocket/index.js` -- `ctx.windowManager` slot already exists as null; lazy-created by `getOrCreateManager()` on first `window.*` command
- `src/collections/CodeGrid.js` -- already has `getContentBounds()` method (delegates to `_collection.getBounds()`)

## Key Design Decisions

1. **TUIWindow owns cursor** -- no shadow copies in TUIFocusManager. All 14 `win.buffer` references from Phase 0 interaction code eliminated.
2. **`markDirty()` coalesces** -- uses `requestAnimationFrame` so rapid keystrokes produce at most one render per frame.
3. **Background color save/restore** -- both focus (TUIFocusManager) and tracking (orchestrationCommands) save the original hex color and opacity, restoring on blur/untrack. No collision because they use different storage (`win._originalBgColor` vs `entry.originalBgColor`).
4. **ANSI strip only** -- regex `\x1b\[[0-9;]*[a-zA-Z]` applied in `_pushWrapped()`. Color parsing deferred to a later phase.
5. **Orchestration uses spatialHelpers.getWorldBounds()** -- the properly imported, tested function from the existing codebase, not an ad-hoc implementation.
