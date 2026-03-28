# Round 1: Interaction Reviews Display & Orchestration

## Errors Found

### E1. `win.buffer` does not exist -- interaction layer is broken against display API

The interaction agent's TUIFocusManager references `win.buffer` in 14 places (focus, hit testing, local keystroke handling, IDE mirror). Display's TUIWindow has no `.buffer` property. The backing store is `win._history` (private), and the public read API is `win.getVisibleLines()`. Every `win.buffer[row]` access will return `undefined`, silently breaking:
- Cursor placement on focus (line 135-136)
- Hit test clamping (line 274)
- All local keystroke editing: backspace, enter, arrows, character insert (lines 340-371)
- The IDE shell terminal mirror (line 557)

This is the single most critical error. The interaction layer literally cannot function without fixing it.

### E2. Local editing mutates display's internal state incorrectly

Even if `win.buffer` were replaced with the correct field, the interaction layer directly splices strings in the buffer (`win.buffer[row] = line.slice(...)`) and pushes/shifts lines. Display's TUIWindow manages its `_history` array internally and couples mutations to dirty tracking + `_render()`. Direct mutation bypasses the dirty flag, scroll offset logic, and content-equality guard. The `win._render()` call at line 380 would work, but only because it forces `_dirty = true` -- except interaction never sets `_dirty` because it does not know about it.

### E3. Cursor state is duplicated with no sync mechanism

Display's TUIWindow already has `cursorRow` and `cursorCol` fields (lines 98-99 in display). The interaction agent creates its own `_cursorRow` and `_cursorCol` on TUIFocusManager. Neither system reads from the other. After display's `write()` or `appendLine()` updates the cursor position, interaction's cursor will be stale. After interaction moves the cursor via arrow keys, display's cursor fields stay stale.

### E4. Interaction assumes `win.grid._background` exists and is a Mesh

The focus/blur code accesses `win.grid._background.material.color` and `.opacity`. Display's phase0 never mentions `_background`. This is an undocumented CodeGrid internal. If CodeGrid changes its background implementation (or if it is lazily created after first render), the focus visual will throw.

## Gaps

### G1. No public mutation API on TUIWindow for keystroke editing

Display provides `write()`, `appendLine()`, and `clear()` -- all replace or append bulk text. There is no character-level insert, delete, or line-split method. Interaction needs these for local editing mode but currently tries to do surgery on the raw buffer. Display should expose:
- `insertChar(row, col, char)` or `editLine(row, newContent)`
- `splitLine(row, col)` (for Enter)
- `deleteBefore(row, col)` (for Backspace)

### G2. No scroll integration between interaction and display

Interaction handles arrow keys and cursor movement but has no scroll logic (PageUp, PageDown, mouse wheel). Display has `scrollUp()`, `scrollDown()`, `scrollToBottom()`. The interaction layer should route scroll-related input to display's scroll API, but this connection is absent.

### G3. Orchestration has no awareness of focus state

Orchestration positions agent windows spatially via `window.track` but does not know which window is focused. If the user focuses a TUI window and an orchestration command moves it (or the grid it tracks), the focus visual (Z-pop, border color) gets out of sync. There is no event from interaction to orchestration saying "this window is focused, do not reposition it."

### G4. No window.scroll command in display's command set

Display's `windowCommands.js` registers write, append, clear, close, list, resize, move -- but no scroll command. Remote agents cannot scroll a window's history. This matters when orchestration wants to show a specific region of output.

## Tensions

### T1. Who owns the cursor?

Display declares cursor fields on TUIWindow. Interaction declares cursor fields on TUIFocusManager. Orchestration ignores cursors entirely. The cursor should have a single owner. Display should own the data (it is per-window state), and interaction should read/write through TUIWindow's cursor fields rather than maintaining a shadow copy.

### T2. One-shot positioning vs. live focus

Orchestration explicitly chose "one-shot positioning, not live constraints" (design decision #1). But interaction's focus system pops the focused window forward in Z and changes its background color. If orchestration re-issues `window.track` to reposition a focused window, it will clobber the Z-pop that interaction applied. Neither system restores the other's state changes.

### T3. `_render()` as the synchronization point

Display's `_render()` is the only method that pushes content to the GPU (via `loadFile`). Interaction calls `win._render()` after keystroke handling (line 380). This couples interaction to display's private method. If display changes `_render` semantics (e.g., debouncing, async), interaction breaks silently.

### T4. Local vs. remote editing mode ambiguity

Interaction routes keystrokes to WebSocket if connected, otherwise handles locally. But display's buffer can be written to by both remote commands (`window.write`, `window.append`) and local keystrokes simultaneously. There is no locking or mode flag to prevent conflicts. A remote `window.write` mid-typing would wipe the user's local edits with no warning.

## Recommendations

1. **Display should expose a public `buffer` getter** returning the visible lines array (read-only). This is the minimal fix for E1. Better: expose mutation methods per G1.

2. **Unify cursor ownership on TUIWindow.** Interaction should call `win.setCursor(row, col)` and read `win.cursorRow`/`win.cursorCol`. No shadow copies.

3. **Add an edit API to TUIWindow** (`insertChar`, `deleteChar`, `splitLine`) that properly manages `_history`, `_dirty`, and scroll offset. Interaction calls these instead of raw buffer surgery.

4. **Interaction should call `win._render()` through a public method** like `win.requestRender()` or `win.markDirty()` rather than reaching into the private API.

5. **Add `window.scroll` command** to windowCommands.js: `window.scroll <id> <up|down|bottom> [n]`.

6. **Orchestration should check focus state before repositioning.** Either query `TUIFocusManager.focusedId` or emit a focus lock event that orchestration respects.

7. **Display and interaction should agree on a `win.mode` field** (`'display'` | `'input'`) so remote writes are blocked during active local editing.

## Key Insight

The three agents designed to a shared noun ("TUIWindow") but not a shared interface contract. Display built a self-contained model with private internals and bulk-write public methods. Interaction assumed a dumb `buffer` array it could freely mutate. Orchestration assumed spatial positioning is the only coordination needed. The result is three systems that cannot compose without an explicit per-character mutation API on TUIWindow and a single-owner cursor protocol. The fix is small -- 4-5 methods on TUIWindow plus renaming interaction's buffer references -- but without it, the interaction layer is dead code.
