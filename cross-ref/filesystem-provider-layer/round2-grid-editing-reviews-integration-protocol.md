# Round 2: grid-editing reviews integration, protocol (inverse)

## Reaffirm or Retract

### 1. `_textToGlyphs` line reference — RETRACT
Protocol and integration both flagged my citation of `_textToGlyphs lines 1139-1145`. They are correct: the file is `src/workers/builders/textToGlyphs.js` (63 lines total), the function is `textToGlyphs` (no underscore), and the skip logic is at lines 31-37. The line numbers I cited were from the old inline method in `GlyphRendererV15` before extraction. My code-level proposals for where to modify `buildBatchBuffers` (lines 321-389 of `src/workers/builders/index.js`) remain correct — the error was only in the cross-reference citation.

### 2. `visCol` naming — RETRACT, adopting `slotCol`
Protocol (round1, recommendation 3) argues `visCol` implies screen position including spaces, which is not what the field tracks. Integration (round1, recommendation 8) goes further and suggests renaming to `charIndex` (0-based index into the full source string). I am retracting my `visCol` naming. However, I disagree with integration's `charIndex` proposal — that is what `rawCol` already is. The field should be `slotCol`: the zero-based index of this glyph among emitted buffer slots on this line. This is distinct from both `rawCol` (source string index) and screen column (which would count spaces). New interleaved layout: `slotToPos[i*3] = line`, `slotToPos[i*3+1] = rawCol`, `slotToPos[i*3+2] = slotCol`.

### 3. Tab/CR handling in `rawCol` — REAFFIRM with clarification
Integration (round1, error 4) correctly identifies the semantic mismatch: the builder skips tabs entirely (`charCode === 9`, line 356 of `buildBatchBuffers`) but `rawCol` must track the source string index for LSP TextEdit compatibility. I reaffirm: `rawCol` must be the index into the raw source string. Tabs and CRs increment `rawCol` but produce no buffer slot. My Phase 0 was unclear on this — "rawCol++ for tab (debatable)" should have been "rawCol++ for tab (required for LSP compatibility)". CRs also increment `rawCol` because they occupy a position in the source string even though the builder skips them.

### 4. Local-first edit application — REAFFIRM with addition
Protocol (round1, recommendation 4) says grid-editing must route edits through the provider for persistent files. I agree and reaffirm my position while adding the reconciliation step I omitted. The sequence is: (a) apply edit to in-memory text immediately for zero-latency cursor feedback, (b) send edit to provider via `applyEdits(uri, edits)`, (c) if provider response content differs from local state, re-render from provider's authoritative content. My Phase 0 only showed step (a). This was a gap, not a wrong design.

### 5. TextEdit format — REAFFIRM `{ range: { start, end }, newText }`
I flagged protocol's flat `{ start, end, newText }` as a deviation from LSP. Protocol did not challenge this in Round 1. Integration's Round 1 also did not object. This is convergence: all three agents should use the standard LSP shape with `range` wrapper.

### 6. `requestAnimationFrame` debouncing — REAFFIRM
Protocol (round1, recommendation 9) agrees this is non-optional given key-repeat at 30ms vs worker round-trip at 5-15ms. No challenge was raised. Reaffirmed as a day-one requirement.

## Evolved Understanding

### URI-driven dispatch vs adapter-swap: both are right, at different layers
After Round 1, I see the tension more clearly. Protocol insists on URI-driven dispatch (`FileSystemRegistry.resolve(uri)`). Integration insists on adapter-swap (`this.repoAdapter.provider = ...`). My Round 1 position was that both can coexist — `switchProvider` for tree-loading context, URI dispatch for file I/O. Round 1 responses confirm this is where all three agents are converging: integration explicitly agreed to adopt JSON-RPC (round1, recommendation 3), and protocol acknowledged the need for a "primary source" concept in the UI (round1, tension 1 resolution).

The evolved position: `FileSystemRegistry` is the dispatch layer for per-file operations. The UI's provider selector sets which scheme is used for `loadRepository()` bulk operations. Individual `readFile`/`applyEdits` calls resolve by URI. This means `CodeGrid` must store a `uri` field (not just `sourcePath`) so that edits can route to the correct provider without ambient state.

