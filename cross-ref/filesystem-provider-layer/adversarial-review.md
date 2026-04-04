# Adversarial Review: FileSystem Provider Layer

Reviewer role: find flaws, break assumptions, challenge scope. No loyalty to the plan.

---

## 1. The UTF-16 / Grapheme Cluster Problem Is Deeper Than You Think

The plan treats this as a future concern. It is a present structural defect that the TextBuffer abstraction will inherit and calcify.

### 1.1 The builder is broken for supplementary plane characters today

`buildBatchBuffers` (src/workers/builders/index.js, line 322) uses `text.charCodeAt(i)` and advances `i` by 1 on every iteration. For any character above U+FFFF (emoji, mathematical symbols, CJK Extension B, musical symbols), `charCodeAt` returns a surrogate half (a meaningless value between 0xD800-0xDFFF). The builder will:

1. Emit **two** buffer slots for one visual glyph (one for the high surrogate, one for the low surrogate)
2. Look up both surrogates in `uvMap`, find neither, fall back to '?' **twice**
3. Produce **two** '?' glyphs side-by-side instead of one replacement character

This means `lineSlotOffsets` is wrong (it counts surrogate halves as separate characters), `slotToPos` mapping would be wrong, `getVisibleCharCount` (CodeGrid.js, line 583) is wrong, and `highlightRange` (line 600) will highlight the wrong columns for any line containing supplementary plane characters.

The codebase **already knows this**. `TerminalCapture.js` (line 247-257) uses `codePointAt()` and advances by 2 for supplementary plane characters. The builder does not. This inconsistency means the same text renders differently depending on whether it enters through the terminal path or the file path.

### 1.2 TextBuffer inherits the confusion

The proposed `StringBuffer._positionToOffset` (boundaries-synthesis.md, line 184-192) scans by `charCodeAt(offset)` looking for newlines (code 10), which is fine. But `pos.character` is added directly as a byte offset (line 192: `return offset + pos.character`). This assumes `Position.character` is a UTF-16 code unit offset, matching LSP spec. But:

- The **builder** counts characters via `charCodeAt(i++)`, which splits surrogates into two "characters"
- The **TextBuffer** adds `pos.character` as a direct string index offset, which is also UTF-16 code units
- But `slotToPos.rawCol` is described as "0-based character offset within line" -- is this UTF-16 units? Visual characters? Grapheme clusters?

The plan never resolves this. The word "character" is used with at least three different meanings across the documents and there is no explicit statement of which coordinate space TextBuffer operates in.

### 1.3 The atlas already handles supplementary plane correctly

`GlyphAtlas._packGlyph` (GlyphAtlas.js, line 196) uses `String.fromCodePoint(charCode)`, which correctly handles supplementary plane characters. The atlas can store emoji. The builder cannot emit them. The atlas can render them. The file path cannot reach them.

### 1.4 ZWJ sequences, joiners, and ligatures are not addressed at all

The plan does not mention Intl.Segmenter (available in all major browsers since 2022). A ZWJ family emoji like U+1F468 ZWJ U+1F469 ZWJ U+1F467 ZWJ U+1F466 is 7 codepoints (25 UTF-16 code units with ZWJs) but 1 grapheme cluster. Canvas 2D `fillText` renders it as one glyph. `measureText` returns one width. But the builder would emit 11 buffer slots (7 codepoints, some of which are surrogate pairs generating 2 charCodeAt values each, minus any that are ZWJ U+200D which is BMP so 1 each).

**Verdict**: The TextBuffer abstraction will paper over this problem in the text storage layer while leaving the rendering pipeline broken. The plan should either (a) fix the builder to iterate by codepoint before building TextBuffer, or (b) explicitly declare "supplementary plane and multi-codepoint graphemes are out of scope for Phase 1" with a tracked issue. Silence is the worst option because it creates a bug that only manifests on specific content.

---

## 2. Over-Engineering

### 2.1 The 5-phase evolution path is fantasy architecture

