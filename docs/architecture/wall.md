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
