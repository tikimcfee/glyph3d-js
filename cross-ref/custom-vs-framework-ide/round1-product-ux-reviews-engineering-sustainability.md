# Round 1: product-ux reviews engineering, sustainability

## Errors Found

### Engineering: LOC count for websocket commands is misleading (Section 5)
Engineering claims "21 command modules (5,418 LOC)" for the CommandRouter command system. The 5,418 figure is the entire `websocket/` directory, which includes `TUIWindow.js` (420 LOC), `TUIWindowManager.js` (91 LOC), `TUIFocusManager.js` (525 LOC), `TUIFormatter.js` (95 LOC), and `index.js` (164 LOC). The actual command modules in `websocket/commands/` total 4,123 LOC across 21 files. This inflates the "code you'd have to duplicate or bridge" argument by ~31%. The conclusion still holds, but the number should be 4,123 not 5,418.

### Sustainability: IDE shell LOC is wrong (Section 4 and Section 7)
Sustainability consistently uses 2,487 lines as the shell total. The actual total is 2,960 lines. The discrepancy is exactly 463 lines -- CommandBar.js, which moved to `examples/ide/components/CommandBar.js`. Sustainability appears to have missed this subdirectory. This matters because CommandBar is arguably the most architecturally significant piece of the shell (dual-mode input, terminal targeting, history, tab completion). Omitting it from the LOC count understates the shell's complexity and slightly weakens the "it's small, maintain it yourself" argument -- though 2,960 is still small.

### Engineering: "7 distinct integration points" framing overstates coupling (Section 1)
Engineering identifies 7 integration points between shell and viewer. But several of these are standard patterns, not problematic coupling: `file-selected` event and `camera-focus-changed` event are just DOM CustomEvents. `ResizeObserver` on `#editor-area` is standard responsive behavior. Calling these "distinct integration points" alongside the more concerning monkey-patching (drawer shim, `updateStats` patch) conflates clean interfaces with ad-hoc wiring. The recommendation to "formalize the 7 integration points" (Section 8.3) is correct, but the framing suggests equal severity across all 7 when really only 3 are problematic.

### Sustainability: EPL-2.0 analysis contains a hedge that could mislead (Section 1)
The claim "if your IDE shell modifies any Theia package internals (which is nearly inevitable when customizing an IDE framework), those modifications must be EPL-2.0" is correct as stated, but the parenthetical "which is nearly inevitable" is an assumption, not a fact. Theia's documented extension points (widgets, contribution points, inversify bindings) are designed to avoid modifying EPL-licensed source. The license risk is real for deep customization but not "nearly inevitable" for all integration patterns. Since the recommendation is to avoid Theia anyway, this doesn't change the conclusion, but it's imprecise enough to be misleading if someone reads this analysis to evaluate Theia for a different project.

## Gaps

### What I covered that others missed
- **The metaphor mismatch table** (my Section 3): Neither engineering nor sustainability systematically mapped user expectations row-by-row. Engineering gestures at it ("Framework editor APIs assume text documents with cursor positions") but doesn't enumerate the specific expectation failures. The UX cost of broken expectations is the strongest argument against a framework, and it's underweighted in both analyses.
- **Mobile responsiveness**: I flagged the explicit mobile detection in IDEShell (lines 91-98, 456-459). Neither other analysis mentions mobile. For a production app at `ivanlugo.dev/ide`, mobile visitors will arrive. Framework web IDEs have poor mobile stories.
- **The "borrow without adopting" pattern** (my Section 6): I proposed specific UX patterns to steal (spatial minimap, hierarchical breadcrumbs, categorized command palette, keyboard shortcut discoverability, theming presets). Neither other analysis offers concrete feature-level recommendations for the custom shell's evolution.

### What others covered that I missed
- **Engineering Section 5 (WebSocket/TUI command mapping)**: Engineering's detailed walk-through of how the CommandRouter protocol maps (or fails to map) to VSCode's extension host JSON-RPC is more thorough than my treatment. I mentioned CommandBar but didn't trace the full CLI -> WS relay -> CommandRouter -> TerminalGrid pipeline.
- **Sustainability Section 3 (commit velocity)**: The concrete data on Theia's monthly release cycle and VS Code's 800-1,200 commits/month is a maintenance burden argument I did not make. Valuable for the solo-dev context.
- **Engineering Section 3 (build system impact)**: I mentioned bundle size as a practical cost but didn't enumerate the specific build tooling consequences (import path rewriting, mandatory transpilation, deployment change from static files to Node.js backend). Engineering's treatment is more thorough.
- **Sustainability Section 1 (license audit)**: I did not address licensing at all. The EPL-2.0 copyleft concern and the VS Code binary vs. source license distinction are important for a solo dev weighing options.

