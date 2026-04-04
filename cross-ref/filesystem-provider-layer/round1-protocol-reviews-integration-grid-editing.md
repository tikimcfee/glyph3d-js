# Round 1: protocol reviews integration, grid-editing

## Errors Found

### integration: Wire format conflict with the relay

The integration analysis proposes a custom `{ cmd: "fs.list", id, path }` envelope (phase0-integration.md lines 100-116) for FS commands on the relay. My protocol analysis specifies JSON-RPC 2.0 with `{ jsonrpc: "2.0", id, method: "fs/readFile", params: {...} }` (phase0-protocol.md lines 117-123). These are mutually exclusive formats. The relay discrimination logic in phase0-protocol.md (lines 395-404) checks for `"jsonrpc"` to distinguish FS traffic from command traffic. The integration agent's `fs.*` commands lack this field and would be parsed as regular display-to-controller messages by the existing relay path (relay.go line 127-138), where they would fail because they contain `cmd` but no `to` field.

**The JSON-RPC format is correct.** It's a standard with defined error handling, notifications, and batching. The custom `{ cmd, id }` format duplicates half of JSON-RPC badly while losing the other half (standard error codes, notification support, batch requests).

### integration: `RepositoryAdapter.provider` method signatures are wrong

The integration analysis (lines 41-48) specifies `listDirectory(path) -> Promise<{tree: [{path, type, size, sha?}]}>` and `readFile(path) -> Promise<{content, encoding, size, path}>`. These use raw path strings, not URIs. My protocol analysis uses `readFile(uri) -> FileContent` with URIs containing scheme and authority (phase0-protocol.md lines 47-48). URI-driven dispatch is essential -- the same `RepositoryAdapter` instance should handle both `github://` and `file://` sources without the caller knowing which is active. The integration approach of swapping `this.repoAdapter.provider` (line 279-296) reintroduces ambient state that URI routing eliminates.

### grid-editing: `_textToGlyphs` line reference is wrong

Phase0-grid-editing.md line 13 cites `_textToGlyphs lines 1139-1145`. The actual file is `src/workers/builders/textToGlyphs.js`, which is 63 lines total. The skip logic is at lines 31-37. The function is also called `textToGlyphs` (no underscore prefix) -- the `_textToGlyphs` name was from the pre-extraction version in `GlyphRendererV15`.

### grid-editing: Space handling in `visCol` tracking is subtly wrong

Phase0-grid-editing.md line 74: `// On space (line 350-355): advance rawCol, visCol stays`. But `visCol` is described as "visible character index" in the slotToPos record. The problem is that spaces DO advance the x cursor and occupy visual columns -- they're just not rendered glyphs. If a user clicks between two visible characters separated by 3 spaces, the `rawCol` must account for those spaces. The proposed code only increments `rawCol` on space but not `visCol`. Whether this is correct depends on the definition of "visible column" -- but if it means "screen column," spaces absolutely count. If it means "buffer slot index within the line," the existing `lineSlotOffsets` already provides this. The naming is ambiguous and will cause bugs at the edit boundary.

### integration: `switchProvider` references wrong existing property

Phase0-integration.md line 279: `this.repoAdapter.provider = new GitHubRepositorySource()`. But `RepositoryAdapter` uses `this.source` (RepositoryAdapter.js line 23), not `this.provider`. The proposal says to rename `this.source` to `this.provider` (line 39), but `switchProvider` assigns a raw `GitHubRepositorySource` directly, bypassing the cache layer that `RepositoryAdapter` provides. The adapter would need to reconstruct its cache integration, not just swap the source.

---

## Gaps

### Covered by protocol, missed by integration
- **Error type mapping** (GitHub 404/403/429 to FileSystemError codes) -- integration has no error handling story at all
- **`onDidChange` notification model** -- integration doesn't address filesystem watching or live updates
- **`applyEdits` returning full FileContent** to avoid readFile round-trip -- integration's `applyEdits` returns `Promise<string>` (line 47), losing stat metadata

### Covered by integration, missed by protocol
- **UI changes**: provider selector dropdown, status bar indicator, state persistence -- protocol is pure interface/wire, deliberately so
- **`filterCodeFiles` staying on consumer side** -- both protocol and integration agree here but integration shows the specific code paths (lines 392-396)
- **Runtime provider switching** and state cleanup (clearing grids, cache, tree) -- important UX concern protocol doesn't address

### Covered by grid-editing, missed by both others
- **Z-depth wrapping interaction with cursor navigation** (lines 352-367) -- neither protocol nor integration considers how arrow keys should behave across Z-wrapped lines
- **Debounced re-render strategy** using `requestAnimationFrame` (lines 334-346) -- practical typing performance concern
- **Cost analysis**: 12 bytes/glyph for slotToPos + 4 bytes/line for lineVisCharCounts (lines 382-389)

### Missed by grid-editing
- **How `applyEdits` flows through the provider to the relay and back** -- grid-editing applies edits to local `this.content` (line 294) but doesn't address persistence to the FS provider or conflict with external changes

---

## Tensions

### 1. Provider dispatch: URI-based vs mode-based

Protocol (phase0-protocol.md lines 369-370): "There is no 'active provider' toggle. The URI determines the provider."
Integration (phase0-integration.md lines 261-298): Provider is a mutable property on `RepositoryAdapter`, swapped by `switchProvider()`.

