# Round 1: editing reviews foundation, rendering

## Errors Found

### Foundation

1. **Version numbers deferred is wrong.** Foundation (line 19): "Versions exist for write conflict detection. Read-only has no conflicts. Deferred to Tier 2." My editing document (section 4) explicitly requires versions in Tier 1 for stale-version detection on `fs/didChange` and cache validation. Foundation is correct that read-only has no write conflicts, but versions also prevent stale-reload bugs -- e.g., relay sends `fs/didChange`, viewer compares version to decide whether to re-read. Without versions from day one, every didChange triggers a full re-read. This is a wasted round-trip that scales with file count. Versions should ship in `FileStat`/`FileContent` in Tier 1 at near-zero cost (one integer field).

2. **`filterCodeFiles` delegation is fragile.** Foundation (line 124): "delegates to `RepositoryAdapter.prototype.filterCodeFiles` (imported, not duplicated)." Importing a method from a GitHub-specific adapter into a local filesystem provider creates a dependency on a class whose constructor expects GitHub API options. If someone refactors RepositoryAdapter's filter logic (e.g., making it instance-method-dependent), RemoteFileSystemProvider silently breaks. The filter logic should be extracted to a shared utility function in `types.js` or a separate `fileFilters.js`.

### Rendering

3. **Wrong line numbers cited.** Rendering section 5 (line 260+) says `_textToGlyphs` is at "Line 1150" and the `charCodeAt` there needs fixing. Actual: `_textToGlyphs` starts at line 1119. The `charCodeAt` is at line 1150 (`char.charCodeAt(0)`), but this is NOT iterating by code-unit index -- it's iterating by `text[i]` string indexing (line 1135: `const char = text[i]`). The `text[i]` approach already handles BMP characters correctly since `text[i]` returns a single UTF-16 code unit, but it will split surrogate pairs the same way `charCodeAt` does. The rendering doc correctly identifies the bug but mislabels the mechanism. The fix here is `for...of` or grapheme iteration on `text`, not just replacing `charCodeAt`.

4. **`countGlyphs` whitespace check is incomplete.** Rendering section 4 (line 233): `if (g !== ' ' && g !== '\n' && g !== '\r' && g !== '\t') count++`. The actual builder (line 1362 of GlyphRenderer.js, line 97 of builders/index.js) also skips any char with code <= 32. The proposed grapheme version only checks four specific whitespace characters, missing control characters 0-8, 11-12, 14-31. This will cause buffer overflows: allocated slots < actual glyphs rendered.

5. **`getLine` off-by-one on trailing newline.** Rendering section 6, `StringBuffer.getLine()` (line 300): `const end = n + 1 < offsets.length ? offsets[n + 1] - 1 : this._text.length`. The `-1` assumes every line boundary is `\n`, but the last line has no trailing newline. For a text `"abc\ndef"`, line 1 would correctly be `"def"` (end = text.length = 7, start = 4). But for `"abc\ndef\n"`, the third "line" (empty, after trailing newline) would get start=8, end=8, yielding `""` -- correct. However, for `"abc\r\ndef"` with CRLF, the `-1` strips only `\n` not `\r`, yielding `"abc\r"` for line 0. The implementation assumes LF-only line endings. This should be documented or handled.

## Gaps

### Foundation covers, others miss
- **Security model**: symlink escape prevention via `EvalSymlinks` + prefix check, file size caps, directory entry caps. Neither editing nor rendering addresses relay-side security at all.
- **Routing discrimination**: the `"jsonrpc"` field approach to multiplex FS traffic and command traffic on one WebSocket. Editing assumes the transport works but never specifies how.

### Rendering covers, Foundation misses
- **Worker serialization of grapheme map**: the `graphemeToId` map must be serialized alongside `uvMap` with the same versioning. Foundation's plan adds no worker-related changes despite the rendering pipeline running in workers.
- **Atlas regrow for synthetic IDs**: IDs above 0x110000 will trigger DataTexture regrow. Foundation's plan doesn't mention atlas impacts.

### Editing covers, both miss
- **Offline mode and reconnect strategy**: three consecutive failures trigger offline mode, reconnect uses `writeFile` for full content sync. Foundation only handles individual request timeouts. Rendering doesn't address network concerns.
- **Coalescing timer mechanics**: the `setTimeout`/reset pattern for grouping keystrokes into undo units. Neither Foundation nor Rendering touches undo semantics.

### Nobody covers
- **How `loadTextAsync` sets `this.content` but not `this.lines`** (CodeGrid.js line 123-125). The rendering doc's `StringBuffer` migration claims `loadTextAsync` gets "same buffer creation" as `loadText`, but `loadTextAsync` deliberately delays `lines` population. The migration must preserve this lazy behavior or risk materializing lines for large files that never call `getLineCount()`.

