# Round 1: rendering reviews foundation, editing

## Errors Found

### Foundation: syntheticId range will break the atlas map DataTexture

Rendering's plan (Section 3) assigns synthetic IDs starting at `0x110000` (1,114,112) for multi-codepoint graphemes. The atlas map DataTexture uses the codepoint as a flat index: `base = charCode * 4` into a Float32Array (`GlyphAtlas.js` line 560). At `0x110000`, the texture would need at minimum `ceil(1114113 / 1024) = 1089` rows at 1024 width = 4,456,448 texels = ~17 MB of Float32Array -- the exact bloat the memory optimization work eliminated (the comment at line 360-362 explicitly says the old full-Unicode map was 17.8 MB). `_regrowAtlasMap` will dutifully allocate this. The plan says "the regrow mechanism already exists" as if that makes it free. It does not. The synthetic range must start dense, not sparse. Use a compact secondary lookup (e.g., a separate small DataTexture or a hash-to-dense-index map) for multi-codepoint graphemes, or start synthetic IDs at `max(existingKeys) + 1` and keep them contiguous.

### Foundation: `CodeGrid.uri` field does nothing without consumers

Foundation adds `this.uri = null` to CodeGrid (item 9, "2 lines"). But nothing in the Tier 1 plan reads `uri`. It is not used for provider routing, not for state persistence lookup, not for `fs/didChange` dispatch. The justification is "so Tier 2 can route edits without a breaking migration," but adding a field that nobody reads is not a migration concern -- adding it later is a one-line non-breaking change too. This is dead code in a plan that otherwise prides itself on scope discipline.

### Editing: `Position.character` as UTF-16 code units contradicts grapheme-cluster rendering

The editing plan's type definitions (Appendix, line 349-350) define `Position.character` as "UTF-16 code unit offset into the source line (LSP convention)." But the rendering plan rewrites the entire builder pipeline to iterate grapheme clusters and produce `lineSlotOffsets` indexed by grapheme position. `getSlotForChar(line, col)` returns `_lineSlotBase[line] + col` (CodeGrid.js line 571), where `col` is now a grapheme index. If `Position.character` is a UTF-16 offset and `col` is a grapheme index, `applyEdits` positions and `highlightRange` positions are in different coordinate spaces. One of these must yield: either positions are grapheme-based (breaking LSP compat) or the slot system needs a UTF-16-to-grapheme translation layer. Neither plan addresses this.

### Editing: `applyEdits` sorts edits but uses wrong variable name

Section 2's algorithm references `sorted[i-1]` and `sorted[i]` in the overlap validation loop, but the loop starts at `i in 1..sorted.length`. The last element is `sorted[sorted.length - 1]`. If `sorted.length` is exclusive (as in JS `for (let i = 1; i < sorted.length; i++)`), this is fine. But the pseudocode says `1..sorted.length` without specifying inclusive/exclusive -- ambiguous for an implementation contract.

### Foundation: `RemoteFileSystemProvider.filterCodeFiles` delegation is fragile

The plan says `filterCodeFiles` "delegates to `RepositoryAdapter.prototype.filterCodeFiles` (imported, not duplicated)." Calling a prototype method from another class's instance requires `RepositoryAdapter.prototype.filterCodeFiles.call(this, tree, options)` or extracting it as a standalone function. The plan does not acknowledge this and implies a simple delegation that would not work as written.

## Gaps

### Foundation missed: no error code mapping for the JS side

`cli/fs.go` defines error codes (-32001 through -32003) and `types.js` defines `FileSystemError` with factory methods, but there is no code showing how `RemoteFileSystemProvider` maps a JSON-RPC error response `{ code: -32001 }` to `FileSystemError.FileNotFound(uri)`. The mapping logic is absent from the plan.

### Rendering missed: `textToGlyphs.js` also uses `charCodeAt`

The rendering plan lists changes to `builders/index.js` and `GlyphRenderer.js` but omits `src/workers/builders/textToGlyphs.js` line 44 (`const charCode = char.charCodeAt(0)`). This is a fourth `charCodeAt` site in the builder pipeline. The file change summary (Section 9) does not mention it.

### Editing missed: no specification of how `EditorInputManager` generates `TextEdit` objects

The editing plan defines `TextEdit`, `EditBatch`, and the `applyEdits` algorithm in detail, but `EditorInputManager` is listed as "Built in Tier 2" with zero specification of how keystrokes become `TextEdit` objects. This is the most complex piece -- keyboard event -> cursor position -> range computation -> edit generation -- and it has no contract.

### Foundation missed: WebSocket reconnection during `rpcRequest`

