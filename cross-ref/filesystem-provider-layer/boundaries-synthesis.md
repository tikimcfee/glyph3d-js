# Abstraction Boundaries — Synthesis

3-agent focused analysis + cross-review on the question: what minimal API design decisions in Tier 1 make the N→N+1 buffer evolution (flat string → piece table → CRDT) a non-breaking internal swap?

## Unanimous Convergence (all 3 agents)

### 1. TextBuffer is internal to CodeGrid

Never exposed. Consumers interact through CodeGrid methods. The buffer can be swapped without any external code knowing.

### 2. `grid.applyEdits(TextEdit[])` is the single entry point

One method on CodeGrid that coordinates:
- Buffer mutation (with inverse computation inside the buffer)
- Edit history recording
- Re-render scheduling (rAF-debounced)
- Provider persistence (async, fire-and-forget)

This is the chokepoint. Everything upstream produces `TextEdit[]`, everything downstream consumes either a content string (renderer) or inverse `TextEdit[]` (history).

### 3. TextBuffer is a dumb storage layer

Two levels, clearly separated:
- **TextBuffer** (pure storage): `getText()`, `getLine(n)`, `getLineCount()`, `applyEdits(edits) → ApplyResult`. Handles offset math, line index, content mutation. Returns replaced text for inverse computation.
- **CodeGrid** (coordinator): `grid.applyEdits(TextEdit[])` wraps buffer mutation with transaction semantics — position sorting, inverse packaging, history recording, re-render scheduling, provider notification.

The buffer doesn't know about versions, labels, providers, or rendering. CodeGrid doesn't know about character offsets, line indices, or memory layout.

### 4. Backward-compatible getters for migration

```js
// CodeGrid — zero-breakage migration
get content() { return this._buffer.getText(); }
set content(text) { this._buffer = new StringBuffer(text); }
get lines() { return this._buffer.getLines(); }  // materialized array, not Proxy
```

Consumers that read `grid.content` or `grid.lines` continue to work. New code uses `grid.getLine(n)`, `grid.getLineCount()`, `grid.getContent()`.

### 5. Worker boundary is the serialization point

The builder (`buildBatchBuffers`) receives a flat string via `text.charCodeAt(i)`. Workers can't hold TextBuffer instances. CodeGrid materializes the string before posting to workers:

```js
// In the re-render path:
const text = this._buffer.getText();  // O(n) materialization, once per edit cycle
this._collection.loadTextAsync(text, ...);
```

This is the only O(n) cost of the abstraction, and it happens once per edit, not per frame.

### 6. Inverse computation belongs inside the buffer

Only the buffer holds "before" content at mutation time. The `ApplyResult` returned by `buffer.applyEdits()` includes the inverse edits:

```js
// TextBuffer.applyEdits(edits) returns:
{
  content: string,           // new full content (for worker serialization)
  inverse: TextEdit[],       // inverse edits for undo
  treeSitterDescs: EditDesc[] // optional: {startByte, oldEndByte, newEndByte} for future tree-sitter
}
```

