# Buffer Internals: TextBuffer Abstraction Boundary

Agent perspective: how text is stored inside CodeGrid, what sits between raw text and the rendering pipeline, and how internal representation can evolve without breaking consumers.

---

## 1. What CodeGrid Currently Exposes

**Public properties (direct access by consumers):**

| Property | Type | Who reads it | Where |
|---|---|---|---|
| `grid.content` | `string` | highlightCommands (via `computeInverse`), edit flow (slice for inverse), consolidated plan's dual-write step 1 | `CodeGrid.js:47`, read externally in `unit-of-work-integration.md:127` |
| `grid.lines` | `string[]` | `highlightCommands.js:211,217-218` (iterate lines, search for tokens), `getLineCount()`, `getMaxLineWidth()`, `getVisibleCharCount()` | `CodeGrid.js:48`, read externally |
| `grid.filename` | `string` | layout, display | `CodeGrid.js:45` |
| `grid.sourcePath` | `string` | identity | `CodeGrid.js:46` |

**Public methods that expose text structure:**

- `getLineCount()` (line 289) -- lazy-splits `content` into `lines` if needed
- `getMaxLineWidth()` (line 301) -- same lazy split, then `Math.max(...lines.map(l => l.length))`
- `getVisibleCharCount(line)` (line 579) -- iterates `this.lines[line]` char by char
- `getSlotForChar(line, col)` (line 569) -- uses `_lineSlotBase[line] + col`
- `highlightRange(startLine, startCol, endLine, endCol, color)` (line 600) -- uses `_lineSlotBase` + `getVisibleCharCount`
- `loadText(text)` (line 91) -- sets `this.content = text; this.lines = text.split('\n')`
- `loadTextAsync(text)` (line 123) -- sets `this.content = text` (lazy lines)

**The problem:** `grid.content` and `grid.lines` are bare public fields. External code reads and mutates them directly. The consolidated plan's dual-write flow (step 1) does `grid.content = newContent; grid.lines = newContent.split('\n')`. The highlight token command iterates `grid.lines[lineIdx]` directly.

---

## 2. What the Builder Actually Needs

Looking at `buildBatchBuffers` (`src/workers/builders/index.js:242`), the builder receives:

```js
items[i].text   // a plain string
```

It iterates character by character (`text.charCodeAt(i)`, line 321), detecting newlines (10), spaces (32), CR (13), tab (9). It never calls `.split('\n')`, never asks for "line N", never uses any text API beyond `charCodeAt` and `length`.

**The builder needs exactly one thing: a flat string.**

The worker boundary enforces this -- structured clone can transfer strings and TypedArrays, but not class instances with methods. Any `TextBuffer` object would need to serialize to a string before crossing to the worker anyway.

This is the key insight: the rendering pipeline's input is always a serialized snapshot (a string), regardless of what data structure holds the text in the main thread.

---

## 3. Where Flat-String Assumptions Live

**Internal to CodeGrid (safe to change):**

- `CodeGrid.js:92` -- `this.content = text` (loadText)
- `CodeGrid.js:93` -- `this.lines = text.split('\n')` (loadText)
- `CodeGrid.js:124` -- `this.content = text` (loadTextAsync)
- `CodeGrid.js:519` -- `const content = this.content` (_buildLineSlotBase)
- `CodeGrid.js:527` -- `this.lines = content.split('\n')` (lazy split fallback)

These are all private or semi-private. Changing the internal storage here breaks nothing external.

**External to CodeGrid (API surface -- must preserve or migrate):**

- `highlightCommands.js:211` -- `grid.lines.length` (existence check + iteration bound)
- `highlightCommands.js:218` -- `grid.lines[lineIdx]` (string search within a line)
- `unit-of-work-integration.md:124` -- `grid.lines` (passed to `linesToOffset`)
- `unit-of-work-integration.md:127` -- `grid.content.slice(startOffset, endOffset)` (extract deleted text for inverse)
- `unit-of-work-integration.md:150` -- `grid.content.slice(0, startOffset)` + concat (apply edit)

The edit flow code in `unit-of-work-integration.md` is planned, not yet implemented. This means we can design the abstraction *before* consumers are written, which is the ideal timing.

The highlight commands are the only *existing* external consumer that reads `grid.lines` directly.

---

## 4. The TextBuffer Interface

