# Planes and carrels: handoff (start here)

Written 2026-11-01 at the end of a long session with Ivan, so the next run starts with the
drive as well as the facts. This is the seed of the design doc for the `planes` branch.

## The drive

Ivan's words, from the conversation that set this off:

> "I'm basically thinking of what a 2D terminal with tabs gives folks, and a standard window
> manager. Something about everything being.. orthographic? flat?.. in the same plane makes it
> mappable. Text is readable, images are viewable, and any perspective problem is non-existent
> because it's just pixels in an X/Y plane. We need the same version here."

> "Visual pane-slices of agents, files, terminals, recorded desktops, etc. This is kinda like
> macOS' stage manager … Instead of a 2D window manager with desktops and windows, it can be a 3D
> space with stacks of desktops. … The desktops are still 3D sessions, some that just happen to be
> 2D planes of windows, others are files, etc. A use case for our `carrels` idea that would help
> with keeping groups around."

> "There was a while where I was using this tool a lot with the multi-terminal dock just because
> having them visible was useful — I want to get back to that level of functionality, where I'm
> in it again, using it, pointing you at things, you suggesting changes to me. We're so close."

> "In the LLM world, two ideas that are super spread out in vector spaces suddenly become an
> incredible insight that gets expanded into something entirely unique. That's where this can go."

> "Let's make it something that you spend as much time on researching on as you'd like —
> testing, implementing, and retesting and rebuilding … work through all of workflows,
> corroborate with your workflow agents and local `agent` helpers. Build it out. Then optimize it.
> Make it work. Give yourself test handles. Give yourself better test tools, and spawn agents when
> you need new ones. … the goal is an implementation. You have months of ideas from me and you,
> months of tests and failures and scrapped trials. Let's see what you can do."

The mandate, in full (Ivan restated it after a compaction lost it; it is also the session /goal —
"plan it out, do the research, put it all together without stopping for me. That's the magicka"):

> "I love it so far. The shared sessions attaching to carrels with terminals and desktop windows
> in them in pretty sick. We already have desktop capture and we haven't really updated it in a
> while. In fact I think it's broken at the moment. I can imagine an agent's carrel having tmux
> sessions, a few desktops it owns for windows and testing or comunication channels, all kinds of
> stuff. Something about the orthographic view and the parallax effect idea seems powerful too.
> We can drop the hand control stuff, just entirely. … I would be careful with prior art, since
> that's mostly memory that you will dig back into, but there's perhaps some time to play with. I
> say have at it. I'd also suggest passing this on to a couple agent agy sessions to spread the
> load out - Argon is perfectly fine to use for this too. … Let's make it something that you spend
> as much time on researching on as you'd like - testing, implementing, and retesting and
> rebuilding … work through all of workflows, corroborate with your workflow agents and local agent
> helpers. Build it out. Then optimize it. Make it work. Give yourself test handles. Give yourself
> better test tools, and spawn agents when you need new ones. You can look at the makepad style of
> how this is done for rust. The only reason I'm saying we do it in the JS land first is because
> the JS has stuff you can already use that's more mature in terms of composed objects. But still -
> the goal is an implementaiton. You have months of ideas from me and you, months of tests and
> failures and scrapped trials. Let's see what you can do."

**Success** means Ivan uses glyph3d daily again: agents, terminals, files and desktops visible and
readable together, him pointing at things, agents pointing back. It does NOT mean a design doc.
The design is a means to that.

## Why: the problem it solves

The agent books work (they scroll, the rising deck helps) but they aren't READABLE. Text needs
about 10–14 px on screen. A book far enough away to read as an object in space sits below that, so
3D-observable and 2D-readable fight each other. Every layout trick so far (deck, splay, the
proposed tape/reel) rearranges pages inside perspective. The way out: stop letting 3D distance
decide how big text is.

## The model we converged on