## Tensions

1. **Version numbers: Tier 1 vs Tier 2.** Foundation says defer. Editing says Tier 1. Editing is correct -- adding `version: number` to `FileStat` and `FileContent` is one integer field on two type definitions and a monotonic counter in the Go handler. The cost is near-zero. The benefit is that `fs/didChange` can include a version, and the client can skip re-reads when versions match. Deferring creates a breaking change to the wire protocol later.

2. **StringBuffer: who builds it.** Rendering puts `StringBuffer.js` in `src/collections/` and wires it into CodeGrid as a Phase 0 deliverable. Editing defines the `TextBuffer` interface and says `StringBuffer` is Tier 2. Rendering is correct to ship the read-only shell now -- it's 30 lines and eliminates the dual `this.content`/`this.lines` state. Editing should note that the read-only `StringBuffer` already exists when it arrives to add `applyEdits()`.

3. **CodeGrid.uri: who adds it.** Foundation adds `this.uri = null` (2 lines). Rendering's CodeGrid migration doesn't mention `uri`. No conflict, but both plans modify CodeGrid.js independently. Implementation order matters: Foundation's uri addition must land before or alongside Rendering's `_buffer` migration to avoid merge conflicts.

4. **`charCodeAt` fix: in scope or separate PR.** Foundation (line 292) explicitly says "charCodeAt fix (real bug, separate PR)." Rendering makes it the centerpiece. Both are internally consistent, but they can't both be right about scope. Rendering is correct that the fix belongs in the same body of work as StringBuffer/grapheme awareness -- splitting them means StringBuffer counts lines by code-units while the builder counts by graphemes, creating a mismatch.

## Recommendations

1. **Add `version` to `FileStat` and `FileContent` in Foundation's Tier 1.** One integer field. Zero-cost. Prevents wire protocol breaking change.
2. **Extract file-filter logic from RepositoryAdapter into a shared utility** instead of having RemoteFileSystemProvider reach into RepositoryAdapter's prototype.
3. **Fix `countGlyphs` whitespace check** to use `codePoint <= 32` (or equivalent grapheme predicate) rather than four named characters, matching the existing builder behavior.
4. **Handle CRLF in StringBuffer.getLine()** -- either normalize on construction (`text.replace(/\r\n/g, '\n')`) or adjust the line extraction logic. Code files from Windows repos will have `\r\n`.
5. **Preserve loadTextAsync's lazy `lines` behavior** in the StringBuffer migration. `StringBuffer` already does lazy `_lineOffsets`; just ensure CodeGrid doesn't eagerly call `getLines()` on the async path.
6. **Merge the charCodeAt fix and StringBuffer into one implementation unit.** They share the same invariant: "what is a character?" Splitting them creates a window where line counts disagree between buffer and builder.
7. **Coordinate CodeGrid.js modifications** across Foundation (uri) and Rendering (buffer) to avoid merge conflicts. Apply both in the same commit or sequential commits on the same branch.
8. **Add `graphemeToId` serialization to Foundation's WebSocketBridge plan.** The bridge modifications for `rpcRequest()` are in Foundation's scope; worker map serialization is in Rendering's scope. Both touch WebSocketBridge/WorkerBridge -- clarify ownership.
9. **Document the LF-only assumption** in StringBuffer if CRLF normalization is not added. The builder already strips `\r` (charCode 13 is skipped), so the rendering is correct, but `StringBuffer.getLine()` returning `"line\r"` will cause subtle bugs in edit position calculations.
10. **Cap the synthetic ID DataTexture regrow.** Rendering proposes IDs starting at 0x110000. A malicious or emoji-heavy file could allocate thousands of synthetic IDs. The DataTexture should have a ceiling (e.g., 0x120000 = 65536 extra slots) with a warning when approaching it.

## Key Insight

The three plans share a hidden dependency on the definition of "character" that none of them fully reconciles. Foundation defines wire types using `content: string` and defers character semantics. Rendering fixes the builder to use grapheme clusters but introduces StringBuffer with code-unit-based `getLine()`. Editing defines `Position.character` as "UTF-16 code unit offset" (LSP convention) while assuming the builder will count graphemes. This triple mismatch -- wire protocol (opaque string), buffer (code units), builder (graphemes) -- must be resolved before any of the three plans can be implemented independently, because `highlightRange(line, col)` crosses all three boundaries and the meaning of `col` must be consistent everywhere. The safest resolution: `Position.character` means grapheme index (not UTF-16 offset), StringBuffer normalizes to LF and indexes by grapheme, and the builder counts graphemes. This diverges from LSP convention but matches user intent (one arrow press = one grapheme) and avoids the UTF-16 code unit mess that plagues every editor that adopted it.
