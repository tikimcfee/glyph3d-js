# Round 1: foundation reviews rendering, editing

## Errors Found

### Rendering (phase0-rendering.md)

1. **Line 64, charCodeAt sites in GlyphRenderer.js**: Rendering claims three sites at "Line 1100", "Line 1150", "Line 1360". The actual lines are correct (1100, 1150, 1360), but line 1150 uses `char.charCodeAt(0)` on an already-split single character from `text.split('')`, not from raw index iteration. The fix shown (iterateGraphemes on `item.text`) would work for _ensureGlyphsInAtlas (line 1100), but the _textToGlyphs sync path (line 1150) iterates characters produced by `text.split('')`, which also breaks on surrogates. The fix there needs to replace the `split('')` call upstream, not just the charCodeAt line. The document does not mention this split.

2. **Line 226, graphemeToId in builder loop**: The plan says builders look up `graphemeToId[grapheme]` using bracket notation. `graphemeToId` is described as a Map in section 3. Map access is `.get(key)`, not bracket notation. This is a typo but the kind that ships as a bug.

3. **Line 97 vs line 27**: The document identifies lines 97 and 322 in `builders/index.js` but misses line 27 (`const c = text.charCodeAt(i)` in `countGlyphs`). The new `countGlyphs` in section 4 replaces it conceptually, but the document does not acknowledge that the existing line 27 must also be removed/replaced. A stale charCodeAt at line 27 would silently undercount glyphs for emoji text.

4. **Line 382, textToGlyphs.js omission**: `src/workers/builders/textToGlyphs.js` line 44 also uses `charCodeAt(0)` on a `split('')` result, identical to the GlyphRenderer sync path issue. This file is not listed in the "9 files total" summary (section 9). It will remain broken after the fix.

5. **Section 3, synthetic IDs above 0x110000**: The DataTexture is described as needing extension to "cover the synthetic range." The current atlas map texture is a 1024-wide float RGBA texture indexed by codepoint. Codepoints up to ~0x110000 require ~69,632 rows (1,114,112 / 16 entries per row). That is a 1024x69632 DataTexture -- likely exceeding GPU `MAX_TEXTURE_SIZE` on most hardware (typically 4096 or 16384). The document says "_regrowAtlasMap already exists" but does not address whether the regrow logic checks hardware limits or whether synthetic IDs will collide with this ceiling. In practice, only a handful of synthetic IDs would be allocated, so the real question is how the DataTexture maps sparse IDs -- if it is dense (index = codepoint), any ID above 0x110000 forces a massive texture. If it is sparse, the document does not describe the indirection.

### Editing (phase0-editing.md)

6. **Section 1, line 35**: "Send the full content via writeFile (not incremental edits, since the version has drifted)" after three consecutive failures. But writeFile is a Tier 1 concept (`fs/writeFile`) that the foundation plan explicitly defers. The editing document's error recovery depends on a method that does not exist in its own tier. This creates a circular dependency: editing (Tier 2) error recovery requires writeFile, but writeFile is listed as deferred from Tier 1.

7. **Section 4, line 118**: "Version numbers are a Tier 1 addition to FileContent and FileStat." But the foundation plan (my own document) explicitly says "Version numbers in FileStat? No. Versions exist for write conflict detection. Read-only has no conflicts. Deferred to Tier 2." These documents contradict each other on when versions ship.

8. **Appendix, line 350**: Position character is defined as "UTF-16 code unit offset into the source line (LSP convention)." But the rendering plan is simultaneously converting the entire pipeline to grapheme clusters. After that conversion, `lineSlotOffsets` count grapheme clusters, `getSlotForChar` takes grapheme indices, and highlight columns are grapheme-based. An editing pipeline that sends UTF-16 code unit positions to a renderer that expects grapheme indices will highlight the wrong columns. The two plans define "character" differently and neither addresses the mismatch.

## Gaps

### What rendering covers that foundation and editing miss

- **Atlas DataTexture regrow mechanics** for non-BMP characters. Foundation and editing assume the atlas "just works" with new codepoints.
- **Worker serialization of the graphemeToId map** -- a real transport concern that foundation's WebSocketBridge RPC additions do not account for (the bridge may need to send atlas updates alongside RPC responses).
- **Intl.Segmenter fallback** in workers. Foundation assumes workers process text opaquely; rendering specifies the exact API boundary.

### What editing covers that others miss

- **Offline mode and reconnection** strategy. Foundation's relay design has no reconnect protocol.
- **Undo coalescing timer mechanics** -- concrete algorithm with boundary conditions.
- **Error taxonomy** (network vs permission vs version conflict) with distinct recovery paths.

### What foundation covers that others miss

