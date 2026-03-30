# Phase 0 -- Sustainability / Independence Analysis

**Perspective**: License implications, fork maintenance burden, community dynamics, upstream risk, monetization, long-term project health.

**Question**: Build a custom web IDE shell vs. integrate an existing open-source web IDE framework?

---

## 1. License Audit -- Hard Facts

### glyph3d-js (current project)
- **License**: MIT (confirmed in `package.json`)
- **Runtime dependencies**: ONE peer dependency (`three >= 0.150.0`). Dev dependencies add only `three ^0.169.0` and `ws ^8.19.0`.
- **Build system**: None. Native ES modules served directly. No bundler, no transpiler.
- This is an extraordinarily clean dependency posture.

### VS Code / Code OSS (microsoft/vscode)
- **Source license**: MIT (the `microsoft/vscode` repository on GitHub).
- **Binary license**: Proprietary Microsoft Software License. The official VS Code download includes proprietary telemetry, branding, and the Microsoft Extension Marketplace. These are injected during Microsoft's build process and are NOT covered by the MIT source license.
- **VSCodium** strips the proprietary components and builds from MIT source. However, VSCodium cannot access the Microsoft Extension Marketplace (only Open VSX).
- **Implication for embedding**: You could theoretically build from MIT source, but you inherit Microsoft's entire build toolchain (Electron, ~1.5GB node_modules, native module compilation). The MIT license itself imposes no monetization or donation-link restrictions, but the practical weight is enormous.

### Eclipse Theia
- **License**: Eclipse Public License 2.0 (EPL-2.0) for the framework core, with some packages under MIT.
- **EPL-2.0 is weak copyleft**: If you *modify* EPL-licensed source files and distribute, those modifications must remain under EPL-2.0. If you merely *use* Theia packages as dependencies without modifying their source, your own code can stay MIT.
- **EPL-2.0 is NOT compatible with MIT for outbound licensing**: You cannot take EPL-2.0 code and relicense it as MIT. The copyleft applies to the specific EPL-2.0 files you modify.
- **Practical concern**: Even if glyph3d-js stays MIT, if your IDE shell modifies any Theia package internals (which is nearly inevitable when customizing an IDE framework), those modifications must be EPL-2.0. This creates a license split in your codebase.
- **Monetization**: EPL-2.0 explicitly permits commercial use and does not restrict donation links or buy-me-a-coffee models.

### OpenVSCode Server (Gitpod)
- **License**: MIT.
- **Reality**: It is a thin fork of microsoft/vscode with server-mode patches. It auto-syncs with upstream VS Code. You inherit VS Code's full dependency tree (~1,500+ npm packages, native modules, Electron-adjacent build requirements).
- **Fork risk**: Gitpod controls the sync cadence. If Gitpod deprioritizes the project (as happened when they shifted focus to their commercial platform), you are left maintaining a VS Code fork yourself. Solo dev maintaining a VS Code fork is not viable.

### code-server (Coder)
- **License**: MIT.
- **Dependencies**: express, argon2, compression, cookie-parser, http-proxy, limiter, ws, and 15+ more runtime packages. Designed as a remote development server, not an embeddable component.
- **Mismatch**: code-server solves "run VS Code on a remote machine accessible via browser." glyph3d-js needs "render 3D text grids with a command palette." These are different problems sharing almost zero surface area.

### Monaco Editor (standalone)
- **License**: MIT.
- **Unpacked size**: ~81 MB on npm (includes dev, min, and min-maps variants). Even the ESM-only slice with tree-shaking is substantial.
- **Dependencies**: Zero runtime npm dependencies (self-contained bundle), but the package itself is large.
- **What you'd actually use**: Command palette widget, possibly keybinding system. You would NOT use the text editor (glyph3d-js IS the text renderer). This means carrying ~81 MB for a command palette.

---

## 2. Dependency Footprint Impact

| Option | Approx. install size | Runtime deps added | Build system required |
|--------|--------------------:|-------------------:|----------------------|
| Current custom shell | 0 MB | 0 | None |
| Monaco standalone | ~81 MB | 0 (self-contained) | Bundler recommended |
| Eclipse Theia (minimal) | ~700 MB+ | 150+ packages | Yes (webpack/Theia CLI) |
| OpenVSCode Server | ~1.5 GB+ | 1,500+ packages | Yes (VS Code build) |
| code-server | ~800 MB+ | 20+ direct, hundreds transitive | Yes (native modules) |