The `treeSitterDescs` field costs nothing to produce (it's a strict subset of what the buffer already computes) and prevents a future breaking change when tree-sitter integration arrives.

### 7. `highlightToken()` becomes a CodeGrid method

Both `highlightCommands.js` and `TourAnnotator.js` implement identical line-iteration + substring-search + visible-column-conversion + highlight logic. Consolidating into `grid.highlightToken(pattern, color)` internalizes all line access, making both consumers fully buffer-agnostic.

### 8. Provider, picking, and package exports are already agnostic

- Providers deal in strings over the wire (JSON-RPC). No changes needed.
- Picking resolves to slot indices, rebuilt on every flush. No buffer dependency.
- Package exports don't expose CodeGrid internals. No changes needed.

## Resolved Tensions

| Tension | Resolution |
|---------|-----------|
| TextBuffer API level (dumb vs smart) | Dumb storage + CodeGrid coordinator |
| `lines` backward compat (Proxy vs array) | Materialized array — simpler, safer |
| Inverse: buffer vs external | Buffer owns it (only holder of "before" content) |
| `grid.content = x` setter conflict | Setter creates new StringBuffer, bypasses applyEdits |
| TextBuffer naming | Pin as `getText()`, `getLine(n)`, `getLineCount()`, `applyEdits()` |

## StringBuffer — Phase 1 Implementation

```js
/**
 * Flat-string buffer with lazy line index. Phase 1 implementation of TextBuffer.
 * Swappable for PieceTableBuffer, RopeBuffer, CRDTBuffer without changing CodeGrid API.
 */
export class StringBuffer {
    constructor(text = '') {
        this._text = text;
        this._lineOffsets = null;  // lazy
    }

    getText() { return this._text; }

    getLine(n) {
        const offsets = this._getLineOffsets();
        if (n < 0 || n >= offsets.length) return '';
        const start = offsets[n];
        const end = n + 1 < offsets.length ? offsets[n + 1] - 1 : this._text.length;
        return this._text.substring(start, end);
    }

    getLineCount() {
        return this._getLineOffsets().length;
    }

    getLines() {
        // Materialized array for backward compat. Consumers should migrate to getLine(n).
        return this._text.split('\n');
    }

    /**
     * Apply edits (pre-document positions, applied bottom-to-top internally).
     * @param {TextEdit[]} edits - positions reference document state BEFORE any edit
     * @returns {ApplyResult} { content, inverse, treeSitterDescs }
     */
    applyEdits(edits) {
        // Sort edits bottom-to-top (reverse document order)
        const sorted = [...edits].sort((a, b) => {
            const lineDiff = b.range.start.line - a.range.start.line;
            return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
        });

        const inverse = [];
        const treeSitterDescs = [];
        let text = this._text;

        for (const edit of sorted) {
            const startOffset = this._positionToOffset(edit.range.start, text);
            const endOffset = this._positionToOffset(edit.range.end, text);
            const deletedText = text.substring(startOffset, endOffset);

            // Inverse: what was deleted becomes the newText, positioned at where the new text lands
            inverse.unshift({
                range: {
                    start: { ...edit.range.start },
                    end: {
                        line: edit.range.start.line + (edit.newText.match(/\n/g) || []).length,
                        character: edit.newText.includes('\n')
                            ? edit.newText.length - edit.newText.lastIndexOf('\n') - 1
                            : edit.range.start.character + edit.newText.length
                    }
                },
                newText: deletedText
            });

            // Tree-sitter descriptor
            const newEndByte = startOffset + new TextEncoder().encode(edit.newText).length;
            treeSitterDescs.unshift({
                startByte: new TextEncoder().encode(text.substring(0, startOffset)).length,
                oldEndByte: new TextEncoder().encode(text.substring(0, endOffset)).length,
                newEndByte
            });

            // Apply
            text = text.substring(0, startOffset) + edit.newText + text.substring(endOffset);
        }

        this._text = text;
        this._lineOffsets = null;  // invalidate

        return { content: text, inverse, treeSitterDescs };
    }

    // --- Internal ---

    _getLineOffsets() {
        if (this._lineOffsets) return this._lineOffsets;
        const offsets = [0];
        for (let i = 0; i < this._text.length; i++) {
            if (this._text.charCodeAt(i) === 10) offsets.push(i + 1);
        }
        this._lineOffsets = offsets;
        return offsets;
    }

    _positionToOffset(pos, text) {
        // Compute from text directly (lazy offsets may be stale during batch apply)
        let line = 0, offset = 0;
        while (line < pos.line && offset < text.length) {
            if (text.charCodeAt(offset) === 10) line++;
            offset++;
        }
        return offset + pos.character;
    }
}
```

## Evolution Path

| Phase | Buffer Implementation | Re-render Strategy | What Changes |
|-------|----------------------|-------------------|--------------|
| 1 | StringBuffer (flat string, lazy line index) | Full re-render via loadTextAsync | Nothing — this is the starting point |
| 2 | StringBuffer + slotToPos | Full re-render + cursor from slotToPos | Builder produces slotToPos, CodeGrid stores it |
| 3 | StringBuffer + tree-sitter | Full re-render + partial color updates | treeSitterDescs consumed, changed ranges → color-only GPU update |
| 4 | PieceTableBuffer | Partial geometry updates via changeset deltas | Buffer swap, CodeGrid._applyEdit changes re-render path |
| 5 | CRDTBuffer (Yjs/Loro wrapper) | Partial updates + collaboration | Buffer swap, add sync protocol |

Each phase changes only the buffer implementation and/or the re-render path inside CodeGrid. Input, history, provider, commands, and consumer code remain untouched.
