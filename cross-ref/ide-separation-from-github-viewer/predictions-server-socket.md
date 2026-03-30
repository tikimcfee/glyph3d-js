# Predictions from server-socket agent

Written before reading the other agents' Phase 0 outputs.

---

## 1. Prediction: ownership-boundaries agent (dependency-graph + component-ownership)

I expect the ownership-boundaries agent concluded that **IDEShell.js, ide.html, ide.css, and the AppShell/components layer are the primary candidates for moving to a standalone `examples/ide/` directory**, because these files exist purely to provide VS Code-like chrome around the viewer and have no GitHub-specific logic in their core layout behavior. They likely identified that IDEShell wraps GitHubRepoViewer but does not extend it, making the relationship a composition seam that can be cleanly separated.

I expect they flagged **GitHubRepoViewer.js, GitHubRepositorySource.js, RepositoryAdapter.js, and RepositoryContentCache.js as firmly viewer-only** since these are GitHub API concerns, while **SceneContext.js, SelectionManager.js, FileStateManager.js, CodeColorManager.js, and BackdropManager.js** were identified as ambiguously shared -- they manage 3D scene state that any code visualization would need, not just GitHub repos. The agent likely recommended these scene-management files either stay shared or get extracted into a common base that both examples import from.

Their key concern was likely the tight coupling between IDEShell's sidebar panels (Drawer.js panel HTML generators like `repoPanelHTML`, `filesPanelHTML`) and viewer-specific data (repo name, GitHub file trees). They probably concluded that the panel content must be pluggable/provider-based for the IDE to work independently, and that the `components/` directory needs to split into viewer-specific panels vs generic IDE shell components.

---

## 2. Prediction: migration-path agent

I expect the migration-path agent proposed a **phased migration plan starting with the creation of `examples/ide/` as a real directory** (replacing the current redirect-only index.html), with shared infrastructure living in either `examples/shared/` or a new top-level location. They likely recommended an incremental approach: Phase 1 copies IDEShell + ide.html/css into `examples/ide/` and has it import SceneContext and core managers from github-viewer as a temporary bridge; Phase 2 extracts shared modules into `examples/shared/`; Phase 3 makes github-viewer and ide fully independent examples that both import from shared.

For the websocket/CLI code specifically, I expect they proposed keeping the relay servers in github-viewer, making CommandRouter available as shared infrastructure (possibly via `examples/shared/websocket/CommandRouter.js`), and noted that CliConnection and AgentWindowManager need to be importable from the IDE directory. They likely flagged the existing `examples/ide/index.html` redirect as the obvious starting point to replace, and recommended that the IDE example should be able to run against the same relay server that github-viewer starts, reinforcing my own finding that the relay protocol is the shared contract.

Their key concern was likely **avoiding premature abstraction** -- the risk of creating a shared/ directory that becomes a dumping ground. They probably recommended keeping the initial extraction minimal (just IDEShell, its HTML/CSS, and the scene-management files it actually imports) and letting the shared boundary emerge from actual usage rather than speculative generalization.
