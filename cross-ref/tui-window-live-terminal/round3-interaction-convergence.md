# Round 3: Interaction Convergence

## Settled

1. **`win.buffer` does not exist.** All three agents flagged this as the single most critical error. TUIFocusManager's 14 references to `win.buffer` are dead code against display's `_history`-backed TUIWindow. Every local keystroke handler, cursor placement, hit-test clamp, and IDE mirror is broken. Unanimous, no dissent.

2. **TUIWindow must expose a character-level editing API.** All three agents agree that `write()`, `appendLine()`, and `clear()` are insufficient for keystroke-by-keystroke editing. Display must add methods like `getLine(row)`, `setLine(row, text)`, `insertChar(row, col, char)`, `deleteChar(row, col)`, and `splitLine(row, col)`. These operate on the visible slice (not raw `_history` indices), manage dirty flags internally, and call `_render()` themselves.

3. **Cursor ownership belongs to TUIWindow.** All three agents identified the duplicated cursor state (TUIWindow has `cursorRow`/`cursorCol`, TUIFocusManager has `_cursorRow`/`_cursorCol`) as unsynchronized and error-prone. The agreed fix: TUIWindow owns cursor state and exposes `setCursor(row, col)` / `getCursor()`. TUIFocusManager reads and writes through those accessors. No shadow copies.

4. **Interaction must not call `win._render()` directly.** Display's `_render()` is private, checks `_dirty`, and interaction never sets that flag. The editing API methods (settled item 2) will handle rendering internally. If interaction needs to force a render outside of edits, TUIWindow should expose `requestRender()` or `markDirty()`.

5. **Scroll bindings are missing.** Display built `scrollUp()`, `scrollDown()`, `scrollToBottom()` but neither interaction nor orchestration wired them up. PageUp/PageDown and mouse wheel on focused windows must route to display's scroll API. A `window.scroll` command should be added to `windowCommands.js` for remote agents.

6. **Orchestration should highlight tracked grids via background mesh, not `setGroupColor`.** `setGroupColor(0, ...)` recolors all glyphs in the default group -- not the intended effect. The correct approach uses `grid._background.material.color.set()` with save/restore, matching interaction's focus pattern.

7. **Orchestration's `getWorldBounds()` is undefined.** CodeGrid needs a `getContentBounds()` method returning `{ width, height }` based on `cols * charWidth` and `rows * lineHeight`.

8. **ANSI escape sequences are unhandled.** No agent addressed parsing. Terminal output from real agents contains ANSI codes that will render as garbled glyphs. Minimum viable: strip `\x1b[...m` sequences in `_pushWrapped()` before storing in history.

## Implementation Plan

### File 1: `src/ide/tui/TUIWindow.js` (display owns)

Add the unified editing + cursor API that interaction depends on:

- `getLine(row)` -- returns visible line at row index (accounts for `scrollOffset`)
- `setLine(row, text)` -- replaces visible line, sets `_dirty`, calls `_render()`
- `insertChar(row, col, char)` -- character insert at visible row/col, advances cursor, renders
- `deleteChar(row, col)` -- character delete at visible row/col, moves cursor back, renders
- `splitLine(row, col)` -- splits line at col (Enter behavior), appends to history, renders
- `setCursor(row, col)` / `getCursor()` -- single source of truth for cursor position
- `requestRender()` -- public wrapper that sets `_dirty = true` and calls `_render()`
- `get visibleBuffer()` -- read-only getter returning `getVisibleLines()` result (convenience for hit testing and IDE mirror)
- Strip ANSI in `_pushWrapped()`: `line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')` before storing

### File 2: `src/ide/tui/TUIFocusManager.js` (interaction owns)

Adapt to the unified TUIWindow API:

- **Remove** `this._cursorRow` and `this._cursorCol` fields entirely. All cursor reads go through `win.getCursor()`, all cursor writes go through `win.setCursor(row, col)`.
- **Replace all 14 `win.buffer` references**:
  - `focus()` line 135-136: `win.buffer.findLastIndex(...)` becomes iterating `win.visibleBuffer` or calling `win.getCursor()` to get current position
  - `_worldToCell()` line 274: `win.buffer[row]?.length` becomes `win.getLine(row)?.length`
  - `_handleKeystrokeLocal()` lines 338-377: replace entire body with calls to `win.insertChar()`, `win.deleteChar()`, `win.splitLine()`, `win.setCursor()`. No raw string slicing.
  - IDE mirror line 557: `win.buffer.join('\n')` becomes `win.visibleBuffer.join('\n')`
- **Remove** the `win._render()` call at line 380. The editing API methods render internally.
- **Add scroll bindings** in `_handleKeyDown`:
  - `PageUp`: `win.scrollUp(win.rows)`
  - `PageDown`: `win.scrollDown(win.rows)`
  - Mouse wheel listener on canvas (when focused): `win.scrollUp(3)` / `win.scrollDown(3)`
- **Arrow keys** call `win.setCursor()` instead of mutating local fields. ArrowUp/ArrowDown clamp against `win.getLine(newRow)?.length` for column.
- `_updateCursorPosition(win)` reads `win.getCursor()` instead of `this._cursorRow` / `this._cursorCol`.
- `_notify()` state object reads from `win.getCursor()`.

### File 3: `src/ide/tui/windowCommands.js` (display owns)

- Add `window.scroll` command: `window.scroll <id> up|down|bottom [n]`
- Routes to `win.scrollUp(n)`, `win.scrollDown(n)`, `win.scrollToBottom()`

### File 4: `src/collections/CodeGrid.js`

- Add `getContentBounds()` method returning `{ width: this.cols * charWidth, height: this.rows * lineHeight }` for orchestration's positioning math

### File 5: Orchestration command handlers (orchestration owns)

- Replace `setGroupColor(0, ...)` with `grid._background.material.color.set(trackingColor)` + save/restore pattern
- Replace `getWorldBounds(targetGrid)` with `targetGrid.getContentBounds()`
- Add `window.track.list` implementation (declared in summary but never implemented)

### Dependency order

1. TUIWindow API additions (File 1) -- no dependencies, can start immediately
2. CodeGrid.getContentBounds (File 4) -- no dependencies, parallel with step 1
3. TUIFocusManager rewrite (File 2) -- depends on File 1 being done
4. windowCommands.js scroll command (File 3) -- depends on File 1 scroll API existing (it does already)
5. Orchestration fixes (File 5) -- depends on File 4

## Implementer Vote

**Display** should implement first.

Display owns TUIWindow, which is the foundation every other agent builds on. The editing API, cursor ownership, ANSI stripping, and `requestRender()` must land before interaction can rewrite TUIFocusManager against the real interface. Display also owns `windowCommands.js` for the scroll command. The buffer model mismatch was the root cause of the single most critical error across all three reviews -- and only display can resolve it.