- **Symlink escape security** (EvalSymlinks + prefix check). Neither other document addresses relay security.
- **50k entry cap and 5MB file cap** -- concrete relay safety limits.
- **StatePersistence source-mode awareness** -- prevents restoring a local session as GitHub or vice versa.

## Tensions

1. **Version numbers: Tier 1 or Tier 2?** Foundation says Tier 2. Editing says Tier 1. **Foundation is correct for the read-only scope.** Versions are meaningless without a writer. However, editing is correct that adding the field shape early (as a nullable/optional field in `FileContent`) is cheap and avoids a breaking migration. Resolution: add `version` as an optional field in `types.js` (value: null for GitHub provider, monotonic integer for remote), but do not implement conflict detection until Tier 2.

2. **Position semantics: UTF-16 code units vs grapheme clusters.** Editing follows LSP convention (UTF-16). Rendering is converting to grapheme clusters. **Neither is wrong in isolation, but they are incompatible as stated.** Resolution: the buffer layer (StringBuffer/TextBuffer) should use UTF-16 positions (LSP compat), and a translation layer converts to grapheme slot indices when talking to the renderer. This translation belongs in CodeGrid.applyEdits, not in StringBuffer or the builder.

3. **StringBuffer ownership.** Rendering's section 6 introduces StringBuffer as a read-only buffer in its scope. Editing's section 8 says StringBuffer is "Built in Tier 2 (editing pipeline)." **Rendering is correct to ship StringBuffer read-only in its phase**, since CodeGrid already maintains content/lines state that StringBuffer cleanly encapsulates. Editing should treat StringBuffer as pre-existing and add `applyEdits()` to it in Tier 2.

4. **charCodeAt fix scope.** Foundation explicitly defers charCodeAt to a "separate PR" (line 292). Rendering claims charCodeAt as its core scope. **Rendering is correct that it belongs with the grapheme work.** Foundation should remove the "separate PR" language and acknowledge rendering owns this fix.

## Recommendations

1. **Rendering must add `textToGlyphs.js` to its file list** and fix the `text.split('')` upstream of the charCodeAt at line 44. Currently a gap.

2. **Rendering must add `builders/index.js` line 27** (`countGlyphs`) to its change list. The conceptual replacement exists but is not explicitly mapped to the existing code.

3. **Rendering must address the atlas DataTexture sizing** for synthetic IDs. Either confirm the texture uses sparse/indirect lookup, or cap synthetic IDs to a range that fits within hardware texture limits (e.g., allocate from 0xF0000 in the Private Use Area instead of 0x110000).

4. **Add `version` as an optional nullable field in `types.js`** now (foundation scope). Do not implement conflict detection. This satisfies editing's wire-format need without foundation taking on conflict logic.

5. **Define a position translation interface** between UTF-16 (buffer/LSP) and grapheme-slot (renderer). This is a 3-line function in CodeGrid but must be agreed upon before both plans are implemented, or highlighting will break under editing.

6. **Editing should drop the `writeFile` reconnection path** from Tier 2 scope, or explicitly add `fs/writeFile` to Tier 2 deliverables. The current plan references a method that no tier commits to building.

7. **Rendering's `iterateGraphemes` generator** should be benchmarked against `segmentGraphemes` array form in the builder hot path. The document assumes the generator avoids allocation, but V8 generator overhead can exceed array allocation cost for short strings (typical source lines are 40-80 chars). Measure before committing to the generator form in the inner loop.

8. **Foundation and editing should agree on relay error codes.** Foundation defines -32001/-32002/-32003. Editing adds -32007. These should be co-located in `types.js` or a shared constants file, not scattered across documents.

9. **Rendering should test the `Intl.Segmenter` worker path** explicitly on Safari, which has historically had `Intl` quirks in dedicated workers. The document asserts it works but cites no verification.

10. **Foundation's `RemoteFileSystemProvider.filterCodeFiles`** delegates to `RepositoryAdapter.prototype.filterCodeFiles` via import. This couples the local provider to the GitHub adapter. Extract the blacklist logic into a shared utility function in `src/services/data/` instead.

## Key Insight

The three plans are independently sound but define "character" in three different ways: foundation treats it as opaque file content (bytes), rendering is converting to grapheme clusters (visual units), and editing defines it as UTF-16 code units (LSP convention). This semantic divergence is invisible within any single document but will produce column-alignment bugs the moment two of these systems interact -- specifically when editing sends a UTF-16-indexed TextEdit to a renderer that maps buffer slots by grapheme cluster count. The fix is small (a translation function in CodeGrid), but it must be designed now, before implementation, because retrofitting position semantics across three layers after the fact is the kind of bug that hides for months and corrupts every highlight, every cursor position, and every picking result on any line containing non-ASCII text.
