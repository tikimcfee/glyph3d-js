# The wall

The wall app (`wall/`, entry `wall/main.jsx`, composition root `wall/TerminalWall.js`).
**`wall/`** — the wall: an infinite flat (orthographic) canvas of terminals on the same
core and relay (Vite :5180, `?relay=PORT`, default 8080 — a relay takes ONE display, so beside
the IDE the wall needs its own relay; a refused display's chip says why). Pan (drag), zoom (wheel or pinch,
eased about the pointer: `WallCamera.WHEEL_ZOOM`), type, cycle, resize by the border; chords are ⌘ on macOS, Ctrl+Alt elsewhere (`wall/chord.js`).
Title bars hold each terminal's whole name, shrunk to fit; past the bar's text floor
(`TitleBar` `minTextPx`) or on a narrow terminal, a map label carries it. A hovered bar shows
hide (a click: off the canvas, still running) and close (HELD for `closeHoldMs`, a ring filling:
kills it); chord+- hides, chord+X held closes. ⇧-drag on empty canvas lassoes terminals into the
selection (⇧-click toggles one); its button or chord+G makes a group (`WallGroups`): named, `tile`
(N columns packed `gap` apart, `wallLayout.tileLayout`) or `freeform` (members keep their spots),
drawn as a quiet backdrop + header; drag the header to move every member. The palette (chord+K)
and the sidebar (chord+B) list every terminal, hidden ones marked, under its group (groups fold).
The terminals live in `g3d-termd` (below), and termd's status rides along with no query of its
own: the topbar's termd chip, a status window (chord+S: the daemon and its terminals; a row
reveals its terminal — `wall/StatusWindow.jsx`) and a notice under the topbar when its brain
restarts (amber, once it lingers past `restartNoticeMs`) or is unreachable, failed or lost (red).
The sidebar and the status window float or dock left/right, side by side on one edge
(`wall/Panel.jsx`). Every action is a `wall.*` verb (`wall/wallCommands.js`:
hide/show/reveal/close/select/group…/sidebar/status/config) that the buttons, chords, palette,
sidebar, status window and CLI all run; knobs live in `wall/wallConfig.js` (`wall.config`).
Names, spots, hidden terminals, groups, the sidebar and the status window's place (`WallStore`)
are per relay and pruned against the relay's live terminals on every connect (a group loses dead
members, goes when empty); a kill forgets at once. `TerminalWall` is its composition root
(start/stop symmetric); gate
`bun tools/wall-e2e.mjs` — its own relay (`tools/lib/wall-relay.mjs`, which the wall's perf tools
share), termd namespace and terminals; `--reuse-relay` to run on one you started.

**The canvas is drafting paper.** `wall/WallPaper.js` draws it: the canvas colour (the renderer's
clear colour, the `background` knob) and a grid of minor lines every `gridMinor` world units, every
`gridMajorEvery`th one a major line — one full-screen quad whose fragment shader finds the lines from
the camera, opaque lines and the rest discarded, drawn first and without depth. Its levels are
discrete (`wallSnap.gridLevels`): a level whose lines would sit closer than `gridMinPx` on screen is
not drawn — a hard switch, never a fade. A line covers exactly `gridLinePx` pixels in its specified
sRGB colour (rendering.md "Colour"; `wall-e2e` reads them back ±2). Terminals on the wall are born
opaque (`TERMINAL_THEME` in `TerminalWall`: the host's theme), so the grid never shows through one.

**Snapping** (`wall/wallSnap.js`, applied by `WallPointer`). A terminal's size is whole cells — the
atlas's cell, not square and not the grid's — so not all four edges can sit on lines. The rule: a
MOVE (title-bar drag, ⌥-drag, a map label's drag) lands the body's top-left corner on the nearest
grid crossing; a RESIZE lands the dragged edge on the grid line nearest the pointer, sized to the
most whole cells that keep it on or inside that line (short of it by less than a cell), the opposite
edge still. Left and top edges line up exactly across terminals; a right or bottom edge sits on its
line or just inside it. A group's header drag lands the group's top-left body corner (for a tiled
group, its first tile) on a crossing, moving every member by that one delta — the tiling's own math
is untouched; a tiled member's own drag and resize don't snap (its spot is its tile's). The step is
the minor spacing while minor lines draw at this zoom, else the major. The `snap` knob turns it on or
off (`wall.snap`, chord+'); Ctrl (⌃ on macOS) held during a drag inverts it for as long as it's held
(`chord.invertsSnap`: not ⌥, which moves, not ⇧, which lassoes, not the chord). The grid shows or
hides by `gridShow` (`wall.grid`, chord+⇧+'); snapping works with it hidden.

**The settings panel** (`wall/SettingsPanel.jsx`, chord+`,`, the topbar's settings button, the
palette, `wall.settings`) lists every wall knob in sections — Canvas, Terminals, Groups, Status,
Input — from ONE schema, `wall/wallSettings.js` (`KNOBS`: section, label, type, range, a sentence
saying what changing it does; the IDE Settings schema's type vocabulary: bool, number, color, enum).
`wall.config` checks every value by that schema (refused naming the knob, never clamped) and every
WALL_CONFIG knob must have an entry (wallConfig fails loudly as it loads). The search box takes the
keys when the panel opens; typing filters knobs by label, key, description and section title (every
word must match somewhere; `searchSettings`, also `wall.config.find`): matching sections open, empty
ones go, the words are marked. ↑/↓ choose a knob; Enter flips a switch, steps a choice or puts the
keys in its field (Enter sets it, Escape drops the edit); Escape clears the search, then closes.
Every edit is `wall.config <knob> <value>` (↺ is `… default`). The knobs the person sets persist in
`WallStore` per relay (`config`; a remembered value that no longer passes is dropped, loudly), as do
the panel's place and folded sections; it floats or docks beside the other panels (`Panel.jsx`).
Gates: `tools/wall-snap.test.mjs`, `tools/wall-settings.test.mjs`, and `wall-e2e`'s grid steps.
