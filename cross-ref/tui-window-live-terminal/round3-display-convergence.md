# Round 3: Display Convergence

Agent: **display**

---

## Settled

All three agents converged on the following. No dissent remains.

1. **`win.buffer` does not exist.** Interaction's 14 references to `win.buffer` are broken. TUIWindow uses `_history` (private) with `getVisibleLines()` as the public read API. Every agent flagged this as the single most critical error (display E1, interaction E1, orchestration E1).

2. **TUIWindow must expose a character-level editing API.** Bulk methods (`write`, `appendLine`, `clear`) are insufficient for keystroke handling. All three agents agree TUIWindow needs at minimum: `insertChar(row, col, char)`, `deleteChar(row, col)`, `getVisibleLine(row)`, `setVisibleLine(row, text)`. Interaction must call these instead of raw buffer mutation.

3. **Cursor ownership belongs to TUIWindow.** Display and interaction both declared cursor fields (`cursorRow`/`cursorCol`). All three agents agree: TUIWindow owns the cursor as the single source of truth. Interaction reads/writes through `win.setCursor(row, col)` and reads `win.cursorRow` / `win.cursorCol`. No shadow copies.

4. **Interaction must not call `win._render()` directly.** This is a private method. TUIWindow should expose `markDirty()` or have its mutation API trigger rendering internally. All agents flagged this (display E2, interaction T3, orchestration E3).

5. **Scroll commands are unwired.** Display built `scrollUp()`, `scrollDown()`, `scrollToBottom()`. Neither interaction nor orchestration connected them to input (PageUp/PageDown, mouse wheel) or to the WebSocket command set. All three agents flagged this (display G5, interaction G2/G4, orchestration G3/G5).

6. **Orchestration's `setGroupColor(0, ...)` for tracking highlight is wrong.** It recolors all glyphs in group 0, not the grid border. Background mesh color (`grid._background.material.color`) is the correct target. Display and orchestration both flagged this.

7. **Orchestration's `getWorldBounds()` is undefined.** Never defined, never imported. CodeGrid needs a `getContentBounds()` method or the caller must use `Box3.setFromObject()`.

8. **Interactive rendering should be batched.** Keystroke-driven mutations should not trigger immediate `_render()` per keypress. A `requestAnimationFrame`-coalesced dirty flush caps rendering at one pass per frame.

9. **Focus and tracking highlights can collide.** Both interaction (focus border) and orchestration (tracking highlight) mutate the same background mesh color. A save/restore protocol or layered priority system is needed so blur does not clobber tracking state and vice versa.

---

## Implementation Plan

The public API that bridges display and interaction lives on TUIWindow. Below is the file-by-file plan.

### File 1: `src/ide/TUIWindow.js` -- Editing API + Cursor Contract

Add to the existing TUIWindow class:

```javascript
// --- Cursor contract (single source of truth) ---

/** @param {number} row - Row relative to visible window (0 to rows-1) */
/** @param {number} col - Column (0 to cols-1) */
setCursor(row, col) {
  this.cursorRow = Math.max(0, Math.min(row, this.rows - 1));
  this.cursorCol = Math.max(0, Math.min(col, this.cols));
  // No render -- cursor is a mesh managed by interaction
}

getCursor() {
  return { row: this.cursorRow, col: this.cursorCol };
}

// --- Character-level editing API ---
// All row indices are relative to the visible window.

/** Return a single visible line (read-only copy). */
getVisibleLine(row) {
  const lines = this.getVisibleLines();
  if (row < 0 || row >= lines.length) return '';
  return lines[row];
}

/** Overwrite an entire visible line. */
setVisibleLine(row, text) {
  const absRow = this._toAbsoluteRow(row);
  if (absRow < 0 || absRow >= this._history.length) return;
  this._history[absRow] = text.slice(0, this.cols);
  this._dirty = true;
}

/** Insert a character at (row, col) in the visible window. */
insertChar(row, col, char) {
  const line = this.getVisibleLine(row);
  const newLine = line.slice(0, col) + char + line.slice(col);
  this.setVisibleLine(row, newLine.slice(0, this.cols));
  this.setCursor(row, Math.min(col + 1, this.cols));
}

/** Delete the character before (row, col). Returns true if a line merge occurred. */
deleteChar(row, col) {
  if (col > 0) {
    const line = this.getVisibleLine(row);
    this.setVisibleLine(row, line.slice(0, col - 1) + line.slice(col));
    this.setCursor(row, col - 1);
    return false;
  }
  // col === 0: merge with previous line
  if (row > 0) {
    const prev = this.getVisibleLine(row - 1);
    const curr = this.getVisibleLine(row);
    this.setVisibleLine(row - 1, (prev + curr).slice(0, this.cols));
    this._removeVisibleLine(row);
    this.setCursor(row - 1, prev.length);
    return true;
  }
  return false;
}

/** Split line at (row, col) -- handles Enter key. */
splitLine(row, col) {
  const line = this.getVisibleLine(row);
  this.setVisibleLine(row, line.slice(0, col));
  this._insertVisibleLine(row + 1, line.slice(col));
  this.setCursor(row + 1, 0);
}

/** Request a render on the next frame (public, replaces direct _render calls). */
markDirty() {
  this._dirty = true;
  if (!this._rafPending) {
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._render();
    });
  }
}

// --- Private helpers ---

_toAbsoluteRow(visibleRow) {
  const start = Math.max(0, this._history.length - this.rows - this.scrollOffset);
  return start + visibleRow;
}

_removeVisibleLine(row) {
  const absRow = this._toAbsoluteRow(row);
  if (absRow >= 0 && absRow < this._history.length) {
    this._history.splice(absRow, 1);
    this._dirty = true;
  }
}

_insertVisibleLine(row, text) {
  const absRow = this._toAbsoluteRow(row);
  this._history.splice(absRow, 0, text.slice(0, this.cols));
  this._dirty = true;
}
```

