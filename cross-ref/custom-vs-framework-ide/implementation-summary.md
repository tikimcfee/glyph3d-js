# Cross-Ref Summary: Custom IDE Shell vs Framework Adoption

## Decision: Keep the Custom Shell

**Unanimous across all three perspectives. Not a close call.**

Three independent, orthogonal disqualifications:

1. **Metaphor mismatch** (product-ux): The "editor" is a WebGL canvas with character-level GPU buffer interaction — not "no text interaction," but text interaction through GPU buffer indexing rather than DOM cursors. IDE framework chrome (Cmd+S, IntelliSense, extensions) creates false user expectations. The system IS text-aware (character-level picking, per-glyph color, semantic mapping — patterns from the Swift/MetalLink predecessor), but operates at the GPU buffer level, not the DOM level.

2. **Integration cost exceeds shell cost** (engineering): The shell is 2,960 LOC. Framework bridge code (iframe isolation, serialization, dual command systems) was estimated at 2,400-4,000 LOC — larger and more fragile than the shell it replaces. The 7 viewer-shell integration points would all become async message channels across an iframe boundary.

3. **Disproportionate dependency weight** (sustainability): 5-15% usage ratio for 100% dependency weight. The smallest option (Monaco standalone) adds 3-5 MB minified; full frameworks add 700 MB-1.5 GB. The project currently has zero build step and zero runtime deps beyond Three.js.

**Bonus disqualification**: The agent-window vision (dynamic 3D windows for AI agents) requires direct Three.js scene graph access. No framework extension API provides this. Framework panel management operates in 2D pixel coordinates; glyph3d-js operates in 3D world space.

## Errors Caught During Cross-Reference

- Shell LOC: corrected from 2,487/~2,600 to **2,960** (sustainability missed CommandBar.js)
- Command module LOC: corrected from 5,418 to **4,123** (engineering included non-command files)
- Shell external imports: corrected from 1 to **5** (engineering undercounted)
- Monaco size: clarified — 81 MB npm package, 3-5 MB tree-shaken runtime
- EPL-2.0 "nearly inevitable" modification claim: flagged as imprecise assumption

## Converged Roadmap (Priority Order)

1. **Extract IDE from `examples/ide/` to `app/ide/`** — production app at ivanlugo.dev/ide, not an example. 5 files to move, 7 import paths to update.

2. **Formalize viewer-shell interface** — `ViewerShellContract.js` replacing 3 ad-hoc integration points (DrawerController shim, updateStats monkey-patch, direct viewer.grids access). Must account for the character-level interaction path: the contract needs to expose glyph-level operations (not just grid-level), enabling the shell to support picking, per-glyph color mutation, and semantic queries against GPU buffer indices. 4 clean integration points (CustomEvents, ResizeObserver) stay as-is.

3. **Build categorized command palette** (~300 LOC) — extend existing CommandBar with prefix categories (`:` commands, `@` grids, `>` terminals, default files). Do not import Monaco.

4. **Adapt Swift predecessor patterns into glyph3d-js core** — the `/home/user/dev/swift-glyph3d` codebase has mature patterns that the JS side is missing:
   - **Picking texture** for character-level hit testing (currently only grid-level raycasting)
   - **SemanticInfoMap** for syntax-aware token-to-glyph mapping
   - **Per-glyph color mutation** via direct buffer writes (additive + multiplicative)
   - **unicodeHash search** without storing strings
   - **Buffer reload = rerender** pattern (mutate buffer → next frame picks it up)

5. **Spatial minimap** (~200-300 LOC) — overhead view of 3D layout showing grid positions + camera frustum. `#minimap-canvas` element already exists.

6. **Write ADR** (`docs/adr/001-custom-ide-shell.md`) — document the decision with revisit condition: reopen only if the project adds traditional DOM-based text editing (not GPU buffer text interaction, which the project already has).

## Implementer Vote

| Agent | Votes For |
|-------|-----------|
| product-ux | engineering |
| engineering | product-ux |
| sustainability | engineering |

**Engineering wins 2-1.** The work is predominantly file moves, import path resolution, and interface formalization — structural engineering tasks.

## Reopening Condition

Revisit the framework question **only** if the project pivots to include traditional DOM-based text editing alongside 3D visualization. The system already has text-level interaction through GPU buffer indexing (from the Swift/MetalLink predecessor architecture) — that's a different paradigm from Monaco/CodeMirror, not an absence of text interaction.

## Files Produced

| Phase | Files |
|-------|-------|
| Phase 0 | phase0-product-ux.md, phase0-engineering.md, phase0-sustainability.md |
| Predictions | predictions-product-ux.md, predictions-engineering.md, predictions-sustainability.md |
| Round 1 | round1-product-ux-reviews-*.md, round1-engineering-reviews-*.md, round1-sustainability-reviews-*.md |
| Round 3 | round3-product-ux-convergence.md, round3-engineering-convergence.md, round3-sustainability-convergence.md |
| Summary | implementation-summary.md (this file) |

Round 2 was skipped — no substantive tensions remained after Round 1.
