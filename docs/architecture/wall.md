# The wall

The wall app (`wall/`, entry `wall/main.jsx`, composition root `wall/TerminalWall.js`).
**`wall/`** — the wall: an infinite flat (orthographic) canvas of terminals on the same
core and relay (Vite :5180, `?relay=PORT`, default 8080 — a relay takes ONE display, so beside
the IDE the wall needs its own relay; a refused display's chip says why). Pan (drag, or a plain wheel /
two-finger swipe — over the focused terminal the wheel is its scrollback), zoom (a wheel with a zoom key —
`zoomKeys`, Ctrl/Alt/⌘ by default — or pinch; about the pointer, a mouse notch eased: `WallCamera.WHEEL_ZOOM`,
`chord.js` `zoomsWheel`),
type, cycle, resize by the border; chords are ⌘ on macOS, Ctrl+Alt elsewhere (`wall/chord.js`).
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
hide/show/reveal/spawn/fit/close/select/group…/sidebar/status/menu/config/snap/grid/settings) that the buttons,
chords, palette, sidebar, status window, right-click menu and CLI all run; knobs live in `wall/wallConfig.js` (`wall.config`).
A right-click opens the wall's own menu (`wall/contextMenu.js` decides, `WallMenu` routes the
events, `ContextMenu.jsx` draws it; `wall.menu` opens and closes it): on a terminal — frame, focus,
rename, add to / take out of the selection, group (new, with the selection, add to a group, take
out), size (the `menuSizes` offers, and `custom…`: cols × rows fields on its own size, Tab between
them, Enter resizes through `terminal.resize`, Esc cancels, a non-whole number, 0 or past termd's
u16 refused with the reason under the row), redraw (`terminal.refresh`), Option as Alt
(wall-wide, `wall.config optionAsAlt`), hide, and close HELD for `closeHoldMs` (the hold ring); on a
group's header — frame, rename, layout, columns, select its terminals, hide all, ungroup; on empty
canvas — a new terminal with its window's top-left at the point (`wall.spawn x y`; with snap on, its
body's top-left on the nearest crossing), fit all (`wall.fit`), select all (`wall.select all`), snap
on/off (`wall.snap`), grid show/hide (`wall.grid`), the sidebar, the status window, the settings
(`wall.settings`). Every row is a verb.
It never takes the browser's menu away: a second right-click while it is open, Shift+right-click,
and a right-click on a text field or the DOM chrome (sidebar, palette, status window) are the
browser's. The FOCUSED terminal (`focusedId`, the one the keys go to), when its program turned mouse
reporting on (DECSET 9/1000/1002/1003, read off its emulator: `TerminalWall.mouseReporting`), owns a
right-click on its body, and Shift+right-click reaches the wall's menu (Ghostty's rule); a terminal
only hovered gives its right-click to the wall's menu whatever its program asked. The program's
right-click is its press and release (below); the menu only prevents the browser's. The menu sits by the pointer, flipped at
the view's edges; ↑ ↓ ← → Enter move and choose, Esc, a click outside, a wheel, a pan or its target
going away close it; the ContextMenu key or Shift+F10 opens it on the focused terminal. Its knobs
are the Menu section's: `menuHint` (the footer line) and `menuSizes` (the size offers, a line of
COLSxROWS). On macOS a Ctrl+click is the OS's right-click, so it opens the menu and starts no drag;
⌃ still frees a drag from snapping once the drag is under way (press, then hold ⌃).
Names, spots, hidden terminals, groups, the sidebar and the status window's place (`WallStore`)
are per relay and pruned against the relay's live terminals on every connect (a group loses dead
members, goes when empty); a kill forgets at once. `TerminalWall` is its composition root
(start/stop symmetric); gate
`bun tools/wall-e2e.mjs` — its own relay (`tools/lib/wall-relay.mjs`, which the wall's perf tools
share), termd namespace and terminals; `--reuse-relay` to run on one you started.

