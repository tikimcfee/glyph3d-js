# Interface & product plan

Produced by a 28-agent analysis (subsystem audit, market research, four competing
product theses each scored by three independent lenses, then synthesis).

Thesis panel scores: Watchfloor 8.0 · Review Table 7.7 · Deepmux 7.5 · Peripheral 6.8.
The synthesis below overrides the top score — see §1. That means the recommended
thesis was never itself put through the three judging lenses; treat §1 as an
argument to check, not a verdict. The §2-§9 diagnosis is independently verified.

Every code claim in here was spot-checked against the tree at 396491d.

---

# glyph3d → **Diffwall**
## The decision, the plan, and what to do in the next session

---

# 1. The decision

## The product

> **Diffwall shows you every file your coding agents changed — before and after, side by side, all of them standing in front of you at once — and for any line, why the agent changed it.**

At a party: *"I have four Claude sessions running. Diffwall puts every file they touched up on a wall, before and after, and I walk it. Click a line and it shows me the agent's own reasoning for that hunk."*

Binary: `diffwall`. Default invocation: `diffwall` in a repo. First frame is your working tree, already laid out.

## Why this and not the runners-up

The panel ranked **Watchfloor 8.0**, **Review Table 7.7**, **Deepmux 7.5**, **Peripheral 6.8**. The right answer is not the top of that list; it's the thing all four were circling.

**Watchfloor scored highest and its own judges killed its pitch.** Every judge said the same thing in different words: the one-liner resolves on *the raised hand*, and the raised hand is precisely what Anthropic shipped free on May 11 2026 (`agent view`, with a literal "waiting on you" column reading harness process state at a fidelity you cannot match), what GitHub shipped in January, and what Cursor 3 rebuilt its IDE around in April. Judge 1: *"a stranger who sees this once re-tells it as '3D dashboard for AI agents' and gets 'Cursor has that.'"* Judge 3: *"pitched that way it will be evaluated as a prettier agent view with a hook dependency Anthropic controls, and lose on fidelity."* The differentiated half of Watchfloor — N agents' diffs open simultaneously — was buried in its middle clause and got 9 of 30 demo seconds.

**Review Table had the right target and two real holes.** It leads with review, which is where the measured hours are (11.4/wk reviewing vs 9.8 writing; 22% rank it top-3; nobody has won it). But its headline beat — "three files did the work, you knew that in two seconds" — is beaten by `git diff --stat`, and its #1 build item (`setSourcePath` on the recto grid, "roughly one line") **silently destroys source files.** I verified this: `DeltaBooks.js:224` loads the recto from `delta.right.map(l => l.text).join('\n')`, which is the *aligned* array containing `{type:'spacer', text:''}` rows and `{type:'hunk', text:'@@ -12,7 +12,9 @@'}` rows (`DiffParser.js:46,73`), and `fileCommands.js` `gridToText` is a bare `grid.lines.join('\n')` with no guard. Ctrl+S on that grid atomically replaces your file with a spacer-padded diff fragment, and none of the relay's excellent barriers fire, because the mtime is unchanged and the content is non-empty.

**Deepmux's central mechanism claim is false.** "Depth decouples legibility from area" — pixels are conserved on a display in 3D exactly as in 2D. What depth actually buys is *no reflow on focus change* plus a *continuous* rather than binary size gradient. Real, worth having, and reproducible in 2D by anyone who bothers. Its flagship differentiator (cross-pane scrollback search) is also justified by a fact that isn't true: `TerminalEmulator.js:49` is `new Terminal({ cols, rows, scrollback: 0 })` because tmux owns history — the browser holds 24 rows per pane and nothing else.

**Peripheral's value proposition is a negative.** "Nothing you leave here disappears" cannot be demoed; its climax is "I quit and reopened and it looked the same," which every application does. And its mechanism only bites past N≈8 while its own persona has 4–8 things.

**Diffwall is the synthesis that survives all four critiques.** It targets the measured, uncontested pain (review at N). It gets return-frequency for free, because the wall updates while agents work — the property that killed CodeCity, Sourcetrail, and Primitive, all of which were consumed once per codebase. It sidesteps every incumbent, because none of them show you *the changes across N agents at once*, and none of them show you *why*. And its differentiator is a thing that costs almost nothing to build here and is structurally unavailable to everyone else:

**Provenance-linked diffs.** GitHub shows you a diff. Cursor shows you a diff. `agent view` shows you a session list. **Nobody shows you the diff with the model's own reasoning for that hunk attached** — even though the reasoning is sitting on disk in `~/.claude/projects/<encoded-root>/` right now, and this repo already parses it (`cli/sessions.go`, `toolRegistry.js` with 58 passing assertions, `AgentBooks` with the tool records already bound as pages). `DeltaBooks.ingestTool()` at `DeltaBooks.js:276` already receives the exact normalized tool record that produced each edit. The link is a field, not a subsystem.

That is the sentence that makes a stranger lean in, and it is the one that no incumbent can copy without owning both the transcript and the diff. Anthropic owns the transcript. GitHub owns the diff. You are the only one holding both.

---

# 2. The author's three questions, answered

## 2.1 "Is this a tracing system or a review system?"

**It is a review system. The tracing subsystem does not lose — it becomes the provenance layer, and that layer is the moat.**

Concretely, here is what happens to each half:

| Trace machinery | Fate |
|---|---|
| `AgentBooks` lane model (`AgentBooks.js`, 995 lines) | **Kept as infrastructure.** A lane is now "an agent whose changes are on the wall." The 3D book of transcript pages becomes the *drill-in from a hunk*, not a default view. |
| `cli/hook.go` live ingress (665 lines, 2 harnesses, 6 Go + 44 JS tests) | **Kept and promoted.** It stops being the product and becomes the thing that makes spreads appear on the wall in real time. Plus one new `case "Notification":` arm. |
| `cli/sessions.go` archive path (zero-config, SHIPPED) | **Kept and promoted.** It becomes the cold-start fallback and the provenance index for git-lane changesets. |
| `AgentsPanel` as a headline surface | **Demoted.** Merged into the Changes roster as an *attribution column*, not its own tab. |
| Stall detection (12s dead-man timer) | **Kept, cheapened.** It stops being a product claim ("we monitor your agents") and becomes one glyph on a roster row. It is semantically misleading anyway — a 15s model think, a 15s test run, and a permission block all read STALLED identically. |
| "Mission control" positioning | **Deleted.** Never said again. |