Phase 3 (tree-sitter), Phase 4 (PieceTableBuffer), Phase 5 (CRDTBuffer via Yjs/Loro). The plan budgets `treeSitterDescs` output in `StringBuffer.applyEdits()` (boundaries-synthesis.md, line 155-159) "at zero cost." It is not zero cost. It calls `new TextEncoder().encode()` **twice per edit** to compute byte offsets. TextEncoder allocates a new Uint8Array on every call. For a coalescing group of 10 single-character edits within 300ms, that is 20 TextEncoder allocations on the hot typing path.

More importantly: Phase 4 and 5 require a fundamentally different rendering strategy (partial buffer updates, not full re-render). The `getText()` materialization boundary (boundaries-synthesis.md, line 42-48) that makes Phase 1 clean is exactly what makes Phase 4 expensive -- materializing a piece table into a flat string defeats the purpose of having a piece table. The evolution path as described requires rewriting the worker pipeline, not just swapping the buffer.

### 2.2 EditHistory cursor tracking (consolidated-plan.md, line 106-109)

`cursorBefore` and `cursorAfter` in `EditEntry`. There is no cursor in the current system. There is no text input system. There is no selection model. Designing cursor persistence into the undo data structure before any of those systems exist is premature. If the cursor model turns out to be multi-cursor (which the research document explicitly discusses), the `Position` type is wrong -- it should be `Position[]`.

### 2.3 `fs/capabilities` notification (consolidated-plan.md, line 132)

A capabilities notification for a system with exactly 3 providers whose capabilities are known at compile time. The browser knows what capabilities `GitHubProvider` has because it imported `GitHubProvider`. This is LSP-brain: useful when you have N unknown servers, not when you have 3 hardcoded classes.

### 2.4 Version conflict detection (consolidated-plan.md, line 74)

`baseVersion` conflict detection with `-32007 VersionConflict` error. In a system where there is exactly **one** editor (the browser tab) and exactly one filesystem server (the Go relay). Who is producing the conflicting edit? The `fsnotify` external change path, which triggers a full reload anyway (line 126). The conflict detection machinery is solving a multi-editor problem that does not exist. A simple "if mtime changed since last read, warn before overwriting" check would suffice.

---

## 3. Under-Engineering

### 3.1 No error recovery for the dual-write path

consolidated-plan.md, line 88-95: The dual-write sequence is optimistic-apply, then async persist. What happens when step 4 (`provider.applyEdits`) fails? The plan says nothing. The in-memory state has already diverged from disk. Options:

- Roll back the optimistic apply using the client-side inverse? Not mentioned.
- Leave the in-memory state dirty and mark it? Not mentioned.
- Retry? Not mentioned.

This is the most dangerous gap in the entire plan. Network flakiness, Go relay crash, disk full -- any of these leaves the in-memory document out of sync with the filesystem with no recovery mechanism.

### 3.2 No batching for `fs/readFile`

The `RepositoryAdapter` currently has `getMultipleFiles` (line 287) that parallelizes fetches. The new provider interface has `readFile(uri)` -- singular. Loading a repository with 500 files will issue 500 individual JSON-RPC requests. The plan has `fs/listTree` for directory listing but no `fs/readFiles` batch method. At minimum, `listTree` should return file contents inline for small files (< 10KB), or there should be a batch read method.

### 3.3 No backpressure on `fs/didChange`

If the user runs `find . -exec touch {} \;` in a watched directory, `fsnotify` will fire thousands of events. The plan says "debounce" but does not specify where or how. The Go relay could flood the WebSocket with `fs/didChange` notifications faster than the browser can process them (each one potentially triggering a CodeGrid re-render).

### 3.4 StringBuffer.applyEdits sorts but does not validate ranges

boundaries-synthesis.md, line 124-168: Edits are sorted bottom-to-top and applied sequentially. But there is no check for overlapping ranges. If two edits overlap, the second edit's offsets are computed against the **original** text (since they reference "document state BEFORE any edit" per line 123), but the text has already been mutated by the first edit. The `_positionToOffset` call on line 136 operates on the mutated `text` variable, not the original. This is a bug: the plan says positions reference pre-edit state, but the implementation applies them against progressively mutated text.

---