**The mouse, for a program that hears it** (`wall/WallMouse.js`, asked first by `WallPointer`).
The FOCUSED terminal's program, once it turned mouse reporting on (DECSET 9/1000/1002/1003, read off
its emulator: `TerminalGrid.mouseTracking`), gets the pointer on that terminal's body as a terminal
gives it: a press of the left, middle, right, back or forward button, every press and release of
the gesture it starts, and a move with a button held, until the last button is let go — off the
terminal too, clamped to its edge, as terminals keep reporting a drag that left the window; with
any-event tracking (1003) the hover over the focused body too. Moves go once per cell, never per
pixel. termd encodes each in the program's live modes and drops what they don't report
(docs/termd/DESIGN.md, "The mouse"): the wall sends the event — `TerminalGrid.sendMouse` →
`terminal.mouse` → the adapter → termd's `mouse` op (protocol 1.4) — and the cell, fractional
(`col` 3.5 is the fourth column's middle; SGR-pixels reads the fraction), from the grid's own
geometry (`TerminalGrid.cellAt`: a slot sits at its cell's left edge and vertical centre). The wall
keeps what is its own: Shift (the lasso and ⇧-click now, selection later: Ghostty's
`mouse-shift-capture` default), Alt on the left button (⌥-drag moves), the title bar, the border and
its grip, the wheel's zoom modifier. An unfocused terminal's click focuses it and reaches nothing: a
program gets the mouse only once its terminal has the keys. A double-click on the program's body is
the program's (no frame), and the pointer there is the arrow. The wheel over the focused terminal
is `terminal.scroll` with the pointer's cell: termd's scrollback on the primary screen, as ever; on
the alternate screen the adapter sends termd one wheel notch per line at that cell, which termd
reports to a program that hears the mouse and makes cursor keys for one that doesn't (alternate
scroll, mode 1007: `less`, `man`). `terminal.mouse <id> <press|release|move> <button> <col> <row>
[mods…]` is the same event from the CLI. Gates: `tools/wall-mouse.test.mjs`, and `wall-e2e`'s mouse
steps (a program echoing what it reads in hex: a click's exact SGR bytes, a drag under 1000 and
1002, an unfocused click and a Shift+click reaching nothing, the alt-screen wheel).

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
(`chord.invertsSnap`: not ⌥, which moves, not ⇧, which lassoes, not the chord). On macOS ⌃ at the
press is a right-click (the menu's), so there it is pressed once the drag has begun. The grid shows or
hides by `gridShow` (`wall.grid`, chord+⇧+'); snapping works with it hidden.

**The settings panel** (`wall/SettingsPanel.jsx`, chord+`,`, the topbar's settings button, the
palette, `wall.settings`, the canvas's right-click menu) lists every wall knob in sections —
Canvas, Terminals, Text, Groups, Status, Input, Menu — from ONE schema, `wall/wallSettings.js` (`KNOBS`:
section, label, type, range, a sentence saying what changing it does; the IDE Settings schema's type
vocabulary: bool, number, color, enum — plus text, a line of words its knob's `parse` checks, edited
as one value: `wall.config menuSizes 80x24 120x36` joins the words).
The Text section holds the terminals' text. `fontFamily` (an enum of the font chain's families:
core `fonts/families.js` — Cousine, Monaspace Neon, Monaspace Argon; Monaspace Neon by default) is
the family every terminal draws in: a set or a reset calls each terminal's `setFontFamily` — live,
cols × rows unchanged, its size on the canvas following the family's cell (a tiled group re-tiles)
— and a new terminal is born in it (the TerminalHost's theme). `boldIsBright` (off by default:
bold is the bold face, in the colour the program named) gives bold text in a standard colour its
bright twin, on every terminal at once. The other four (`lineThickness`, `underlineRaise`,
`curlyAmplitude`, `dimAlpha`) are the glyph shader's line style (`setGlyphLineStyle`, born from
core's `GLYPH_LINE_DEFAULTS`): a set or a reset reaches every terminal's underlines,
strikethroughs and dim text at once.
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
