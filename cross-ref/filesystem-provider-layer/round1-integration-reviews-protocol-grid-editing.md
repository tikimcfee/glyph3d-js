# Round 1: integration reviews protocol, grid-editing

## Errors Found

### Protocol: `new URL()` with custom schemes works but parsing is fragile

Protocol's `parseProviderUri` (phase0-protocol.md line 89-93) uses `new URL(uri)`. This works for `github://owner/repo/branch/path` -- but the URL API treats the first path component after `://` as the **host**, not a structured path segment. So `new URL('github://owner/repo/main/src/index.js')` gives `host: 'owner'`, `pathname: '/repo/main/src/index.js'`. The parsed example in protocol's doc (line 95-96) actually shows this correctly (`host: 'anthropics'`), so the data is right -- but the subsequent extraction logic "owner='anthropics', repo='claude-code', branch='main', filePath='src/index.ts'" (line 96) is never shown as code. The consumer would need to do `host = owner`, then split `pathname` into `[repo, branch, ...filePath]`. This is undocumented and error-prone for paths with branches containing `/` (e.g., `feature/auth`). A branch like `feature/auth` would make `github://owner/repo/feature/auth/src/index.js` ambiguous: is `auth` part of the branch or the file path?

### Protocol: URI-driven dispatch conflicts with how the codebase actually loads repos

Protocol's position (phase0-protocol.md line 369-371) is "no active provider toggle" -- URIs determine routing. But `GitHubRepoViewer.loadRepository()` (line 900-959) works in bulk: it fetches a tree, gets multiple files, creates grids for all of them. There is no per-file URI dispatch at load time. The call is `repoAdapter.getRepositoryTree(owner, repo, branch)`, not per-file. Protocol's new flow (line 177-191) suggests `provider.listDirectory('github://owner/repo/branch/')` followed by per-file `provider.readFile(...)` -- but this loses `getMultipleFiles()` which batches GitHub API calls with concurrency limits (`RepositoryAdapter.js` line 256-280). URI-driven dispatch at the file level would serialize or naively parallelize GitHub fetches, losing the adapter's batch optimizations.

### Grid-editing: `_textToGlyphs` reference is to the sync path, not the hot path

Grid-editing references `_textToGlyphs` lines 1139-1145 (phase0-grid-editing.md line 13) for skip-set documentation. Those line numbers are in `GlyphRenderer.js` -- the sync rendering path. But the async worker path in `src/workers/builders/index.js` (lines 324-356, the `buildBatchBuffers` function) is the hot path for CodeGrid. The skip logic is the same, but citing the sync path obscures where the actual changes need to go. The agent does correctly identify `buildBatchBuffers` in section 1, so this is a citation error not a logic error.

### Grid-editing: tab handling in `rawCol` counter is wrong