The abstraction should be a thin wrapper that CodeGrid owns internally, exposed through methods on CodeGrid itself. Consumers never touch `TextBuffer` directly -- they call `grid.getLine(n)`, `grid.getLineCount()`, etc. This keeps the API surface on CodeGrid and lets the internal implementation swap freely.

```js
/**
 * TextBuffer -- internal text storage abstraction.
 * Phase 1: wraps a flat string + cached line index.
 * Future: piece table, rope, CRDT document.
 *
 * NOT exported. NOT visible to consumers. CodeGrid owns one.
 */
class TextBuffer {
    constructor(text = '') {
        this._text = text;
        this._lineIndex = null;  // lazy Int32Array of newline positions
    }

    // -- Core read API --

    /** Full content as string (for worker serialization, save, etc.) */
    getText() { return this._text; }

    /** Number of lines (1-indexed count, empty string = 1 line) */
    getLineCount() {
        this._ensureLineIndex();
        return this._lineIndex.length + 1;
    }

    /** Content of line N (0-based), without trailing newline */
    getLine(n) {
        this._ensureLineIndex();
        const start = n === 0 ? 0 : this._lineIndex[n - 1] + 1;
        const end = n < this._lineIndex.length ? this._lineIndex[n] : this._text.length;
        return this._text.substring(start, end);
    }

    /** Length of longest line (characters) */
    getMaxLineWidth() {
        this._ensureLineIndex();
        let max = 0;
        const count = this.getLineCount();
        for (let i = 0; i < count; i++) {
            const len = this._getLineLength(i);
            if (len > max) max = len;
        }
        return max;
    }

    /** Character at absolute offset */
    charCodeAt(offset) { return this._text.charCodeAt(offset); }

    /** Total character count */
    get length() { return this._text.length; }

    // -- Mutation API (Phase 2: editing) --

    /** Replace range with new text. Returns inverse edit for undo. */
    applyEdit(startOffset, endOffset, newText) {
        const deleted = this._text.substring(startOffset, endOffset);
        this._text = this._text.substring(0, startOffset) + newText +
                     this._text.substring(endOffset);
        this._lineIndex = null;  // invalidate
        return { startOffset, endOffset: startOffset + newText.length, deletedText: deleted };
    }

    /** Bulk replace (for full file reload) */
    setText(text) {
        this._text = text;
        this._lineIndex = null;
    }

    // -- Internal --

    _ensureLineIndex() {
        if (this._lineIndex !== null) return;
        const indices = [];
        for (let i = 0; i < this._text.length; i++) {
            if (this._text.charCodeAt(i) === 10) indices.push(i);
        }
        this._lineIndex = indices;
    }

    _getLineLength(n) {
        const start = n === 0 ? 0 : this._lineIndex[n - 1] + 1;
        const end = n < this._lineIndex.length ? this._lineIndex[n] : this._text.length;
        return end - start;
    }
}
```

**Phase 1 cost: zero.** The flat-string implementation is what CodeGrid does today, just organized behind methods. `getText()` returns the string directly -- no copy, no transformation. The line index replaces the current `this.lines = text.split('\n')` with a more memory-efficient approach (array of newline offsets instead of N substring copies).

**Future swap path:** Replace `_text` with a piece table or rope. `getText()` materializes the string (needed for worker serialization). `getLine()` and `applyEdit()` become O(log n) piece-tree operations. No consumer code changes.

---

## 5. CodeGrid API Changes

CodeGrid hides the buffer behind methods. The `content` and `lines` properties become accessors for backward compatibility, then deprecate.

```js
class CodeGrid extends THREE.Object3D {
    constructor(scene, atlas, options) {
        // ...existing...
        this._buffer = new TextBuffer();
    }

    // New method API (canonical)
    getLine(n)        { return this._buffer.getLine(n); }
    getLineCount()    { return this._buffer.getLineCount(); }
    getMaxLineWidth() { return this._buffer.getMaxLineWidth(); }
    getContent()      { return this._buffer.getText(); }

    // Backward-compatible accessors (deprecation path)
    get content()     { return this._buffer.getText(); }
    set content(v)    { this._buffer.setText(v); }
    get lines()       { return this._linesProxy(); }

    // Lazy lines proxy for highlight commands that iterate grid.lines[i]
    _linesProxy() {
        const buf = this._buffer;
        const count = buf.getLineCount();
        // Return array-like with indexed access + length
        // Avoids splitting entire content into N substrings upfront
        return new Proxy([], {
            get(_, prop) {
                if (prop === 'length') return count;
                const idx = Number(prop);
                if (Number.isInteger(idx) && idx >= 0 && idx < count) {
                    return buf.getLine(idx);
                }
                return undefined;
            }
        });
    }

    loadText(text, options) {
        this._buffer.setText(text);
        this._clearContent();
        this._layoutContent();
        this._updateBackground();
        return this;
    }
}
```

