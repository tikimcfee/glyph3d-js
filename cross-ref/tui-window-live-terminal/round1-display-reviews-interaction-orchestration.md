# Round 1: Display Reviews Interaction + Orchestration

Reviewer: **display** agent
Reviewed: **interaction** (phase0-interaction.md), **orchestration** (phase0-orchestration.md)

---

## Errors Found

### E1. Interaction references `win.buffer` -- property does not exist (CRITICAL)

Display's TUIWindow uses `this._history` (private) for the line buffer and exposes `getVisibleLines()` as the public read API. There is no `.buffer` property.

Interaction's `_handleKeystrokeLocal` directly reads and mutates `win.buffer` in 13 places (lines 135-136, 274, 340-341, 347-349, 358, 363, 366, 369-371). Every single local keystroke handler is broken against the actual TUIWindow API.

**Fix options**: (a) TUIWindow exposes `get buffer()` returning `_history` slice for the visible window -- but then mutations would not propagate to `_history` correctly. (b) Interaction should call TUIWindow methods (`appendLine`, `write`, or a new `insertChar`/`deleteChar` API) instead of raw buffer manipulation. Option (b) is correct.

### E2. Interaction calls `win._render()` directly (line 380)

`_render()` is a private method on TUIWindow. The interaction agent should not call it. After buffer mutations, the TUIWindow public API methods (`write`, `appendLine`, `clear`) already call `_render()` internally. This is another consequence of bypassing the TUIWindow API.

### E3. Orchestration references `coll.setGroupColor(0, ...)` on CodeGrid

CodeGrid wraps a GlyphCollection, and `setGroupColor` is a GlyphCollection method that operates on group IDs. Calling `setGroupColor(0, ...)` changes the color for ALL instances in group 0 (the default group) -- this would recolor the entire grid's text, not highlight the grid border/background. The intended "tracking green highlight" would actually turn all glyphs green. To highlight a grid, the background mesh color should be changed instead (`grid._background.material.color`), which interaction already does correctly for focus.

### E4. Orchestration's `getWorldBounds(targetGrid)` is undefined

The function `getWorldBounds` is called but never defined or imported. CodeGrid (extending Object3D) does not have a `getWorldBounds` method. Three.js has `Box3.setFromObject()` but it is expensive and the orchestration code does not use it.

---

## Gaps

### G1. No input API on TUIWindow for interaction to use

Display's TUIWindow has `write()`, `appendLine()`, `clear()` -- all bulk operations. There is no character-level editing API (`insertCharAt(row, col, char)`, `deleteCharAt(row, col)`, `getLineAt(row)`). Interaction needs this for local keystroke handling. Display must add it.

### G2. Cursor mesh not added to scene

Interaction creates a PlaneGeometry cursor mesh in `_initCursorMesh()` but only adds it to a grid via `win.grid.add()` inside `_updateCursorPosition()`. If `focus()` is called before any click (programmatic focus), `_updateCursorPosition` is called -- this works. But `_initCursorMesh()` never adds the mesh to any scene. Between construction and first focus, the mesh exists in limbo. Not a bug per se, but fragile.

### G3. Orchestration has no error handling for stale grid indices

Grid indices can change as grids are added/removed. `window.track` stores `gridIndex` at invocation time. If grids are added or removed after tracking, the stored index becomes stale. The `window.track.list` response would return wrong indices. There is no validation on subsequent access.

### G4. Orchestration's `window.track.list` command is declared in the summary table but never implemented

The command summary lists `window.track.list` as a browser-side command, but the implementation sketch only shows `window.track` and `window.untrack`. Missing implementation.

### G5. Scroll commands have no interaction path

Display provides `scrollUp()`, `scrollDown()`, `scrollToBottom()` on TUIWindow. Interaction's keystroke handler has no scroll bindings (PageUp, PageDown, Ctrl+Home/End, mouse wheel). When a TUI window is focused, there is no way for the user to scroll it.

---

## Tensions

### T1. Buffer model mismatch: unbounded history vs. fixed-row editing

Display designed TUIWindow with an unbounded `_history` and a sliding viewport via `scrollOffset`. Interaction designed local editing against a fixed `buffer` array of exactly `rows` length. These are fundamentally different data models. Interaction's Enter key handler does `buffer.push(); buffer.shift()` (fixed ring), while Display's model grows infinitely. Reconciling these requires deciding: is local editing done on the visible slice or on the full history?

### T2. Cursor ownership: Display tracks cursor, Interaction tracks cursor

Display's TUIWindow has `this.cursorRow` and `this.cursorCol`. Interaction's TUIFocusManager has `this._cursorRow` and `this._cursorCol`. These are independent, unsynchronized copies. When `appendLine()` is called (e.g., from a WebSocket command), Display's cursor updates but Interaction's does not. The cursor mesh would be at the wrong position.

### T3. Orchestration positions agent grids via `agentGrid.position.set()` -- but Display positions TUI windows via `TUIWindowManager` auto-layout

If TUI windows and agent grids coexist, orchestration's `window.track` repositions grids by setting `position` directly, which would conflict with TUIWindowManager's auto-positioning stack (`_nextX`, `_nextY`). Neither system knows about the other's positioning.

### T4. Focus highlight vs. tracking highlight on same grid

Interaction uses `_background.material.color.set(FOCUS_BORDER_COLOR)` for focus. Orchestration uses `setGroupColor` for tracking. If a user clicks a tracked grid's TUI window, both systems try to modify the visual state, and `blur()` restores the "original" background color -- which might be the tracking color or the default, depending on order.

---

## Recommendations

1. **Display must add a character-level editing API** to TUIWindow: `getLine(row)`, `setLine(row, text)`, `insertChar(row, col, char)`, `deleteChar(row, col)`. These operate on the visible slice, handle dirty flags, and call `_render()`. Interaction should use only these public methods.

2. **Unify cursor state.** Either TUIWindow owns the cursor and exposes `setCursor(row, col)` / `getCursor()`, or Interaction owns it and TUIWindow drops its cursor fields. Single source of truth. Recommendation: TUIWindow owns it (it already has cursor fields), Interaction reads/writes via accessor.

3. **Orchestration should highlight via background mesh**, not `setGroupColor`. Use `grid._background.material.color.set(trackingColor)` with save/restore, same pattern as Interaction's focus.

4. **Orchestration needs a bounds helper.** Add a `getContentBounds()` method to CodeGrid that returns `{ width, height }` based on `cols * charWidth`, `rows * lineHeight`. Then positioning math in `window.track` uses that instead of the undefined `getWorldBounds`.

5. **Add scroll bindings** in Interaction: PageUp/PageDown call `win.scrollUp(win.rows)` / `win.scrollDown(win.rows)`. Mouse wheel on focused window calls `win.scrollUp/Down(3)`.

---

## Key Insight

Interaction and Display designed against incompatible buffer models. Interaction assumed a mutable fixed-length `buffer` array it could edit in-place -- a classic terminal emulator model. Display built an append-only history with a sliding read viewport -- a log viewer model. Neither is wrong, but they cannot interoperate without an explicit editing API layer on TUIWindow that mediates between the two paradigms. This is the single highest-priority design gap to resolve before implementation.