Phase0-grid-editing.md line 76 says "On CR/tab (line 356): rawCol++ for tab (debatable), skip for CR". But in `buildBatchBuffers` at line 356, `if (charCode === 13 || charCode === 9) continue;` -- both CR and tab are fully skipped. They don't advance `charsOnSegment`, don't advance `x`, and get no buffer slot. The proposed `slotToPos` builder must NOT increment `rawCol` for tabs if it wants to stay consistent with how the buffer builder handles them. However, `rawCol` is meant to index into the raw source string for TextEdit, where tab IS a character at a specific column. This is a genuine semantic mismatch: the builder skips tabs as if they don't exist, but LSP TextEdits count them. The grid-editing agent needs to decide: does `rawCol` track the source string index (where tabs count) or the builder's character counter (where they don't)?

### Protocol: `filterCodeFiles` consumer-side position is partially wrong

Protocol says filtering stays on the consumer (line 208-209). But for LocalFS, the Go relay MUST filter server-side (node_modules, .git, binary blobs) to avoid sending megabytes of irrelevant tree data over WebSocket. My own analysis (phase0-integration.md line 136) correctly notes the relay should apply exclusion patterns server-side. Two-pass filtering (relay coarse + browser fine) is the right approach. Pure consumer-side filtering won't scale to large local repos.

## Gaps

- **Protocol covers `onDidChange`/fsnotify; I missed it.** My analysis doesn't address file-watching or change notifications. Protocol's `fs/didChange` notification model (phase0-protocol.md lines 151-157, 439-465) is essential for local FS editing and should be adopted.
- **Grid-editing covers Z-depth wrapping impact on cursor navigation (section 7); protocol and I don't.** This is important -- arrow key behavior across wrapped lines requires reading the 3D position buffer, not just line/col arithmetic.
- **I cover the Go relay `--root` / `--writable` security flags; neither other agent does.** Path traversal prevention (rejecting `..`) and opt-in write access are security requirements that the protocol and grid-editing analyses assume but don't specify.
- **Protocol introduces `FileSystemRegistry` as a routing layer; I use direct provider swapping on `RepositoryAdapter`.** These are two different architectural patterns -- registry-dispatch vs. adapter-swap. Both work but they're incompatible designs.
- **Grid-editing's debounced re-render with `requestAnimationFrame` (section 6) is not addressed by protocol or me.** This is the right approach for typing latency but needs to be reconciled with the `applyEdits` round-trip to the relay.
- **Neither protocol nor grid-editing addresses `StatePersistence` changes.** My analysis (section 6) covers persisting the active provider across sessions.

## Tensions

### URI-driven registry vs. adapter-swap provider model

Protocol proposes `FileSystemRegistry` that resolves URIs to providers (phase0-protocol.md lines 317-348, 369-371: "no modal provider switching; the URI scheme determines routing"). My analysis proposes swapping the provider on `RepositoryAdapter` (phase0-integration.md lines 29-48, 276-298).

**The adapter-swap model is correct for this codebase.** `GitHubRepoViewer.loadRepository()` operates on a single source at a time. It calls `repoAdapter.getRepositoryTree()` then `repoAdapter.getMultipleFiles()` -- there is no interleaving of providers within a single load. The URI-registry model adds complexity (every path becomes a URI, every method call requires scheme parsing) without delivering value until the system actually needs mixed sources. The adapter already encapsulates caching, batching, and filtering. Protocol's registry can be a future addition when cross-provider scenarios emerge.

### `DirEntry.name` (basename only) vs. `{path, type, size}` tree shape

Protocol's `listDirectory` returns `DirEntry[]` with only `name` (phase0-protocol.md line 30: "basename (no path separators)"). But `GitHubRepoViewer` and `RepositoryAdapter` work with `{path, type, size}` where `path` is the full relative path (e.g., `src/services/data/RepositoryAdapter.js`). GitHub's tree API returns full paths. `filterCodeFiles()` operates on `path`. `hierarchicalManager.layoutHierarchy()` parses `path` to build the directory tree. Returning only basenames from `listDirectory` would require the consumer to reconstruct full paths by tracking recursion depth -- a breaking change to the current tree-processing pipeline.

**The existing `{path, type, size}` shape is correct.** Protocol's `DirEntry` should include `path` (relative to root), not just `name`.

### `applyEdits` on the provider interface

Protocol places `applyEdits` on the `FileSystemProvider` interface (phase0-protocol.md line 57). My analysis does the same (phase0-integration.md line 47). Grid-editing generates TextEdits at the `EditorInputManager` level and applies them to the backing text in-browser first, then re-renders (phase0-grid-editing.md lines 288-303).

These are compatible but the sequencing matters: for local FS, the edit should go to the relay (`provider.applyEdits`) which writes the file AND returns updated content, THEN the grid re-renders with the authoritative content from disk. Grid-editing's approach of modifying in-browser text first and calling `loadTextAsync` is correct for the optimistic UI path, but it needs a reconciliation step with the provider response.

## Recommendations

1. **Adopt `{path, type, size}` for `listDirectory` return shape, not `DirEntry` with basename only.** Protocol's `DirEntry` must include full relative `path` to match the existing tree pipeline. Add `sha?` for GitHub compatibility.

2. **Use the adapter-swap model for Phase 1, defer the URI registry.** Replace `this.source` with `this.provider` on `RepositoryAdapter`. The `FileSystemRegistry` can wrap this later when multi-provider views are needed.

3. **Adopt JSON-RPC 2.0 framing from protocol for the WebSocket wire format.** My `fs.*` command namespace (phase0-integration.md section 2) works but is ad-hoc. Protocol's JSON-RPC framing (phase0-protocol.md section 3) is standard, has clear error codes, and discriminates cleanly from existing command traffic via the `"jsonrpc"` field.

4. **Resolve the `rawCol` semantics in grid-editing.** Define `rawCol` as the index into the source string (tab = 1 character), not the builder's internal counter. The `slotToPos` array maps buffer slots to source positions -- tabs and CRs occupy source indices but have no buffer slots, so they appear as gaps in the mapping.

5. **Add server-side tree filtering to the Go relay `fs.list` handler.** Exclude `.git`, `node_modules`, and binary files at the relay level before sending the tree over WebSocket. Browser-side `filterCodeFiles()` runs as a second pass.

6. **Add `onDidChange` to the provider interface from Phase 1.** Protocol's `fsnotify`-based notification model is essential for local FS editing. Without it, edits made by external tools (or by the relay's own `applyEdits`) won't propagate back to the viewer.

7. **Keep `getMultipleFiles` as a batch method on the adapter, not N parallel `readFile` calls.** The adapter's concurrency-limited parallel fetch is a performance feature that URI-driven per-file dispatch would lose.

8. **Grid-editing should store the source string index (`charIndex`) in `slotToPos`, not `rawCol`.** Rename to avoid ambiguity: `slotToPos[i*3+1]` = `charIndex` (0-based index into the full source string), which naturally handles tabs, CRs, and all skip characters.

9. **Add branch disambiguation to the URI scheme.** If URIs are adopted, use an explicit separator for branch: `github://owner/repo?ref=feature/auth&path=src/index.js` or encode the branch as a fragment. The path-based encoding `github://owner/repo/branch/path` is ambiguous for branches containing `/`.

10. **Grid-editing's `_applyEdit` should call `provider.applyEdits` for remote providers, not just modify in-browser text.** The optimistic local edit + provider write + reconciliation pattern must be explicit in the design.

## Key Insight

The three analyses are designing at different altitudes: protocol defines an abstract interface and wire format, I define the wiring into the existing application, and grid-editing defines the data structures for editing. The critical integration risk is that protocol's URI-registry model assumes per-file granularity while the actual codebase operates in bulk (fetch tree, batch-load files, lay out all grids). The adapter-swap model preserves the bulk operations that make the viewer fast while still enabling provider abstraction. The URI scheme is a good identifier format for individual files (tabs, breadcrumbs, persistence), but it should not be the dispatch mechanism for bulk operations like `getRepositoryTree` and `getMultipleFiles`. Adopting URIs as identifiers while keeping the adapter as the operational layer gives both agents what they need without forcing a rewrite of the load pipeline.
