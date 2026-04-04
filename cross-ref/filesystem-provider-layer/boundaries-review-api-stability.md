# Review: api-stability reviews buffer-internals, edit-pipeline

## Errors or Conflicts

**1. TextBuffer API shape disagrees across analyses.**
Buffer-internals defines `getLineCount()` as a method returning `this._lineIndex.length + 1`. Edit-pipeline defines `get lineCount()` as a getter property. These are different call signatures (`buffer.getLineCount()` vs `buffer.lineCount`). The CodeGrid facade hides this from consumers, but the internal contract must be pinned before anyone writes code. Pick one convention and hold it -- I lean toward methods (`getLineCount()`) for consistency with the existing CodeGrid public API.

**2. Edit-pipeline's dual-write step 3 writes `grid.content = newContent` directly.**
My analysis identified `grid.content` as a property that should become a getter/setter pair. Buffer-internals agrees and defines `set content(v) { this._buffer.setText(v); }`. But edit-pipeline's flow diagram still shows `grid.content = newContent` as a direct assignment in step 3, then separately says the buffer abstraction is "invisible to steps 4-6." This is technically compatible if the setter exists, but the edit-pipeline analysis never acknowledges the setter -- it treats it as a plain field write. If someone implements the edit pipeline before the getter/setter is in place, it will bypass the buffer entirely.

**3. Buffer-internals cites `unit-of-work-integration.md` as an external consumer of `grid.content` and `grid.lines`.**
That document is a design plan, not shipped code. Treating planned code as an existing consumer is misleading -- it inflates the migration surface. The actual external consumers of `grid.content` are limited to `HeatmapProvider` (one `.length` read). Buffer-internals correctly notes this distinction ("planned, not yet implemented") but still lists it in the "external to CodeGrid" table alongside real consumers, which could cause confusion during implementation.

**4. `toString()` vs `getText()` naming.**
Edit-pipeline uses `buffer.toString()` as the canonical method for content materialization. Buffer-internals uses `buffer.getText()`. These are the same operation with different names. `getText()` is clearer -- `toString()` is a JavaScript convention with implicit-coercion baggage. Converge on `getText()`.

**5. Proxy-based `lines` shim is unnecessary complexity.**
Buffer-internals proposes a `Proxy` on the `lines` getter to avoid materializing all line substrings. My analysis shows exactly 3 external consumers of `grid.lines`, and the iteration pattern is trivial (`for` loop with indexed access + `.length`). A plain `Array` from `getText().split('\n')` is simpler, debugger-friendly, and the perf difference is irrelevant for the file sizes involved (highlight token scans happen once per user action, not per frame). The Proxy adds a deoptimization surface for V8 and makes stack traces harder to read. Just return the array until the consumer is migrated to `getLine(n)`.

## Convergence (what all three agree on)

1. **TextBuffer must be internal to CodeGrid.** No consumer should import or hold a reference to the buffer. CodeGrid is the public facade; the buffer is a swappable implementation detail.

2. **The worker boundary forces string serialization.** No matter what data structure backs the buffer, workers receive a flat string. The builder pipeline (`buildBatchBuffers`) needs zero changes.

3. **Backward-compatible getters on `content` and `lines` provide a zero-breakage migration.** All three analyses agree that JavaScript getters let us swap internals without breaking existing consumers.

4. **`TextEdit[]` is the right edit currency.** LSP-compatible, provider-compatible, tree-sitter-convertible. No custom ChangeSet type needed for Tier 1.

5. **Inverse computation belongs inside the buffer.** The buffer holds the "before" state at mutation time; externalizing inverse computation leaks the abstraction.

6. **The picking system is already buffer-agnostic.** Slot indices and picking IDs are derived from the rendered geometry, not the text representation. No changes needed.

7. **Phase 1 is a flat-string wrapper with zero performance cost.** The abstraction pays for itself immediately by replacing `text.split('\n')` with a newline-offset index.

## Key Recommendation

The single most important Tier 1 decision is **locking the CodeGrid method API before writing any edit-pipeline code.** All three analyses agree on the shape (`getLine(n)`, `getLineCount()`, `getContent()`, and eventually `applyEdit()`), but the buffer-internals and edit-pipeline analyses disagree on the internal TextBuffer naming (`getText` vs `toString`, `getLineCount()` vs `lineCount`). If the edit-pipeline is implemented against one naming convention and the buffer against another, the integration will require a tedious rename pass. Pin the internal `TextBuffer` interface in a single file with JSDoc, get the three method names right (`getText()`, `getLine(n)`, `getLineCount()`, `applyEdits(edits)`), and only then start wiring consumers. The backward-compatible getters on `content` and `lines` buy time for consumer migration, but the internal contract between CodeGrid and TextBuffer must be frozen first -- that contract is the load-bearing seam for every future phase.