### File 2: `src/ide/TUIFocusManager.js` -- Remove shadow cursor, use TUIWindow API

Replace all `win.buffer` references and shadow cursor state:

```javascript
// REMOVE these fields from constructor:
//   this._cursorRow = 0;
//   this._cursorCol = 0;

// In focus():
//   BEFORE: const lastRow = win.buffer.findLastIndex(l => l.length > 0);
//   AFTER:
const lines = win.getVisibleLines();
const lastRow = lines.findLastIndex(l => l.length > 0);
const row = Math.max(0, lastRow);
win.setCursor(row, lines[row]?.length ?? 0);

// In _handleKeystrokeLocal(), replace all buffer surgery:
//   Character insert:
//     BEFORE: win.buffer[row] = line.slice(0, col) + char + line.slice(col);
//     AFTER:  win.insertChar(win.cursorRow, win.cursorCol, char);

//   Backspace:
//     BEFORE: win.buffer[row] = line.slice(0, col-1) + line.slice(col);
//     AFTER:  win.deleteChar(win.cursorRow, win.cursorCol);

//   Enter:
//     BEFORE: win.buffer.push(...); win.buffer.shift();
//     AFTER:  win.splitLine(win.cursorRow, win.cursorCol);

//   Arrow keys -- read cursor from win directly:
//     BEFORE: this._cursorRow = ...
//     AFTER:  win.setCursor(newRow, newCol);

// Replace win._render() call:
//   BEFORE: win._render();
//   AFTER:  win.markDirty();
```

### File 3: `src/ide/windowCommands.js` -- Add scroll command

```javascript
// Register alongside existing commands:
registerCommand('window.scroll', (args) => {
  // args: <id> <up|down|bottom> [n]
  const [id, direction, countStr] = args;
  const win = manager.get(id);
  if (!win) return { error: `unknown window ${id}` };
  const n = parseInt(countStr, 10) || 1;
  switch (direction) {
    case 'up':     win.scrollUp(n); break;
    case 'down':   win.scrollDown(n); break;
    case 'bottom': win.scrollToBottom(); break;
    default: return { error: `unknown direction: ${direction}` };
  }
  return { ok: true, scrollOffset: win.scrollOffset };
});
```

### File 4: `src/ide/TUIFocusManager.js` -- Add scroll key bindings

```javascript
// In _handleKeyDown, add cases:
case 'PageUp':
  e.preventDefault();
  win.scrollUp(win.rows);
  win.markDirty();
  break;
case 'PageDown':
  e.preventDefault();
  win.scrollDown(win.rows);
  win.markDirty();
  break;
```

### File 5: `src/collections/CodeGrid.js` -- Add getContentBounds()

```javascript
/** Return world-space content dimensions for layout math. */
getContentBounds() {
  return {
    width: this.cols * this._charWidth,
    height: this.rows * this._lineHeight
  };
}
```

### File 6: Orchestration highlight fix (wherever `window.track` is implemented)

```javascript
// BEFORE: coll.setGroupColor(0, { r: 0.2, g: 1.0, b: 0.4 });
// AFTER:
targetGrid._background.material.color.set(0x33ff66);
// Save original so untrack can restore:
trackEntry.originalBgColor = targetGrid._background.material.color.clone();
```

---

## Implementer Vote

**interaction**

Rationale: The largest volume of code changes falls on the interaction side -- replacing 14 `win.buffer` references, removing the shadow cursor, rewiring all keystroke handlers to the new TUIWindow API, and adding scroll key bindings. The display-side changes (adding the editing API to TUIWindow) are structurally straightforward additions. The interaction agent best understands the keystroke handling flow and cursor movement logic that must be rewritten, making them the most efficient implementer for the full bridging work.
