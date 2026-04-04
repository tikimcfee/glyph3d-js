# Phase 0: TUI System Audit

## 1. What TUIWindow Actually Wraps

TUIWindow (`src/tui/TUIWindow.js`) creates a CodeGrid internally (line 55) and adds these layers on top:

- **Line-buffer history** (`_history: string[]`) with scroll offset viewport
- **Column wrapping** (`_pushWrapped`) at a fixed `cols` width
- **ANSI stripping** (regex `\x1b\[[0-9;]*[a-zA-Z]`)
- **Dirty-flag render coalescing** -- skips `grid.loadFile()` if content unchanged
- **Cursor tracking** (row/col) with `setCursor()`/`getCursor()`
- **Character-level editing API** -- `insertChar()`, `deleteChar()`, `splitLine()`, `setLine()`, `getLine()`
- **Scroll API** -- `scrollUp()`, `scrollDown()`, `scrollToBottom()`
- **Dimensions constraint** -- fixed `cols`/`rows`, re-wrap on resize

The actual render path is trivial (line 402-412):
```js
_render() {
    const content = this.getVisibleLines().join('\n');
    this.grid.loadFile(`[${this.title}]`, content);
}
```

It calls `CodeGrid.loadFile()` with a joined string every time. The entire history/scroll/wrap system exists to feed a single `loadFile()` call.

## 2. TUIFormatter Usage by Command Handlers

### Methods actually called:

| Method    | Called by                                                                                          |
|-----------|----------------------------------------------------------------------------------------------------|
| `box()`   | systemCommands, sceneCommands, cameraCommands, gridCommands, selectCommands, layoutCommands, spatialCommands, registryCommands, annotationCommands, navigationCommands |
| `kvLines()` | systemCommands, sceneCommands, cameraCommands, gridCommands, selectCommands, layoutCommands, spatialCommands, registryCommands, agentLayoutCommands |
| `table()` | gridCommands, searchCommands, agentLayoutCommands, annotationCommands, navigationCommands, registryCommands |

### Methods NEVER called by any handler:

| Method       | Status |
|--------------|--------|
| `pad()`      | Dead -- only used internally by `box()`, `table()`, `kvLines()` |
| `truncate()` | Dead -- zero call sites outside TUIFormatter.js |
| `hr()`       | Dead -- zero call sites anywhere |
| `BOX`        | Dead export -- only used internally by `box()` default param |
| `BOX_THIN`   | Dead export -- zero call sites |

### What these formatters produce:

`box()` draws Unicode double-line box characters around key-value output. `table()` draws column-aligned text with thin-line separators. `kvLines()` pads key-value pairs. All return plain strings. **None of this is structural -- it is cosmetic text formatting for the command response `.text` field.**

The `.text` field is what gets displayed in the CommandBar log panel (DOM element) and echoed back over WebSocket. The `.data` field carries structured JSON. The box-drawing is purely for human readability of the text response.

## 3. TUIWindowManager Lifecycle Operations

Defined in `src/tui/TUIWindowManager.js`:

| Method       | Called by                          | Status     |
|--------------|------------------------------------|------------|
| `create()`   | windowCommands `window.create`     | USED       |
| `get()`      | windowCommands (write/append/clear/close/resize/move/scroll/scale) | USED |
| `remove()`   | windowCommands `window.close`, sceneCommands `scene.clear_windows` | USED |
| `list()`     | windowCommands `window.list`       | USED       |
| `clearAll()` | sceneCommands `scene.clear_windows` | USED      |
| `.count`     | systemCommands `status`, sceneCommands `scene.info` | USED |
| `.windows`   | Direct Map access in windowCommands | USED      |

Auto-positioning logic (lines 22-25, 38-43): stacks vertically at `_nextX = -100`, `_nextY = 50`, wrapping columns. This is used when no explicit position is given. The Go hook never sends a position, so it always uses auto-positioning.

## 4. TUIFocusManager Analysis

`src/tui/TUIFocusManager.js` provides:
- Click-to-focus via raycasting against CodeGrid `_background` meshes
- Keystroke routing (printable chars, arrows, backspace, enter, delete, home/end)
- Cursor mesh (blinking vertical bar)
- Camera controller disable/enable on focus/blur
- WebSocket keystroke relay (`window.input` event)
- Mouse wheel scroll

**TUIFocusManager is NEVER instantiated anywhere in production code.** The only `new TUIFocusManager()` occurrence is in a cross-ref design doc. It imports `primaryMod` from `../services/utils/platform.js` -- a path that does not even exist under `src/`. CommandBar.js mentions it in comments (lines 10, 229) but never imports or uses it.

**Verdict: TUIFocusManager is entirely dead code.** It was designed for interactive terminal editing but was never wired up. The character-level editing API on TUIWindow (insertChar, deleteChar, splitLine, etc.) is also dead -- no caller outside TUIFocusManager uses these methods.

## 5. Command Handler Data Flow Analysis

### windowCommands.js (the only handler that creates TUI windows):