`rpcRequest` uses a pending-promise map with timeouts. If the WebSocket drops mid-request, pending promises will hang until timeout. The plan mentions no `onclose` cleanup (rejecting all pending promises). The editing plan covers reconnection for edit persistence but Foundation does not cover it for read-only requests.

## Tensions

### StringBuffer ownership: rendering vs. editing

Rendering (Section 6) defines `StringBuffer` as a new file at `src/collections/StringBuffer.js` -- a read-only flat-string wrapper with lazy line offsets, ~30 lines, no `applyEdits`. Editing (Section 8, N->N+1 boundary) says `StringBuffer` "implements TextBuffer interface" including `applyEdits(edits) -> ApplyResult`.

**Resolution**: Rendering is correct for Phase 0. The read-only `StringBuffer` ships first. Editing extends it later. But they must agree on the file path and constructor signature now, or the Tier 2 edit will be a rewrite, not an extension. Rendering's placement in `src/collections/` is reasonable since `CodeGrid` lives there. Editing should confirm this path.

### Version numbers: Foundation says "deferred to Tier 2," Editing says "Tier 1 addition"

Foundation (Section "What Is NOT In This Plan") explicitly defers version numbers. Editing (Section 4) says "Version numbers are a Tier 1 addition to FileContent and FileStat. They travel on the wire from day one." These directly contradict. **Foundation is correct for scope**: versions serve no purpose in read-only mode where there are no write conflicts. Adding them to the wire protocol costs nothing, but asserting they are "Tier 1" when Tier 1 is read-only is misleading. Ship the field as `0` from the Go relay from day one, but do not build version-comparison logic until Tier 2.

### charCodeAt fix: Foundation says "separate PR," Rendering says "Phase 0"

Foundation (last paragraph of "What Is NOT In This Plan") says the `charCodeAt` fix is a "real bug, separate PR." Rendering's entire plan IS the `charCodeAt` fix. **Both are right in different ways**: the grapheme fix is orthogonal to the filesystem provider. They can land independently. But they share `CodeGrid.js` and `builders/index.js` modifications (StringBuffer integration vs. grapheme iteration). Whoever lands second will need to rebase.

## Recommendations

1. **Use a compact secondary map for synthetic IDs**, not sparse indices at `0x110000`. A `Map<number, {u0,v0,u1,v1}>` sampled via a uniform array or a small dense DataTexture avoids the 17 MB regression.
2. **Resolve the Position coordinate space conflict** between editing (UTF-16 code units) and rendering (grapheme indices) before either ships. Recommend: internal slot addressing uses grapheme indices; a `utf16ToGrapheme(line, utf16Col)` adapter converts LSP positions at the API boundary.
3. **Add `textToGlyphs.js` to the rendering file change list** -- it has a `charCodeAt` at line 44 that will produce surrogate halves.
4. **Add `onclose` cleanup to `rpcRequest`** in the Foundation plan: reject all pending promises with a connection-closed error on WebSocket close.
5. **Extract `filterCodeFiles` logic into a standalone utility function** importable by both `RepositoryAdapter` and `RemoteFileSystemProvider`, rather than prototype-method delegation.
6. **Drop `CodeGrid.uri` from Tier 1** -- add it when a consumer exists. The plan's own "scope discipline" standard argues against it.
7. **Coordinate `StringBuffer` file path and constructor signature** across rendering and editing plans before implementation to avoid a rewrite.
8. **Ship version as `0` from Go relay in Tier 1** but defer all version-comparison logic to Tier 2. This resolves the Foundation/Editing tension.
9. **Specify error-code-to-FileSystemError mapping** in `RemoteFileSystemProvider`: a `switch` on `error.code` that calls the appropriate factory method.
10. **Add `EditorInputManager` contract** to the editing plan -- at minimum, the method signature that converts a `KeyboardEvent` + cursor state into `TextEdit[]`.

## Key Insight

The three plans are well-scoped individually but share a critical unresolved boundary: the coordinate space for character positions. Rendering is moving to grapheme-cluster indexing (one slot per visual cluster), editing adopts UTF-16 code unit offsets (LSP convention), and the existing codebase uses raw `charCodeAt` indices (UTF-16 code units that happen to equal byte offsets for ASCII). All three systems meet at `getSlotForChar(line, col)` and `highlightRange(startLine, startCol, ...)`, which today assume `col` is a visible-character index derived from `charCodeAt` iteration. If rendering ships grapheme-based slots and editing ships UTF-16-based positions without an explicit translation layer, highlight and cursor placement will silently break on any line containing a non-BMP character -- the exact class of bug the rendering plan exists to fix. This coordinate-space reconciliation must be designed before either plan lands, not after.