### `rawCol` is actually `charIndex` — no, it is source-column
Integration suggested renaming `rawCol` to `charIndex` meaning "0-based index into the full source string." But LSP `Position.character` is the column offset within the line, not the absolute offset into the file. My `rawCol` is the LSP-compatible column: the character index within `this.lines[line]`. The absolute source offset is computed from `rawCol` plus the sum of preceding line lengths. This distinction matters for `applyEdits` where `start.character` is a column, not a file offset. I maintain `rawCol` as the correct semantic, but acknowledge the naming could be improved to `sourceCol` for clarity.

### Undo/redo is a real gap
My Round 1 flagged this as missed by all three. No agent has addressed it in their reviews either. This remains a critical omission for any editing system. The `applyEdits` pipeline must be wrapped in an `EditHistory` that records inverse operations.

## Convergence

These points are now agreed by all three agents:

1. **JSON-RPC 2.0 for FS wire format.** Integration explicitly adopted this (round1, recommendation 3). Protocol defined it. Grid-editing endorsed it (round1, recommendation 2). The custom `{ cmd: "fs.list" }` format is dead.

2. **`applyEdits` returns `FileContent`, not `string`.** Protocol defined it. Integration's `Promise<string>` was flagged by both protocol and grid-editing. Integration acknowledged (round1 did not contest).

3. **LSP `TextEdit` shape with `range` wrapper.** Protocol's flat format was flagged by grid-editing (round1, error 1). No objection raised. Standard LSP format wins.

4. **Server-side tree filtering for local FS.** Integration proposed it, protocol's consumer-side-only position was challenged, integration's round1 explicitly reaffirmed (recommendation 5). Two-pass filtering (relay coarse + browser fine) is consensus.

5. **`slotToPos` built in the same pass as glyph buffers.** No agent challenged the zero-extra-pass approach. The builder loop in `buildBatchBuffers` (line 321-389 of `src/workers/builders/index.js`) is the correct insertion point.

6. **`onDidChange` notification for external file modifications.** Protocol defined it. Integration acknowledged the gap (round1, gap section). Grid-editing acknowledged the gap (round1, gap section). All agree it is Phase 1 scope.

7. **`CodeGrid` needs a `uri` field.** Protocol recommended it (round1, recommendation 7). Grid-editing needs it for edit routing. Integration needs it for `onDidChange` event matching.

## Remaining Tensions

### 1. `listDirectory` return shape: `DirEntry.name` (basename) vs `{path, type, size}` (full path)
Protocol defines `DirEntry` with `name` only (basename). Integration and the existing codebase use full relative paths. Integration's round1 (recommendation 1) argues for full paths. Protocol has not conceded. The codebase's `filterCodeFiles()` and `hierarchicalManager.layoutHierarchy()` both operate on full relative paths. Changing to basenames would require recursive path reconstruction. **My position**: full relative `path` in the return shape, matching the existing `{path, type, size}` convention. Add `name` as a convenience field if desired, but `path` is required.

### 2. `getMultipleFiles` batch optimization vs per-file URI dispatch
Integration (round1, recommendation 7) insists on keeping `getMultipleFiles` as a batch method because `RepositoryAdapter.js:256-280` has concurrency-limited parallel fetch. Protocol's URI-driven model implies per-file `readFile` calls. Neither has fully resolved this. **My position**: the adapter can internally batch `readFile` calls by collecting URIs with the same scheme and delegating to a batch method on the provider. The provider interface exposes `readFile(uri)` as the contract; the adapter layer adds batching as an optimization. This preserves protocol's clean interface without losing integration's performance.

### 3. Branch disambiguation in GitHub URIs
Integration (round1, recommendation 9) flags that `github://owner/repo/branch/path` is ambiguous for branches containing `/` (e.g., `feature/auth`). Protocol has not addressed this. **My position**: use query params: `github://owner/repo?ref=main&path=src/index.js`. This eliminates ambiguity and keeps the URI parseable without branch-name heuristics. However, this is a Phase 2 concern — the existing codebase threads `branch` as a separate parameter everywhere, and encoding it in the URI is only needed if we commit to URI-driven dispatch for GitHub.