- **The world is planes; 3D is how they're arranged.** Two layers with different jobs:
  - **Space** = memory and travel. Perspective, flying, places. Position IS memory (method of
    loci): "the relay agent is over there by the terminals." Space doesn't try to be readable. It
    gets **map-style labels** instead: text sized in screen pixels, pinned to world anchors,
    decluttered by priority (focus, recency, agents waiting on you). Cartographic label placement.
  - **Plane** = reading. Enter a surface and the camera squares to it, then perspective eases into
    **orthographic at 1 world unit = 1 screen pixel**: a window manager. Panes, tabs, scrollback,
    pixel-sharp text, images at true size, no foreshortening. The transition is continuous, so
    you never lose your place: a curved desk unrolls flat as you approach and curls back on leave.
- **Carrels are the desktops** (Stage Manager in 3D). A carrel is already a durable group (held
  membership, per-instance tuning, saved and restored, placed in the world). New: a FORM for being
  entered.
  - `plane` carrels flatten into a tiled pane layout: agent runs as scrollback panes with a step
    tab strip, terminals, code grids, video/desktop-stream panes.
  - `space` carrels (code trees, libraries) stay 3D when entered.
  - From space: carrels are the stack of desktops around you (the gomuxai hub cylinder is that
    ring), each a live miniature with labels. Inside one, the others stay visible at the edges
    (Stage Manager's strip).
- **Depth is free in orthographic.** Under ortho, farther ≠ smaller, so z on a plane can carry
  TIME (a file's history, an agent's earlier turns, scrollback) or LAYERS. A small tilt fans them
  out with parallax like a deck of slides, then they flatten back. Books already store time as
  depth. Ivan flagged this as powerful.
- **Shared sessions.** A carrel is like a tmux session for everything: persistent, detachable,
  attachable. An AGENT's carrel holds its tmux sessions, desktops it owns (for windows, testing,
  communication channels), its book. Agents attach to carrels and work in them while Ivan
  watches. Ivan: "pretty sick."
- **Shared pointing (deixis).** Make "this / that / over there" a two-way primitive on the
  command bus (attention slots are already addressable). When Ivan points at a pane, line or page,
  any agent resolves "this" to an exact reference. When an agent suggests a change, it points back:
  a highlight or ghost cursor at the exact line in Ivan's plane. Like Figma multiplayer cursors,
  with agents as the other players.
- **Far planes as impostors.** Draw distant carrels as image cards refreshed now and then, like
  game-engine LOD and Stage Manager thumbnails. Hundreds of desktops cheap, only the entered one live.
- Smaller ideas still on the table: "less text, never smaller text" (a sheet below reading size
  swaps to its one-line summary at a readable size); books leading with the agent's replies, calls
  as compact rows; the tape/reel book form as a `space`-form book.

## Decisions and constraints

- **Hand control is DROPPED entirely** for this work ("a whole 'nother can of worms"). Code from
  that arc is committed (1b15518 on the-backport); its helpers are retired.