## 4. Complexity Budget

8 new files + 13 modified files = 21 file touches for Tier 1 (read-only). This is a lot of surface area for "files can come from disk instead of GitHub."

### What you actually need for read-only local files:

1. **1 new file**: `RemoteFileSystemProvider.js` -- JSON-RPC client that speaks `fs/readFile` and `fs/listTree`
2. **1 new file**: `cli/fs.go` -- FS handler in the Go relay
3. **2 modified files**: `relay.go` (route JSON-RPC), `main.go` (add flags)
4. **1 modified file**: `RepositoryAdapter.js` or `GitHubRepoViewer.js` -- swap data source

That is 5 files, not 21. You do not need:

- `FileSystemRegistry.js` -- you have 3 providers, use an if/else
- `types.js` as a separate file -- put the JSDoc typedefs in `RemoteFileSystemProvider.js`
- `MemoryProvider.js` -- demos currently work without it, defer
- `GitHubProvider.js` as a separate class -- the existing `RepositoryAdapter` already IS the GitHub provider; wrapping it in another class adds a layer for no value
- URI scheme parsing -- use string prefixes (`file://`, `github://`) with a 3-line dispatch, not a registry
- `StatePersistence.js` changes -- persist provider choice in localStorage with 2 lines, not a schema change
- `Drawer.js` / `ide.html` / `IDEShell.js` UI changes -- a URL parameter `?source=local` is sufficient for Phase 1

The abstraction is not earning its weight. The provider interface is solving the general case (N providers, dynamic registration, URI-based dispatch) when the specific case (GitHub OR local disk, chosen at startup) needs 20% of the machinery.

---

## 5. The Go Relay as Filesystem Server

### 5.1 Security surface

`--root` sandboxing (consolidated-plan.md, line 130) with `..` traversal rejection. This is necessary but insufficient. Consider:

- **Symlinks**: `/sandboxed/link -> /etc/shadow`. The plan does not mention symlink resolution.
- **Race conditions (TOCTOU)**: Check path, then open file. Between check and open, a symlink could be created. Use `openat2` (Linux) or `O_NOFOLLOW` + `fstatat`.
- **Large file DoS**: No mention of file size limits on `fs/readFile`. A 2GB log file will be read entirely into memory and serialized as a JSON string.

### 5.2 Single goroutine per connection

The current relay (relay.go) handles each WebSocket connection in a single goroutine with a blocking read loop (line 42-159). Adding synchronous filesystem I/O (`os.ReadFile`, `os.ReadDir`) to this goroutine means a slow disk read (NFS, spinning disk, fuse mount) blocks the entire connection, including heartbeats and command relay. File I/O should be dispatched to a separate goroutine with a timeout.

### 5.3 `--writable` is all-or-nothing

The flag enables writes to the entire `--root` tree. There is no path-level write permission. For a code viewer that might also have system config files visible, this is coarse. But this is probably acceptable for Phase 1 -- just noting it.

---

## 6. Xi Editor Warning: Process Separation

The research document (line 277-278) explicitly says: "Don't separate edit engine and renderer into separate processes. The async IPC overhead kills responsiveness for interactive editing."

The plan puts:
- Text storage in the browser (StringBuffer in CodeGrid)
- Persistence in the Go relay (fs/applyEdits over WebSocket)
- Full re-render in web workers (builder pipeline)

This is **not** the Xi mistake. Xi separated the edit engine (core) from the renderer (frontend), making every keystroke require a round-trip before the display updated. Here, the browser holds the authoritative text state and renders optimistically. The Go relay is a persistence backend, not an edit engine. The workers are a compute offload, not a state owner.

**However**, the dual-write path (consolidated-plan.md, line 88-95) introduces a subtle version of the problem: if version conflict detection is taken seriously, the browser must wait for the relay's response (step 5) to confirm the edit succeeded. If it does not wait, the version numbers can drift. If it does wait, you have Xi's latency problem for conflict detection.

The plan says "fire-and-forget" for persistence but also says "compare response.version against expected" in step 5. These are contradictory. Pick one: either persistence is fire-and-forget (accept occasional data loss on crash), or it is confirmed (accept latency). Do not try to be both.

