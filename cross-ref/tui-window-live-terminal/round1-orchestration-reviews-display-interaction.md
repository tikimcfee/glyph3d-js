# Round 1: Orchestration Reviews Display & Interaction

Reviewer: orchestration agent
Subjects: display (phase0-display.md), interaction (phase0-interaction.md)

---

## Errors Found

### E1. Interaction references `win.buffer` -- display renamed it to `_history` (BREAKING)

Interaction's `_handleKeystrokeLocal` directly mutates `win.buffer[row]` (lines 339, 341, 346-349, 369-372). Interaction's `_worldToCell` clamps against `win.buffer[row]` (line 275). Interaction's `focus()` calls `win.buffer.findLastIndex(...)` (line 135). The IDE docking sketch also uses `win.buffer.join('\n')`.

Display explicitly renamed the fixed `buffer` array to `_history` (private, unbounded, scroll-windowed). There is no `win.buffer` property. Every interaction reference to `win.buffer` will throw `TypeError: Cannot read properties of undefined`.

This is the single most critical error across both documents.

### E2. Interaction's local editing model is incompatible with display's scroll model

Interaction treats `win.buffer` as a fixed-size array of `rows` lines and directly splices characters into indexed rows. Display's `_history` is unbounded and the visible window is computed via `getVisibleLines()` using `scrollOffset`. Editing row N of the buffer does not correspond to editing row N of the visible window -- the mapping depends on `scrollOffset` and total history length. Even if the property name were fixed, the index arithmetic is wrong whenever `scrollOffset > 0` or `_history.length > rows`.

### E3. Interaction calls `win._render()` directly (line 380)

Display's `_render()` checks `_dirty` flag and compares `_lastRenderedContent`. Interaction never sets `_dirty = true` before calling `_render()`, so the dirty check will short-circuit and the buffer edits will not appear on screen. The correct call sequence is: mutate buffer, set `win._dirty = true`, then call `win._render()`. Or better: display should expose a public mutation API rather than having interaction reach into private state.

### E4. Cursor placement in `focus()` uses `win.buffer` dimensions, not visible window

Line 135: `win.buffer.findLastIndex(l => l.length > 0)` -- even with the name fix, this scans the entire history, not the visible slice. The cursor row would be set to an absolute history index (potentially hundreds), but cursor rendering assumes row is relative to the visible window (0 to rows-1). The cursor would be positioned far below the visible content.

---

## Gaps

### G1. No ANSI escape sequence handling anywhere

Neither agent addressed ANSI parsing. Display's `write()`/`appendLine()` pass raw text to `loadFile()` which renders escape codes as literal characters (`\x1b[32m` shows as garbled glyphs). Real terminal output from agents contains ANSI colors, cursor movement, and clearing sequences. Without a stripping or parsing layer, TUI windows will display garbage for any non-trivial agent output.

Orchestration predicted display would handle this. Neither agent did. This is the largest functional gap.

### G2. No public mutation API on TUIWindow

Display exposes `write()`, `appendLine()`, `clear()` for bulk operations, but no character-level editing (`insertChar(row, col, ch)`, `deleteChar(row, col)`, `getVisibleLine(row)`). Interaction needs character-level access for local keystroke handling but has no clean interface to use. The current approach (direct `win.buffer` manipulation) is both broken and architecturally wrong.

### G3. Display has no scroll command integration

Display added `scrollUp()`, `scrollDown()`, `scrollToBottom()` on TUIWindow, but neither the command system (`windowCommands.js`) nor the interaction layer registers commands or keystrokes to invoke them. PageUp/PageDown are not handled in `_handleKeyDown`. The scroll API exists but is unreachable.

### G4. Cursor mesh not added to any scene

`_initCursorMesh()` creates the mesh but never adds it to a scene. It is only added to a grid in `_updateCursorPosition()`, which is only called after `focus()`. But `focus()` calls `_updateCursorPosition()` at line 138 after setting cursor position. If the mesh was never previously parented, the first `_updateCursorPosition` call does parent it to `win.grid`. This works -- but if `blur()` is called, the mesh is set invisible but remains parented to the old grid. If that grid is disposed, the mesh's geometry reference becomes invalid. Minor but worth noting.

### G5. No `window.scroll` command

Orchestration's command set does not include scroll commands. Display built the scroll API. Nobody wired it up. CLI agents cannot scroll TUI windows.

---

## Tensions

### T1. Buffer ownership: who mutates TUIWindow state?

Display treats `_history` as private (underscore prefix, managed through public methods). Interaction assumes direct array mutation of a public `buffer`. These are incompatible ownership models. Either:
- Display exposes a character-level editing API (display owns buffer, interaction calls methods), or
- Interaction owns an input-line buffer separate from display's history (two-buffer model)

The two-buffer model is cleaner: display owns the scrollback history (read-only from interaction's perspective), interaction owns a single input line at the bottom, and Enter commits the input line into the history via `appendLine()`.

### T2. Sync rendering vs. deferred flush

Display renders synchronously on every mutation (`write`/`appendLine`/`clear` all call `_render()` immediately). This is fine for command-driven updates (one write per WebSocket message). But interaction's keystroke handler could fire 10+ times per second during typing. Each keystroke triggers `_render()` which calls `loadFile()` which rebuilds the entire CodeGrid. At 80x24 that is 1920 chars rebuilt per keypress -- manageable but wasteful. A `requestAnimationFrame`-batched dirty flush would be more appropriate for interactive input.

### T3. Escape key conflict

Interaction uses Escape to blur the focused window (line 290-294). ShortcutManager may also bind Escape for other purposes (close panels, cancel operations). The ordering guarantee ("ShortcutManager fires first") means if ShortcutManager consumes Escape, TUIFocusManager never sees it. If ShortcutManager does not consume it, TUIFocusManager does. This is fragile and depends on registration order, which is implicit.

---

## Recommendations

1. **Fix the buffer interface immediately.** Display should add: `getVisibleLine(row)`, `setVisibleLine(row, text)`, `insertAtCursor(row, col, char)`, `deleteAtCursor(row, col)`, and `commitInput(text)`. Interaction should use only these methods. No direct `_history` access.

2. **Add an ANSI strip layer.** Minimum viable: strip all `\x1b[...m` sequences in `_pushWrapped()` before storing in history. This loses color but prevents garbled output. A proper ANSI parser that maps escape codes to per-character color attributes can come later.

3. **Wire scroll commands.** Add `window.scroll <id> up|down|bottom [n]` to `windowCommands.js`. Map PageUp/PageDown in `_handleKeyDown`. This connects display's existing API to both interaction paths.

4. **Batch interactive rendering.** Replace direct `_render()` calls in keystroke handler with `_dirty = true` + `requestAnimationFrame` coalescing. One render per frame maximum during typing.

5. **Adopt two-buffer input model.** Interaction maintains an input line separate from display history. Enter appends it via `win.appendLine()`. Arrow keys in the input line are interaction's concern. Scroll through history is display's concern. Clean separation.

---

## Key Insight

Display and interaction designed against different mental models of the same object. Display built a **scrolling log viewer** (unbounded history, viewport window, dirty-flag optimization). Interaction built a **terminal emulator input layer** (fixed buffer, direct cell editing, cursor navigation). These are both valid but they assumed different buffer semantics and neither specified the contract between them. The `win.buffer` vs `_history` mismatch is not just a naming bug -- it reveals that the two agents never agreed on whether TUIWindow is a log viewer or an editable terminal. The answer is both, but with a clear boundary: display owns the read-only scrollback, interaction owns the input line, and they communicate through TUIWindow's public API, not through shared mutable state.