The precise product statement: **the transcript is not a thing you watch; it is the answer to "why is this line like this."** Every spread on the wall carries `agent-3 · Edit · 14:22 · why ▸`, and `w` pages that agent's book to the tool call that produced the hunk under your caret, with the thinking block above it.

This resolves the tension the author has been sitting in. The tracing work was never wasted; it was pointed at the wrong noun. Watching an agent is a solved, free, first-party feature. Explaining a diff is not.

## 2.2 "I need the VSCode moment"

**The instinct is right. The reference is wrong, and getting the reference wrong is what has been costing you.**

What actually happened with VSCode: it did **the same job** as Sublime/Atom, so nothing had to be learned — muscle memory transferred on day one — and then it was better at one thing (integrated language servers). Familiarity was cheap because the job was identical.

Diffwall is not doing VSCode's job. It is doing **GitHub's Files-changed tab's** job, and that is your familiarity target. Everybody who will ever use this has spent hundreds of hours in that exact screen. Copy its chrome *exactly*:

- a left list of changed files with `+47 −12` per row,
- a per-file **Viewed** checkbox that dims the row,
- next-file / prev-file keys,
- split vs unified toggle,
- a find box.

Ten seconds in, a stranger recognizes the screen. Then be better at the three things that screen is structurally worst at:

1. **One file at a time.** It's a scroll container; to see hunk 1 of `relay.go` you must remove hunk 3 of `attach.go` from the screen. Diffwall shows fourteen at fixed coordinates.
2. **No provenance.** It knows nothing about *why*.
3. **Read-only.** You can't fix the typo; you go back to your editor, find the file, find the line.

You still get everything you asked for — tabs, panes, search, shortcuts, extensions — mapped in §4. But they are mapped onto the *review* job, not imported from the *editing* job, because importing controls whose problem you don't have is how you ended up with 273 verbs and 380 settings keys.

One more piece of the "VSCode moment" you should take literally: VSCode's first frame is a **Welcome tab with your recent folders**, not an empty void. Yours is currently a black canvas with a VRAM statistics panel active (`app/IdeDock.jsx:99-105` — `buildDefaults` calls `api.addPanel(opts)` with no `inactive`, so the last panel added wins the tab; catalog order ends `monitor`). That is a two-word fix and it is worth more than any feature below it.

## 2.3 "Embed in VSCode keeps coming back as no"

**Settled: no. Permanently. Stop revisiting it.** Four reasons, in ascending order of finality:

1. **GPU contract.** `compute/GlyphLayoutKernel.js` has no CPU fallback by design. A webview's WebGPU access is contingent on the host's flags, the user's hardware-acceleration setting, and the deployment — vscode.dev, Codespaces, and Remote-SSH have no local GPU path at all. You built a system that fails loud at substrate seams; a webview is a seam whose contract you don't own and can't validate.
2. **Lifecycle.** Webviews are destroyed when hidden unless `retainContextWhenHidden`, which VSCode's own docs discourage because it pins memory. You already fight VRAM exhaustion and built `onDeviceLost` recovery with a sessionStorage loop guard (`tools/device-loss-recovery.test.mjs`). Embedding adds a *second, host-controlled* eviction source. Every tab switch becomes a potential arena teardown.
3. **Terminals cannot be reparented.** VSCode's terminals live in VSCode's panel. Inside VSCode you would keep your own tmux-backed terminal system anyway and the user would have two.
4. **The real one: two window managers cannot share one window.** A webview is a leaf in VSCode's tiling tree. Your entire value is *an arrangement* — fixed coordinates, no reflow under focus, a camera. Inside VSCode that arrangement is a rectangle governed by a rival arrangement, competing for area with the editor. VSCode can host a rendering surface; it cannot host a rival spatial arrangement of the user's attention, because arranging the user's attention is VSCode's job.

**The correct relationship is peer, not host, and it's ~200 lines.** A VSCode extension that talks to the already-running local binary over the WebSocket the CLI already uses:

| Command | Fires |
|---|---|
| `Diffwall: review this branch` | `delta.git <base> <head>`, opens the browser |
| `Diffwall: reveal this file` | `sheet.focus <path>` + `edit.goto <line> <col>` |
| `Diffwall: why did this change?` | new `delta.why <path> <line>` (§5, Stage 2) |
| status bar item | `N unreviewed · 2 agents working` |

The entire receiving end exists: 273 verbs, full CLI/RPC parity, one handler for click and shell alike. Same instinct you had, opposite topology, one weekend instead of a year.

---

# 3. Grafts and deletions

## 3.1 Ideas grafted in (with attribution)