## Tensions

### Shell LOC count: 2,487 (sustainability) vs. 2,960 (engineering)
Engineering is correct. The actual file-level count is 2,960 across 5 files. Sustainability missed `components/CommandBar.js`.

### Maintenance burden estimate: "~20 hrs/year" (engineering) vs. "well within solo-maintainable range" (sustainability)
No real tension -- both agree it's low. But engineering's specific "20 hrs/year" estimate is unsubstantiated. There's no basis for that number. Given that the shell is a production app that's actively evolving (the services extraction was recent, the WIP commit on the current branch shows ongoing architectural work), 20 hrs/year likely underestimates active development while overestimates maintenance-only work. Better framing: the shell's maintenance cost is dominated by feature development, not bug fixes or compatibility patches, and that's the correct cost structure for custom code.

### Framework integration LOC estimate: "2,400-4,000" (engineering) vs. not estimated (sustainability)
Engineering's estimate that framework bridge code would exceed the current shell is a strong claim. It's plausible but not proven. However, engineering's reasoning is sound: the 7 integration points all become async message channels if the canvas lives in a webview iframe, and each needs serialization/deserialization code. The estimate is directionally correct even if the exact range is speculative.

### "5-15% usage ratio" (sustainability Section 4)
I agree with this framing and it's the most concise way to state the core economic argument. Engineering makes the same point more verbosely in Section 4 ("What a framework adds that you'd actually use"). Sustainability's formulation is sharper.

## Recommendations

1. **Fix the LOC count discrepancy.** Sustainability should use 2,960, not 2,487. The CommandBar is a critical component that must be included in any analysis of shell complexity.

2. **Formalize the viewer-shell interface, but prioritize the ad-hoc parts.** Engineering's recommendation (Section 8.3) is correct but should distinguish between clean integration points (CustomEvent listeners) and problematic ones (drawer shim monkey-patch, `updateStats` frame patch, direct `viewer.grids` access). Start with the three ad-hoc ones.

3. **Build a categorized command palette.** All three analyses agree the current Cmd+P is file-path-only. Adding prefix-driven categories (`:` for commands, `@` for grids, `>` for terminal targets) would give the single highest UX payoff for the least code. This is ~200-400 lines in the existing CommandBar, not a framework adoption.

4. **Extract the IDE shell from `examples/`.** Both engineering (Section 8.2) and the project's own memory notes flag this. The shell is production code at `ivanlugo.dev/ide`, not an example. Move to a top-level `app/ide/` or `ide/` directory.

5. **Add a spatial minimap.** The `#minimap-container` exists in the HTML but renders a basic canvas. A birds-eye view of the 3D layout showing grid positions and the camera frustum would be more valuable than any framework feature.

6. **Do not pursue Monaco for the command palette.** Sustainability correctly identifies the 81 MB cost for a command palette widget. The custom implementation is the right call. Engineering's estimate of 200-300 LOC for command registration is in the right ballpark.

7. **Document the agent-window architecture path.** All three analyses agree that the 3D agent-window vision is the differentiator and that no framework supports it. But none of us produced a concrete architectural roadmap for how CommandBar + TerminalGrid + TUIWindowManager evolves into the agent-window system. This is the next analysis needed.

8. **Add component tests for the shell.** Engineering (Section 8.1) flags zero test coverage. For a production app, at minimum: panel switching, resize behavior, tab management, and CommandBar mode switching should have tests.

9. **Publish the "borrowing" list as a feature roadmap.** The UX patterns worth stealing (spatial minimap, hierarchical breadcrumbs, keyboard shortcut discoverability, theming presets) should become tracked work items, not just analysis observations.

10. **Close this decision.** All three analyses reach the same conclusion via different reasoning paths (UX metaphor mismatch, engineering integration cost, sustainability dependency burden). The framework question is answered. Investment should shift to hardening and evolving the custom shell.

## Key Insight

The three analyses converge on the same verdict but via genuinely different load-bearing arguments, and that convergence is itself the most important finding. Product/UX says the metaphor is wrong (a VSCode shell promises text editing that doesn't exist). Engineering says the integration surface doesn't exist (a WebGL canvas is not a document editor, and the iframe boundary kills the interaction model). Sustainability says the economics are wrong (5-15% feature usage for 100% dependency weight). Any one of these would be sufficient to reject the framework path; having all three independently disqualifying means this is not a close call that could flip with new information. The decision is structurally settled. The remaining work is not "should we adopt a framework" but "how do we make the custom shell excellent" -- specifically, how the CommandBar/TerminalGrid/TUIWindowManager stack evolves into the agent-window primitive that no framework could provide.
