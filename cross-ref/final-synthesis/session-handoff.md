# Session Handoff — Next Session Work

## What Was Accomplished

### Filesystem Provider Layer + Grapheme Fix (committed)
- **Grapheme cluster rendering**: Replaced `charCodeAt` with `Intl.Segmenter` across the entire rendering pipeline. Atlas now string-keyed with dense numeric IDs. Emoji/ZWJ sequences render correctly.
- **Local filesystem provider**: `RemoteFileSystemProvider` talks JSON-RPC 2.0 to Go relay. `cli/fs.go` handles `fs/readFile`, `fs/listTree`, `fs/stat` with path sandboxing and 10MB file cap.
- **WebSocket infrastructure**: `rpcRequest()` on WebSocketBridge, JSON-RPC message routing, channel-based single-writer goroutine on relay (replaced mutex).
- **UI**: Source selector dropdown in repo panel (GitHub/Local), provider switching via `_switchSourceMode()`.
- **Commits**: `6a7b82f` (grapheme + provider), `c8c36ac` (UI + WS race + channel writer)

### Cross-Reference Analysis (on disk, not committed)
- 30+ documents in `cross-ref/filesystem-provider-layer/` and `cross-ref/final-synthesis/`
- Full implementation plan, adversarial review, Metal GPU pipeline exploration, edit data structures research
- Tier 2 editing design contract at `cross-ref/final-synthesis/phase0-editing.md`

## What Needs Doing Next

### 1. CLI Server File Filtering (Priority)

**Problem**: The Go relay's `fs/listTree` loads ALL files, including binary content that the grapheme segmenter tries to atlas-pack (thousands of CJK, Arabic combining marks, etc. from binary data interpreted as text). This caused massive atlas overflow spam.

**Fix**: Filter `fs/listTree` to a known set of source code extensions, similar to how SwiftGlyph filters. The relay already excludes some directories (`.git`, `node_modules`) and binary extensions, but:
- The binary extension list is incomplete
- It should be a **whitelist** of known text extensions, not a blacklist of binary ones
- Reference the SwiftGlyph app's extension filter at `~/dev/swift-glyph3d/` for the canonical list

**Files to change**:
- `cli/fs.go` — `listTree` walk logic (around line 210-270). Switch from blacklist to whitelist approach.
- Consider: should the relay also do a UTF-8 validity check on `fs/readFile` and reject non-text content?

### 2. Settings Persistence for Local Mode

**Problem**: When switching to Local mode, the user's last-used root directory and source mode aren't saved/restored properly.

**Fix**: 
- `app/StatePersistence.js` — save `sourceMode` ('github'/'local') and `localRoot` alongside existing repo URL/branch
- `app/GitHubRepoViewer.js` — restore source mode and local root on startup, populate the UI fields
- The Source selector should reflect saved state on page load
- `app/IDEShell.js` — status bar should show the active provider (Local/GitHub)

### 3. Documentation Cleanup

- The `cross-ref/` directories contain analysis documents (30+ files). These are reference material, not shipping code. Consider:
  - Committing a summary document (the final implementation plan)
  - Adding `cross-ref/` to `.gitignore` if these shouldn't be in the repo
  - Or committing them as design documentation

### 4. Agent Activity Window Cleanup

- The Claude Code hooks (`cli/hook.go`) create activity windows that may need cleanup
- Check if hook.go needs updating for the new relay channel-based writer

## Key Architecture Notes for Next Session

- **No compat shims**: When changing a pipeline, REPLACE the old path entirely. No dual paths, no backward-compat flags.
- **"Character" = grapheme cluster**: Internally, everywhere. The wire protocol also uses grapheme indices (no LSP server to maintain UTF-16 compat with).
- **Provider switching**: `_switchSourceMode()` on GitHubRepoViewer creates the appropriate provider and swaps `repoAdapter`.
- **Channel-based writer**: All display WebSocket writes go through `Relay.sendToDisplay()` → `displayWrite` channel → single writer goroutine.
- **Atlas**: String-keyed `uvMap` (`Map<string, UV>`), dense numeric IDs for GPU DataTexture. 2048x2048 canvas, shelf-packing.

## Files of Interest

| File | What it does |
|------|-------------|
| `cli/fs.go` | Go FS handler — where extension filtering goes |
| `cli/relay.go` | WebSocket relay with channel writer |
| `app/GitHubRepoViewer.js` | Viewer app — provider switching, `_loadLocalRepository()` |
| `app/components/Drawer.js` | Source selector UI (`repoPanelHTML()`) |
| `app/StatePersistence.js` | localStorage save/restore |
| `src/services/data/RemoteFileSystemProvider.js` | JSON-RPC client for local FS |
| `src/GlyphAtlas.js` | String-keyed atlas with dense IDs |
| `src/utils/grapheme.js` | `Intl.Segmenter` wrapper |
| `cross-ref/final-synthesis/implementation-plan.md` | Full converged plan |
| `cross-ref/final-synthesis/phase0-editing.md` | Tier 2 editing design contract |
