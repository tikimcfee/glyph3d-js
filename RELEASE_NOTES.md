## What's new in v0.2.0

~460 commits since `v0.1.0`. The short version: glyph3d went from a renderer
with an app around it to a working 3D reading instrument — projects lay out as
structures you can read, terminals are fully live, and the whole workspace
survives a reload.

**The field reads as the project.** `ContentTree` mirrors the directory tree
into the scene graph, and pluggable layout schemes pack it: `packed`, `walk`,
`district`, `jellyfish` (directories as cylindrical columns of file panels),
and `tree`. Directory volumes, ownership lines, and ordered arrows keep the
structure legible, and every file lands in the field — no count caps.

**Code is semantic.** Tree-sitter syntax coloring; an AST-backed semantic
model; structural layouts that move whole callable units (functions as
sub-blocks, a nested strata view); LSP over the relay — definition and
references at the caret, breadcrumb chips, a results panel.

**Terminals grew up.** Per-cell ANSI backgrounds (git diffs and `--color`
CLIs read correctly in 3D), scrollback paged into depth, live grip-resize,
keyboard capture with a focus-aware block cursor, modifier-aware key encoding
(word motion, word-aware Backspace), and self-healing re-adoption across
reloads — resize can no longer race the redraw.

**Vector glyphs matured.** A prebaked Slug glyph core ships as a static asset
and hydrates at boot instead of re-encoding; new glyphs append incrementally.
The monospace cell derives from real font extents, emoji get double-width
cells in a growable atlas, and the cursor is codepoint-consistent — emoji
editing can't corrupt the buffer.

**Picking and input.** Multi-channel GPU picking is the single hit-test
source, down to a glyph: click-to-caret in any layout, in-place editing, hjkl
spatial focus navigation, and composable gesture/keyboard responder chains.

**Camera.** An egocentric fly camera with proximity auto-slow and a
soft-bounds leash; focus squares to the object's own plane, so a rotated grid
frames face-on; interruptible `flyTo` animation.

**Windows, dock, panes.** Windows dock into a camera-locked radial dome with
a spotlight focus slot; a binary-BSP pane compositor tiles the view frame,
and a framed window reshapes to fill its pane; `FrameGrid` turns a live video
capture into an interactive glyph window.

**The workspace persists.** A declarative `WorkspaceModel` — session restore
applies state directly, no verb replay. Files, camera, dock, focus, and
terminals come back after a reload, served by a `SessionStore` in the binary.

**Observability.** The dispatcher self-instruments (every verb timed, counted,
trace-logged), and the relay keeps a queryable SQLite + FTS5 store of every
browser log record — `log.query` / `log.search` / `log.errors` / `log.stats`
answer with no page open.

**Agent trails.** A coding-agent session renders as a spatial corridor: tool
calls as moment cards with per-tool metadata, touched files on a rail, a
rolodex carousel to scrub history, and the live conversation decked alongside.

**Performance.** One shared TSL material per grid kind (bulk load 7× faster),
O(1) colorizer column conversion (a 200-file load: 58s → 2.7s), frustum
culling from real instance bounds, distance LOD, and frame-time-adaptive
reload budgets.

**The bus got friendlier.** Dot-free verb spelling (`grid list` ==
`grid.list`), `help` is a compact orientation map computed from the live
registry, and the command palette ranks nouns — files, sheets, layout schemes
— alongside verbs in one list.

Library releases: [`@glyph3d/core@0.2.0`](https://www.npmjs.com/package/@glyph3d/core)
and [`@glyph3d/r3f@0.2.0`](https://www.npmjs.com/package/@glyph3d/r3f).

---

**glyph3d-cli** — a single self-contained binary. Download the one for your OS,
run it, and it serves glyph3d in your browser at http://localhost:8080. No
install, no dependencies; the whole app is baked into the binary.

### macOS / Linux

```sh
chmod +x glyph3d-cli-<platform>
./glyph3d-cli-<platform> serve            # browse the current directory
./glyph3d-cli-<platform> serve ~/project  # …or point it at a repo
```

macOS is unsigned here, so Gatekeeper may say it's from an "unidentified
developer." Clear the quarantine flag once:

```sh
xattr -d com.apple.quarantine glyph3d-cli-darwin-*
```

…or right-click the binary → **Open** the first time.

### Windows

```
glyph3d-cli-windows-amd64.exe serve
```

SmartScreen may warn (unsigned) — **More info → Run anyway**.

---

Then open **http://localhost:8080**. `Ctrl-C` to stop.

| platform | file |
| --- | --- |
| macOS (Apple Silicon) | `glyph3d-cli-darwin-arm64` |
| macOS (Intel) | `glyph3d-cli-darwin-amd64` |
| Linux (x86-64) | `glyph3d-cli-linux-amd64` |
| Linux (ARM64) | `glyph3d-cli-linux-arm64` |
| Windows (x86-64) | `glyph3d-cli-windows-amd64.exe` |