---

## 7. JSON-RPC 2.0 Overhead

Xi's retrospective warns about JSON IPC being "surprisingly problematic." But Xi's problem was Swift's JSON serializer, not JSON itself. In the browser, `JSON.parse`/`JSON.stringify` are native C++ implementations and handle 10MB+ payloads in <5ms.

For typing at 30ms intervals (33 keystrokes/second), the actual JSON payload is tiny:
```json
{"jsonrpc":"2.0","method":"fs/applyEdits","id":1,"params":{"uri":"file:///...","edits":[{"range":{"start":{"line":5,"character":10},"end":{"line":5,"character":10}},"newText":"x"}],"baseVersion":42}}
```
That is ~250 bytes. WebSocket frame overhead is 2-6 bytes. JSON serialization time is <0.1ms. Round-trip on localhost is <1ms. This is not a problem.

The problem would be `fs/readFile` for large files, where the entire file content is base64-encoded (or raw UTF-8) inside a JSON string. A 1MB file becomes a ~1.3MB JSON payload. This is fine for initial load but would be terrible for the full-content-on-every-save path implied by `writeFile`. The plan should specify that saves use `applyEdits` (delta), not `writeFile` (full content), for interactive editing.

---

## 8. What I Would Cut

To ship in half the files (10 instead of 21):

**Keep:**
1. `RemoteFileSystemProvider.js` -- the core new capability
2. `cli/fs.go` -- Go-side FS handler
3. `cli/relay.go` modification -- JSON-RPC routing
4. `cli/main.go` modification -- flags
5. `RepositoryAdapter.js` modification -- accept a mode flag, delegate to remote provider when mode is 'local'
6. `GitHubRepoViewer.js` modification -- provider switching
7. `CodeGrid.js` modification -- `uri` field only (no TextBuffer, no cursor, no position methods)
8. `src/workers/builders/index.js` -- fix `charCodeAt` to `codePointAt` iteration (not in the plan, but should be)

**Cut entirely:**
- `types.js` -- inline JSDoc where used
- `FileSystemRegistry.js` -- 3-way if/else in the viewer
- `GitHubProvider.js` -- RepositoryAdapter already is this
- `MemoryProvider.js` -- defer to when demos actually need it
- `EditorInputManager.js` -- Tier 2, not needed for read-only
- `EditHistory.js` -- Tier 2
- `textEditUtils.js` -- Tier 2
- `Drawer.js` changes -- URL parameter instead
- `IDEShell.js` changes -- minimal, fold into viewer
- `StatePersistence.js` changes -- 2 lines of localStorage
- `ide.html` changes -- defer

**Net: 8 file touches, not 21. Delivers "open local files in the 3D viewer via Go relay." Editing, undo, URI schemes, registries, and provider UI come later, if ever.**

---

## 9. Summary of Critical Issues

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| 1 | Builder uses charCodeAt, breaks on supplementary plane chars | Bug (present today) | builders/index.js:97,322 |
| 2 | StringBuffer.applyEdits applies bottom-to-top against mutating text, contradicting "pre-edit positions" contract | Bug (design) | boundaries-synthesis.md:124-168 |
| 3 | Dual-write has no error recovery path | Gap | consolidated-plan.md:88-95 |
| 4 | Fire-and-forget persistence vs version conflict detection are contradictory | Contradiction | consolidated-plan.md:88-95 |
| 5 | treeSitterDescs allocates TextEncoder on every edit for no current consumer | Waste | boundaries-synthesis.md:155-159 |
| 6 | 21 file touches for read-only file loading is 3-4x over budget | Scope | consolidated-plan.md:157-188 |
| 7 | Symlink traversal not addressed in security model | Security | consolidated-plan.md:130 |
| 8 | No backpressure on fs/didChange notifications | Robustness | consolidated-plan.md:119-126 |
| 9 | No fs/readFile batching for initial repository load | Performance | consolidated-plan.md:21-23 |
| 10 | "character" used with 3+ meanings, never disambiguated | Clarity | Across all docs |