| Idea | From | Where it lands |
|---|---|---|
| **Open the demo with a five-second static hold where the world changes by itself** | Watchfloor / stranger judge | §7 shots 1–2. This is the single best idea in the whole panel: it demonstrates return-frequency without a word of narration, and it is the property every dead 3D visualizer lacked. |
| **Never boot empty — fall back to the archive** | Watchfloor / feasibility judge | §4 cold start. Adapted: worktree diff → last commit → agent archive → repo tree. There is always a populated first frame. |
| **No reflow under focus + permanent numeric address** | Watchfloor / durability judge | The stated spatial guarantee (§4.2). Already implemented and covered by five dock harnesses; it just has never been *claimed*. |
| **"Nothing is rendered as a copy"** | Review Table / stranger judge | Elevated to a hard rule (§3.3). Inverted implementation: the diff page is explicitly read-only and *promotes* to the real file on click. |
| **Bounded, self-updating working set as the world** | Review Table / feasibility judge | The core framing. N≈14 instead of 1489 retires the entire load-storm/ECS/arena roadmap as optional. |
| **Far-texel LOD as requirement, not novelty** | Review Table / durability judge | The spatial argument (§4.7). "Which files moved and how much" is genuinely a shape question. |
| **Persisted reviewed bit** | Review Table / durability judge | Stage 1. Cheapest return-frequency mechanism available. |
| **The change ledger — rim warmth relative to the observer** | Peripheral (all three judges named it) | Stage 3. Continuous, decays on being looked at, type-agnostic across diffs/terminals/agents. This is the correct answer to "which one needs you" and it beats a red dot because it measures *neglect*, not activity. |
| **"Focus never removes"** | Peripheral / durability judge | The one unifying interaction rule (§4.2). Every "open" is a placement. |
| **Search across everything on the wall** | Deepmux (generalized) | Stage 4. Relay-side, not browser-side — `TerminalEmulator` has `scrollback: 0`. |

## 3.2 Deleted from the surface (kept in the repo)

Not deleted from git. Deleted from the screen, the toolbar, the palette, and the pitch.

- **All six ContentTree layout schemes** (`packed`, `walk`, `district`, `jellyfish`, `tree`, `library`) and the Layout panel. Keep `packed` as the internal placement algorithm. `jellyfish` and `tree` are additionally the only two schemes with zero test coverage, and `jellyfish` is the one that mutates tree structure.
- **Carrels** as a user-facing concept, panel, and word. The machinery (`Carrel.js`, model-authoritative residence, 90/90 passing) becomes the invisible placement/persistence engine for spreads.
- **Hands / the sensor plane.** Superb engineering, zero product surface, no gesture binding exists. Off the surface entirely.
- **Minimap, `capture`, `overlay`/`inline`, `hide ‹`, `map ●`.** The `capture` button is currently the third control on the toolbar and fires an OS screen-share permission prompt on a first-run user's blind click.
- **Books / volumes / splay / deck / strata / z-pages / newspaper** as user-facing words. Every one of them, gone.
- **380 settings keys → ~12 on surface.** `app/client/settings.js` is the most-touched file in the history; every knob is a decision refused and exported to the user. The rest move behind `⌘K → settings.set`.
- **The library framing on the README front page.** "The core library API is still settling" names a customer who does not exist and grants permanent permission to refine instead of ship.

## 3.3 Deleted from the code

These are verbs that can only ever fail, and they pollute the one surface that works (the palette indexes all 273):

- **`select.*`** — 5 verbs, 116 lines. `CommandProvider.jsx:147` sets `selectionManager: null` and nothing ever assigns it; `grep 'new SelectionManager'` returns zero. Every call returns `ERR: no selection manager`. Delete the verbs; move `SelectionManager.js` (322 lines) to `attic/`.
- **`group.*`** — 13 verbs. `CommandProvider.jsx:150` sets `spatialManager: null`, never assigned. Delete the verbs; attic `SpatialWindowManager.js` (603 lines) and `EntityInputRouter.js` (never instantiated).
- **`nav.status`** — `CommandProvider.jsx:213` sets `spatialNav: null`; the class does not exist; the verb unconditionally returns an error string explaining that it can't work.
- **Both tour systems.** `navigationCommands.js` and `tourCommands.js` both register `tour.clear`; `CommandRouter.register` is a bare `Map.set` with no duplicate detection, and `index.js:74` registers tourCommands after `:69`, so navigation's `tours` Map can never be emptied and `tour.create` is a one-shot-per-name lockout for the page session. Zero UI, zero persistence, zero tests. Delete `navigationCommands`' tour half.
- **`highlight.clear` collision.** Registered twice (`annotationCommands.js:277`, `highlightCommands.js:232`); the glyph-level one wins by registration order, so `highlight.grid`'s tint and Z-pop have no undo. Fix by merging, and **add duplicate detection to `CommandRouter.register`** so the next collision is loud.
- **`ReaderCompass.js`** (427 lines, never constructed, `hitTest` has zero callers) → attic.
- **~2,900 lines of v1 layout managers** (`GridLayoutManager`, `HierarchicalLayoutManager`, `SpiralLayoutManager`, `StackLayoutManager`, `TreemapLayoutManager`) still exported from both package indexes, referenced only by comments → attic.
- **`field.list`** — `WorkspaceModel.js:83` hardcodes one field forever. Delete the verb until multi-field exists.

That's roughly 35 verbs and 5,000 lines off the surface. `⌘K` gets meaningfully better the same day.

## 3.4 The one hard rule this establishes

> **Nothing the camera can reach is a copy.** Every surface is either the real file — editable, saveable, LSP-visible — or is explicitly marked read-only and promotes to the real file in one click. No unsaveable look-alikes, ever.

This names the repo's recurring structural failure rather than a feature. `SearchBook.js:271-274` renders matched files as cards and never calls `setSourcePath`, so clicking a search hit flies you to an unsaveable copy that `LspNavigator` ignores and that a double-click will happily let you "edit." `DeltaBooks` was one line away from repeating it *with atomic disk writes attached*. Make this rule explicit in `CLAUDE.md`.

---

# 4. The interface spec

## 4.1 The first screen

