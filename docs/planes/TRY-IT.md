# Planes: Try It

A short walkthrough of what is built on branch `planes` and the verbs to inspect each piece through the command bus (`./glyph3d-cli --as '' <verb …>` or the in-app CommandBar).

---

## 1. Plane View & Pixel-Exact Reading

Enter any flat surface or plane desk to square the camera to it at a narrow lens (`plane.fov`, 1°) where each text column is `plane.cellPx` (8) whole device pixels wide and the cell-grid origin sits on a device-pixel corner.

```sh
./glyph3d-cli --as '' plane.enter <surface-or-carrel:name>
./glyph3d-cli --as '' plane.state
./glyph3d-cli --as '' plane.leave
```

**What to notice:**
- The ease holds the point you were looking at (`referent`) stationary on screen while zooming to 1:1 device pixels; near/far forms a tight slab around the plane so nothing in front of it occludes the view.
- `plane.state` reports `viewport.exact` (whether the WebGL drawing buffer matches the canvas's device-pixel box 1:1) and warns if browser zoom or scaling makes it inexact.
- Inside a plane, drag pans 1:1, the wheel scrolls the surface under the cursor, and `Esc` (or `plane.leave`) eases back to the pose you entered from.

---

## 2. Plane Desks: Pins, Tiles, Clip, the Strip & Carrel Cards

Plane desks (`Carrel` mode `plane`) are persistent 2D workspaces arranged in 3D space.

```sh
./glyph3d-cli --as '' carrel.enter <desk>
./glyph3d-cli --as '' carrel.set <desk> planeArrange tiles
./glyph3d-cli --as '' carrel.card <desk> 512 --show card
```

**What to notice:**
- **Pins (`planeArrange pins`, default):** Every member sits at its natural size on shelves in sticky seat order (a 239-column terminal stays 239 columns wide; a frame pins at 1 texel = 1 device pixel). Leaving members leave ghost seats so neighbors never jump until `carrel.settle <desk>` repacks.
- **Tiles (`planeArrange tiles`):** A `PaneTree` tiling manager (`pane.layout <even|main|stack>`, `pane.split`, `pane.resize`, `pane.zoom`). Surfaces that do not reflow are clipped cleanly at their tile boundaries with edge marks and pan inside the tile via `pane.scroll <cols> [rows]`.
- **Keyboard (`Ctrl+Space` plane prefix):** Press `Ctrl+Space`, then `h`/`j`/`k`/`l` to focus neighbor pins or tiles, `Tab` for previous desk, `z` to zoom a tile, `]`/`[` to cycle tabs, or `q` to leave.
- **The Strip & Map Labels:** Every entered plane reserves a left-edge strip ordered by true compass bearing to the other desks (`carrel.neighbor <h|l|j|k|parent|child>`), keeping column 0 of the entered surface clear to the right of the strip, with badges for waiting agents and off-screen edge marks for points (`label.list`, `label.explain <id>`).
- **Carrel Cards:** `carrel.card` and `card.list` capture orthographic render-target impostors of desks (`CARD_LAYER = 29`, byte-capped LRU pool; automatic background refresh is gated by `carrel.card.enabled`, off by default).

---

## 3. Agent Desks: Scroll Books, Live Screens & Owned Desktops/Terminals

Every agent with helpers or a live tmux screen (`gx-<agent>`) stands at its own plane desk `gomux/<agent>`, with its book and its surfaces side by side.

```sh
./glyph3d-cli --as '' gomux.list
./glyph3d-cli --as '' agent.surfaces
./glyph3d-cli --as <agent> desktop.start <name> 1280x720 --browser <url>
```

**What to notice:**
- **Scroll books (`book.form <id> scroll`):** On a plane desk, an agent's run reads as one continuous document at uniform text size. Long tool outputs and file snapshots collapse to a single summary row (`▸ output · N lines`) until clicked in place or opened with `book.expand <id> <step|top|all>`.
- **Read-only live screens (`gomux.attach <agent>`):** Streams the agent's tmux pane beside its book without attaching a tmux client to the agent's server.
- **Owned terminals & desktops (`AgentSurfaces`):** Any terminal (`terminal.spawn`) or headless Chromium desktop (`desktop.start`) created by an identified caller (`--as <agent>`) is claimed by that agent, seated automatically at `gomux/<agent>`, and kept across browser reloads; after a relay restart its desktops start again on their own (the relay keeps their specs in `.glyph3d/`), and its terminals come back with `terminal.recover`. When the agent finishes, its surfaces are marked (`ownerEnded`) rather than stopped.
- **Driving owned desktops:** An agent (or the person) drives its desktop over CDP with `desktop.go <name> <url>`, `desktop.click <name> <x> <y>`, `desktop.type <name> <text>`, `desktop.key <name> <key>`, `desktop.scroll <name> <dx> <dy>`, and `desktop.still <name>` (`desktop.eval` is excluded; other identified agents are refused).

---

## 4. Team Channel

A team's parent and helpers share a single chronological message scroll pinned at `gomux/<team>`.

```sh
./glyph3d-cli --as '' team.channel <team> show
./glyph3d-cli --as '' team.channel <team> rows -10
./glyph3d-cli --as '' team.channel <team> hide
```

**What to notice:**
- `channel:<team>` merges every message between the team's agents and you oldest-first, with `from → to · HH:MM:SS` headers in the sender's hue over the exact message text.
- New messages append only their tail rows; scrolling up holds your view while live messages continue arriving.

---

## 5. Depth as Time & the Parallax Fan

Stand a surface's history behind it on its own cell grid and fan the stack out in depth.

```sh
./glyph3d-cli --as '' layer.show <id> 5
./glyph3d-cli --as '' plane.fov 18
./glyph3d-cli --as '' pane.layer <id> 1
```

**What to notice:**
- `layer.show <id> [n]` stands past pages behind the surface: git revisions (`fs/gitLog --follow`) behind a source file, earlier turns behind an agent scroll, or scrollback screens behind a terminal — stepped back in `z` and raised so each older page's top rows peek above the page in front.
- Holding `Ctrl+Space` past key-repeat (or running `plane.fov 18`, reset with `plane.fov default`) widens the lens while holding the foreground scale constant, fanning the stack out with parallax.
- `pane.layer <id> 1` brings a past layer to `z = 0` (`pane.layer <id> now` restores the live surface); `pane.blink <id> 0 1` alternates two layers in place (`pane.blink <id> off` stops).

---

## 6. Shared Pointing (Deixis)

Two-way references (`this` and `that`) between you and agents without stealing camera or focus.

```sh
./glyph3d-cli --as '' deixis.here hover
./glyph3d-cli --as '' point.mark here
./glyph3d-cli --as <agent> point.show "<file>:<line>" --kind suggest --say "<note>" --with "<replacement>"
```

**What to notice:**
- `point.mark` (or `Ctrl+Space` then `p`) resolves what you are pointing at — a source line with its quote or a terminal row's exact drawn characters at that moment — and drafts `this = <ref>` into the CommandBar.
- `point.show` highlights the target line in the calling agent's hue without moving your camera, focus, or keyboard target; `--kind suggest --with <text>` records the proposed text, and the point resolves when an edit makes it. While you are typing, incoming points wait in `held` state until you pause.
- Points re-anchor automatically as lines are inserted or deleted above them, and a `suggest` point marks itself `resolved` when an edit produces its proposed text. Use `point.list`, `point.go [id]`, and `point.clear [id|all]` to inspect, visit, or dismiss points.

---

## 7. Agent Edits & Open Files Following Disk

Open files stay synchronized with disk writes from agents and external tools without losing your reading line.

```sh
./glyph3d-cli --as '' file.open <path>
./glyph3d-cli --as '' log.search "a change on disk"
```

**What to notice:**
- The relay watches only the refcounted parent directories of open subscribed files (`fs/watch`, never a recursive tree walk).
- When an agent's Edit/Write or an external tool modifies an open file on disk, the `CodeGrid` updates in place while holding the screen row you are reading stationary (grids with unsaved local edits are left untouched).

---

## 8. Answering Agents (`gomux.input`, Off by Default)

Reply to or approve waiting agents directly from where you read them once opt-in input is enabled.

```sh
./glyph3d-cli --as '' agent.waiting
./glyph3d-cli --as '' gomux.status <agent>
./glyph3d-cli --as '' agent.say <agent> "<message>"
```

**What to notice:**
- `agent.waiting` and the HUD waiting bar list every agent waiting on a prompt or tool permission.
- Answering is gated behind **Settings ▸ gomuxai ▸ `gomux.input`** (off by default so browsing is strictly read-only).
- Once `gomux.input` is enabled, pressing a printable key on a focused agent screen opens the CommandBar pre-filled with `agent.say <agent> …`, and `Ctrl+Space` then `y` / `n` (or `agent.approve <agent> --expect <tool>` / `agent.deny <agent>`) answers through gomuxai's own commands (refusing identified agent callers).

---

## Checking It All

One command runs every plane feature's live check on a relay and display of its own (a scratch root,
its own tmux socket, agent screens off — it never touches your display) and prints one verdict table;
`--port 8080` points it at the running display instead:

```sh
bun tools/planes-e2e.mjs [--out-dir <dir>]
```

The headless gates for the whole branch: `tools/verify-staged.sh` (every `tools/*.test.mjs` on the
committed snapshot, GPU gates on a scratch Vite), and `cd cli && go test ./...`.

---

## One-Command Showcase

Run the non-destructive showcase script to step through the live desks, plane state, layer stacks, team channels, points, and cards on the command bus (or pass `--no-camera` to inspect without moving the camera):

```sh
bun tools/planes-showcase.mjs
```