- **Desktop capture exists but is probably broken.** Fix it early: agent carrels with owned
  desktops depend on it. (See the desktop-stream gomuxai agent and the gx- screen
  path in CLAUDE.md's gomuxai hub section.)
- **Prior art on a short leash.** It's mostly recollection. Corroborate against the repo, the
  memories and the tests before leaning on it. Some time to play with it is fine.
- **JS first** (its composed objects are more mature); the goal is an implementation. Look at
  makepad's approach for how the Rust side does this later.
- **Agents:** workflows (Ivan opted in explicitly; scale is fine: "as many agents as we want, as
  long as we want"), local `agent` helpers, and a couple of `agy` sessions. The Argon model is
  fine; `agent spawn` has no model flag, but `agy` takes `--model`.
- **Build test handles first-class:** verbs for every primitive, headless gates, pixel checks.
  Build better test tools when the existing ones aren't enough.
- Repo rules still hold: command-bus-native, no shims or aliases, fail loud at seams, constants
  born configurable, JSDoc types, no host details in tracked files (public repo).

## The plan as proposed (Ivan said "have at it")

1. **Design (workflow).** Lenses in parallel: zoomable UIs and semantic zoom; window managers
   (Stage Manager, Exposé, tiling WMs, tmux); spatial computing (visionOS windows, volumes and
   spaces); spatial memory; multiplayer presence and pointing; game-engine LOD and impostors; OUR
   OWN history (the repo, memories, why the multi-terminal dock worked). Then deliberate
   COLLISIONS (pair distant lenses, write what each pair suggests), several divergent "a day in
   this tool" session narratives, then critique and converge into a design doc: the core
   primitives, the user's session, buildable slices.
2. **Build:** slices with tests, starting with `carrel.enter <name>` on a plane-form carrel
   (PaneTree tiling + ortho pixel-exact snap; `carrel.leave`). Then agent scrollback panes,
   desktop capture repaired, shared carrel sessions, deixis, map labels, depth-as-time.
3. **Optimize and iterate:** measure, rebuild what doesn't hold.

Builds on what exists: `Carrel` (durable, `tuning.js`, `Holding`), `PaneTree` (BSP),
`CameraDock`, reverse-billboard focus (`_planeOf` / `_billboardPose`), the 2D companion views,
terminals as `TerminalGrid`s, `AgentVisibility` (show/hide, 315b4a0), the gomuxai hub.

## Progress (2026-11-01 night, CF + helpers; Ivan away, /goal active)

### SETTLE PHASE (2026-11-02 ~15:30) — READ FIRST
Ivan: "Let's settle our current feature sets and usability first … make it clean for both of us before
either of us start building on top of them." NO new features or tour stops (pointing, answering wait).
Fixed + live today: e3e2e9a desk carries the view (blank team desk) · 4e2d27c strip real click ·
8e58135 key-run verb errors on the status line · af61327 + ca89689 local times · 94f5918 strip =
collapsible scrollable list of every desk (Ivan: "working well now!").
SETTLE LIST (open):
- DONE: 5f50d55 pan reaches the whole desk · 5b2ce59 strip labels · 35be3be map tags clear the strip.
- [gomuxai agent + scroll] edit-and-resend shows both prompts: BOTH SIDES BUILT, uncommitted; gomuxai
  commit/install waits on Ivan; then commit scroll's 10 files (agent-events needs gomuxai's rewind case).
- pan has no bound (a fling can lose the desk) — asked Ivan.
- team desk clutter: ghost seats, finished helpers' books, nested helper desks (carrel.settle safe now).
- agent screens wider than the canvas (my 239 cols ≈ 1,912 px vs ~1,869): pan / tiles / fit width?
- pick.at over a scroll book answers "nothing pickable" though it reads (tooling, not felt).
- keys.trace is ON on Ivan's display (turn off when settled).
Waiting on Ivan (not now): push/merge, gomux.input, plane.ortho default, hand-code deletion.

### NOW (2026-11-02 ~10:50) — READ FIRST after compaction: Ivan is BACK, touring LIVE

- Ivan is in his own browser (Vivaldi) on the planes instance: Vite :5173, relay :8080, `?relay=8080`.
  The agents' headless display (tmux `planes-display`) is STOPPED — never restart it while Ivan is on
  (the relay takes one display). Don't move his camera without announcing; he hard-reloads when asked.
- `/goal` is CLEARED. Ivan's way of working now: a guided TOUR, one stop at a time; he reports what he
  sees; I fix (via helpers) and re-verify before showing the next stop. He asked to "flow cleanly so you
  don't have to jump around" — verify each stop myself (screenshot verb on his display, scene.at/pick.at,
  carrel.check) BEFORE taking him there.