`diffwall` in a git repo with changes. No saved session. **`delta.git` + `camera.fitall` run before the mouse is handed over.**

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⌘K search        worktree ▾        fit        panels ▾                    ● relay    │
├────────────────────┬─────────────────────────────────────────────────────────────────┤
│ CHANGES   14 files │                                                                 │
│                    │      ┌────────┬────────┐   ┌────────┬────────┐                  │
│ ☑ relay.go  +47−12 │      │▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓│   │        │        │                  │
│   agent-3          │      │▓▓  ▓▓▓ │▓▓ ▓▓▓▓▓│   │  ▓     │  ▓▓    │                  │
│ ☑ attach.go +8 −2  │      │▓▓▓▓    │▓▓▓▓▓▓  │   │        │        │                  │
│   agent-3          │      └────────┴────────┘   └────────┴────────┘                  │
│ ☐ auth.js  +31 −9  │       relay.go  +47 −12     attach.go  +8 −2                     │
│   agent-1  ● 40s   │            agent-3               agent-3                        │
│ ☐ session.js +4 −1 │                                                                 │
│   agent-1          │      ┌────────┬────────┐   ┌────────┬────────┐   ┌───┬───┐      │
│ ☐ fs_test.go +2 −0 │      │▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓│   │   ▓    │   ▓▓   │   │   │ ▓ │      │
│ …                  │      │▓▓▓▓▓ ▓▓│▓▓▓▓▓▓▓▓│   │        │        │   │   │   │      │
│                    │      └────────┴────────┘   └────────┴────────┘   └───┴───┘      │
│ ── agents ──       │       auth.js  +31 −9       session.js +4 −1    fs_test  +2      │
│ ● agent-1 working  │          agent-1 ●            agent-1                           │
│ ○ agent-3 done     │                                                                 │
│                    │                    … 9 more …                                   │
├────────────────────┴─────────────────────────────────────────────────────────────────┤
│ 14 files · 2 reviewed · +312 −88 · agent-1 working · click a file to fly to it · ?    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Left page red bars = removed. Right page green bars = added. Dimmed spread = reviewed. `●` = changed since you last looked at it. Spreads packed by churn: biggest change nearest the camera.