### 4. Undo/redo architecture
Flagged by grid-editing (round1), not addressed by protocol or integration. This is not a "nice to have" — without it, every keystroke is permanent. Must be designed before keyboard input lands. The question is where the undo stack lives: on `CodeGrid` (per-file), on `EditorInputManager` (global), or on the provider (enabling undo across reconnects for local FS). **My position**: per-CodeGrid `EditHistory` that records `{ forward: TextEdit[], inverse: TextEdit[] }` pairs. The provider does not own undo — it is a UI concern.

## Synthesis

The three workstreams converge on this architecture:

1. **Types file first.** Create `src/services/data/types.js` with JSDoc typedefs for `TextEdit` (LSP shape), `FileContent`, `FileStat`, `DirEntry` (with `path`), and `FileSystemProvider` interface. All three workstreams import from it. This was my Round 1 key insight and remains the single most important pre-implementation step.

2. **Provider layer.** `FileSystemRegistry` resolves URIs to providers. `GitHubProvider` wraps `GitHubRepositorySource` + cache. `RemoteFileSystemProvider` wraps the WebSocket relay with JSON-RPC 2.0. `MemoryProvider` is in-process. The UI's provider selector sets the default scheme for bulk tree-loading operations.

3. **Wire format.** JSON-RPC 2.0 on the existing WebSocket, discriminated by `"jsonrpc"` field. Go relay gains `fs/readFile`, `fs/writeFile`, `fs/applyEdits`, `fs/listDirectory`, `fs/stat` handlers with `--root` path sandboxing and `--writable` opt-in.

4. **Editing pipeline.** `slotToPos` (interleaved `[line, rawCol, slotCol]` per buffer slot) built in `buildBatchBuffers` same pass. `CodeGrid.getTextPosition(slotIndex)` for inverse mapping. Cursor as separate `THREE.Mesh` child. `EditorInputManager` captures keystrokes, generates LSP `TextEdit`s, applies optimistically to in-memory text, sends to provider, reconciles on response. `requestAnimationFrame` debouncing from day one.

5. **Edit flow for local FS.** Keystroke -> `EditorInputManager._applyEdit()` -> update `grid.content` in-memory -> schedule re-render via `requestAnimationFrame` -> send `provider.applyEdits(grid.uri, edits)` via JSON-RPC -> relay writes to disk, returns `FileContent` -> if content matches local state, no-op; if different, re-render from authoritative content. `onDidChange` notifications from relay handle external modifications.

6. **Deferred to Phase 2.** Undo/redo stack (`EditHistory`), multi-cursor/selection, incremental buffer updates (shift-based slot insertion), branch disambiguation in URIs.

## Dissent

### `rawCol` should remain `rawCol`, not `charIndex` or `sourceCol`
Integration suggested `charIndex` (round1, recommendation 8). Protocol suggested it is ambiguous (round1, recommendation 3 suggests `slotCol` for what I called `visCol`). I maintain `rawCol` is the correct name for the second field in `slotToPos` because it directly maps to `Position.character` in LSP, which is universally called "character" or "column." The word "raw" distinguishes it from `slotCol` (buffer-slot column). `charIndex` suggests an absolute offset into the full source string, which is a different value. If forced to rename, `sourceCol` is acceptable but adds no clarity over `rawCol`. This is a naming preference, not a functional disagreement — the semantics are agreed.

### Incremental buffer updates should not be deferred to Phase 2
Protocol (round1, recommendation 9) and my Phase 0 (section 6) both note that full re-render per keystroke is acceptable at <15ms. But the real bottleneck I identified is the worker message round-trip, not computation. With `requestAnimationFrame` debouncing, this works for normal typing. However, for operations like paste (potentially thousands of characters) or find-and-replace (many edits across the file), a full re-render per operation is the only option if we defer incremental updates. This is fine for Phase 1 — but the `slotToPos` data structure should be designed now to support future incremental updates (offset-shifting for slots after the edit point). The current interleaved `Int32Array` design supports this: shifting `slotToPos` entries after an edit is a single `copyWithin` call plus updating the affected entries.