- Tour stops: 1 hub center (`carrel.enter gomux`) — FIXED, reads as a ring of scroll books with
  nameplates (8eb8076); 2 my desk as a plane (`carrel.enter gomux/glyph3d-js-root`) — BROKEN NOW
  (see bugs); 3 `depth-probe` (Book.js + 5 revisions; Ctrl+Space hold or prefix-f = fan) — works;
  4 team channel (`team.channel glyph3d-js-root show`, pinned on my desk) — blocked by the broken desk;
  5 answering (needs Ivan's OK to set gomux.input on his display) — pending; 6 pointing (point.show) —
  not shown yet. `reading` desk works (plane-live-check 7/7).
- OPEN BUGS:
  * BLANK TEAM DESK (camera helper on it, URGENT): `carrel.enter gomux/glyph3d-js-root` shows nothing;
    pick.at grid all empty; scene.at "the ray meets nothing between near and far"; carrel.check says all
    11 members in seat at local z −830. Read fine ~09:00, before 8eb8076 (front-face anchor, airspace =
    union of members, hub radius floor, hub books scroll). Ruled out: radius floor, card system; a
    carrel.settle made it worse. Live session copy: scratchpad/session-blank-desk.json.
  * STRIP CARD CLICKS do nothing in his real browser (pixels helper on it; gate = real playwright click).
  * Channel timestamps show UTC (16:29) not local — queue (scroll helper's TeamChannels).
  * Key-driven verb errors are silent (e.g. Ctrl+Space Tab → carrel.back ERR "no carrel to go back to"
    never shows) — needs a HUD/toast line for keyboard-run verb results.
  * The team desk holds ghost seats + old helpers' books + nested helper desks → cluttered; consider.
  * keys.trace is ON on his display (turn off: `keys.trace off`).
- Commits since ~08:50: 3645fe1 (answers signed as the person), 3b5ac32 (plane click/keys), 7561bd8 (tag
  jitter), d5bd022 (fan toggle prefix-f + keys.trace), 8eb8076 (hub scroll books 5a / front-face anchor /
  radius floor / strip previews — LIKELY the blank-desk regression). HEAD green (105/105 verify-staged).
- Helpers (idle unless noted): camera (blank desk), pixels (strip clicks), scroll, desktop.


Design: docs/planes/DESIGN.md (workflow-built, critiqued, revised — §6 slices, §8 open questions).
Local commits on `planes` (none pushed): 966871d plane view · 2c23529 cell-grid pen fix ·
2f0badb device-px plane math + pixel-exact canvas box · cd21551 plane desks (tiling) · bdb97b7
pixel-check (pixels helper) · 56ecb1b frame repair (desktop helper) · 42cdba4 pane verbs + plane
prefix · 70414ca PIN BOARD (mode plane, viewport-free; Entered restore; ownViewOf) · 31d5049 agent
screens read in a plane (TerminalGrid metrics/pixelOrigin, book planeRowHeight, seat-order settle).
Felt property seen live: my own 239×56 agent screen pinned in the team desk plane passes pixel-check.
Later: 4e54950 agent.waiting + HUD waiting line + [usage] + tools/plane-live-check.mjs · 7b2356d
STICKY SEATS + DESIGN.md committed · 0e14f97 camera finished (camera helper) · 7e47366 frames pin
1 texel = 1 device px (checker strip exact) · 8aa07d2 every agent with a screen owns a plane desk
(gomux.teamMode) · be9a172 agent edits land in open files, reading row held (pixel-identical live).
Later still (2026-11-01 late): 2d478e1 Carrel onDeskMode hook · 02e9e51 perf: member turns land
(idle recomputes 350k/s → 60/s; `scene.transforms who`) · 4fe2e65 overlay + map labels (pixels) ·
1f4cb42 tools/verify-staged.sh · c66acb7 SCROLL FORM (scroll helper; tail-append p95 1.29 ms) ·
9dda500 per-call caller + deixis lite (camera) + relay-owned CDP desktops (desktop) · 637bdff
presence (carrel.attach/who, Participants.js) + attention refused for identified callers.
Assigned now: camera → slice 6 (briefs/slice6.md); desktop → slice 5 live felt gate + relay
fsnotify watcher (briefs/desktop-3.md; I wire AgentEdits to `fs/changed`); scroll → live pixel
check + click-to-expand + hub scroll-view save hunk; pixels → strip + CarrelCards (strip-cards.md).
NOTE: a whole-file write had reverted settings.js / CHECKS.md once; backups in my scratchpad.
LATEST+ (2026-11-02 ~08:50): 3645fe1 answering agents TESTED END TO END on a private relay + scratch shell
agent (tools/agent-answer-check.mjs 6/6) — found + fixed: the relay's `agent send` child inherited AGENT_NAME,
so the person's reply was signed as an agent; now "[from a person on <host>]". 69 local commits.
LATEST (2026-11-02 ~08:15): + bd5113f slice 10b BUILT (PlaneCamera; plane.ortho OFF by default — 1,543 px
on the focus border's inner edge differ from the 1° lens; the ortho fan slides pages rigidly), 77867e5 live
tools never move what they didn't create (a shared-mode e2e had emptied reading/depth-probe — rebuilt),
0991db0 e2e step 5 measures the layers (+ a desk read through a member stays live), e087ddf layers fit
their member and peek above the title. planes-e2e 9/9 perspective and --ortho on HEAD.
FINAL (2026-11-02 ~05:30): 64 local commits on `planes` (1b15518..HEAD), none pushed. HEAD fully green:
verify-staged 102/102, go test + vet + windows build, type-imports ok; tools/planes-e2e.mjs 9/9 on a private
relay and on the shared display; plane-live-check 7/7 with reload. Closing work: 9826eb9 one render owner,
45f828f + 0b85f0e live stillness / scroll cost (reserved window), e507c95 planes-e2e, 2e671cd panel batch
walks only shown panels (main-thread p50 5.5 → ~3 ms on the hub), 74ea36b cards ON by default (budget-fit
tiers; 15-min soak clean; live 4 min no context loss). Helpers idle (their gomux desks are the demo).
WAITING ON IVAN: gomux.input (answer agents — built, off), 10b (ortho endpoint — needs his read of the fan),
hand-code deletion (§8 q6), the other §8 questions; push/merge.
Then (2026-11-02 ~03:30): b480b39 1dec527 (batch still-skips) · 170310a 12be007 (agent-owned surfaces)
· 75a6028 (watcher, parent dirs only; FileWatch) · a9df9e6 (team channels) · 06c820d c9be246 e9eea93 (render
walk → flat root + pick lists) · fe6eb25 (strip + cards; cards OFF by default) · bd7bcdd 06fe5b8 263f059
(as-drawn terminal rows, overdrawn marks, stable hues, relay-kept points) · be03d28 (desktop driving +
restart) · 7040146 (TRY-IT.md + showcase) · 24a24af 29f8a67 (blank code grids on desks: materialize swap +
Book.release — carrel.check verb) · f26c0e1 (desks never overlap) · a6d36c9 (verify-staged trustworthy).
plane-live-check 7/7 with reload. In flight: camera → RenderPasses (one render owner); pixels → card soak
(default-on?); desktop → tools/planes-e2e.mjs; scroll → live stillness + scroll-cost tools.
Then (2026-11-02 ~01:25): 9dda500…1021e1f — identity/deixis-lite/desktops, presence + attention
refusal (637bdff), sessions re-read on a rewritten transcript, click-to-expand, nested plane desks
exact (8c79957), memory handles (scene.memory / scene.textures / SIGUSR2 heap), PaneLayout +
x-clip + chrome/pick cut + durable panes (slice 6 DONE: a0d6cdd 3e89155 9e69b12), deixis full
pieces (95e93b2: re-anchor, resolved-by-edit, typing gate), agent input behind gomux.input OFF
(6ccfaae — live round trip needs Ivan to switch it on), depth as time 10a (1b3b3b0; desk
depth-probe), group tables by use + label-batch row uploads (be8506b 568766a), books stay where
seated (1021e1f). HEAP: GC'd retained heap steady 118–124 MB over 06:35–07:15Z (the 2 GB was garbage).
In flight: pixels → strip + cards (fixed the context-loss loop + blank terminals; one more: the strip
band covers plane.enter'd surfaces); desktop → fsnotify watcher (de-flaking a test); scroll →
agent-owned surfaces; camera → frame profile on a private relay. Waits on Ivan: gomux.input, 10b.
Then (2026-11-02 ~00:10): 53874ff sessions — a follow past a rewritten transcript re-reads the
book · de8603b click-to-expand + hub scroll views (scroll) · 8c79957 nested plane desks pixel-exact
(getPlaneRect/pinAim in world units) + hub centering keeps any plane. Scroll helper → slice 10a
(briefs/slice10a.md). LOST: the `reading` + `frames` desks — frame-capture-check §4's ephemeral relay
served the worktree and autosaved over .glyph3d-session.json (desktop helper fixing: mkdtemp root);
recreate them after. Watching: textures 460→484 / geometries 272→291 in 5 min at a constant 659
scene objects (leak candidate); heap 595 MB (was 2.1 GB after a long run). TODO after next Vite
restart: carrel.settle the gomux team desks (stale deck-height pins), live-check a team desk entry.
Previously: camera → slice 2 (per-call caller + deixis lite, brief deixis.md); scroll (claude) →
slice 4 scroll form (brief scroll.md); pixels → alias removal + estimator fix, then its overlay/
labels commit; desktop → slice 5 step 3 (CDP desktops, relay binary plane).
Open: real 1.5× browser check of the canvas device box; agent input (slice 1b) awaits Ivan's yes.

Helpers (agent list): glyph3d-js-root-camera (claude; dollyAt referent, shortest arc, listener set,
fly-leaves-first, switch cut, inexact notice — owns ViewerCameraController/planeView/spatialMath/
planeCommands/cameraCommands), glyph3d-js-root-pixels (agy; screen overlay + map labels — owns
PlaneOverlay.js, MapLabels.js, labelCommands.js), glyph3d-js-root-desktop (agy; frame.pattern gate,
naturalPx, agent-owned desktops via CDP + relay binary plane). Briefs in the session scratchpad
briefs/. COMMIT DISCIPLINE: helpers don't commit; I stage only finished work, shared files as
HEAD+their-hunks blobs (git hash-object + update-index) and verify the staged snapshot alone
(git checkout-index to scratch + gates). The working CLAUDE.md = HEAD + camera's edits.

Display: tools/agent-display.mjs in tmux `planes-display` (exec; SIGUSR1 reload via anchored pkill);
the relay takes ONE display — stop it before Ivan opens his browser.

Next (slice 1 leftovers): [usage] records; felt gates (first key lands, reload-readable, switch
≤200 ms) as a live check tool; dock hide is moot (slab clips it). Then slice 1b (agent.say/approve/
deny — waits on Ivan's yes, open question 1; the waiting line doesn't), slice 2 pointing-lite.

## Setup state

- Worktree `~/dev/glyph3d-js-planes`, branch `planes` (from 1b15518). Commits stay LOCAL to
  `planes` at milestones. Nothing is pushed or merged until Ivan says.
- ONE dev instance, from this worktree, on the normal ports (Vite :5173, relay :8080, the default
  `glyphd` tmux socket), started by `tools/dev.sh refresh` in the detached tmux session
  `planes-dev`. Ivan's main instance (~/dev/glyph3d-js) is stopped; he isn't using it.
- `tools/dev.sh` passes `serve` its flags BEFORE the project root (Go's flag parsing stops at the
  first positional, so `serve <root> --port N` silently ignored the port). No sandbox launcher:
  one instance is enough.
- How to work (Ivan's feedback): run servers in their own detached tmux session, never in my
  shell, never attach. Check readiness with one quick read, not poll loops or repeated pane
  captures. When Ivan says something is unused, believe him and simplify. Ivan runs restarts of
  HIS instance himself; the planes instance is ours to drive.
