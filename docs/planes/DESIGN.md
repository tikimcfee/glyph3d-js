# Planes and carrels: the design

This is the design for the `planes` branch. `HANDOFF.md` (beside it) holds the drive and the
history. This file holds the model, the primitives, the camera math, one day in the tool, and the
build slices in order. It was converged from a design workflow (grounding reports on the camera,
carrels and panes, pane content and desktop capture, and our own history; outside lenses on zoomable
UIs, window managers, spatial computing, spatial memory, multiplayer presence and LOD; six lens-pair
collisions; three session narratives), then revised against two critiques: one checked every named
seam against the code, one read each slice against Ivan's day. Code references are repo-relative.
Where a choice had alternatives, this file picks one and names the others in a sentence. The last
section lists the critique this file doesn't take, and why.

---

## 1. The drive and the test

> "Something about everything being.. orthographic? flat?.. in the same plane makes it mappable.
> Text is readable, images are viewable, and any perspective problem is non-existent because it's
> just pixels in an X/Y plane. We need the same version here."

> "Instead of a 2D window manager with desktops and windows, it can be a 3D space with stacks of
> desktops. … The desktops are still 3D sessions, some that just happen to be 2D planes of
> windows, others are files, etc."

> "There was a while where I was using this tool a lot with the multi-terminal dock just because
> having them visible was useful — I want to get back to that level of functionality, where I'm in
> it again, using it, pointing you at things, you suggesting changes to me."

**The success test is that Ivan uses glyph3d daily**: agents, terminals, files and desktops visible
and readable together, him pointing at things, agents pointing back. A slice that doesn't move that
test is the wrong slice.

**What his day holds.** Agents. The live instance shows the `gomux` hub with 11 members, team desks
of 7 and 12 agent books, and six terminals, every one a `gx-` agent screen (Claude TUIs at 239 × 56
or 119 × 56); none is his own shell, and the CameraDock is empty. He answers agents from an outside
terminal. So the first slice has to beat *his outside terminal plus `agent attach`* at watching and
answering agents. Beating a terminal emulator at showing two code files doesn't move the test.

**The lesson from our own history.** The June CameraDock worked because *the screen, not the
world, decided text size*: tiles rode a camera-locked node, the spotlit tile filled a fixed
fraction of the view, terminals were live and typeable, and switching never moved the camera. Every
later readability attempt (trail corridor, rolodex, deck, splay, world-size headlines, rising deck,
the proposed reel, mip atlases, the far-texture, minify ramps) arranged pages *inside perspective*
and delivered location, rhythm or overview, never reading. The planes model is the dock's logic made
exact (one text column is a whole number of device px, every edge on a pixel) and generalized from
"a bar that follows the camera" to "a carrel you enter". The June feeling had three parts together:
agents' screens **visible**, **readable**, and **answerable**. Since June, agents moved to read-only
screens and transcript books; the first slices put readability and answering back together.

---

## 2. The model on one page

**Space layer.** Perspective, flight, places. Its job is *memory and travel*: position is memory
(method of loci), and it never tries to be readable. Carrels stand on a 2.5D floor (rings, walls;
height only for rows), at positions that move only when Ivan moves them or calls `carrel.settle`.
Text in space is either at the reading floor `text.minPx` or it is less text (a headline, a name, a
bar, a box): **less text, never smaller text**.

**Plane layer.** Reading. Entering a plane desk squares the camera to the desk's plane and eases into
a flat view where **one text column is `plane.cellPx` whole device pixels** (default 8, which makes
the row exactly 8 × 54.375 / 29 = 15 device px: the 8 × 15 terminal cell). The plane's origin and
every member edge sit on device-pixel corners; nothing on the plane is foreshortened, resampled or
sub-pixel. "1 world unit = 1 screen px" is stated this way because a glyph cell is about 0.7 × 1.4
world units (`worldScale` 0.025 × the 48 px atlas): the invariant is on the cell, in device pixels.

**Carrels are the desktops.** A carrel is already a durable named group (Holding membership,
per-instance tuning, saved and restored, placed in the world). It gains a third layout **mode** beside
`ring` and `grid`: `plane`. A plane desk is **laid out in space exactly as it reads when entered**:
every member normalized to the plane's one column, each at its own natural size, pinned on a board.
From afar you are looking at the plane itself, and entering moves only the camera. A ring or grid desk
entered stays 3D (code trees, libraries, the hub cylinder).

**A pin board first, tiling later.** Ivan, in July: *"just pretend they're rectangles. You put the
rectangle on a pin board. It stays there."* A member's rect on the plane is its own size (a 239-col
screen is 1912 px wide); members sit in shelves, nothing is clipped, and the plane is simply larger
than the viewport: you pan 1:1 or move focus between members, and the aim slides to the focused one.
A newcomer takes free space and nothing else moves. Tiling (a binary split tree with tabs, clipping
foreign content to its tile) arrives later as an arrangement you choose, once the pin board has been
lived in.

