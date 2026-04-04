# Review: buffer-internals reviews edit-pipeline, api-stability

## Errors or Conflicts

1. **TextBuffer naming collision.** My analysis (buffer-internals) and edit-pipeline both define a `TextBuffer` class, but with incompatible interfaces. I use `getText()` for content retrieval; edit-pipeline uses `toString()`. I use `applyEdit(startOffset, endOffset, newText)` with byte offsets; edit-pipeline uses `applyEdits(TextEdit[])` with line/character positions. These are two different abstraction levels. The flat-string buffer I proposed operates on raw offsets; the edit-pipeline's buffer operates on LSP-style `TextEdit[]` with pre-document position semantics and reverse-order application. Both cannot be the same class without one being a wrapper around the other. Resolution: my `TextBuffer` is the storage layer; edit-pipeline's `applyEdits()` is a coordination method that should live on CodeGrid or an `EditorInputManager`, calling down into the storage layer's offset-based mutations.

2. **Who owns inverse computation.** Edit-pipeline says the buffer MUST produce inverses because "only the buffer holds the before content." My analysis leaves `applyEdit` returning a simple `{ startOffset, endOffset, deletedText }` inverse at the offset level. Edit-pipeline wants line/character-position inverses suitable for undo replay. These are not the same thing. If the buffer returns offset-based inverses, something upstream must convert them to position-based `TextEdit[]` for the undo stack. Edit-pipeline is right that the buffer should own this -- but only if the buffer also owns position-to-offset conversion, which my flat-string `TextBuffer` does (via the line index) but a piece table might not expose the same way.

3. **`lines` getter: Proxy vs materialized array.** I proposed a `Proxy` on the `lines` getter to avoid materializing every line. Api-stability proposes `get lines() { return this._buffer.getLines(); }` returning a real `string[]`. The Proxy is clever but fragile -- `Array.isArray()` returns false, `for...of` may not work without a Symbol.iterator trap, and `console.log` will show `[]`. Api-stability's materialized approach is safer for backward compatibility even though it is less memory-efficient. The Proxy is probably not worth the edge-case risk for a deprecation shim.

4. **Missing `highlightToken` consolidation.** Api-stability identifies that both `highlightCommands` and `TourAnnotator` duplicate the token-search-and-highlight pattern and recommends a `grid.highlightToken(pattern, color)` method. My analysis missed this. This is a legitimate API addition that would eliminate both external `grid.lines` consumers in one move, making the deprecation of `lines` trivial.

5. **`grid.content` assignment in dual-write.** Edit-pipeline's flow (section 6, step 3) does `grid.content = newContent` after buffer mutation. But if `content` is a getter/setter pair (as both my analysis and api-stability recommend), the setter would call `this._buffer.setText(v)` -- which overwrites the buffer that *just* did the edit. This is a redundant double-write. The edit flow should skip the property setter and use the buffer's already-mutated state directly. The render path should read `this._buffer.getText()` rather than requiring an explicit content assignment.

## Convergence (what all three agree on)

- **TextBuffer is internal to CodeGrid, never exported.** All three analyses agree consumers call CodeGrid methods, never the buffer directly.
- **The worker boundary is a natural serialization point.** The builder always receives a flat string. No buffer abstraction crosses to the worker.
- **`grid.content` and `grid.lines` must become getters** with backward-compatible semantics during migration. Api-stability audited every consumer; buffer-internals designed the getter mechanics; edit-pipeline assumed the getters exist.
- **The provider layer is already buffer-agnostic.** It speaks `TextEdit[]` and strings. No changes needed there.
- **Picking is buffer-agnostic.** Slot-based resolution is decoupled from text storage.
- **Phase 1 is flat-string, zero-cost.** All three agree the initial TextBuffer wraps the existing string with no performance regression, and that piece table / CRDT swaps happen later behind the same interface.
- **`TextEdit[]` is the pipeline currency.** LSP-format edits flow from input to provider to history without translation.

## Key Recommendation

The single most important decision for Tier 1 is to **settle the TextBuffer interface at one abstraction level and keep it there.** The buffer should own offset-based storage, line indexing, and position-to-offset conversion -- but it should NOT own edit-transaction semantics like pre-document position sorting, multi-cursor batch application, or history recording. Those belong in a coordinator (CodeGrid or EditorInputManager) that translates `TextEdit[]` into the buffer's native offset operations. If the buffer tries to be both a storage engine and an edit-transaction processor, swapping the storage implementation later (piece table, CRDT) will require reimplementing transaction logic too. Keep the buffer dumb, keep the coordinator smart, and the swap path stays clean.