**Protocol is correct.** URI-driven dispatch is stateless and composable -- a viewer can show files from multiple providers simultaneously. The integration approach of `this.repoAdapter.provider = new LocalFSProvider(...)` means the adapter can only talk to one backend at a time, which prevents mixed-source views. The `FileSystemRegistry.resolve(uri)` pattern (protocol lines 327-330) is strictly superior.

However, integration is correct that the UI needs *some* concept of "primary source" for the tree panel and load button. Resolution: the registry handles dispatch, the UI tracks a "default scheme" for the tree listing, but individual file operations always go through URI resolution.

### 2. Go relay: new handler vs pure forward

Protocol (lines 385-404): Relay inspects messages for `jsonrpc` field, routes to internal FS handler.
Integration (lines 100-117): Relay intercepts `fs.*` in the display message handler.

Both agree the relay must handle FS requests itself (not forward to controllers). The implementation differs -- JSON-RPC discrimination (protocol) is cleaner because it's a single check at the top of the message loop rather than being embedded inside the `role == "display"` branch. The relay currently only processes display messages that have a `to` field (relay.go line 137) -- integration's approach of intercepting inside this branch means FS requests would need to NOT have a `to` field, which is correct but fragile.

### 3. Edit application: local-first vs provider-first

Grid-editing (lines 288-302): Edits are applied to `this._activeGrid.content` directly, then re-rendered.
Protocol (lines 214-224): Edits go through `provider.applyEdits(uri, edits)` which returns the new FileContent.

**Both are needed, sequenced correctly.** For local FS: edit -> provider.applyEdits (writes to disk) -> response -> re-render. For in-memory/GitHub-readonly: edit -> modify local content -> re-render. Grid-editing's local-first approach is the right optimistic strategy for typing latency, but it needs a reconciliation path when the provider's returned content differs from the optimistic local state.

---

## Recommendations

1. **Adopt JSON-RPC 2.0 as the sole FS wire format.** Integration must drop the custom `{ cmd: "fs.list" }` envelope and use `{ jsonrpc: "2.0", method: "fs/list" }`. This is non-negotiable for error handling consistency.

2. **Integration should use `FileSystemRegistry` for dispatch, not mutable `repoAdapter.provider`.** The adapter can hold a default scheme for tree browsing, but `readFile`/`writeFile`/`applyEdits` must resolve providers by URI.

3. **Grid-editing's `visCol` must be renamed to `slotCol`** (the column index counting only buffer-emitted glyphs). "Visible column" implies screen position including spaces, which is a different number. The naming confusion will cause off-by-one errors in every consumer.

4. **Grid-editing must route edits through the provider for persistent files.** Add a path: `_applyEdit -> provider.applyEdits(grid.uri, [edit]) -> update grid from response`. The optimistic local-content path is a performance optimization layered on top, not a replacement.

5. **Fix grid-editing's `_textToGlyphs` reference.** The file is `src/workers/builders/textToGlyphs.js`, the function is `textToGlyphs` (no underscore), and the skip logic is at lines 31-37, not 1139-1145.

6. **Integration's `applyEdits` return type should be `Promise<FileContent>`**, not `Promise<string>`. The caller needs updated `stat` (mtime, size) to keep the grid's metadata consistent and to detect concurrent external modifications.

7. **Add `uri` field to CodeGrid metadata.** Both protocol and grid-editing need this: protocol for `onDidChange` event matching (protocol line 457: `registry.findByMeta('uri', event.uri)`), grid-editing for routing edits to the correct provider. Currently CodeGrid stores `sourcePath` but not the full URI.

8. **Integration's relay `--root` flag should be reflected in a `fs/capabilities` handshake message** sent when the display connects. The browser needs to know the root path and whether writes are enabled before rendering the local-FS UI. Protocol should define this as a JSON-RPC notification: `{ jsonrpc: "2.0", method: "fs/capabilities", params: { root: "/path", writable: true } }`.

9. **Grid-editing should use `requestAnimationFrame` batching from day one**, not "start with full re-render per keystroke." The worker round-trip is 5-15ms per the analysis's own numbers, and key-repeat fires every 30ms. Debouncing is not optional.

10. **Integration's `WebSocketBridge.request()` timeout (10 seconds, line 193) should be configurable per method.** `fs/readFile` on a large file over SSH may take longer; `fs/stat` should be fast. A flat 10s timeout will cause false failures on slow networks and unnecessary delays on fast ones.

---

## Key Insight

The three analyses converge on a single pipeline -- URI identifies source, provider executes I/O, builder produces buffers and metadata, grid renders -- but they diverge on where state lives. Integration puts provider identity on a mutable adapter property; protocol puts it in the URI; grid-editing puts file content on the grid itself. The correct architecture threads the URI through the entire stack: the URI is stored on the CodeGrid, the registry resolves it to a provider, the provider returns content with stat metadata, the builder produces slotToPos alongside the buffers, and edits flow back through the same URI to the same provider. Any shortcut that breaks this chain (mutable provider swap, local-only content mutation, path-based dispatch instead of URI-based) creates a special case that every downstream consumer must handle. Getting the URI threading right in Phase 1 will determine whether the editing and multi-source features compose cleanly or fight each other.