**Moving between carrels.** From space: Enter on a carrel enters it. Inside: one key returns to the
last carrel (`carrel.back`), and a plane-to-plane switch is a cut, not two lens eases. Later, the
other carrels stay visible at the edge as quiet cards (Stage Manager's strip), ordered by **true
bearing** from where you stand, so "the relay agent is over there by the terminals" stays true from
inside.

**Answering.** A plane of agents is a tool, not a monitor: from a focused agent screen you can say
something to it, approve or deny its prompt, through gomuxai's own commands, never a tmux client. A
quiet line in the HUD names the agents waiting on Ivan; clicking one enters where it sits.

**Pointing.** "This / that" is a two-way bus primitive. Ivan points with one key and agents resolve
"this" to an exact reference (`path:line «quote»`, or a screen row); agents point back with a
highlight at the exact line, and **an agent's point never moves Ivan's camera, focus, keyboard or
projection**. It starts small (resolve, insert, highlight) and grows only where Ivan's real prompts
show it misses.

**Depth is time** (later). On a plane, view depth costs almost no size, so z can carry time and layers:
an agent's earlier turns, a file's revisions, a desktop's stills. A held key fans the layers; releasing
it flattens them back.

**Shared carrels** (later). A carrel is a session in the tmux sense: persistent, detachable. Agents
attach to a carrel to be seen there (presence, attribution, putting things in it, pointing); an agent's
own carrel holds its book, its screen, the terminals and desktops it owns.

**Impostors** (later). A carrel too far or not entered draws as a card: a picture of its own plane,
the last page Ivan read there. Live, card, far-LOD box, map label: discrete tiers, no ramps.

**Quiet.** One ornament row per member (its title: name, lamp, status), plus the HUD's waiting line.
Nothing else is drawn on a plane until a pixel asks for it; agents' presence marks are off by default
(motion Ivan didn't cause).

---

## 3. Core primitives

Each primitive lists its **data** (where it lives), **verbs** (exact names; `NEW` = to build,
otherwise registered today or in the working tree), **test handles** and the **code it builds on**.

### 3.1 Plane mode and the pin board

- **Data.** `mode: 'ring' | 'grid' | 'plane'` on `Carrel` (`packages/glyph3d-core/src/services/
  interaction/Carrel.js`): the three enum sites (`Carrel.js` constructor and `setMode`, `DESK_KNOBS`
  in `app/client/tuning.js`) change together. Ring and wall knobs carry `shows: (d) => d.mode !==
  'plane'`; the plane knobs (`paneGapPx`, `plane.shelfCols`) carry `shows: plane`. A plane-only knob on
  a ring desk is not a state that exists. Hub and team desks are derived (never serialized), so their
  mode is their tuning value under `carrel:<name>`. The default mode for `carrel.create` is a Setting
  (`carrel.createMode`, default `plane`); the hub and the agents desk stay `ring` (cylinders).
- **The working tree.** `Carrel.js` carries an uncommitted draft with a `form` knob, `setForm`,
  `setPlaneFrame` (set from the viewport), `getPlaneRect`, and a PaneTree tiling (`paneRects`,
  `_reconcilePanes` with an inbox, `_layoutPlane`, `_reflowToPane`, `_unpane`), plus `carrel.layout`
  and `carrel.panes` verbs. Slice 1 keeps `getPlaneRect`, folds `form` into `mode`, replaces the
  viewport-set frame with the viewport-free pin board below, and keeps the tiling draft out of its
  commit; the tiling returns in slice 6 on one pane-layout object shared with the CameraDock.
- **The plane's unit.** The plane has one column width `cw` world units. Each member stands at member
  scale `m = cw / charWidth_member`, so every member's column is the same `cw`. Entering at
  `plane.cellPx` puts `k = cellPx / cw` device px per world unit. The world layout depends on `cw`
  and the members only: **never on the viewport or the dpr**. A canvas resize in space moves no member;
  a resize while entered changes only the aim and the snap.
- **Pins.** A member's pin is its natural extent at the plane cell: a terminal's cols × rows cells, a
  code grid's own frame (its `frameRows` window, its own break: `natural` for code, by default), a
  frame's natural pixels. Pins sit in shelves left to right in seat order, wrapping at
  `plane.shelfCols` (default 480 columns: two 239-col screens and a gutter; per-desk tunable), with
  `paneGapPx` whole-px gutters; every pin origin is a whole device px at `k`. A newcomer takes the
  first free slot after the existing pins. A leaver leaves its gap until `carrel.settle`. A pin's
  reserved rect only grows (the calm-seats law, `7328b44`); a member that outgrows it moves only the
  pins after it on its own shelf, and `carrel.settle` repacks.
- **Books in a plane desk.** An agent's live `gx-` screen is its pin (`GomuxHub._seatScreens` is
  mode-aware: in a plane desk the screen is a member pin beside its book, not the book's aside). The
  book pins at the scale where its headline row is one plane row; it reads, but is not pixel-gated
  until slice 4 gives it a scroll form.
- **Plane rect.** `Carrel.getPlaneRect()` → `{center, normal, up, width, height}` of the board, in
  world space (the union of pins). `getLocalBounds()` is the airspace box (shadow, stack) and the
  wrong frame for the camera.
- **Verbs.** `carrel.set <name> mode plane` (the verb exists; the value is NEW), `carrel.settle
  [name]` (exists; repacks pins), `carrel.get <name>` reports mode and pins.
- **Test handles.** `plane.state` gains `{carrel, cellPx, pins:[{id, rectDev}]}`; `carrel.get`
  reports per-member column width in device px.
- **Builds on.** Carrel grid mode (a flat wall at local z = −R facing +z), `_animateMember`,
  `cylinderForm()` (`app/commands/handlers/carrelCommands.js`), `tuneDesk` / `projectTune`.

### 3.2 Enter, leave, back, switch

- **Data.** An `Entered` durable component (NEW) on the `view:plane` surface:
  `{carrel, home: {position, pitch, yaw, fov, near, far, dist}, focus, aim, at}`, keyed by carrel
  *name*. The saved camera is the *pre-enter* pose (`getState` already returns the home pose while
  entered). `ctx.activeCarrel` history (last two) for `carrel.back`.
- **One way in.** `carrel.enter` on a plane desk calls the same function `plane.enter` uses, with the
  desk's plane rect and focus. `carrel.leave` leaves the entered plane only; it has no `findCarrel`
  fallback (a bare name picks *some* desk). Ring and grid desks keep today's stand-at-the-center flight.
- **Plane life is a listener set.** `cc.onPlaneChange` is one slot that `plane.enter` overwrites on
  every call (`planeCommands.js`). It becomes a listener set on `ViewerCameraController` (add/remove),
  so `ctx.planeTarget`, the dock hide, `Entered`, and later the overlay each listen without clobbering
  the others.
- **Verbs.**
  - `carrel.enter <name> [--focus <id>]` (form-aware entry NEW): plane mode runs the plane path (§4),
    sets the key slot to the focused pin **at t = 0**, before the camera lands, and aims at it.
  - `carrel.leave` (in the working tree): the reverse ease, landing bit-exact on `home`.
  - `carrel.back` (NEW): toggle to the last carrel (i3 back-and-forth, tmux `last-window`).
  - **Switching.** `carrel.enter` or `carrel.back` while entered is a **cut** to the other plane's
    endpoint pose: no lens out and back in. `plane.switchMs` (default 0; a slide when > 0), born
    configurable. Ceiling: 200 ms from key to the new plane pixel-exact.
  - **The desk carries the view.** A desk can move while it's read: the hub ring re-seats a nested
    team desk when its members change, and the hub itself is re-placed (a reload re-enters before the
    hub has settled). `carrel.enter` gives the camera a `track` (the desk's `getPlaneRect`), read every
    frame. A moved, grown or rescaled board re-poses the view with the board's top-left on the same
    device pixel and the aim at the same device px from it, so what's on screen stays put. Mid-ease,
    the ease lands on the moved board. A still board changes nothing. Gate: `tools/plane-follow.test.mjs`.
  - **A fly while entered** (`camera.focus`, `agent.focus`, a ring desk's `carrel.enter`) first
    leaves to `home`, then flies. Nothing drops the plane in place: `_dropPlane` keeps the plane pose,
    which at the endpoint is about 7000 units out on a 70° lens.
  - `GomuxHub._centerWhenSettled` (once per load, `carrel.enter gomux`) stands down whenever a plane is
    entered *or* an `Entered` fact is pending.
  - The camera half stays `plane.enter <target> [cellPx]` / `plane.leave` / `plane.aim <x> <y>` /
    `plane.state` / `plane.fov` (registered, `app/commands/handlers/planeCommands.js`); any surface
    can be read in a plane, not only a carrel.
- **Restore.** `Entered` and every new durable component restore in **stage 1 with tunings**
  (`SessionStore.js`), before stage 2 seats members. The order: the camera's `applyState(home)` in
  stage 1 (`applyState` drops any plane), then the pending `Entered` enters through the live
  `carrel.enter` code with a 1 ms lens once the desk and its members exist (a convergent pending fact,
  like `holding.dock.pendingFrame`). `carrel.dissolve` forgets the desk's components as it forgets its
  tuning (`forgetTune`); `DeskTree._retire` keeps a team desk's values, by design.
- **A member's own view.** `SessionStore` captures each open file's `frameRows`, `scrollOffset` and
  `grid.position` from the live grid; the dock has a `homePosition` exception and the carrel has none.
  The capture asks the residence for a member's own view (`holding.ownViewOf(id)`, NEW, used by the
  dock and the carrel), so a file seated on a plane never saves its pin pose as its own.
- **Test handles.** `plane.state` → `{target, aim, origin, pxPerUnit, fovDeg, camera:{fov, near,
  far, distance}, viewport:{exact, dpr, box, why}, tweening, carrel, cellPx, pins}`.
  `attention.info` during the tween; `camera.info` before enter and after leave.
- **Builds on.** `ViewerCameraController.enterPlane / leavePlane / setPlaneAim / planeState /
  planeOf / planeViewport`, `services/camera/planeView.js`, `flyTo` / `tweenPose`
  (`services/spatial/spatialMath.js`), the restore stages in `app/client/SessionStore.js`.

### 3.3 The keyboard inside a plane

The responder chain is `captureToggle → entityTyping → contextEsc → navKeymap`
(`app/client/keyboardRouter.js`). With the key slot on a terminal pin, every plain key is typed into
the terminal, so plane keys need their own tier:

- **A plane tier above `entityTyping`**, beside `captureToggle`: a reserved prefix chord
  `plane.prefix` (born configurable; a chord no terminal program reads), then one key: `h j k l`
  focus the neighbor pin (the aim slides to it), `Tab` = `carrel.back`, `q` = `carrel.leave`,
  `y` / `n` = approve / deny (slice 1b), `p` = point (slice 2), `f` = the fan, toggled
  (`plane.fan toggle`; holding the chord fans while the OS repeats it). No bytes reach the PTY.
  `keys.trace on` logs each key event the router sees (key, code, modifiers, repeat, the claiming
  tier, the plane state) as a `[keys]` record, so what a browser delivers is read rather than guessed.
- **Esc.** In soft focus Esc is the context pop, and the entered plane is the outermost context: the
  first Esc releases the key slot to the plane (focus stays drawn), the second leaves. In capture
  (settled, greedy) Esc goes to the program, as today.
- **Unprefixed, with nothing holding the keyboard**, the nav layer is the plane's (`app/client/keymap.js`
  `PLANE_BINDINGS`): `h j k l` and the arrows hop pins (`pane.focus <dir>`, one press one hop) and
  the book keys page. The tree walk (`focus.neighbor` / `parent` / `child`, whose focus flies the
  camera out of the plane) belongs to the open world. A plane read with no desk (`plane.enter` on one surface) keeps only the book keys.
- **The pointer.** A click inside a plane focuses and never moves the camera
  (`app/client/gestureResolver.js` `focusTarget`, asking `planeReading`). It sets primary, gives a
  terminal the keyboard, and on a desk gives the clicked pin the desk's focus
  (`pane.focus <id> --keep-view`), so the hops go on from it. It never sends `camera.focus`, whose fly
  leaves the plane first.
- **Enter in space.** With a carrel in the primary slot (or its label hovered), Enter enters it (a
  nav-keymap binding, born configurable).

### 3.4 Who owns the size

One rule, split on **who owns the content's size** (tmux `window-size`):

- **Foreign content keeps its cols × rows**: Ivan's terminals, gomuxai agent screens, a capture of his
  monitor. On the pin board its pin is its size, never clipped, text never shrinks. A size change is
  always explicit and named: `gomux.resize` (exists; writes the agent's tmux window size back) or
  `terminal.resize`. A terminal *born* into a plane desk is born at a size Ivan chose.
- **Owned content** has a break per member: `natural` (its own lines; the default for code, which
  Ivan reads as laid) or `wrap` to a width in cells (the default for prose: agent scrollback, delta
  pages). Agent-owned desktops are sized at commit (CDP `Emulation.setDeviceMetricsOverride`).
- Images and frames: 1 texel = 1 device px with NearestFilter.
- **Under tiling** (slice 6) a tile can be smaller than foreign content; then it shows as a viewport,
  clipped and scrolled, with an edge mark saying columns are off the tile. That is an arrangement Ivan
  picks, never the default.
- **Builds on.** size-tagged OUTPUT frames (the stream is the only writer of terminal size),
  `terminal.resize`, `gomux.resize`, CodeGrid `setLayout` / `setFrameRows` / `setScrollOffset`.

### 3.5 Answering agents and the waiting line

- **Verbs** (NEW; relay → gomuxai, never a tmux client):
  - `agent.say <agent> <text>` → `agent send <name> <text>` (typed in at its prompt, held while it's
    busy, refused at dialogs; it reports what it did, and the OK line says so).
  - `agent.approve <agent>` → `agent approve <name> --expect <tool>`, with the tool the display showed
    (from the hub tree's pending call, else `agent status <name> -v`); unknown → refused, never blind.
  - `agent.deny <agent>` → `agent deny <name>`.
  - `agent.waiting` → the agents waiting on Ivan, oldest first, with `since` and the pending call.
- **Reply line.** The existing CommandBar. A printable key on a focused `gx-` pin opens it prefilled
  `agent.say <name> ` with that key typed: the first key lands where Ivan looked. No new UI.
- **The waiting line.** One row in the HUD (DOM, so pixel-exact by nature): `waiting · minor-features
  14:02 · relay-agent 14:10`. Click = `carrel.enter` of the desk the agent sits in, focused on its pin.
  It reads gomuxai status (`lane.meta.gomux`, `lane.beacon`); it shows in space and in a plane.
- **Builds on.** `cli/agentevents.go`, `cli/children.go` (the relay already runs `agent` children,
  killed with it), `app/client/GomuxHub.js`, `app/client/CommandBar.jsx`, `app/client/HudPanel.jsx`.

### 3.6 Agent scroll form

- **Data.** A third Book form, `scroll`, beside `deck | splay` (`book.form`, `collections/Book.js`):
  the records SessionBooks already parses, presented as one document wrapped to the pin's width at one
  size (a headline row per event, `[verb] target`, `[you]`, `[delivered]` … in the action hue, then its
  body; hue, weight and indent carry hierarchy, never size). Long outputs collapse to one summary row
  (`output · 214 lines`) that expands on click; nothing is truncated. It keeps the book's registry id
  (`agent:book:<lane>`), so Holding, attention, tuning and deixis address one entity. A bounded window
  like the deck's cap, paged with `agentEvents/read {until, tail}`; held away from the live end it
  shows `+N newer` in its title row.
- **Cost.** `CodeGrid._relayoutLoop` re-lays the whole document on every change, and `setScrollOffset`
  / `setFrameRows` each run a full pass. A live run lands a batch about every 50 ms. The scroll form
  appends by laying out only the new tail (a row-append path in `LayoutGenerator` /
  `InstancedSlotBuffer`) and scrolls by moving the document under its clip (an aim, not a refold).
  Measure append and scroll at the window cap (`load.stats`) before and after.
- **Ornaments.** Inside an entered plane, a member's title row (name, status lamp, `turn · step ·
  live|held`) is plane content at the plane cell, pixel-exact like any text, not an overlay. A step tab
  strip (hue chips per turn) is a later dial if the rhythm the rising deck showed is missed.
- **Builds on.** `app/client/SessionBooks.js`, `collections/agentEvents.js` (AgentEventReader),
  `AgentBooks.setHistory`, `CodeGrid.highlightRange`, `app/commands/handlers/bookCommands.js`.

### 3.7 Identity and the caller

- **The caller is per call.** `CommandRouter.execute` writes `ctx.sender` onto the one shared context
  (`CommandRouter.js`): a nested `router.execute` resets it to null and an async handler reads whoever
  called last. The router runs each call with a frozen `Object.create(ctx)` view carrying `{sender,
  cid}` and propagates it through nested calls; every caller updates in the same change.
- **Bus identity.** The CLI global flag `--as <name>`, defaulting from `AGENT_NAME` (set in agent
  environments), sent in the controller handshake so the relay stamps `from: <name>` instead of
  `ctrl-N` (`cli/relay.go`). It is attribution (hue, name) and the key for an agent's points.
- **Builds on.** `services/orchestration/CommandRouter.js`, `cli/main.go`, `cli/relay.go`.

### 3.8 Deixis

**Lite (slice 2).**

- **Data.** A `Ref` with what a prompt needs: `{kind: code | terminal | sheet, entity, durable (code
  {path, line, col}; terminal {terminal, historyLine, col}; sheet {session, at}), quote, origin: {who,
  ts}, text}` where `text` is the one-line form `app/x.js:42 «rec.meta?.patch»` or
  `gx-relay row 31 «…»`.
- **Ivan points.** `plane.prefix p` (or the point verb) resolves the hovered glyph through the hover
  probe's glyph slot (`CanvasInteraction.resolveGlyphHitFor`, `pick.at`) and puts `this = <text>`
  into the CommandBar, so the next `agent.say` carries it.
- **Agents point back.** `point.show <ref> [--kind look|suggest] [--say <line>]` from an identified
  caller draws the existing highlight fill (`highlightCommands.js`) in the agent's hue on the line,
  with no camera, focus, keyboard or projection change. One live point per agent.
- **Verbs** (NEW). `ref.resolve <text|json>` (one resolver over `services/tour/TourResolver.js` and
  `parsing/parseFileRef.js`), `deixis.here [hover|primary|key]`, `point.mark [here|<ref>]`,
  `point.show`, `point.list`, `point.go [id]` (Ivan's verb: it may move his camera), `point.clear`.
  Every `point.*` writes a `[deixis]` record to the relay log store.

**Full (slice 9), only where lite misses.** Ivan's real prompts pick which of these get built: `seen`
(what was on screen when pointed at) and a snapshot ring for streamed terminals; quote re-anchoring
(offset, quote near offset, quote anywhere, coarser layer with an orphan mark) and `resolved-by-edit`;
a deictic stack; rect refs on desktops; a relay-resident point store for points made while no display
is connected; delivery held to breakpoints graded by scale; ghost diffs through DeltaBooks rendering.

### 3.9 Sticky seats

- **Data.** A `Seats` durable component (NEW) on `carrel:<name>`: a remembered seat coordinate per
  lane id. Newcomers take free gaps, leavers leave ghost seats (dimmed), only `carrel.settle` repacks.
  It replaces "node order is seat order" (`flowBoxes` + `squareWrap` ordering in `Carrel._relayout`),
  for ring desks too, on top of the calm-seats law. Seats restore in stage 1.
- **Why early.** The hub re-packs every time an agent ends, which breaks position-as-memory in the one
  place Ivan's day lives.
- **Builds on.** `Carrel._relayout`, `app/client/DeskTree.js`, `tools/carrel.test.mjs` (rewritten).

### 3.10 Desktop and image frames

- **Data.** `FrameGrid` (`collections/FrameGrid.js`) drawing any texture through the glyph material's
  frame branch: a video track, an image bitmap, a relay source, a render target (which makes it the
  card primitive too). `naturalPx()` (NEW) for 1:1 pins.
- **Agent-owned desktops.** Relay-owned producers: a headless Chromium driven over CDP (raw CDP over
  the relay's websocket library, the binary found on PATH or by a flag, failing loud when absent),
  streamed on a relay **binary source plane** (`0x03`, free today: `0x01` is terminal output, `0x02`
  fs RPC), through the drop-oldest display queue, killed with the relay (`cli/children.go`),
  restorable across reloads with no gesture. A `frame` is HOLDABLE, so an agent's carrel holds its
  desktops. Lossless stills are kept as the evidence layer.
- **Verbs.** `frame.capture`, `frame.regrid`, `frame.list`, `frame.info`, `frame.kill`, `frame.status`
  (registered); NEW: `frame.pattern [name]` (a canvas test-card stream), `desktop.start <name> [WxH]
  [--browser <url>]`, `desktop.stop <name>`, `desktop.list`, `desktop.still <name>`.
- **Builds on.** `app/commands/handlers/frameCommands.js`, `core/glyphMaterial.js`,
  `InstancedField.setFrameTexture`, `picking/PickingSystem.js`, `cli/relay.go` (sources are JSON-only
  today), `WebSocketBridge.onBinaryFrame`, `tools/cdp-shot.mjs`.

### 3.11 Tiling inside a plane

- **One pane layout.** CameraDock's tree holds window ids; the working tree's carrel draft holds pane
  ids plus a stacks map. One object (`PaneLayout`, NEW: tree + stacks + inbox + focus + whole-px rects)
  is owned by both the dock frame and a tiled plane desk; CameraDock moves onto it in the same change.
  The `pane.*` verbs act on the active layout (the entered desk's, else the dock's), and the draft's
  `carrel.layout` / `carrel.panes` become `pane.layout` / `pane.list` (one verb family).
- **Data.** A `Panes` durable component (NEW) on `carrel:<name>`: the layout's serialized tree plus
  `{focus, zoomed, inbox}`, restored in stage 1. Leaves hold stacks (i3 tabbed). A named layout
  (`even-h`, `main-v`, `agent`) is applied when a desk first becomes tiled; joins after that land in the
  inbox leaf as the active tab, and nothing else's rect changes.
- **Size.** A tiled plane's size is a desk value in cells (`plane.cols × plane.rows`, per-desk
  tunable), never the viewport. A viewport larger than the plane centers it on whole px.
- **Clip.** Pane edges on cell boundaries; the group clip vec4 (today `clipTop, clipBottom,
  clipEnabled` plus one free lane, whole-quad discard on y) extends to x as well (the group stride
  grows, and GlyphBatch and the pick shader read the same table); frames clip by UV in the shader;
  PanelBatch quads are cut on the CPU to the tile. No GL scissor (it would break one-draw-per-kind
  batching).
- **Verbs.** `pane.split|focus|resize|close|swap|list` (registered, dock-only today), NEW
  `pane.zoom [id]`, `pane.tab <next|prev|id>`, `pane.place <id> <leaf> <left|right|up|down|tab>`,
  `pane.layout <name>`, `pane.fit [id]` (an explicit resize of foreign content to its tile).
- **Builds on.** `services/interaction/PaneTree.js`, `CameraDock._placePane`'s placement algebra,
  `app/commands/handlers/paneCommands.js`, `tools/panetree-check.mjs`, `tools/pane-compose-check.mjs`.

### 3.12 Shared carrels

- **Agent carrels.** DeskTree gives every agent with a screen or a desktop its own plane desk
  (`gomux/<name>`); its seats and tuning stick by the lane name.
- **Attach is presence.** `carrel.attach <carrel>`, `carrel.detach [carrel]`, `carrel.who [carrel]`
  (NEW): an identified agent is listed and attributed in a carrel, may put things in it (the existing
  Holding verbs) and point in it. Participants are ephemeral (not saved), dropped when gomuxai reports
  the agent ended. `attention.set` / `attention.capture` are refused from identified agents (one writer
  per slot), decided on the per-call caller (§3.7).
- **Agent edits land.** An open code member follows an agent's edit from the tool event's `file` text
  (the file as the call left it), swapped in place with the line under Ivan's eye held still; a relay
  file watcher on served and reached roots covers edits that carry no text (`fsnotify`, a new
  cross-platform dependency in `cli/go.mod`).
- **Builds on.** `app/client/Holding.js`, `DeskTree.js`, `GomuxHub.js`, `AgentVisibility.js`,
  `cli/relay.go`, `cli/fs.go`.

### 3.13 The screen overlay and the render-pass owner

- **One pass owner** (built: `app/client/FramePasses.js`, mounted as `<RenderPasses/>` —
  `app/client/RenderPasses.jsx`). r3f auto-renders unless a positive-priority `useFrame` takes the
  loop; the app's one such `useFrame` draws the frame through `ctx.renderPasses`, in a declared order:
  **main** (the view camera; the flat render root when it serves) → **overlay** (the plane overlay,
  depth cleared) → **cloud** (the hand cloud's picture-in-picture) → **minimap** (the scissored
  corner, `MinimapPass`, while `view.minimap`). A pass is a named entry (`renderPasses.add`), never a
  second `useFrame(…, 1)` and never a scene `onAfterRender` hook. The screenshot verb draws through the
  same owner (what you see). Card captures and picks keep their own schedules and report their time
  (`record`); `scene.render` lists every pass's ms. A second positive-priority `useFrame` is a fault —
  logged loudly, shown as FAIL in `scene.render`, and the owner keeps drawing (a frozen display is
  worse than a loud one). Gates: `tools/render-passes.test.mjs` (real r3f), `tools/render-passes-check.mjs`
  (byte-identical to the passes it replaced).
- **Data.** An overlay scene with its own `OrthographicCamera` at 1 unit = 1 device px, depth cleared,
  on a camera layer the batches skip. FieldLabel always enrolls in GlyphBatch and PanelBatch (which
  hook the main scene only), and `isShown` / `rootOf` need a SceneTransforms on the scene, so overlay
  text is a non-enrolled field type with the same material and atlas, origins snapped.
- **Hit path.** Overlay items are device rects resolved by the placer's CPU rect list, feeding the
  hover slot **through the hover probe** (one writer per slot); the GPU pick stays the truth beneath.
- **Why it's needed.** Inside a plane the depth slab clips everything off the plane, including the
  CameraDock (parked 10 units ahead of the eye) and ReaderCompass. While entered the dock hides (its
  state kept) from slice 1; the overlay later carries screen-anchored things: the strip, map labels,
  edge marks.
- **Builds on.** `getCanvasViewportSize()`, the glyph material, FieldLabel's layout.

### 3.14 Map labels and the strip

- **Labels.** Text sized in screen pixels, pinned to world anchors, decluttered by priority on a
  screen grid (deixis > waiting on Ivan > attention chain > carrels > agents > terminals > files >
  directories > ended), never truncated, never shrunk. **One size** (`labels.px`, default 13), with a
  heavier weight for the first two classes; a label that loses placement drops to a dot or joins a
  cluster label (`gomux · 7 agents · 2 waiting`; a waiting count never aggregates away). Hard
  switches: `labels.fadeMs` default 0. Placement at `labels.placeHz` and on camera rest, with
  hysteresis at each threshold. Once a thing's own title projects at least as large as its label, the
  thing names itself.
- **The strip.** Carrel cards at the left edge of an entered plane, ordered by bearing (the ring
  unrolled: the seat layout that rolls into the cylinder at curvature 1/R lays out the strip at
  curvature 0), with waiting badges; at most 6 per edge, the rest as a cluster. It reads Holding
  membership; it is not a second roster.
- **Locus hints, since lines, visit marks**: later dials, born when a pixel asks.
- **Verbs** (NEW). `maplabel.list` (every candidate: class, rect, px, state, why hidden),
  `maplabel.explain <id>`, `maplabel.freeze on|off`, `carrel.neighbor <h|l|j|k|parent|child>` (by
  bearing). `label.*` stays the annotation-label family (`annotationCommands.js`).
- **Builds on.** GlyphBatch's per-frame pose write, FieldLabel, `seedLabelPops` (a module function in
  `ContentTreeLabels.js`; opacity identity), `Carrel._relayout`'s roll (`th = cx / R`); NEW in
  `Carrel.js`: `seatMap` / `rollSeat`.

### 3.15 Depth as time

- **Data.** Per-member layer lists: scrollback by turn or by day since the last visit; a code member's
  revisions (delta watch lane, `fs/gitDiff`, `git log -L`); a desktop's stills; a terminal's scrollback
  pages. Each layer has an opaque page backing so overlaps stay legible. An agent's `suggest` strips sit
  at z > 0 over the lines they'd replace, exactly registered when flat (tracing paper); history at
  z < 0.
- **The fan, on either endpoint.** The perspective plane endpoint is a 1° lens: a layer 50 units
  back is 0.7% smaller (7 px at 1000 px off-center), and its fan widens the lens (`layers.fanFov`).
  The orthographic endpoint (§4.6, `plane.ortho`) keeps every layer 1:1 behind the page, and its fan
  slides the pages themselves: page i right by i·n whole device px (`layers.fanPx`), rigidly, its
  backing with its text (`LayerStack.setFan`, eased by the camera's fan listener). The member and
  everything at its own depth (its backdrop, focus border, `now` backing) stay byte-still. A
  projection shear can't do that: it is linear in depth, so it holds one depth still and slides the
  member's backdrop (0.5 units behind its text) by a fraction of a layer step.
  Holding the pane prefix fans either one (`plane.fan on`); releasing folds it (`plane.fan off`).
- **Verbs** (NEW). `pane.layer <id> <n|now|label>` (bring a layer to z = 0), `pane.blink <id> <a>
  <b>`, `grid.history <id> [--at n]`, `plane.fan <on|off|px>` (px on the orthographic endpoint only).
- **Builds on.** the Book deck (`deck.rise`; in a plane `rise = rowPx / k`, so each sheet behind shows
  exactly one headline row), `collections/terminalDepthHistory.js`, DeltaBooks.

### 3.16 Impostor cards

- **Data.** One card per carrel: an ortho render of its plane rect at power-of-two tier sizes chosen
  from projected size, drawn as a 1 × 1 `FrameGrid` of a `WebGLRenderTarget` texture. Captured on
  `carrel.leave` from the last pixel-exact frame (the postcard: the page Ivan last read), refreshed on
  content change under `carrel.card.budgetMs` (1.5 ms per frame), near-live for the top
  `carrel.card.live` (6), with a staleness stamp. A byte-capped LRU pool falls back to the far-LOD box.
  Swap live ↔ card at texel ≥ pixel with hysteresis. The desk the plane view reads is live however
  far: the entered one, or the one holding the member read (`plane.enter <member>`) — a card is flat,
  and that member's layer pages (§3.15) need the scene for the fan to move them.
- **Layers, stated.** Batched panels and labels are off layer 0 and draw from arenas that are on layer
  0, so a card-layer camera sees neither unless the card pass enables the arenas (with only the
  carrel's ranges live) or the originals; and GlyphFarLod's per-view layer state decides what the
  card pass sees. The card pass sets both explicitly, and the gate counts batch repacks across it.
- **Verbs** (NEW). `carrel.card <name>` (force a refresh), `card.list` (tier, age, bytes).
- **Builds on.** `collections/GlyphFarLod.js`, PanelBatch's one-draw pattern, the picking grid
  channel (card click = `carrel.enter`).

---

## 4. The camera transition

### 4.1 Frames and units

- Plane frame from `Carrel.getPlaneRect()` (or `planeOf(obj)` for any surface): center `c`, unit
  normal `n` (the face toward the reader), up `u` projected off `n`, right `r = u × n`, size `w × h`
  world units. Plane coordinates `(x, y)` are measured from `c` along `r` and `u`, +y up.
- Viewport: **device** px `Wd × Hd` (`VCC.planeViewport`; the canvas box is whole device px,
  `usePixelExactBox` in `packages/glyph3d-r3f/src/GlyphCanvas.jsx`). `pxPerUnit` is device px per
  world unit everywhere.
- The plane's column `cw` world units; with `plane.cellPx` = `c_px` device px per column,
  `k = c_px / cw` device px per world unit, and `rowPx = c_px · charSize.height / charSize.width`
  (8 → 15.000 exactly for Cousine, 29 × 54.375 atlas px; the baseline sits 0.2651 · 15 = 3.98 px above
  the cell bottom and the x-height top at 10.97 px, both within 0.03 px of a pixel row). All metrics
  come from the atlas. `rowPx` is a whole number only where `c_px · h / w` is (for Cousine: multiples
  of 8). At other values rows land on fractional pixels; `plane.state` reports `rowExact: false` and
  the pitch gate runs only on exact values (open question 3).

### 4.2 Squaring

The reading orientation looks down `−n` with up `u`. In the controller's YXZ pitch/yaw:

```
pitch = asin(−n.y)          yaw = atan2(n.x, n.z)
```

Desks are yaw-only, so this is exact for every carrel; a pitched surface (an agent sheet, a tilted
desk) holds the plane's quaternion directly (camera +Z = n, camera +Y = u) and the per-frame YXZ
rebuild is skipped while held. The plane lens already turns the short way (`_startLens`). `flyTo` →
`tweenPose` (`spatialMath.js`) lerps yaw raw and spins the long way across the hub; it takes
`Δyaw = ((yaw₁ − yaw₀ + π) mod 2π) − π` in slice 1, with a `tools/camera.test.mjs` case (ring desks'
`carrel.enter`, `camera.focus`).

**The referent is the fixed point.** During the square-up the eye position is solved per frame so
the referent (the focused pin's title row, or `deixis.here primary`, else the plane center) keeps its
starting screen position: `eye(t) = P − q(t)·dir(ndc₀)·dist(t)`. This replaces `_stepLens`'s linear
aim lerp. During the lens ease the plane point at the aim holds its screen position by construction.

### 4.3 The lens ease

The camera stays one `PerspectiveCamera`. A plane squared to it maps with one uniform scale, so
"orthographic" is reached as a dolly zoom: narrow the fov while the eye backs off along `n` so the
plane's scale is held. In device px:

```
D(φ, k)  = Hd / (2 · k · tan(φ/2))                         plane distance for fov φ, scale k (device px/unit)
φ(t)     = φ₀ + (φ₁ − φ₀)·e(t)                             fov, linear in degrees
k(t)     = exp(ln k₀ + (ln k₁ − ln k₀)·e(t))               scale, linear in log (even zoom)
eye(t)   = c + r·aim.x + u·aim.y + n·D(φ(t), k(t))
k₀       = Hd / (2 · d₀ · tan(φ₀/2))                       what the camera saw at its aim when it started
φ₀ = 70°, φ₁ = plane.fov (1°), k₁ = c_px / cw, e = the lens ease, t ∈ [0, 1] over plane.enterMs (700)
```

`planeView.dollyAt` computes exactly this and is gated (`tools/plane-view.test.mjs`); the camera's
`_stepLens` log-lerps distance and lerps fov on one ease, so its scale is exact only at the endpoints.
Slice 1 drives `_stepLens` from `dollyAt` (scale log-linear, distance derived) together with the
referent solve, and gates "scale at t equals `k(t)`". One rule, not two.

Something `Δ` world units in front of the plane at `o` px from the view center drifts `o·Δ / (D − Δ)`
px from where an orthographic view would draw it. At the endpoint (`Hd` = 1380, `k` = 11.03, φ₁ = 1°)
`D` ≈ 7170 units, so a layer one unit off the plane at 1100 px drifts 0.15 px. Coplanar members drift
zero. `orthoFov(...)` returns the widest fov under a drift tolerance.

**The slab.** `near = max(D − front, 10⁻³·D)`, `far = D + back`, with `front = depth/2 +
plane.front`, `back = depth/2 + plane.back`. It clips everything between the eye and the plane (the far
wall of the ring, other desks) and buys depth precision. It is also why camera-locked content hides
while entered (§3.13).

**Leave** runs the same lens back to `home` (the pose saved at enter, along the same ray) over
`plane.leaveMs` (600), landing bit-exact. **Switch** (§3.2) skips both eases: the camera is set to the
other plane's endpoint pose directly.

### 4.4 Pixel snap

The plane origin `o` (the plane rect's top-left in plane coordinates) maps to device px:

```
X = Wd/2 + (o.x − aim.x)·k          Y = Hd/2 − (o.y − aim.y)·k
aim' = (aim.x + (X − round X)/k,  aim.y − (Y − round Y)/k)      snapAim: X, Y become integers
```

The settle moves at most half a pixel and happens at landing; drag pans in whole device pixels, focus
moves slide the aim in whole pixels, and the wheel scrolls members in whole rows. Pin rects are whole
device px at `k` (§3.1), gutters in whole px. A member's content origin is its rect's top-left plus
whole-px padding.

Three substrate conditions make the snap mean anything:

1. **Exact backing store.** `usePixelExactBox` sizes the canvas box to whole device px from
   `devicePixelContentBoxSize`; when the device box isn't CSS × dpr it falls back to 100% with a
   one-time `console.warn`. That isn't loud enough for a plane: `cc.planeViewport()` reports `{exact,
   dpr, box, why}`, and `plane.enter` / `carrel.enter` on an inexact box enter with the OK line and a
   HUD notice naming the dpr and the box (the pixel gate fails, by design). `canvasSizeGuard.js`
   (`packages/glyph3d-r3f/src/`, imported nowhere, checking `buffer == floor(css·pr)`, which passes
   while the compositor resamples) is deleted in slice 0.
2. **The pen on the cell grid.** `core/LayoutGenerator.js` steps the pen in whole cells (`step =
   round(advance / charWidth) · charWidth`), sizes the ink quad at the true advance `ax/upem ·
   emWorld`, and refuses metrics without `emWorld` (`2c23529`, gate `tools/layout-cells.test.mjs`).
   Code and terminals share one column grid; there is no knob for another pen rule.
3. **Orientation settled.** Members slerp to their seats at `yawRate`; the plane path snaps member
   orientation at landing.

### 4.5 What the other systems need

| system | under the plane view | change |
|---|---|---|
| main render, culling | projection-agnostic (frustum from P·V) | none |
| GPU picking | a true perspective camera; `setViewOffset` on the copied pick camera is exact | none; `pick.at` is the gate handle |
| greek tier | `fwidth`-based, device px; rows are 15 px | none |
| far-LOD | measures `rowPx` at the box's nearest depth through `pxPerUnitAt` (the projection matrix) | truthful at any blend |
| GlyphBatch / PanelBatch | refresh only for cameras that see layer 0; camera-relative writes stay precise at D ≈ 7000 (f32 ulp ≈ 0.0005 units ≈ 0.006 px) | overlay and card cameras use other layers (§3.13, §3.16) |
| SceneTransforms | matrices only | none |
| CameraDock, ReaderCompass | parked 10 / 5 units ahead of the eye: inside the slab's near clip | hidden while entered (a plane-life listener) |
| VCC input | inside: drag pans 1:1, wheel scrolls the member under the cursor, flight/look/dolly off | aim clamped to the plane rect; key slot set at t = 0; a fly leaves first (§3.2) |
| autosave | `onMoved` schedules saves; `_applyPlane` never calls `_notifyMoved` | the saved camera is `home`; members save their own view (§3.2) |
| world relayout | a world-managed or nested desk can move while entered | the parent's relayout is frozen while entered; the camera re-squares from `matrixWorld` if a pose changes anyway |
| SessionStore | captures live grid state | `holding.ownViewOf(id)` (§3.2) |

### 4.6 The orthographic endpoint (slice 10b)

Depth-as-time read exactly needs layers *behind* the plane to stay 1:1, which a 1° perspective can't
give. The view camera is `PlaneCamera extends PerspectiveCamera`
(`packages/glyph3d-core/src/services/camera/PlaneCamera.js`, created in `app/main.jsx`), a pinned-plane
blend at a fixed eye. At λ = 1 its matrix is three's own, so the open world is bit-identical to a
PerspectiveCamera (the blend formula at λ = 1 agrees only to ~1e-14). `plane.ortho` chooses the
endpoint: on, the camera keeps the open-world fov, stops at `d₀`, and blends λ 1 → 0 in the same ease
as the dolly (d₀ pinned to the referent's depth every frame, where the blend terms vanish,
so the referent solve holds at every λ); off, it dollies to the 1° lens. **Off by default**: on the
flat plane the two differ in 1543 of 1.6 M px (`tools/plane-ortho-check.mjs`), all on the inner
anti-aliased edge of the focus border, which stands in front of the plane, so 1° magnifies it by
D/(D−d). Text and panels are byte-identical. With layers shown, the 1° endpoint's layers drift where
the orthographic ones stand 1:1. In view space (forward −z), with the plane at depth `d₀` and blend
`λ ∈ [0, 1]`:

```
x_clip = sx·x                             sx = 1/(aspect·tan(φ/2)),  sy = 1/tan(φ/2)
y_clip = sy·y
z_clip = A·z + B                          A = −(λ(f+n) + 2(1−λ)d₀)/(f−n),  B = −(λn + (1−λ)d₀) + A·n
w_clip = −λ·z + (1−λ)·d₀
```

- λ = 1 is three's perspective matrix element for element; λ = 0 is an orthographic camera whose
  scale equals the perspective scale at `d₀`; at depth `d₀`, `w = d₀` for every λ, so the plane never
  changes size and only off-plane parallax collapses, linearly in λ. `z_ndc` is monotonic in depth for
  all λ, so sorting holds.
- `d₀ = e₅·Hd / (2k)` (e.g. fov 70°, Hd 1080, k 11.03 → 69.9): the eye never backs off, so the dock,
  the overlay and camera-relative batches stay where they are.
- The fan is not the camera's (§3.15): `setPlaneFan(n)` eases n device px per rank and hands it, with
  the plane's px per world unit, to its fan listeners; LayerStacks slides each stack's history pages
  `rank·n / pxPerUnit` world units right. At λ = 0 that is exactly rank·n device px whatever the
  stack's pitch or scale, and the camera doesn't move bit for bit.
- Picking: `copy()` carries λ and `d₀`; `updateProjectionMatrix()` applies the view offset
  as an NDC crop, equal to three's `setViewOffset` at λ = 1. Below λ = 1 it throws on the WebGPU
  coordinate system, reversed depth, a zoom or a film offset. Rays come from `rayFromCamera` (three's
  `setFromCamera` takes the perspective branch at every λ).
- One truth helper in `services/spatial/spatialMath.js`: `clipW(cam, d) = −e₁₁·d + e₁₅`,
  `pxPerUnitAt(cam, d, H) = e₅·H / (2·clipW)`, `pxPerUnitAtPoint`, `viewHeightAt(cam, d) = 2·clipW /
  e₅`, `worldPerPixel`, `rayFromCamera`, `sphereFitDistance`; `zDistanceForFit` stays a perspective
  fit from the fov (what a fly flies with). Every site that read a scale from a fov reads it. The gate
  (in `tools/plane-camera.test.mjs`) is trig on a fov — `rg 'getEffectiveFOV|isPerspectiveCamera|
  setFromCamera\(|Math.(tan|sin|atan)(…fov…)'` lists only spatialMath, PlaneCamera (it derives sx/sy
  as three does) and `planeView.js` (the pure endpoint math); the `plane.fov` verb and setting names
  don't count.
- The far clamp eases with λ: `far(λ) = lerp(planeBack + margin, farSpace, e(λ))`.

---

## 5. Ivan's session

A condensed day, assembled from the three narratives and re-cut to the slices. Display 2200 × 1380
device px at dpr 1; plane cells 8 × 15.

**09:00, back in space.** He reloads. He stands where he left space: the hub cylinder ahead, his code
tree left, the agents desk right. Nothing is readable and nothing tries to be. The HUD's waiting line
reads `waiting · minor-features since Tue`. Seats haven't moved since yesterday, even though four
agents ended overnight: their ghost seats hold the gaps (slice 3).

**09:02, a working set.** He spawns three agents from his shell for a two-repo change (a gomuxai side,
a glyph3d-js side, a reviewer). They seat on a team desk in the hub; he sets it to a plane
(`carrel.set gomux/refactor mode plane`), and it lays itself out where it stands: three 239 × 56
screens on two shelves, each pinned at its own size.

**09:04, entering.** He presses Enter on the desk. The key slot moves to the focused screen at once;
the desk swings square, the lens narrows, and at 700 ms the plane locks to the pixel. The first screen
fills most of the view, every one of its 239 columns there; the second sits to its right, past the
edge. Prefix-`l` slides the aim to it in whole pixels. It reads like his terminal. This is the June
dock, exact.

**09:06–09:12, answering.** The reviewer stops on a permission prompt: its name joins the waiting line,
its title row turns warm, nothing moves. He focuses it, reads the pending call on its own screen, and
presses prefix-`y`: `agent.approve reviewer --expect Bash`. He starts typing on the gomuxai agent's
screen and the CommandBar opens with `agent.say gomuxai-side ` and his first letter in it; Enter sends
it, and the OK line says it's held until the agent's turn ends. He never opened his shell (slice 1b).

**09:14, "change this".** He opens `DeltaBooks.js` in the plane; it pins in the next free slot and no
other screen moves. He hovers `rec.meta?.patch` on line 298 and presses prefix-`p`: the CommandBar
gets `this = packages/glyph3d-core/src/collections/DeltaBooks.js:298 «rec.meta?.patch»`, and he types "change this to read
meta.hunks" after it. The agent's reply on its screen opens with the same reference. It points back
with `point.show` at line 301: a teal fill on the line, his camera and focus untouched. Its edit lands
in the open file in place, the line under his eye unmoved (slices 2 and 7).

**10:02, a live display bug.** In another carrel an agent is testing a UI change in its own desktop
(`desktop.start`, a headless browser, pinned at 1:1 beside its screen, slice 5). Ivan notices a
one-pixel seam in the agent's page, points at it, and asks "what is this?". The agent takes a lossless
still, points at the pixels and at the CSS line together, fixes it, and blinks the two stills so he can
see the seam go.

**A week later, 09:12.** He opens the tab after eight days. He lands at the pre-enter pose of the plane
he was in, re-entered as soon as its desk stood up. The finished agents of the week hold ghost seats in
the hub. On the plane's edge the strip shows the other carrels by bearing, each card the last page he
read there (slices 8 and 11). He holds the fan key on the reviewer's scrollback, and the week steps out
as day layers behind the page (slice 10).

---

## 6. Build slices

Each slice lands with its gate, is committed locally on `planes` at the milestone, and ends with
something Ivan can look at. Constants are born configurable (Settings ▸ Planes and siblings), all verbs
are bus verbs, fallbacks fail loud. Every slice from 1 on also writes `[usage]` records to the relay
log store (`carrel.enter`, `carrel.leave`, `agent.say`, time entered), so "uses it daily" is a number
`log.stats` answers, quiet and local.

### Slice 0. Commit what's in flight

- **Scope.** The frame branch, uncommitted in the working tree: `uRenderMode` / `frameTexture` /
  `frameCols` / `frameRows` / `uFrameFlipY` in `core/glyphMaterial.js`, `InstancedField`, `FrameGrid`,
  the pick-shader bypass in `PickingSystem`, the far-LOD and greek exclusions for frames
  (`GlyphFarLod`), `frame.status`, one colour rule, stale WebGPU comments gone, and its gates. Delete
  the unwired `canvasSizeGuard.js` and its test. Independent of planes, it unblocks image files and
  agent-book image sheets today.
- **The diagnosis it fixes.** Capture works; rendering didn't. `frame.capture` gets a live `MediaStream`
  and its `<video>` plays, but the WebGL2 glyph material that replaced the WebGPU `GlyphField` in the
  backport (2134258) had no frame branch: `setFrameTexture` stored a texture nothing read, so each
  frame cell's index went down the glyph path as a font glyph id and a capture drew as glyph soup. The
  same root cause broke image files and agent-book image sheets. The old check asserted `hasTexture`
  and took a screenshot with no pixel assertion.
- **Gate.** `tools/frame-capture-check.mjs`: a four-quadrant test card (red, green, blue, white)
  through `canvas.captureStream()` and the same handler code; read back the quadrant centres; assert
  colour within tolerance and orientation (red top-left); the same for a 2 × 2 PNG through
  `textureFromImageBytes`. Fails on the pre-repair tree, passes after. `tools/frame-grid.test.mjs`,
  `tools/glyph-far-lod.test.mjs`.
- **Ivan looks at.** An image file and an agent's image sheet, drawn as images.

### Slice 1. The June dock, exact, for agents

- **Preflight (scene-changing, so the building agent's step, announced to Ivan first).** Set the live
  `gomux/glyph3d-js-root` team desk to grid and `plane.enter carrel:gomux/glyph3d-js-root`, and
  `plane.enter gx-glyph3d-js-root`: see what mixed member scales and today's seating do in a plane,
  and whether 8 × 15 is his size. Check why four `gx-` screens report the same position.
- **Scope.** `mode: plane` (§3.1) with the knob predicates and `carrel.createMode`; the viewport-free
  pin board (normalized members, natural-size pins, shelves, a newcomer takes free space, growth moves
  only later pins on its shelf); mode-aware `_seatScreens`; `getPlaneRect`; `carrel.enter` through the
  `plane.enter` path, the key slot at t = 0; `carrel.leave` (no fallback); `carrel.back`; the switch
  cut; a fly while entered leaves first; the hub standing down while entered or pending; plane life as
  a listener set; `Entered` restored in stage 1; `holding.ownViewOf`; `_stepLens` driven by `dollyAt`
  with the referent solve; the `tweenPose` shortest arc; the dock hidden while entered; the
  inexact-box notice; the keyboard plane tier (§3.3). The `ViewerCameraController.js` header line that
  says the plane view is "driven by `carrel.enter` on a plane-form desk" becomes true.
- **Files.** `packages/glyph3d-core/src/services/interaction/Carrel.js`, `CameraDock.js`;
  `services/camera/ViewerCameraController.js`, `planeView.js`; `services/spatial/spatialMath.js`;
  `app/client/tuning.js`, `WorkspaceModel.js` (`Entered`), `SessionStore.js`, `Holding.js`,
  `GomuxHub.js`, `keyboardRouter.js`; `app/commands/handlers/carrelCommands.js`, `planeCommands.js`,
  `cameraCommands.js`, `agentCommands.js`.
- **Verbs.** `carrel.set <name> mode plane`, `carrel.enter <name> [--focus <id>]`, `carrel.leave`,
  `carrel.back`, `carrel.settle`, `plane.state` (extended).
- **Gate.**
  - `tools/carrel-plane.test.mjs` (headless): enter → leave restores `camera.info` bit-exact; a canvas
    resize in space changes no member's `matrixWorld`, and while entered changes only aim and snap; a
    join, an open and a leave change no earlier pin's `rectDev` (zero tolerance; teeth: a re-pack on
    join fails); 20 rounds of enter, leave and reload with member churn give identical rects; `Entered`
    round-trips through the snapshot; enter → autosave → reload in space gives each file its pre-plane
    `frameRows` and position (teeth: capturing the live grid fails); `camera.focus` while entered equals
    leave-then-fly (teeth: `_dropPlane` in place fails); the hub center doesn't fire while an `Entered`
    is pending; prefix + `l` with a terminal focused moves focus and sends no bytes to the PTY; the
    lens scale at t equals `k(t)`; the referent drifts < 1 px across the square-up (teeth: > 1 px
    without the solve); the shortest-arc case in `tools/camera.test.mjs`.
  - **First key lands where you looked**: keys sent during the enter tween arrive at the focused pin
    (bytes at the PTY for a glyphd terminal, the caret for a code grid).
  - **Readable within N s of a reload**: reload with an `Entered` fact → the plane's text is
    pixel-exact by `load.stats` ≤ `plane.restoreBudgetMs` (born configurable; measured first, then set).
  - **Switch ceiling**: `carrel.back` while entered → the other plane pixel-exact ≤ 200 ms.
  - Pixel: `bun tools/pixel-check.mjs --live --crop <pin> --expected-pitch 15 --gate` on synthetic
    `|l▏█` and `eeee` rows in a code pin and a terminal pin **and on the live team desk's real 239 × 56
    screens**: row pitch 15.000, single-step stem edges, column 0 and the last column's profiles
    identical, every source column on the plane, backing store equal to CSS × dpr. **Live content
    reads still**: on a streaming screen, unchanged rows are byte-identical frame to frame and only
    changed rows change. Teeth: a +0.5 px aim fails crispness; the pre-`2c23529` advance fails the
    column profile.
  - **Felt property locked: an agent's screen in a plane is your terminal, every column, crisp; entering
    never loses your place, and Esc puts you back exactly.**
- **Ivan looks at.** His live team desk, entered: does it read like his terminal, does Esc put him back
  exactly where he was, does `carrel.back` toggle the way his hands expect. `plane.cellPx` and
  `plane.shelfCols` are his dials.

### Slice 1b. Answer them without leaving

- **Scope.** `agent.say` / `agent.approve` (`--expect`) / `agent.deny` / `agent.waiting` through the
  relay (§3.5); the CommandBar as the reply line, opened by a printable key on a focused `gx-` pin;
  prefix `y` / `n`; the HUD waiting line. The input verbs reverse the hub's written "read-only: nothing
  here types into an agent" and land on Ivan's yes (open question 1); the waiting line and
  `agent.waiting` land regardless.
- **Files.** `cli/agentevents.go` or `cli/gomux.go` (the RPCs, `agent` children), `cli/children.go`;
  `app/commands/handlers/agentCommands.js`; `app/client/GomuxHub.js`, `keyboardRouter.js`, the
  CommandBar and HudPanel; CLAUDE.md's gomuxai hub paragraph (current state).
- **Gate.** A `cli` test with a fake `agent` binary: say → `send`, approve → `approve --expect <tool>`,
  approve with no known tool → refused, deny → `deny`; stderr and exit codes surface in the OK/ERR line.
  **Answer round-trip** (live, a scratch agent): `agent.say` from the plane → the text on that agent's
  screen, and no pin rect or scroll moved. The waiting line lists exactly the agents gomuxai reports
  waiting (teeth: a status flip shows within one tree push). **Felt property: you answer an agent where
  you read it.**
- **Ivan looks at.** One afternoon with three agents in a plane: how many replies went from glyph3d
  and how many from his shell (`log.stats` counts the first).

### Slice 2. Pointing, lite

- **Scope.** The per-call caller (§3.7) with `--as` and the relay stamp; the lite `Ref`; `ref.resolve`;
  `deixis.here`; prefix `p` / `point.mark` into the CommandBar; `point.show` look/suggest drawing the
  highlight fill in the caller's hue; `point.list`, `point.go`, `point.clear`; `[deixis]` records.
- **Files.** `services/orchestration/CommandRouter.js` and every caller of `ctx.sender`; `cli/main.go`,
  `cli/relay.go`; new `app/client/Deixis.js`, `app/commands/handlers/deixisCommands.js`;
  `app/client/CanvasInteraction.jsx`, `keyboardRouter.js`; `services/tour/TourResolver.js`.
- **Gate.** Two interleaved async verbs from two senders each see their own identity, and a nested
  call inherits the outer sender (teeth: the shared `ctx.sender` fails). `tools/deixis-lite.test.mjs`:
  a code glyph and a terminal row resolve to the right `path:line` / `historyLine` and quote; an
  anonymous `point.show` fails loud. **The doesn't-steal gate**: `camera.info` (lens included),
  `attention.info`, dock and pin rects identical before and after `point.show`, with the agent-hue fill
  in the pixels. **Felt property: "this" means what you were looking at, and an agent's "look here"
  lands on the line without moving you.**
- **Ivan looks at.** Ten "fix this" prompts in a day: how often the agent's echo names what he meant.
  That score picks what slice 9 builds.

### Slice 3. Sticky seats

- **Scope.** `Seats` (§3.9) for ring, grid and plane desks; ghost seats; `carrel.settle` as the only
  repack; restore in stage 1; `carrel.dissolve` forgets them.
- **Files.** `Carrel.js`, `DeskTree.js`, `GomuxHub.js`, `SessionStore.js`, `WorkspaceModel.js`;
  `tools/carrel.test.mjs`.
- **Gate.** Hide and show an agent, end one, start one: no other lane's seat moves (teeth: order-based
  seating fails); a reload restores every seat. **Felt property: the room is where you left it.**
- **Ivan looks at.** The hub after a day of agents ending: are the seats where he left them.

### Slice 4. Agent scroll form

- **Scope.** `book.form scroll` (§3.6): the document over the record window, follow-at-end vs held
  `+N newer`, collapsed outputs, the `(session, at)` row index, paging older history at the top, the
  tail-append and scroll-by-aim paths with their cost measured, the title row as plane content.
- **Files.** `collections/Book.js`, `collections/AgentBooks.js` (records shared, no second parse),
  `core/LayoutGenerator.js` / `InstancedSlotBuffer` (row append), `collections/CodeGrid.js`,
  `app/client/SessionBooks.js`, `app/commands/handlers/bookCommands.js`.
- **Gate.** `tools/scroll-form.test.mjs` (gomuxai's corpus through AgentEventReader): shown text equals
  source text (nothing truncated); no row wider than the pin; a held pin doesn't move when 30 events
  append; a reload restores the top row by `(session, at)`; one book id across Holding, attention and
  tuning; append and scroll cost per batch under budget at the window cap (`load.stats`, the `[frames]`
  watcher; teeth: the full-relayout path fails). Pixel: pitch 15, crisp. **Felt property: an agent's
  whole run reads like its screen, past the screen's edge.**
- **Ivan looks at.** A finished agent with no screen, read as a scroll: does he read it instead of the
  rising deck, and is hue enough to tell headline from body at one size.

### Slice 5. Agent-owned desktops

- **Scope.** `naturalPx()`, 1:1 pins; the relay binary source plane `0x03`; `desktop.start / stop /
  list / still` with a CDP Chromium screencast (JPEG first), lossless stills, fit-on-commit; restore
  across reloads with no gesture; `frame.pattern`. Ivan's own monitor stays a gesture capture.
- **Files.** `collections/FrameGrid.js`; `app/commands/handlers/frameCommands.js`; `cli/relay.go`,
  `cli/children.go`, new `cli/desktop.go` (CDP client, Chromium found on PATH or by flag);
  `services/orchestration/WebSocketBridge.js`.
- **Gate.** `cli/relay_source_test.go` binary case. Pixel: a desktop pin at 1:1 against a lossless CDP
  PNG of the same frame, max channel delta ≤ 1; the desktop is back after a reload. No Chromium →
  `desktop.start` fails loud naming what it looked for. **Felt property: a desktop is a real desktop,
  sharp at its own pixels, and comes back after a reload.**
- **Ivan looks at.** `frame.pattern` in a plane (red top-left, true colours), then an agent's browser
  desktop beside its screen.

### Slice 6. Tiling inside a plane

- **Scope.** `PaneLayout` shared by the CameraDock and tiled plane desks, CameraDock moved onto it in
  the same change (§3.11); `Panes` restored in stage 1; named layouts on first tiling, the inbox after;
  the plane size in cells; the x clip lane, UV clip for frames, CPU-cut panels; the viewport policy for
  foreign content with its edge mark; `pane.*` verbs re-pointed and the new ones; the working tree's
  tiling draft rebuilt on it.
- **Files.** new `packages/glyph3d-core/src/services/interaction/PaneLayout.js`; `PaneTree.js`,
  `CameraDock.js`, `Carrel.js`; `core/glyphMaterial.js`, `collections/InstancedField.js`,
  `collections/GlyphBatch.js`, `collections/PanelBatch.js`, `picking/PickingSystem.js`;
  `app/commands/handlers/paneCommands.js`, `carrelCommands.js`.
- **Gate.** A join, an open, an attach change no other pane's `rectDev` (zero tolerance; teeth: a
  split-the-focused-leaf policy fails); dock tests pass unchanged on `PaneLayout`; a clipped foreign
  member's columns are all reachable by scroll and its edge mark shows when columns are off the tile;
  `Panes` round-trips. **Felt property: tiles you arranged stay where you put them.**
- **Ivan looks at.** The same team desk as a pin board and as tiles, a day each: which he keeps.

### Slice 7. Shared carrels

- **Scope.** One-agent plane desks from DeskTree; `carrel.attach / detach / who` as presence and
  attribution; `attention.*` refused from identified agents; agent edits landing in open code members
  with the anchor held; the `fsnotify` fallback.
- **Files.** `cli/relay.go`, `cli/fs.go`, `cli/go.mod`; `app/client/DeskTree.js`, `GomuxHub.js`,
  `SessionBooks.js`, `Holding.js`; new `app/client/Participants.js`;
  `app/commands/handlers/carrelCommands.js`, `attentionCommands.js`.
- **Gate.** `tools/carrel-session.test.mjs`: an anonymous `carrel.attach` fails loud; `attention.set`
  from a participant is refused (by the per-call caller); a corpus Edit event updates an open grid's text
  and the row under the anchor stays at the same screen row. Pixel: before/after an agent edit, the
  anchor row's pixels are identical. **Felt property: agents' changes land where you're reading without
  moving your place.**
- **Ivan looks at.** An agent editing a file he has open in a plane.

### Slice 8. The overlay, map labels, the strip

- **Scope.** `RenderPasses` with Minimap folded in; the overlay scene and its non-enrolled text; the
  hover path through the probe; map labels (§3.14: one size, hard switches, clusters, a waiting agent
  never aggregated away); the strip by bearing (flat cards first); `carrel.neighbor`; off-screen marks
  for deixis and waiting.
- **Files.** new `app/client/RenderPasses.jsx`, `app/client/PlaneOverlay.js`, `app/client/MapLabels.js`,
  `app/client/Strip.js`, `app/commands/handlers/mapLabelCommands.js`; `packages/glyph3d-r3f/src/
  Minimap.jsx`, `app/main.jsx`; `Carrel.js` (`seatMap` / `rollSeat`, NEW).
- **Gate.** `tools/map-labels.test.mjs`: the same pose reached by two paths shows the same label set;
  small pan steps toggle no label more than once; a waiting agent is always shown or edge-marked; shown
  text equals source text; world title and map label never both shown; `carrel.neighbor l` then `h`
  returns, `l` × N visits every seat once; one render-loop owner (a second positive-priority `useFrame`
  fails). Pixel: label cap height in device px unchanged across three camera distances (teeth: today's
  world-sized FieldLabel fails by the distance ratio). **Felt property: you know where everything is
  without reading, and the room tells you who needs you.**
- **Ivan looks at.** The hub from its center with labels on: can he name five places, and does a
  waiting agent's label find his eye.

### Slice 9. Pointing, full (only what slice 2's score asks for)

- **Scope.** From §3.8's full list, the pieces Ivan's ten-prompt score shows missing. Candidates in
  likely order: `seen` and the snapshot ring for streamed terminals; quote re-anchoring and
  `resolved-by-edit`; ghost diffs for `suggest`; the relay-resident point store; breakpoint delivery.
- **Gate.** Per piece, from `tools/deixis-ref.test.mjs`: re-anchor after edits above; orphan on delete;
  resolved-by-edit; a terminal row pointed at frame f with 30 lines streamed after resolves to the row as
  drawn (teeth: without the ring it returns the current row); the noise gate (simulated keys while three
  agents point → zero drawn until `breakpointIdleMs` after the last key). The doesn't-steal gate stays.

### Slice 10. Depth as time

- **10a, the probe.** Layer lists, opaque backs, `pane.layer`, `pane.blink`, `grid.history`, suggest
  strips registered over their lines, the fan as Ivan's quasimode on `plane.fov` as built. Gate: layer
  order and registration headless; the z = 0 layer pixel-identical with the fan off and on. **Ivan looks
  at:** a code pin with its last five revisions, fanned; an agent's scroll by turns, fanned: does he
  read on the fanned layers.
- **10b, the exact endpoint (built; `plane.ortho` off by default, §4.6).** `PlaneCamera` (§4.6), the
  truth helper and every fov-trig site in one change; `plane.fan <on|off|px>`; `plane.blend <0..1>` as
  a raw test handle. Gate:
  `tools/plane-camera.test.mjs` grows (λ = 1 equals `PerspectiveCamera` and λ = 0 equals
  `OrthographicCamera` element for element; the plane at `d₀` keeps its NDC size for all λ; `z_ndc`
  monotonic; the NDC crop equals `setViewOffset` at λ = 1; `pxPerUnitAt` agrees with projecting two
  points); `tools/plane-oblique.test.mjs` (a real LayerStack's 20 pages land on integer device px, page i
  rigidly i·n over, the member's text, backdrop, frame and `now` backing and the camera unmoved; teeth:
  a projection shear (clip x += h·(z + d₀)) moves the backdrop and tears a page's backing off its text, and
  a non-integer n fails); picking at λ = 0; the rg gate. **Felt property:
  the past is right behind the page, and you can read it without flattening.**

### Slice 11. Impostors

- **Scope.** Carrel cards (§3.16) with the layer statement; the postcard on leave; the strip and the hub
  drawing cards; the card budget; the byte-capped pool; persisted cards with staleness stamps.
- **Files.** new `packages/glyph3d-core/src/collections/CarrelCards.js`; `collections/FrameGrid.js`,
  `collections/GlyphFarLod.js`, `picking/PickingSystem.js`; `app/client/Strip.js`,
  `app/client/RenderPasses.jsx`.
- **Gate.** A card of a 200 × 60 terminal vs the live member: max channel delta ≤ 1 (teeth: a half-pixel
  offset fails); capture under 2 ms; GlyphBatch and PanelBatch repack counts unchanged across a card
  pass; the hub with 100 carrels holds frame time within budget (`load.stats`). **Felt property: the
  room is full of your own last views, and it costs nothing while you read.**
- **Ivan looks at.** Five last-view cards beside five outside-view renders, unlabelled: which ones he
  can name.

---

## 7. Collision ideas

### Kept (and where they land)

- **The referent is the fixed point of every transition** (LOD/ortho × presence). Slice 1.
- **Text has one size; a plane desk is laid out in space as it reads** (ZUI × spatial computing):
  entering moves only the camera; later, a dolly toward the desk could enter at the distance where rows
  reach the plane's row. Slice 1 (layout).
- **The pin board as locus** (spatial computing × spatial memory, and Ivan's July rule): a member's rect
  is its place; joins take free space and never re-pack. Slice 1; the tiled form's inbox leaf keeps the
  same law in slice 6.
- **Owned reflows, foreign keeps its size** (window managers × LOD/ortho), with the integer contain-fit
  ladder kept for the CameraDock spotlight in space. Slices 1 and 6.
- **The readable set is the gaze; point at what you saw** (ZUI × presence; LOD/ortho × presence).
  Slice 9, if the score asks.
- **Surfacing is the interruption schedule** (ZUI × presence): breakpoints graded by scale. Slice 9, if
  the score asks.
- **Text is a place** (spatial memory × window managers): any `path:line` in any member resolves to a
  locus. `ref.resolve` in slice 2; clickable links later.
- **Borrow, don't travel** (spatial memory × window managers): a summoned member slides in from its
  home's bearing and the home seat keeps a ghost. Slices 3 (ghost seats) and 8 (the slide).
- **The ring is a rolled-up map** (spatial memory × window managers; ZUI × spatial computing): the strip
  is the ring unrolled, `carrel.neighbor` goes by bearing. Slice 8.
- **One label, three lives** (ZUI × spatial computing): a map label in space travels to the member's
  title row on enter at the same px size. Slice 8.
- **Notifications walk you home** (spatial computing × spatial memory): the waiting line's click enters
  where the agent sits. Slice 1b; the walking animation is a later dial.
- **Tracing paper: depth carries who and when** (LOD/ortho × presence). Slice 10.
- **Depth read obliquely; rise = R/k** (ZUI × spatial computing). Slice 10.
- **One picture, many lives; the postcard is the last page you read** (window managers × LOD/ortho;
  spatial computing × spatial memory): a card is a FrameGrid of a render target. Slice 11.

### Parked

- **Deck of desktops** (the strip as an MRU z-stack behind the plane): it competes with the bearing
  strip and reorders by recency.
- **The overview as an orthographic floor map** where the palace is built by dragging footprints: it
  needs cards first.
- **The arrange tilt** (a Data Mountain pose at partial λ): arranging stays on the pin board until it's
  missed.
- **Every view is a client** (per-client batch caches): revisit if repack counts say so.
- **Presence as degree of interest** driving semantic tiers, and **agents' derived presence bars**:
  motion Ivan didn't cause. Off until he asks.
- **One salience service** ranking card refresh, label area and point count: built when one of those
  budgets is exceeded, not before.
- **The frozen backdrop** with a frozen pick-ID image while entered: panes and the slab already cover
  most of the screen, and it would be a second picking path. Built only if pixels show the backdrop
  matters.
- **Participants' watch/drive modes** and "Ivan's input wins": no agent yet needs to send input to a
  member it doesn't own.
- **Locus hints, since lines, visit marks, step tab strips, edge marks in three sizes**: born when a
  pixel asks.
- **The reel/tape book form** as a ring-desk book.

---

## 8. Open questions for Ivan

1. **Input to agents.** May glyph3d send to gomuxai agents through gomuxai's own commands (`agent.say`
   → `agent send`, `agent.approve` → `agent approve --expect`, `agent.deny`)? It reverses the hub's
   written "read-only: nothing here types into an agent", never with a tmux client. Recommended: yes;
   without it a plane of agents is a monitor, not a tool. Slice 1b's input waits on this.
2. **Pin board or tiles for agent screens.** An agent screen's rect is its own size (pin board: every
   column there, pan or hop between screens) by default, with tiling (each screen clipped to a tile and
   scrolled) as an arrangement you choose. Or tiles first? This is the choice you'll feel most.
3. **Sizes between 8 and 16.** At Cousine's 29 × 54.375 cell, rows are whole pixels only at cell widths
   that are multiples of 8 (8 × 15, 16 × 30). Do you want sizes in between? Then the row pitch becomes
   its own whole-px dial (`plane.rowPx`, line spacing off by up to ½ px), applied to code and terminals
   alike.
4. **The prefix chord and Esc.** Which chord is the plane prefix for your hands? And is "first Esc
   releases the focused screen, second Esc leaves" right, or should leave have its own key only?
5. **The strip's order.** By bearing (where the carrels stand, so memory holds) with `carrel.back` for
   recency, or Stage Manager's recency order?
6. **The hand arc's code.** You dropped hand control entirely; its code (`hand/`, `HandCalib.js`,
   `handCommands.js`) is committed on main and still reads the camera's fov. Delete it from the branch,
   or leave it and scope the camera gates around it?

---

## 9. Critique not taken

- **A plane size in cells as a desk value for slice 1** (buildability critique §3.3): the viewport-free
  part is taken whole; the pin board makes the plane's size the union of its members, so a
  `plane.cols × plane.rows` value arrives only with tiling (slice 6), where a fixed frame needs one.
- **One render-pass owner created in slice 1** (buildability §4.2): taken, but with the first overlay
  (slice 8). Slice 1 draws nothing screen-anchored: title rows are plane content, the waiting line and
  the reply line are DOM.
- **The strip as the dock's entries re-hosted, same `dock.*` verbs** (felt critique §4): the strip shows
  carrels and the dock holds windows, which are different sets. The concern behind it (no second roster,
  no second window manager) is taken: the strip reads Holding membership, and tiling is one `PaneLayout`
  shared with the dock.
- **Counting the share of replies sent from his shell** (felt §3.7): glyph3d can count its own
  `agent.say` calls; replies typed in an outside terminal never reach this repo. The count is glyph3d's
  side only; gomuxai's own logs would answer the rest.
- **Deleting the hand arc before slice 10b** (buildability §2): it is code on main, and deleting it is
  Ivan's call; asked as open question 6.
- **Refusing to enter a plane on an inexact canvas box** (buildability §1, one of its two options): it
  enters with a loud notice instead, so a fractional-dpr display still reads, and the pixel gate fails
  by design. That keeps the failure visible without blocking him.
- **Moving `agent.say/approve/deny` into slice 1 itself** (felt §6.1): kept as its own slice 1b,
  landing right after slice 1, because it reverses a documented rule and waits on Ivan's yes; the
  read-only half (the waiting line) doesn't wait.
- **"A join moves nobody" on a centered ring** (slice 3's gate, built): leaves, hides, ends and
  returns move nobody (ghost seats), and a newcomer takes a ghost when there is one; a newcomer with
  no ghost to take APPENDS and the centered ring re-centers rigidly (every seat by the same arc — the
  arrangement holds). A fixed left anchor would avoid even that, at the price of a small hub sitting
  off to one side behind you; freezing the centering width breaks the boot-time fill (members
  arrive one by one). Ivan judges the look; `tools/carrel.test.mjs` locks what holds.