The Proxy on `lines` is a compatibility shim. The one real consumer (`highlightCommands.js:217-218`) iterates `grid.lines[lineIdx]` in a for loop with `grid.lines.length` as the bound. The Proxy satisfies both patterns without materializing every line. Once highlightCommands migrates to `grid.getLine(n)` and `grid.getLineCount()`, the Proxy can be removed.

---

## 6. Worker Boundary

TextBuffer cannot cross the worker boundary. This is fine because the builder only needs a string.

**Serialization point:** `GlyphCollection.flushAsync()` at line 604 iterates `items[i].text`. Today that text comes from `this._pendingAdds`, which stores the string passed to `addText()`. The flow is:

1. `CodeGrid._layoutContentAsync()` calls `this._collection.addText(this.content, ...)` (line 472)
2. `this.content` is now `this._buffer.getText()` -- returns the flat string
3. String goes into `_pendingAdds`
4. `flushAsync()` sends it to the worker

No change needed. The worker always receives a string. The TextBuffer abstraction lives entirely in the main thread.

**Future optimization:** When TextBuffer uses a piece table, `getText()` materializes the full string for the worker. This is a single O(n) pass. For incremental re-renders (future tier), the edit deltas themselves could be sent to the worker to compute partial buffer updates -- but the builder would still receive string slices, not piece-table structures.

---

## 7. Cost Analysis

| Operation | Current cost | With TextBuffer (flat string) | With TextBuffer (piece table) |
|---|---|---|---|
| `loadText(text)` | O(n) split | O(1) store + lazy index | O(1) store |
| `getLineCount()` | O(n) split if not cached | O(n) first call, O(1) cached | O(log n) |
| `getLine(n)` | O(1) array index (after split) | O(1) substring (after index) | O(log n) |
| `getText()` (for worker) | O(1) direct reference | O(1) direct reference | O(n) materialize |
| `applyEdit()` | N/A (not implemented) | O(n) string concat + invalidate | O(log n) |
| Memory | string + N line copies | string + newline offset array | piece descriptors |

For the flat-string phase, the TextBuffer is strictly cheaper than the current approach because it replaces `text.split('\n')` (which allocates N string objects) with a newline-offset index (one integer array).

---

## 8. Recommendation

**Do NOT expose `TextBuffer` as a public type.** Keep it internal to CodeGrid. The reasons:

1. Consumers should never know the text storage implementation. They call `grid.getLine(n)`, `grid.getContent()`, `grid.getLineCount()`.
2. The worker boundary forces string serialization anyway -- no consumer can hold a TextBuffer reference that survives a worker round-trip.
3. The edit path (`applyEdit`) should flow through CodeGrid methods that coordinate buffer mutation, line-slot-base invalidation, and re-render scheduling as a single operation.

The right layering is:
```
Consumer (highlightCommands, EditorInputManager, etc.)
    ↓ grid.getLine(n), grid.getContent(), grid.applyEdit(edit)
CodeGrid (coordinates buffer + render + slot mapping)
    ↓ this._buffer.getLine(n), this._buffer.applyEdit(...)
TextBuffer (internal, swappable implementation)
    ↓ this._buffer.getText() → string
Worker (receives plain string, returns Float32Arrays)
```

**Migration order:**
1. Add `TextBuffer` class (internal to `CodeGrid.js` or `src/collections/TextBuffer.js`)
2. Add `get content()` / `get lines()` accessors to CodeGrid (backward compat)
3. Replace internal `this.content`/`this.lines` usage with `this._buffer.*`
4. Migrate `highlightCommands.js` to `grid.getLine(n)` / `grid.getLineCount()`
5. Remove `lines` Proxy, mark `content` getter as deprecated
6. Implement `applyEdit()` on TextBuffer for the editing pipeline
7. (Future) Swap flat string for piece table inside TextBuffer -- zero external changes
