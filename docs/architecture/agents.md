# Agents

Agent sessions, their events, agent books and the gomuxai hub (IDE + relay).

## The relay and gomuxai

**Agent transcripts come from gomuxai**: the relay runs the installed `agent` CLI
(`agent sessions --json`, `agent transcript … --follow`) and moves its lines to the display
(`cli/agentevents.go`); nothing in this repo reads a harness transcript. `serve
--sessions-interval` (10s) paces the session list, `--max-followers` (64) caps live
followers, `--no-gomuxai` turns all of it off, `--debug` logs each session-list push's size.
Every `agent` child dies with the relay (`cli/children.go`): Pdeathsig on Linux, however the
relay dies; elsewhere the SIGINT/SIGTERM handler kills them (a SIGKILLed relay off Linux
still orphans its `agent export`).

## Agent session RPCs

Agent sessions and their events ride relay↔display JSON-RPC (`cli/agentevents.go`), the
relay moving gomuxai's lines without reading them: `agentSessions/list` (the latest
`agent sessions --json`, re-run while a display is connected) and the `agentSessions/changed`
push, sent only when a session appears or leaves or a field a display shows changes (status and end reason,
title, workgroup, parent, agent name, harness, cwd/project) — size/mtime/status_at ride the
next push and the list. Follow and read name a session through ONE resolver over that list
(exact session_id, exact path, a workgroup agent's name = its newest non-subagent session, a
unique id prefix; a miss re-polls once; unknown/ambiguous is an RPC error) and hand `agent`
the path. `agentEvents/follow {session, from?}` / `unfollow`: one `agent transcript --follow`
per transcript and byte, shared, killed when no subscription holds it — a display
disconnecting drops its own — at most `--max-followers`. `agentEvents/lines` batches (≤50 ms
or 256 KB, in order, whole lines, on their own display plane behind control traffic; a display
that leaves a push waiting 10 s loses the subscription rather than the relay buffering).
`agentEvents/ended` (a follower exited, code + stderr; or code -1, the display stalled) waits
on that plane as long as the display stays, behind the lines queued before it — a display
always learns. Followers' stderr lands in the relay log as `[agent-transcript]`.
`agentEvents/read {session, from?, until?, tail?}` → `{lines, size}` is a bounded one-shot
ending at min(until, size) (a running session's not-yet-written transcript reads as
`{lines: [], size: 0}`; an ended one's missing file is an error); `tail` (not with `from`) starts at the first line start at/after
`end - tail` (`--from` the line before), so `{until, tail}` pages back without the prefix.

## Agent sessions

**Agent sessions** (`app/client/SessionBooks.js`, `services/data/AgentSessionProvider.js`):
gomuxai is the ONE reader of agent transcripts (its docs/EVENTS.md); the relay runs
`agent sessions --json` (pushed whole as `agentSessions/changed`; `agentSessions/list`) and
`agent transcript <session>` per followed session, and only moves lines
(`agentEvents/follow|unfollow|read` RPCs; `agentEvents/lines|ended` pushes). Every agent book
opens through SessionBooks: `read {tail}` (doubling until it holds the book's cap) → hydrate →
`follow {from: the last at}` → each pushed batch through `AgentEventReader` → `applyEvents`
(an add is a sheet, an update rebuilds its sheet in place; a file sheet shows the event's
`file` text — what the call read, or the file as it left it — else reads its target joined
to the session's cwd, and a refused read says why on the page); paging back reads
`read {until, tail}` windows before each oldest `at`. A FOLLOW only while the session runs
(not ended — a follower is a relay process, and the relay caps them; `setLive` as the status
moves); every follow drops the book's provisional replies first, and `agentEvents/ended` (or a
reconnect) re-follows from the last `at`, backing off. A result far from its call (a
background call's, megabytes on) is read or followed BEFORE its call: the lane holds it as an
orphan and the call adopts it when it pages in. A failed open keeps its book and retries; a
refused follow or a failed open says so on the book (its notice, also in the Agents panel). A
live call that lands ok taps the delta books' watch lane with its event record (meta carries
an edit's patch). Lane ids: a workgroup agent's gomuxai name (its main session — its
subagents carry its workgroup too), else the session id (`laneForSession`). The **agents
desk** (`app/client/SessionDesk.js`) is the `agents` cylinder: the local sessions (no
workgroup) live or written within `gomux.historyHours` — the newest `agents.maxBooks`
(default 24) — get books, a session's subagents sit on its own `agents/<session id>` team
desk (DeskTree, the hub's rule), older sessions open on demand (`agent.open
<session|prefix|name>`, the Agents panel's history — the whole session list) and are seated
there too — a workgroup's subagent (a hub agent's, opened from history) sits on its agent's
team desk at the hub instead; a team desk whose helpers' books have all closed folds. Restore
reopens saved books (by session) through the same path, parents before subagents; a session
that ended before the `gomux.historyHours` window stays closed unless its book was pinned or
tuned (the Agents panel's history opens it). **Hidden agents** (`app/client/AgentVisibility.js`,
`ctx.agentVisibility`) get no book at all — no read, no follower, no seat, no screen — yet stay
listed (dimmed) in the Agents panel: an agent's own override (`agent.hide` / `agent.show`;
`agent.open` shows) else its group's rule (`agent.group <gomux|local> <shown|hidden|ended>` —
`ended`: only running agents get books; a new agent follows its group). It is the ONE "stays
closed" memory: `agent.clear` on a book the hub or the agents desk opened hides it (one opened
from history just closes), and a hidden session keeps its `agents.maxBooks` slot. The hub and
the desk converge on the rule (every push, every change) and wait on `agentVisibility.ready`
before opening anything; the set is the durable `agents:visibility` surface (Visibility
component), saved as the snapshot's `agentVisibility` and restored in stage 1, so a reload
never opens a hidden agent. `agent.hidden` reports it. Gates: `tools/session-books.test.mjs`,
`tools/agent-events.test.mjs`, `tools/agent-visibility.test.mjs`.

## gomuxai hub

**gomuxai hub** (`app/client/GomuxHub.js`, relay `cli/gomux.go`): the relay keeps one
`agent export --json --follow --all` running (gomuxai's own read-only feed of every store it can
find; `--gomuxai <dir>` adds a `--store`), folds its lines into the agent tree, and pushes it
(`gomux/changed`; `gomux/list`). Each agent shown (live, or finished within
`gomux.historyHours`) is an agent book whose lane id is its gomuxai name, opened from its
current session (the node's `sessionId`, else its transcript's path) through SessionBooks
(`agentEvents/*`: gomuxai's events, never the transcript itself); an
agent that moves on to a new session keeps its book. The tree is desks (`app/client/DeskTree.js`): the world-managed
`gomux` carrel — born a CYLINDER by default (`gomux.hubForm`: a natural-seat ring whose rows
stack up to `carrel.cylinderMaxRows` before it widens past `carrel.cylinderRadius`; everything
around you is a camera turn away); an agent with helpers gets a flat `gomux/<name>` team carrel
seated in its parent's desk (its book first, then its helpers), titled `<name> · N helpers`,
born `gomux.gap` apart.
Desks seat a Book by `getSeatBounds()` — the room it draws in (cover pad, tab ruler, nameplate)
— while framing and the tree keep its page box (`getLocalBounds`). An agent book RESERVES its
room (`Book.setReserve`, at its sheet cap): its frame (`frameBounds` — the spread, the deck
at the cap, the full rise; set by its settings, never by what's on screen) is what the cover
wraps, the nameplate (bottom pinned, `book.labelGap` above; its band only grows), tabs and
aside anchor to, and the seat measures — sheets landing and pages turning move none of it.
Seats are CALM (`Carrel`): a member that claims its room (`claimsSeat` — a framed book, a
desk) is seated as stated; any other (a grid, a terminal) by a seat that only GROWS (the
union of its sizes), so a shrink never pulls its neighbors in. A desk re-learns its seats
when a member joins or leaves, or on `carrel.settle [name]`. Hub desks are `derived` —
rebuilt from the tree, never saved — yet a value set on one is its own and comes back with it
(per-instance knobs, below). Status rides `lane.meta.gomux` (the agent's own status wins
over what a live batch did to the book). The relay names a claude agent's session by its
transcript's file name when export reports none. `gomux.attach <name>`
shows the agent's live tmux screen as terminal `gx-<name>`, riding beside its book (the book's
aside — `Book.setAside`: right of the cover, height-fit to it, in its seat box) — with NO
tmux client on gomuxai's server (any client there, even read-only, becomes the default target of
every tmux command and broke gomuxai's send-keys): a capture-pane snapshot, then `tail -F` of the
pane's pipe-pane log, inside an ordinary termd terminal of ours; input goes nowhere (`gomux.detach`
closes only ours). One adapter per screen: the relay answers a repeat ask (a reload re-asking
before its adapters re-adopt) with the live one. A screen reads its agent's pane size (the relay
pushes `gomux/paneSize` when it moves) and a resize writes back (`gomux.resize` → tmux
`resize-window` on the agent's session — a server command, no client — and its CLI reflows).
With `gomux.autoScreens` (default on) every live agent's screen opens beside its book; a
detached one stays closed. Seating converges (`GomuxHub._seatScreens`, on every tree push, book
open and terminal registration): a screen up but not riding its book is given to it, whichever
arrived first — a reload re-adopts screens before their books open.
Once per load (`gomux.centerOnLoad`) the camera stands at the hub's center (`carrel.enter`)
when the tree, the books and the desks have stopped moving — polled to the same answer three
times, since the load is part events, part state.
Verbs: `gomux.list`, `gomux.status`, `gomux.refresh`, `gomux.attach`, `gomux.detach`.
Read-only: nothing here types into, starts, or stops an agent.
