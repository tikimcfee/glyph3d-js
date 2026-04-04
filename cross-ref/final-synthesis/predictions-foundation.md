# Predictions from Foundation Agent

What I believe the other agents concluded, without reading their Phase 0 outputs.

---

## Rendering Agent

**Scope**: grapheme/Unicode fix, TextBuffer/StringBuffer, Intl.Segmenter compat, CodeGrid API migration

I predict the rendering agent concluded that the `charCodeAt` grapheme bug is real and urgent but should be a standalone fix, not entangled with the provider layer. They likely proposed `Intl.Segmenter` with a fallback path (since it is not universally available in all WebView contexts) and scoped the fix to the buffer builders in `src/workers/builders/`, where codepoint iteration happens during the single-pass text-to-Float32Array conversion. They probably resisted introducing `TextBuffer`/`StringBuffer` at this stage, recognizing it as Tier 2 editing infrastructure rather than a rendering concern, or if they did propose it, they scoped it narrowly as a read-only rope/gap-buffer that the builder reads from instead of raw strings. For CodeGrid API migration, I expect they proposed adding a thin accessor layer (methods like `getText()`, `getLine()`) rather than breaking the existing `addText`/`flush` contract, since the rendering pipeline is provider-agnostic and should remain so. The key tension they resolved was likely: "fix the real grapheme bug now, defer the structural TextBuffer to when editing actually needs it."

## Editing Agent

**Scope**: design contract for the editing pipeline (Tier 2), resolving adversarial contradictions

I predict the editing agent defined the Tier 2 contract as a set of interfaces and interaction protocols rather than concrete implementations, since Tier 2 depends on Tier 1 (my provider layer) existing first. They likely specified `TextBuffer` as the central abstraction -- a mutable document model that sits between the filesystem provider and CodeGrid, holding the in-memory text, tracking dirty state, and exposing edit operations (`insert`, `delete`, `replaceRange`). They probably resolved the adversarial contradiction around "who owns the text": the provider owns the persisted version, the buffer owns the working copy, and CodeGrid owns the rendered projection. For `EditHistory`, I expect they defined an undo/redo contract using operation-based (not snapshot-based) history, since the glyph system's per-slot buffer architecture makes snapshot-based undo prohibitively expensive. They likely deferred `fs/writeFile` and `fs/applyEdits` to an implementation phase but defined the JSON-RPC method signatures so Tier 1 (my plan) and Tier 2 share a wire protocol. The key adversarial contradiction they resolved was probably: "should edits flow through the filesystem provider or directly mutate the buffer?" -- and they landed on buffer-first with provider as the persistence flush target, not the edit authority.
