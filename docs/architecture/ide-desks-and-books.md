# IDE desks and books

Books (`collections/Book.js`) and per-instance knobs on desks and books.

## Per-instance knobs

**Per-instance knobs** (`app/client/tuning.js`): Settings are the values a desk or a shelf book
is BORN with — a Settings change never pushes onto a live one. A value set on ONE instance
(`carrel.set <name> <knob> <v>`, `book.set [id] <knob> <v>`, `book.form`) is its own and wins:
no owner re-stamps it (the hub's tree push, the agents desk's sweep, a shelf's Settings
re-apply — `Book.setDeckDefaults` passes a book's own deck values by); `default` hands a knob
back (a desk to `Carrel.born`, a book to its shelf's default); `carrel.get` / `book.get` read
value · born · own. Own values are the workspace model's durable `Tuning` component
(`view.tune`, keyed by registry id: `carrel:<name>`, `agent:book:<id>`, `delta:book:<id>`),
saved as the snapshot's `tunings` and restored FIRST — so a saved desk (whose `serialize()`
holds what it was born as) and a derived hub desk (rebuilt each boot) both stand up wearing
them, and anything registering later is projected. The HUD's collapsible **Desk** section (the
desk the focused thing sits at) and **Book** section (the focused agent/delta book) show and
edit them through those verbs. The hub and the agents desk are born cylinders
(`cylinderForm`: `carrel.cylinderRadius`, `carrel.cylinderMaxRows`).
Gate: `tools/desk-tuning.test.mjs`.

## Books

**Books** (`collections/Book.js`) — library volumes, agent runs, delta sets: a deck of
sheets whose one nav state is the head. The open sheet fronts at z = 0, the sheets still
ahead recede a pitch each — and RISE a step each (`deck.rise`, the first `riseRows`; agent
books `book.deckRise`), so every headline ahead peeks over the page in front like a list
row and a run's rhythm reads at a glance — the sheets turned past lie pressed in a block
at the deck's back — the deck's box never depends on the head. A turn CUTS the sheets changing sides
and slides the reading deck at most `books.turnSlide` pitches: nothing flies through the
deck. Shift+wheel / two-finger drag page through a detent (`app/client/wheelDetent.js`,
`books.wheel*`); bare `book.*` verbs and the `, . < >` keys page the book in focus
(`app/client/bookFocus.js`). An agent sheet is a spread: the verso (`[verb]` headline,
the call's remaining lines, info rows) and the recto (prose, a file snapshot, an output,
an image). Each side has a text size (a world row height: `versoTextSize` is the
headline's, `rectoTextSize` prose's — the other blocks keep a ratio of it) and a break
(`wrap` to the page | `natural`, the text's own lines): Settings ▸ Agent Books holds the
deck defaults, `book.set <id> <knob>` (the HUD's Book section) gives one book its own.
ONE sizing rule (`fitTextStack`, `collections/ActionPage.js`): a block's size is the most
it's set at; too big for its page, it scales DOWN — a natural long line shrinks its block
(left to right), wrapped text shrinks only if still too tall; nothing is upscaled.
Gate: `tools/book-page-text.test.mjs`. An agent book's tabs are its timeline (each sheet's number in
the run, hued by action kind, the open one raised); the HUD reads turn · sheet · live|held
(the turn = the open sheet's event's prompt). Fed by gomuxai's event stream
(`collections/agentEvents.js` reads it; `AgentBooks.applyEvents`), a book is one sheet per
EVENT, never grouped: prompts of every origin are first-class sheets (tagged by whose words —
`[you]`, `[you · queued]`, `[delivered]`, `[notification]`, `[peer]`, `[command]`,
`[harness]` — in the prompt hue), bookkeeping tool calls are sheets too, set in a dim noise
hue (`book.showNoise` off hides them), an event of a branch the conversation left (gomuxai's
`abandoned`: a prompt edited and sent again, and what answered it) keeps its sheet, set in the same
dim lift and marked abandoned in its info rows, every sheet carries its turn id + index, and an
event's update (a tool's result, a confirmed reply, a branch abandoned) rebuilds its sheet IN
PLACE (`Book.replaceSheet`).
An agent book is a fixed-size WINDOW (its cap of sheets) sliding over its whole run
(`AgentBooks.setHistory` — SessionBooks gives it the session's `agentEvents/read`): pushing past its
oldest sheet slides it one sheet back (the older one materializes at the front, the newest
waits as a parsed record), past its newest slides it forward, `book.page last` slides it to the
live end. Sheets outside the window are records, not GPU objects; every record carries its
source line's byte offset (`at`), and paging within `historyLead` of the oldest sheet prefetches
older records: `read {until, tail}` — the last ~`historySliceBytes` before the oldest record
(doubling until it holds `historyTurns`), reading `historyOverlapBytes` past it so an edge call
pairs with its result (a farther one is an adopted orphan). Sheet numbers are an estimate
until paging reaches the run's start, which makes them exact; a page whose read fails says so
(`headState.failed`) and isn't re-read on every page. While the window is held away from the live end, live sheets wait beyond it (the HUD's
`+N newer`) — the book never grows or shifts under the reader.
Gates: `tools/book-deck.test.mjs`, `tools/book-controls.test.mjs`, `tools/agent-book-history.test.mjs`,
`tools/agent-events.test.mjs` (gomuxai's corpus).