The current project serves raw ES modules with `python3 -m http.server`. Every framework option except Monaco would require introducing a build system, which is itself a maintenance surface.

---

## 3. Fork Maintenance Burden -- Commit Velocity

### Eclipse Theia
- Monthly release cycle. Master branch may contain breaking changes on any commit.
- Quarterly "community releases" provide more stable anchors.
- Breaking changes in imports, APIs, and extension points are routine (e.g., Theia 1.65 required import path migrations).
- **Solo dev burden**: You must track quarterly releases minimum, resolve breaking changes, and re-test your customizations. Budget 1-2 days per quarter.

### VS Code / OpenVSCode Server
- Monthly release cycle with ~800-1,200 commits per month.
- Extension API is intentionally stable, but the internal API (which you'd need for deep embedding) changes freely.
- **Solo dev burden**: Maintaining a fork or deep integration against this velocity is effectively a full-time job. Not viable for one person.

### Monaco Editor
- Releases roughly monthly, tied to VS Code releases.
- API surface is smaller and more stable than full VS Code.
- Breaking changes do occur but are less frequent than the full IDE framework.
- **Solo dev burden**: If using Monaco as a dependency (not forking), upgrade friction is moderate -- maybe a few hours per quarter.

---

## 4. The "How Much Would You Actually Use" Question

The custom IDE shell (`IDEShell.js` + `ide.css` + `ide.html`) is 2,487 lines. It provides:
- Activity bar with panel switching
- Sidebar collapse/resize
- Tab bar (open file tabs)
- Bottom panel with tabs
- Status bar (FPS, glyph count, camera position, WebSocket status)
- Keyboard shortcuts
- ResizeObserver integration with Three.js renderer
- Mobile responsiveness

From any full IDE framework, you would use:
- Command palette (search-driven action dispatch) -- available as Monaco standalone feature
- Possibly: keybinding manager, notification toasts, theming system

You would NOT use:
- Text editor (glyph3d-js replaces this entirely)
- Language servers / IntelliSense
- Debug adapters
- Terminal emulation
- Extension host / extension API
- File system providers
- Source control integration (you have your own)
- Settings UI (you have your own)

**Estimated usage ratio**: 5-15% of any full framework's surface area. You would carry 100% of the dependency weight and upgrade burden for that fraction.

---

## 5. Upstream Risk Assessment

### Theia
- Governed by Eclipse Foundation -- stable institutional backing.
- Risk: Eclipse Foundation priorities shift. The "AI-native IDE" branding push in 2025 signals a direction that may diverge from "embeddable framework" use cases.
- Risk: EclipseSource (primary corporate contributor) reduces investment.

### VS Code / Monaco
- Controlled by Microsoft. The stable extension API is a deliberate strategy to maintain ecosystem lock-in.
- Risk: Microsoft could change Monaco's bundling, drop AMD support (already happening), or shift the API in ways that break your integration.
- Risk: The Marketplace restriction means you cannot use VS Code extensions in non-Microsoft builds. This is irrelevant for glyph3d-js (you don't need extensions), but it illustrates Microsoft's control posture.

### OpenVSCode Server
- Gitpod controls sync cadence. Gitpod has already pivoted toward their commercial cloud platform.
- Risk: If Gitpod stops maintaining the sync, the project becomes a stale VS Code fork. Multiple organizations depend on it, which provides some resilience, but none are obligated to maintain it.

### Custom shell
- Risk: You. If you stop maintaining it, it stops. But it also cannot be broken by anyone else's decisions.
- The 3D agent-window vision (dynamic windows for AI agents in 3D space) is deeply specific to glyph3d-js. No upstream framework will ever prioritize this. Building it on top of a framework means fighting the framework's layout assumptions.

---

## 6. Buy-Me-a-Coffee Compatibility

All candidate licenses (MIT, EPL-2.0) permit donation links and modest monetization without restriction. There is no license-based obstacle to adding a buy-me-a-coffee link regardless of which path you choose.

The practical concern is brand confusion: if you ship something that looks like VS Code, users may expect VS Code. If you ship something that is clearly "glyph3d IDE," the identity is yours.

---

## 7. Solo Dev Sustainability -- 2,487 Lines vs. Framework Adoption

### Maintaining 2,487 lines of custom UI
- The code is vanilla JS + CSS Grid + DOM manipulation. No framework, no build step.
- The dependencies are zero (it imports from glyph3d-js's own modules).
- The risk surface is: browser API changes (minimal -- CSS Grid and DOM are stable), and your own feature scope.
- At current size, this is well within solo-maintainable range. The entire shell is smaller than a single Theia package.
- Over 3 years, you might grow it to 5,000-8,000 lines. Still manageable.

### Maintaining a framework integration
- Initial integration: 2-6 weeks (optimistic for Theia, longer for VS Code fork).
- Quarterly upgrade cycles: 1-2 days each, 4 times per year = 4-8 days/year.
- Debugging framework internals when something breaks: unpredictable, potentially days.
- Fighting the framework's layout model to support 3D canvas + agent windows: ongoing friction.
- Over 3 years: 12-24 days of pure framework maintenance, plus integration debugging.

---

## 8. Verdict from Sustainability Perspective

**Recommendation: Keep the custom shell. Do not adopt a framework.**

The reasoning, in order of weight:

1. **Dependency posture is a strategic asset.** Zero runtime dependencies beyond Three.js is rare and valuable. Every framework option adds hundreds of megabytes and introduces a build system. This directly conflicts with the project's current architecture (native ES modules, no build step, `python3 -m http.server`).

2. **Usage ratio is disqualifying.** Using 5-15% of a framework while carrying 100% of its weight and upgrade burden is a poor trade, especially for a solo developer.

3. **The agent-window vision cannot live in a framework.** Dynamic 3D windows for AI agents is the defining differentiator of glyph3d-js/ide. No IDE framework supports or will support this. Building it on top of Theia or VS Code means fighting their 2D layout assumptions at every step. The custom shell gives you complete control over the DOM-to-3D boundary.

4. **2,487 lines is small.** This is not a maintenance burden; it is a feature. The entire shell is readable in an afternoon. Framework integration code would likely be longer, harder to debug, and coupled to upstream release cycles.

5. **License cleanliness matters for a solo project.** Staying pure MIT with zero copyleft entanglements keeps options open indefinitely. EPL-2.0 (Theia) introduces a license split that, while manageable, adds cognitive overhead and potential confusion for contributors.

### One concession worth considering

If you want a command palette (Cmd+Shift+P style action dispatch), consider extracting *just* the command palette pattern as a standalone implementation (~200-400 lines of custom code) rather than pulling in Monaco. The pattern is: a fuzzy-filterable list of registered commands, rendered as an overlay, dispatching to handlers. This is a well-understood UI pattern that does not require 81 MB of Monaco.

---

## Sources

- [VS Code License (proprietary binary)](https://code.visualstudio.com/license)
- [VS Code FAQ (MIT source vs proprietary binary)](https://code.visualstudio.com/docs/supporting/FAQ)
- [VSCodium (MIT builds without telemetry)](https://vscodium.com/)
- [EPL-2.0 FAQ (Eclipse Foundation)](https://www.eclipse.org/legal/epl-2.0/faq/)
- [EPL-2.0 / MIT compatibility check](https://interoperable-europe.ec.europa.eu/licence/compatibility-check/EPL-2.0/MIT)
- [OpenVSCode Server (Gitpod, MIT)](https://github.com/gitpod-io/openvscode-server)
- [code-server (Coder, MIT)](https://github.com/coder/code-server/blob/main/LICENSE)
- [Monaco Editor (npm)](https://www.npmjs.com/package/monaco-editor)
- [Eclipse Theia releases](https://theia-ide.org/releases/)
- [Eclipse Theia 1.65 breaking changes](https://eclipsesource.com/blogs/2025/10/16/eclipse-theia-1-65-release-news-and-noteworthy/)
- [Theia package size review](https://github.com/eclipse-theia/theia-blueprint/issues/39)
- [@theia/core (npm)](https://www.npmjs.com/package/@theia/core)