| Command         | TUIWindow method called | Data written              |
|-----------------|------------------------|---------------------------|
| `window.create` | `mgr.create()`         | Nothing (empty window)    |
| `window.write`  | `win.write(text)`      | Base64-decoded plain text |
| `window.append` | `win.appendLine(text)` | Base64-decoded plain text |
| `window.clear`  | `win.clear()`          | (empties buffer)          |
| `window.close`  | `mgr.remove()`         | (disposes grid)           |
| `window.resize` | `win.resize(cols,rows)`| (re-wraps at new width)   |
| `window.move`   | `win.setPosition()`    | (delegates to grid.position.set) |
| `window.scroll` | `win.scrollUp/Down/ToBottom()` | (adjusts viewport) |
| `window.scale`  | `win.setScale()`       | (delegates to grid.scale.setScalar) |

**All content written to TUI windows is plain text.** No handler calls `box()`, `table()`, or any formatter to write *into* a window. The formatters are only used for command *response* strings.

### The Go hook (`cli/hook.go`) -- the primary TUI window consumer:

The hook sends two commands per tool event:
1. `window.create claude 100 40 claude-activity` (ensure-create, idempotent after first call)
2. `window.append claude <base64>` with single-line emoji-prefixed plain text like:
   - `"Read src/foo.js (lines 10-50)"`
   - `"Edit src/bar.js (3->5 lines)"`
   - `"$ git status"`
   - `"Claude stopped"`

This is a log stream. No tables, no boxes, no formatting. Just `appendLine()` with short text lines.

### Could all window operations use `grid.loadText()` instead?

Yes. The full data flow is:
1. Hook sends `window.append claude <base64-text>` (one line of plain text)
2. windowCommands calls `win.appendLine(text)` which pushes to `_history[]`
3. `_render()` joins visible lines with `\n` and calls `grid.loadFile(title, content)`

A replacement that maintains a string array and calls `grid.loadText(lines.join('\n'))` would be functionally identical. The wrap/scroll/cursor machinery is unused overhead.

## 6. Dimensions and Constraints

TUIWindow imposes:
- **cols=80, rows=24** defaults (terminal-style fixed viewport)
- Long lines hard-wrapped at `cols` boundary (character split, no word wrap)
- Scroll viewport: only `rows` lines visible at a time
- History: unbounded array (grows forever with `appendLine`)

**Are these necessary?** No. The hook sends short lines (~60 chars max). The `cols=100` requested in hook.go is never hit. The `rows=40` viewport is rarely filled -- it's a slow-drip activity log. CodeGrid handles variable-length text natively; artificial wrapping at a column boundary is counterproductive for 3D space where text can extend freely.

## 7. What Can Be Deleted vs. Replaced

### DELETE entirely (dead code):

| File/Feature | Reason |
|---|---|
| `src/tui/TUIFocusManager.js` | Never instantiated. Dead code. Depends on nonexistent `../services/utils/platform.js`. |
| TUIWindow cursor API: `setCursor`, `getCursor`, `insertChar`, `deleteChar`, `splitLine`, `getLine`, `setLine` | Only caller is TUIFocusManager (dead). |
| TUIFormatter: `truncate()`, `hr()`, `BOX_THIN`, `pad()` (as public export) | Zero external call sites. `pad()` is used internally by `box`/`table`/`kvLines`. |

### DELETE with thin replacement:

| Component | Replacement |
|---|---|
| `src/tui/TUIWindow.js` | A plain object holding `{ grid: CodeGrid, history: string[] }` with `appendLine` that calls `grid.loadText()`. ~30 lines replaces ~420 lines. |
| `src/tui/TUIWindowManager.js` | A `Map<string, CodeGrid>` with create/get/remove. Auto-position logic moves to the command handler or a helper. ~20 lines replaces ~90 lines. |
| `windowCommands.js` | Rewrite to work with CodeGrid directly. Same wire protocol, same commands. The `window.*` command names stay. |

### KEEP but relocate:

| Component | Reason |
|---|---|
| `TUIFormatter.box()` | Used by 10 command handlers for response text formatting. Not TUI-specific. |
| `TUIFormatter.table()` | Used by 6 command handlers. |
| `TUIFormatter.kvLines()` | Used by 9 command handlers. |

These three functions should move to a general `app/commands/handlers/formatResponse.js` or similar. They are string-formatting utilities for CLI response text, not TUI features. `pad()` stays as a private helper inside the same file.

### What the replacement looks like for the hook flow:

```
hook sends: window.create claude 100 40 claude-activity
  -> handler creates CodeGrid, stores in Map, adds to scene

hook sends: window.append claude <base64>
  -> handler decodes text, pushes to string[], calls grid.loadText(lines.join('\n'))
```

No TUIWindow, no TUIWindowManager, no scroll offset, no column wrapping, no cursor, no ANSI stripping. CodeGrid does the rendering. The handler maintains a `string[]` if append-mode is needed.

## Summary of Findings

| Category | Count | Lines of code |
|---|---|---|
| Entirely dead (delete) | TUIFocusManager + cursor API + unused formatter methods | ~600 lines |
| Replace with thin wrapper | TUIWindow + TUIWindowManager + windowCommands rewrite | ~540 lines -> ~80 lines |
| Relocate (keep logic) | box/table/kvLines formatting | ~60 lines (move, not delete) |
| Total TUI system | 5 files | ~1,050 lines |
| Net after replacement | ~140 lines (80 new wrapper + 60 relocated formatters) | |

The TUI system is a terminal emulator abstraction wrapping what is fundamentally a text display. The terminal features (fixed viewport, column wrapping, cursor editing, scroll history, ANSI stripping, focus management) are unused overhead. The only live consumer (Go hook) writes single lines of plain text to an append-only log. CodeGrid can do this directly.
