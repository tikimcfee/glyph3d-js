# Predictions from `rendering` Agent

Written without reading the other agents' Phase 0 outputs.

---

## Prediction: `foundation` Agent

The foundation agent was scoped to types, providers, a relay server, and wire format -- all as a read-only Tier 1 layer with strict scope discipline. I predict they concluded that the current codebase lacks formal type definitions and that JSDoc alone is insufficient for the contracts that editing and rendering will need to share. They likely proposed a lightweight type vocabulary (perhaps a `types.js` or `types/` directory) defining position types (`{line, column}` as grapheme-column, not code-unit-column), range types, text-change descriptors, and glyph identity types. For the relay server and wire format, they probably formalized the WebSocket message schema currently implicit in `ws-relay.mjs` and the CLI command handlers, defining a versioned JSON envelope with typed payloads. They almost certainly stayed disciplined about not introducing runtime dependencies or build steps, keeping everything as plain ES module exports and JSDoc annotations -- no TypeScript, no code generation. They may have flagged that the `graphemeToId` map (which I introduced) needs a type contract visible to both workers and the main thread, and that the relay wire format should use grapheme-indexed positions rather than code-unit offsets.

## Prediction: `editing` Agent

The editing agent was tasked with designing the editing pipeline contract at Tier 2, resolving adversarial contradictions. I predict they grappled with the central tension between "build it now" and "you have no consumers yet" -- the same tension my Phase 0 resolved by making StringBuffer read-only. They likely concluded that the editing contract should define the *interface* (method signatures, event shape, undo semantics) without committing to a backing data structure (piece table vs. rope vs. flat string). They probably specified an `applyEdit(range, newText)` operation that takes grapheme-indexed positions (aligning with my grapheme-correct slot mapping) and returns a description of what changed, suitable for incremental re-rendering. They likely addressed the adversarial contradiction around whether to build TreeSitter integration now or defer it, concluding (as I did) that it's premature -- the contract should be shaping-agnostic. They probably defined an edit event that CodeGrid can subscribe to for triggering selective re-render of affected lines rather than full `flush()` cycles. They may have proposed an EditSession or EditController that sits between input handling and StringBuffer, owning cursor state and selection -- but specified it as a contract/interface rather than implementation, since no keystroke handling exists yet.

