# Predictions from the Editing Agent

Written without reading the foundation or rendering agents' Phase 0 outputs.

---

## Foundation Agent (types, providers, relay server, wire format)

The foundation agent likely converged on a strict scope boundary: define the `FileSystemProvider` interface, the `FileContent`/`FileStat`/`DirectoryEntry` types, and the JSON-RPC wire format for the Go relay, but explicitly defer any editing-related methods (`applyEdits`, `writeFile`) to Tier 2. They probably specified `version` fields on `FileContent` and `FileStat` as opaque provider-assigned integers, established the three concrete providers (GitHub read-only, in-memory, remote/relay), and defined `fs/didChange` as a notification with URI + version. The relay wire format is almost certainly JSON-RPC 2.0 over WebSocket with `fs/` method prefixes, and they probably spent significant time on error codes -- defining at least `-32001` FileNotFound, `-32002` PermissionDenied, and `-32007` VersionConflict as the minimum set, even though only the first two are exercised in Tier 1.

I expect they wrestled with whether `uri` should be a `vscode-uri`-style structured object or a plain string and landed on plain string with a scheme prefix (`file:///`, `github://`, `memory://`), since there is no VS Code dependency and URL parsing is built into browsers. They probably also defined the relay server's filesystem sandboxing (root directory restriction) and the WebSocket handshake, noting that the existing `ws-relay.mjs` and `ws-relay.py` are the starting points but the Go binary is the production target.

---

## Rendering Agent (grapheme/Unicode fix, TextBuffer/StringBuffer, Intl.Segmenter, CodeGrid API migration)

The rendering agent likely identified the core grapheme cluster bug: the current builder pipeline iterates by UTF-16 code unit (`string[i]` or `charCodeAt`), which breaks on emoji, CJK supplementary plane characters, and any multi-code-unit grapheme. They probably proposed an `Intl.Segmenter`-based iteration path with a `for...of` / spread fallback for environments without Segmenter support, and defined a `Grapheme` or segment abstraction that maps one visual glyph to potentially multiple code units. The key architectural tension they addressed is that the atlas is keyed by codepoint but a grapheme cluster can be multiple codepoints -- they likely proposed rendering only the base codepoint (or a tofu/replacement glyph) for unsupported clusters, deferring full cluster rendering to a future atlas enhancement.

For `TextBuffer`/`StringBuffer`, they probably defined the same interface I did (`getText`, `getLine`, `getLineCount`, `applyEdits`) but focused on the read-path integration with CodeGrid -- specifically how `CodeGrid.setContent()` creates a `StringBuffer` internally, how backward-compatible `grid.content` and `grid.lines` getters delegate to the buffer, and how the builder receives text from the buffer rather than raw string arrays. They likely specified that `StringBuffer` stores text as a single string with a lazily-computed line offset index (same conclusion I reached), and noted that the `_lineSlotBase` mapping from line numbers to buffer slots must be rebuilt on any content change. The CodeGrid API migration probably involves deprecating direct `_lines` array access in favor of buffer-mediated access, with the rendering pipeline consuming `buffer.getText()` instead of `lines.join('\n')`.

---
