# Round 3: Orchestration Convergence

## Settled

1. **`win.buffer` does not exist; interaction must use TUIWindow's public API.** All three agents flagged this as the single most critical error. Interaction's 14 references to `win.buffer` are dead code against display's `_history` model. No disagreement.

2. **TUIWindow must add a character-level editing API.** Display currently exposes only bulk operations (`write`, `appendLine`, `clear`). All three agents agree display must add methods like `getVisibleLine(row)`, `setVisibleLine(row, text)`, `insertChar(row, col, char)`, `deleteChar(row, col)`. Interaction calls these instead of raw buffer surgery.

3. **Cursor ownership belongs to TUIWindow, not TUIFocusManager.** Display already has `cursorRow`/`cursorCol`. Interaction has shadow copies. All three agents agree: single source of truth on TUIWindow, interaction reads/writes via `win.setCursor(row, col)` and `win.cursorRow`/`win.cursorCol`. No shadow state.

4. **Interaction must not call `win._render()` directly.** Display should expose `win.markDirty()` or `win.requestRender()`. Interaction calls the public method after mutations. This also fixes the dirty-flag bypass (E3 from orchestration's review).

5. **Scroll bindings are missing and must be added.** Display built `scrollUp`/`scrollDown`/`scrollToBottom`. Nobody wired them. Interaction adds PageUp/PageDown/mouse-wheel handlers. Display adds `window.scroll` command for remote agents.

6. **Orchestration must highlight via background mesh, not `setGroupColor`.** Display correctly identified that `setGroupColor(0, ...)` recolors ALL glyphs in the default group. Tracking highlight should use `grid._background.material.color` with save/restore, matching interaction's focus pattern.

7. **`getWorldBounds()` is undefined and must be replaced.** Orchestration's `window.track` calls a function that does not exist. Replace with a `getContentBounds()` method on CodeGrid that computes `{ width: cols * charWidth, height: rows * lineHeight }`, or use `new THREE.Box3().setFromObject(grid)`.

8. **`window.track.list` is declared but not implemented.** Add it to `orchestrationCommands.js`.

9. **ANSI escape sequences will render as garbled glyphs.** Neither display nor interaction handles stripping or parsing ANSI codes. Minimum viable: strip `\x1b[...m` sequences in `_pushWrapped()` before storing in history. Proper ANSI-to-color mapping is a later phase.

10. **Two-buffer input model is the correct architecture.** Display owns the scrollback history (read-only from interaction's perspective). Interaction owns a single input line at the bottom. Enter commits the input line via `win.appendLine()`. This cleanly separates the log-viewer model from the terminal-emulator model without forcing either agent to abandon their design.

---

## Implementation Plan

### File 1: `examples/github-viewer/websocket/TUIWindow.js` (display owns)

Add character-level editing API and public render trigger:

- `getVisibleLine(row)` -- returns `this.getVisibleLines()[row]` with bounds check
- `setVisibleLine(row, text)` -- maps visible row to `_history` index via scroll offset, replaces, sets `_dirty = true`, calls `_render()`
- `insertChar(row, col, char)` -- delegates to `setVisibleLine` after string splice
- `deleteChar(row, col)` -- delegates to `setVisibleLine` after string removal
- `splitLine(row, col)` -- for Enter key; splits line at col, inserts new line in `_history`
- `setCursor(row, col)` -- sets `this.cursorRow = row; this.cursorCol = col`
- `markDirty()` -- sets `this._dirty = true` and calls `_render()` (public replacement for `_render()`)
- Strip ANSI in `_pushWrapped()`: `line = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')` before storing

### File 2: `examples/github-viewer/websocket/TUIFocusManager.js` (interaction owns)

Rewrite all buffer access to use TUIWindow public API:

- Replace all `win.buffer[row]` with `win.getVisibleLine(row)`
- Replace all `win.buffer[row] = ...` with `win.setVisibleLine(row, ...)`
- Replace `win.buffer.push/shift` in Enter handler with `win.splitLine(this._cursorRow, this._cursorCol)`
- Replace `win._render()` call (line 380) with `win.markDirty()`
- Remove `this._cursorRow` and `this._cursorCol` shadow fields; read/write `win.cursorRow`/`win.cursorCol` directly via the focused window
- Add PageUp handler: `win.scrollUp(win.rows)`
- Add PageDown handler: `win.scrollDown(win.rows)`
- Add mouse wheel handler on canvas (when focused): `win.scrollUp(3)` / `win.scrollDown(3)`
- In IDE shell terminal mirror (line 557): replace `win.buffer.join('\n')` with `win.getVisibleLines().join('\n')`

### File 3: `examples/github-viewer/websocket/commands/orchestrationCommands.js` (orchestration owns)

Fix `window.track` implementation:

- Replace `getWorldBounds(targetGrid)` with inline bounds computation:
  ```js
  const cw = targetGrid.metrics?.charWidth || 0.6;
  const lh = targetGrid.metrics?.lineHeight || 1.2;
  const width = targetGrid.cols * cw;
  const height = targetGrid.rows * lh;
  ```
- Replace `coll.setGroupColor(0, ...)` with background mesh highlight:
  ```js
  targetGrid._background.material.color.set(0x4dE680);  // tracking green
  ```
- Add `saveGridState`/`restoreGridState` for background color (not group color)
- Implement `window.track.list` handler: iterate `ctx.windowTracking`, return array of `{ windowId, gridIndex }`
- Add grid-index staleness validation: verify `grids[storedIndex]` is still the same grid (check by name or reference)

### File 4: `examples/github-viewer/websocket/commands/windowCommands.js` (display owns)

Add scroll command:

- Register `window.scroll` handler: `window.scroll <id> <up|down|bottom> [n]`
- Delegates to `win.scrollUp(n)`, `win.scrollDown(n)`, or `win.scrollToBottom()`

### File 5: `src/collections/CodeGrid.js` (shared concern)

Add bounds helper method:

- `getContentBounds()` returns `{ width, height }` computed from `this.cols * charWidth` and `this.rows * lineHeight`
- Used by orchestration's `window.track` positioning math

### File 6: `examples/github-viewer/websocket/commands/index.js`

Wire orchestration commands:

- Import and call `registerOrchestrationCommands(router)` alongside existing registrations

### Integration: `window.track` + agent bridge end-to-end

The `window.track` flow crosses three files:

1. **CLI side** (`agent-hook.mjs`): `--track <filepath>` flag calls `mgr.trackFile(label, filePath)`
2. **CLI side** (`AgentWindowManager`): `trackFile` queries `grid.list`, finds matching grid index, sends `window.track <label> <gridIndex>` over WebSocket
3. **Browser side** (`orchestrationCommands.js`): `window.track` handler receives the command, finds agent grid by `agent:<label>` naming convention, computes target grid bounds, positions agent grid adjacent, highlights target grid background, stores tracking state in `ctx.windowTracking`

The critical contract: agent grids are identified by naming convention `agent:<label>` (already used by `AgentWindowManager.ensureWindow` and `agentLayoutCommands.js`). Grid indices come from `grid.list` response and are validated at invocation time. Stale indices are caught by checking `grids[idx]` exists and optionally matching the expected filename.

---

## Implementer Vote

**display** agent should implement first.

Rationale: Every interaction fix and every orchestration fix depends on TUIWindow's public API existing. The editing methods (`getVisibleLine`, `setVisibleLine`, `insertChar`, `deleteChar`, `splitLine`, `setCursor`, `markDirty`) and the ANSI strip are all in `TUIWindow.js`. Until display ships these methods, interaction cannot rewrite its buffer access and orchestration cannot test `window.track` against a working system. Display is the foundation; the other two agents are consumers.