**Cold-start fallback chain, in order** — there is never an empty void:
1. Git repo with a dirty worktree → `delta.git` (worktree vs HEAD).
2. Git repo, clean → `delta.git HEAD~1` with a one-line banner: *"Working tree is clean — showing the last commit."*
3. Not a git repo, but `~/.claude/projects/<encoded-root>` or `~/.kimi-code` has sessions → the archive (`cli/sessions.go`, zero configuration, SHIPPED today, needs no hook, no wiring, works the moment you point the binary at a directory you've used Claude Code in).
4. Nothing at all → the repo tree laid out, one line: *"No changes yet. `⌘K` to search, or start an agent."*

## 4.2 The two rules that define the interaction model

**Rule 1 — Focus never removes.** Every "open" is a placement. Focusing a spread moves the *camera*; nothing is displaced, hidden, evicted, or reflowed. Opening a search result stands it *next to* what's already there.

**Rule 2 — Position is a permanent address.** A spread's coordinates are a function of the changeset, never of activity or focus. `CameraDock` already enforces this for pinned tiles — `order` is a persisted sort key because "terminals re-adopt async, in arrival order — order is what keeps the bar from scrambling" (`CameraDock.js:58`), and a framed tile leaves a breathing ghost in its held-open slot "so the bar never reshuffles under a focus change" (`CameraDock.js:79`), guarded by `dock-ghost-check`, `dock-labels.test`, `dock-refresh-check`. This is the one property a tab strip or tiling WM structurally cannot have, it is already built, and it has never been *stated*.

**Explicit correction to the Watchfloor spec:** do **not** rank spreads by urgency in space. Urgency ranks the *Tab traversal order* and the roster; spatial position is frozen at changeset construction. Urgency-ranked position is exactly the reflow both rules exist to forbid.

## 4.3 Tabs

**The Changes roster is the tab strip, and the set is given rather than managed.** You never open or close a "tab" — the changeset defines membership.

| Key | Action |
|---|---|
| `⌘1`…`⌘9` | Fly to the Nth file |
| `⌥→` / `⌥←` | Next / previous file |
| `n` / `p` | **Next / previous hunk, across file boundaries** — treating the changeset as one ordered list of changes. Neither GitHub nor VSCode has this and it is the traversal reviewers actually want. |
| `⌘Enter` | Mark reviewed |
| `⌘⇧Enter` | Mark reviewed and advance to the next unreviewed |
| `⌃\`` | Next spread that **changed since you last looked at it** |

## 4.4 Panes

**The base|head spread *is* the split** — no second window manager, no `pane.split` grammar to learn.

Beyond that, one binding for two-up comparison, because "did the caller and the callee stay consistent" is the one judgment that genuinely needs two distant positions on screen at once:

| Key | Action |
|---|---|
| `Enter` | Fly into the focused spread, fill the view |
| `Esc` | Back to the wall |
| `⌘\` | Split the focus frame — pull a second spread in beside this one (`pane.split`) |
| `⌃h/j/k/l` | Move between split panes (`pane.focus`) |
| `⌘⇧\` | Collapse back to one |
| `⌘\` (in a spread) | Toggle split ⇄ unified rendering |

`PaneTree.js` is 251 lines with **44 passing assertions**, exact-tiling invariants, ratio-preserving collapse, directional neighbour, and a tested serialize round-trip — and it has **zero callers outside its own handler file**. This is binding, not building. `CameraDock.serializeFrame()` exists at `:1056` with zero callers repo-wide; `SessionStore` will call it.

## 4.5 The keyboard map (complete)

```
NAVIGATE
  ⌘1..⌘9      fly to file N            ⌥→ / ⌥←     next / prev file
  n / p       next / prev HUNK          Enter        open focused spread
  Esc         back to the wall          ⌥←(back)     camera back (pose ring)
  ⌃`          next changed since seen   `            fit all

REVIEW
  ⌘Enter      mark reviewed             ⌘⇧Enter      mark reviewed + advance
  w           WHY — the agent's reasoning for this hunk
  ⌘⇧D         change the changeset (worktree / HEAD~1 / ref..ref)

EDIT
  click       place caret → opens the REAL file beside the spread
  ⌘S          save                      ⌘Z           (not in v1 — see §5.5)

SEARCH
  ⌘K          palette (files, commands, agents, changed files)
  ⌘F          find in this changeset — lights every matching spread
  ⌘⇧F         find across the repo

PANES / WINDOWS
  ⌘\          split the focus frame     ⌃h/j/k/l     move between split panes
  ⌘⇧\         collapse                  ⌘T           new terminal

HELP
  ?           which-key overlay — renders the binding table 1:1
```

`app/client/keymap.js:14` has said *"The table is exported so a which-key / `?` overlay can render it 1:1 — the bindings ARE the documentation"* since the file was written. `NAV_BINDINGS` has exactly one consumer. The overlay is ~40 lines and it retires most of the vocabulary problem in one stroke. Build it in Stage 0.

`keyboardRouter.js` is built for exactly this — one capture-phase listener with an ordered, composable tier list that already yields wholesale to DOM inputs and already has a chord matcher at tier 0. These bindings are a table plus one tier, not a rewrite.

## 4.6 Search

Three scopes, and the third one is new to the world:

1. **`⌘F` — find in the changeset.** Hits highlight simultaneously on *every* spread on the wall while the roster filters to matching files. This answers the standing HN objection to graphical dev surfaces ("you can't search it") by doing something the text editor cannot: showing you that your term appears in 6 of 14 changed files, as lit bars, at once. `Enter`/`⇧Enter` cycle hits across files. Thin composition over `highlight.token`.
2. **`⌘⇧F` — find across the repo.** Binds the existing streaming relay walker (`cli/fssearch.go`, 10 passing Go tests + 36 JS assertions). **Plus the missing egress:** a `search.open <n>` verb that does `sheet.focus <path>` + `edit.goto <line> <col>` so a hit lands on the real editable file. Today `SearchBook` never calls `setSourcePath`, so a hit flies you to an unsaveable card the LSP ignores — this is a closed loop you can enter but not exit.
3. **`⌘K` — the palette, unchanged.** It is the most finished surface in the repo: fzf v2 over all registered verbs plus nouns, every row subtitled with the literal verb line it will run, locked by both `tools/palette-rank.test.mjs` and a real DOM-driven `tools/itests/palette.itest.mjs` that asserts the camera actually flew. It stays as the escape hatch to everything hidden, which is *why* hiding 200 verbs costs nothing.

New palette nouns for v1: changed files (`auth.js — +31 −9, agent-1`), agents, and terminals. Everything registered is already indexed automatically.

## 4.7 What the 3D field is FOR vs what stays 2D

This is the discipline that keeps the renderer honest.

| 3D (the wall) | 2D (dockview chrome) |
|---|---|
| The spreads — because there are 14–40 and they must be simultaneously present at stable coordinates with a *continuous* size gradient | The Changes roster — a list is the right shape for an ordered set of names with counts |
| Live terminals and their output | Settings, Monitor, the palette, the status bar |
| Agent transcript pages, when you drill in from a hunk | The which-key overlay |
| The repo tree, dimmed, far back — an address space, not a feature | The file tree, when you want it |

**The spatial argument, stated so it can be attacked:** at wall distance the first act of review is *"which files moved and how much"* — a shape question (red/green bar density × ink mass), not a text question. The far-texel LOD path (average syntax color × ink density per texel, energy-conserving mips, oracle-locked bit-exact by `tools/far-texels-check.mjs`) computes exactly that. Then you fly in and **the same object** is real, selectable, LSP-aware text. No zoom level to choose, no mode change. A 2D tool must pick a rendering per zoom; this one does not.

Two honest caveats you should hold, not hide:
- At N=14 a 2D CSS grid of mini-diff cards captures much of the "see the shape" value. The renderer becomes non-negotiable above ~30 spreads (multi-agent days, a big PR) and in the survey-and-read *continuum*.
- `git diff --stat` also answers "which three files did the work" in two seconds. The wall's advantage over `--stat` is that the answer and the reading surface are the same object, and that it persists and updates. Say that, don't oversell the glance.

---

# 5. The build plan

## Stage 0 — the next session (one afternoon, ~5 edits)

**Goal: the product exists.** After this, `diffwall` in a repo opens onto your working tree, laid out, and a stranger's first frame is a changeset instead of a VRAM statistics panel.

| # | Change | File | Size |
|---|---|---|---|
| 0.1 | `opts.inactive = def.id !== 'changes'` (for now: `!== 'files'`) in `buildDefaults` | `app/IdeDock.jsx:99-105` | 2 words |
| 0.2 | With no saved session: `delta.git` → `camera.fitall` before handing over the mouse; fallback chain per §4.1 | `app/client/CommandProvider.jsx` (~:755, served root already resolved pre-restore), `app/client/SessionStore.js` | ~30 lines |
| 0.3 | Auto `delta.watch` on lane creation — one call at the `ensure()` path. `delta.watch` has **zero callers** today, so `ingestTool` (already tapped at `agentCommands.js:207`) returns early on every event and the diff book never fills | `app/commands/handlers/agentCommands.js` | 1 call |
| 0.4 | `?` which-key overlay rendering `NAV_BINDINGS` 1:1 | `app/client/keymap.js`, new `app/client/WhichKey.jsx` | ~40 lines |
| 0.5 | Bind `⌘S` → `file.save`. The verb is production-grade (mtime lost-update barrier, truncation barrier, fsync'd atomic rename preserving mode, 4 passing Go tests) and has **never had a keybinding** | `app/client/keyboardRouter.js` | ~10 lines |
| 0.6 | Delete the always-erroring verb families (`select.*`, `group.*`, `nav.status`, `field.list`, `navigationCommands`' tour half); add duplicate detection to `CommandRouter.register` | `app/commands/handlers/*`, `CommandRouter.js:50-52` | ~1 hr |

**Also fix in the same pass, because they are one-liners and they are currently red:**
- `tools/camera-focus-docked-check.mjs:31` and `tools/term-geom-persist-check.mjs:136` stub `cameraDock.has` while the code now reads `ctx.holderOf` (`cameraCommands.js:67`, `SessionStore.js:92`). Two regression guards — including the one that exists specifically to prevent the session-restore camera clobber — have been silently dead since a refactor. Fix the stubs.
- Add `"test": "for f in tools/*.test.mjs tools/*-check.mjs; do bun $f || exit 1; done"` to `package.json`. There is currently **no CI, no `.github`, and exactly one npm script (`serve`)**. That is why nobody noticed.

## Stage 1 — the review loop closes (~1 week)

**Unlocks: you can finish a changeset in it.**

- **Changes panel** — one dockview panel, roster by churn, `+N −M` per row, reviewed checkbox, click-to-fly, agent attribution column. Model it on `app/FileTree.jsx` and `app/AgentsPanel.jsx`. ~200 lines.
- **Reviewed bit, persisted.** `review.mark` / `review.unmark` / `review.next` / `review.stats`; rendered as a dimmed spread and a roster checkbox. **`grep -c delta app/client/SessionStore.js` returns 0** — delta sets are not persisted at all today, so add a `delta` section to `capture`/`restore` (by reference: set kind + ref + reviewed set, not content). ~150 lines. *This is the return-frequency mechanism; it is not optional.*
- **`camera.back`** — a pose ring buffer pushed on every `flyTo`, bound to `⌥←`. `ViewerCameraController.js:413-436` `getState`/`applyState` is already a complete serializable pose. ~40 lines. Without it every navigation is a one-way teleport and exploration is punished.
- **The keymap** (§4.5) as a table plus one `keyboardRouter` tier.
- **Error surfacing.** Today only `RepoPanel` and `MonitorPanel` read a command result; every other click discards `ERR`. The Changes panel must surface `delta.git` failures or the carefully-designed empty state never renders. Add a status-bar error channel (`StatusBar.jsx` currently cannot show an error at all — `ctx.status` clears in a `finally`).
- **A React error boundary.** `grep -rn "ErrorBoundary|componentDidCatch|getDerivedStateFromError"` returns zero hits across `app/` and `packages/`; `tools/itests/boot.itest.mjs:3-5` documents that one undefined variable in one panel takes down the whole tree.

**Verbs promoted to UI:** `delta.git`, `delta.list`, `delta.files`, `delta.close`, `book.page`, `file.save`, `camera.focus`, `camera.fitall`, `sheet.focus`, `edit.goto`.

## Stage 2 — provenance (~1–2 weeks) — **the differentiator**

**Unlocks: the thing nobody else can build.**

- **`case "Notification":` in `cli/hook.go`.** Verified: the switch at `hook.go:83,95` handles `PostToolUse`, a no-op `PreToolUse`, and `Stop` — nothing else. Claude Code's `Notification` event is the one that fires when an agent needs a human. `agent.request` and `lane.beacon` already exist and land correctly; `grep` confirms **zero emitters repo-wide** — the hand can only be raised by a human, about an agent, which inverts the entire point. ~15 lines of Go, and it is the highest-leverage change in the codebase.
- **`diffwall hook install`** (writes the `settings.json` block for Claude Code / Kimi) + **`hook.status`** heartbeat the roster reads. Today the entire live half is gated behind reading Go source, and `hook.go` calls `os.Exit(0)` on no stdin (`:53-56`), bad JSON (`:60-63`), and failed relay connect (`:75-77`) — a misconfigured hook is behaviorally identical to a working one. This converts three WIRED capabilities to SHIPPED and is the difference between a product and a repo.
- **Per-hunk attribution.** For watch sets this is free — `ingestTool(agentId, …)` makes the set id the agent id. For git sets, build a `path → [{agentId, toolRecord, ts}]` index from `AgentBooks` / `cli/sessions.go` and attach it to entries. ~200 lines.
- **`w` = why.** New verb `delta.why <path> <line>`: resolves the hunk → the tool record that produced it → pages that agent's book to it with the preceding thinking block, standing it beside the spread (Rule 1: nothing is displaced). All the parsing exists — `toolRegistry.js` (58 passing assertions) is one shared semantics table used by both the live hook and the archive parser specifically so they cannot drift.

## Stage 3 — the wall stays open (~1–2 weeks)

**Unlocks: you don't close it.**

- **The change ledger.** Per-surface `lastChangedAt` + delta counter, fed from signals that already exist as real subscribe hooks: `TerminalGrid.onBytes` (`:676`), `AgentBooks.onChange`, and the relay's `fs/didChange` notification. Surfaced as (a) a spread rim that **warms with time-since-*you*-last-looked and cools on focus**, and (b) one line in the status strip. ~200–400 lines. Note the encoding is deliberately *relative to the observer* — it measures neglect, not activity, which is why it beats a red dot.
- **Lifecycle as geometry.** `AgentBooks.js:920` is verbatim `_setState(lane, state) { if (lane.state !== state) lane.state = state; }` — a bare field write, so the 3D scene renders a stalled, active, and finished agent identically, and the only surfacing is one word of text on a background tab. Give state a visual consequence. Widen the 6-hue identity palette (`AgentBooks.js:96`) past 8 so agents 7+ stop silently sharing a color.
- **Persist the beacon and the lane state.** `SessionStore.js:287-297` saves session/prefix/head/following/limit/pinned — no beacon, no state. Every reload erases every raised hand, on a screen meant to stay open all day, in an app that reloads *itself* on device loss.
- **Terminal identity.** `terminal.rename` + auto-titles from tmux (`#{pane_current_command}`, `#{pane_current_path}`) shipped on the existing 2s liveness tick. **Verified: none of the 16 registered `terminal.*` verbs is a rename.** At ten shells the bar reads `term-1 · 80×24` ten times; this is the single fact that kills the wall at N=6.
- **Two correctness fixes that block daily use.** (a) `cli/relay.go:996,1001,1023,1072` write JSON *directly* to the display connection from `spawnTerminalAdapter`/`recoverTerminals` while `startDisplayWriter`'s goroutine concurrently writes output frames — a gorilla/websocket concurrent-writer data race on every `＋` press, most likely to fire exactly when other terminals are streaming. Route both through the single writer. (b) `termSeq` is in-memory (`relay.go:38`) and repaired only inside `recover`, so after a relay restart `＋` mints `term-1`, `ensureTmuxSession` finds `glyph-term-1` already exists and **attaches to the stranded old shell** instead of opening a fresh one. Fire `terminal.recover` automatically on reconnect.

## Stage 4 — edit in place, safely (~1 week)

**Unlocks: it's a work surface, not a viewer. This is the step every dead 3D visualizer skipped.**

**Do not do what Review Table's plan says.** `setSourcePath` on the recto grid is not a one-line change; it is a file-corrupting change. Verified: `DeltaBooks.js:224` builds the recto text from the *aligned* array, which contains `{type:'spacer', text:''}` rows and `{type:'hunk', text:'@@ …'}` rows. `gridToText` (`fileCommands.js`) is a bare join with no guard, and the relay's stale-write and truncation barriers both pass. That is the same bug class as `grid.window` → `setWindow` → `this.lines = slice.split('\n')`, reproduced at the product's headline gesture, in a repo with **no undo, no dirty indicator, and no beforeunload guard**.

**Do this instead — it is cheaper, safer, and better product design:**

Every `DiffLine` carries `lineNo` (`DiffParser.js:16`), and every delta entry carries `entry.path` (`DeltaBooks.js:229`). So clicking a head-page line fires:

```
sheet.focus <resolved path>   →   edit.goto <lineNo> <col>
```

The **real** file grid — full context, tree-sitter colors, LSP definition/references, `_relayoutPreservingCursor`, the atomic-save barriers — flies in and **stands beside the spread** (Rule 1). You fix the line, `⌘S`, and the spread updates from disk on the next `fs/didChange`. Zero new reconstruction logic, zero corruption risk, entirely shipped verbs.

Mark the diff pages read-only in the picking policy so the existing dblclick→`edit.goto` path (which routes today, because `_wirePagePick` at `DeltaBooks.js:484-494` registers them as `type:'grid'` and `gestureResolver` branches on `type`, not `role`) cannot drop a live caret into a spacer row.

Also in Stage 4:
- `⌘F` / `⌘⇧F` per §4.6, plus the `search.open` egress.
- `PaneTree` bound to `⌘\` and persisted via the existing-but-uncalled `CameraDock.serializeFrame()`.
- **Thumbnail LOD.** Below a viewport-fraction threshold, stop running the full `applyScreen` cell loop and the full instance rewrite per output frame. Cheap first move: `TerminalGrid.js:124` has `_depthEnabled = options.depthHistory ?? true` with `depthMax 80`, so an 80×24 shell allocates `cols*rows + cols*80 = 8320` instances where 1920 would do — default depth **off** for wall-distance tiles and 77% of that budget evaporates in one line.
- **Measure it.** A headless N-surface frame-cost check in `tools/`. The defining workload — 14–40 simultaneously mutating surfaces — has literally never been measured, and both delta suites currently run headless emitting *"no pipeline arena — renders EMPTY."*

## 5.5 Deliberately not in v1

- **Undo.** Real hole, acknowledged. There is not one line of undo machinery in the repo — no history stack on `CodeGrid`, no edit journal, no `edit.undo` stub. v1 review edits are typo-shaped and go through `sheet.focus` into the real file, so `git` is the safety net. If the two-week test shows people making *large* edits on the wall, undo becomes item 1 of v1.1, not before.
- **Replace / multi-cursor / text selection.** Same reasoning.
- **Cross-terminal scrollback search.** Deferred to v1.1, and when it lands it must be relay-side `capture-pane -p -S -` across `glyph-*` sessions — `TerminalEmulator.js:49` sets `scrollback: 0` deliberately because tmux owns history, so the browser holds only 24 visible rows per pane. The Deepmux pitch's architectural justification for this feature is simply wrong.
- **Anything about "mission control."**

---

# 6. Vocabulary

| Internal term | User-facing term | Notes |
|---|---|---|
| `glyph3d` | **Diffwall** | The renderer keeps its name internally; the product does not carry it. Naming the product after the substrate is the substrate trap in one word. |
| `CodeGrid` / "grid" | **file** | `"close / remove this grid"` → `"close this file"`. Leaking everywhere today: `HudPanel.jsx:272`, `FileTree.jsx:403`, `EditorPanel.jsx:126`. |
| `sheet` (WorkspaceModel) | **open file** | |
| `sheet` (Book page-pair) | **spread** | Two words for one thing today; this one keeps the metaphor, the other loses it. |
| delta `Book` | **changeset** | `delta:git` → `worktree`, `delta:agent-3` → `agent-3's changes`. |
| agent `Book` | **transcript** | |
| `lane` | **agent** | |
| `carrel` | *(never shown)* | Machinery kept, word deleted. Nothing in-product defines it and the empty state explains it with the same words. |
| `field` | **the wall** | |
| `splay` / `deck` / `volume` | *(deleted from surface)* | |
| `strata` / `z-pages` / `newspaper` / `long-column` | *(deleted from surface)* | Four layout-mode chips in an unlabeled row in a 210px floating box. |
| layout `scheme` (`jellyfish`, `district`, `walk`, `packed`, `tree`, `library`) | *(deleted from surface)* | `packed` stays as the internal algorithm. |
| `CameraDock` | **pinned** | "Pin this to keep it with you." |
| view-`frame` | **focus** | `frame` currently means three different things. |
| dockview `panel` | **panel** | Keep — it's fine and it matches VSCode. |
| `attention.primary` / `.key` | **focused** / **typing into** | Verbs keep the names; the UI never says "attention slot." |
| `book.page` / `book.limit` | **page** / **keep N** | Keep the verbs, plain-English the labels. |
| `⊞` (hover-revealed, 12px) | **`open in 3D`** — a persistent, labeled button | The cold-open report found the product's best moment behind this glyph at 3:40. |

---

# 7. The 30-second demo

One continuous screen recording. No narration. Captions only. The first eight seconds contain no cursor.

**0:00–0:05 — the hold.** The wall. Fourteen spreads, before on the left of each, after on the right, red and green bars. Camera static. Mouse cursor is not in frame.
> caption: *nobody is touching this*

**0:05–0:08 — it moves by itself.** One spread's plate ticks from `+12 −4` to `+31 −9`; its green bars grow. Another spread appears in an empty slot. The status bar ticks `14 files` → `15 files`. Nothing else moved.
> caption: *an agent is working*

*(This is the most valuable five seconds in the film. Every dead 3D code visualizer — CodeCity with its measured +24% correctness, Sourcetrail, Primitive — died of being consumed once. This beat proves return-frequency with no words, by making the only thing that moves be the world rather than the operator.)*

**0:08–0:12 — the shape.** Slow pull-back. Three spreads are dense with color; eleven are nearly blank.
> caption: *three files did the work*

**0:12–0:17 — fly in.** Click the densest spread. It fills the view: base left, head right, aligned line for line, hunk headers tinted, changed lines the only color. Obviously real text, not a texture.

**0:17–0:22 — THE MOMENT.** Cursor lands on a hunk. Press `w`. Beside the spread, the agent's own transcript unfolds to the tool call that made this change, with its reasoning above it: *"the test was asserting on the fixture's id, which the refactor renamed — updating the assertion."* Nothing else on screen moved.
> caption: *why it did that*

**0:22–0:27 — fix it.** The reasoning is wrong: it deleted the assertion instead of fixing the fixture. Click the line on the head page. The **real file** flies in and stands beside the spread. Type the correction. `⌘S`. Status bar: `saved cli/relay_test.go`.
> caption: *it's the real file*

**0:27–0:30 — out.** `⌘⇧Enter`: that spread dims, camera flies to the next bright one. `Esc`: back to the wall — four dimmed, ten bright, and in the corner another spread ticks up, untouched.
> caption: **Every change your agents made, and why.**
> `brew install diffwall`

No logo. No "3D." No "spatial." No "mission control."

---

# 8. What to tell people it is

**README, first paragraph — replacing "Status: v0.2.0, pre-release. The core library API is still settling."**

> # Diffwall
>
> **Diffwall is where you review what your coding agents wrote.** Run it in any repo and it puts every changed file up at once — before on the left, after on the right — instead of one scrolling page at a time. Click any line and it shows you the agent's own reasoning for that change, pulled from the transcript on your disk. Fix the line right there; it writes to the real file, atomically. Leave it open and the wall updates itself as your agents work.
>
> It runs as one binary next to your editor. It is not an editor and does not try to be one.
>
> ```
> curl -fsSL https://github.com/tikimcfee/diffwall/raw/main/tools/install.sh | sh
> diffwall ~/your-project
> ```

**Fix in the same commit** — the current install story is broken in both directions:
- `.gitignore:39` excludes `cli/go.sum` and it is not tracked, so `make build` — the exact command `README:83` prescribes — fails on a fresh clone with 7 `missing go.sum entry` errors. Either commit `go.sum` or make the Makefile run `go mod tidy`.
- `tools/install.sh` works, against real published releases (v0.3.0 verified live), and is referenced in **zero** documentation files.
- `README:14` says v0.2.0, two releases stale.
- `cli/go.mod:3` declares `go 1.26.1` while `CONTRIBUTING.md:16` promises `Go ≥ 1.21`.

One gitignore line and one README section separate this repo from a genuine two-minute install. Everything downstream of that first command is far more finished than the first command implies.

---

# 9. How you'll know if this is wrong

Ship Stages 0–2. That's the wall, the roster, the reviewed bit, and `w`. Give the binary to **five people who run 3+ agents daily**. Measure exactly one number: **how many open it again on day three.**

Not "did they like it." Not "was it fast." Return frequency is the metric that has never been optimized here and it is the one that decides everything — it's what CodeCity's +24% correctness didn't have, and what killed every viewer in the graveyard.

Three of five come back → you have a product and every remaining question is ordinary engineering. Zero come back → you learned in three weeks what eight years of substrate work could never tell you, and the honest fallback is narrow and real: ship `w` alone as a CLI (`diffwall why <file> <line>` printing the agent's reasoning for a hunk) and see if *that* gets used.

**Three things to hold while you build:**

1. **Assume no individual ever pays.** Vibe Kanban died April 2026 with thousands of daily engineers because "the vast majority are free users." Crystal deprecated February. Terragon shut January. Conductor raised $22M in March and is still free. Sourcetrail's 2021 autopsy named the only exception — "except maybe from the security/compliance/productivity angle." If Diffwall ever has a buyer, it is a team lead auditing what a fleet of agents merged last week, not the dev. Publish the binary, skip the company, and let that question answer itself.
2. **Never let the economics depend on a harness subscription.** Anthropic blocked third-party frameworks from Pro/Max on April 4 2026 (135k+ instances, reported 50x cost jumps), then readmitted them behind a capped credit pool at full API rates. Your relay and command bus are already harness-agnostic. Keep them that way; the archive path (`cli/sessions.go`) reads files on disk and needs no API access at all.
3. **The blocker was never competence.** The binary ships. The failure engineering is production-grade — a log storm brake locked by a test, an occlusion-query fault guard, device-loss recovery with a sessionStorage loop guard, per-phase restore quarantine with the dated data-loss incidents that motivated each guard written in the comments. Measurement precedes optimization. The 273-verb bus is a rare agent-drivable asset that most GUI apps are frantically retrofitting right now and doing badly.

What has been missing is one choice, and the reason it stayed unmade is that making it means shelving "a 3D IDE" — the dream that carried SwiftGlyph and now this. That's a real loss. Name it as a loss rather than as an open technical question, because every *"but first the load path needs…"* is one more month of not having to.

The renderer isn't being abandoned. It's being pointed at the one job where "many live text surfaces, simultaneously legible, at near-zero marginal cost" is a **requirement** instead of a novelty — and where the content changes while you're not looking, so you look again.

**Start with Stage 0.6 and 0.1. Two words in `app/IdeDock.jsx:99-105`, and a boot path in `CommandProvider.jsx`. Time-to-value goes from 3 minutes 40 seconds to zero this afternoon.**