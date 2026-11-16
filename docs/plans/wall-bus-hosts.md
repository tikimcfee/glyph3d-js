# Brief: the wall sees every host on the gomuxai bus

For the agent picking this up (written 2026-11-15, branch `wall`, after `d7b87207`).

## The goal

Ivan wants one wall that shows the gomuxai agents on **every machine on the bus** (today: a laptop
and a workstation), so he can watch and steer them without hopping between computers and terminals.
Keep it simple: helpers around the `agent` CLI, nothing more.

## What already works (`d7b87207`)

- The wall lists the agents the relay's `agent export` follows (`gomux/list`, `gomux/changed`), by
  host, with status: the sidebar's **agents** section, the palette, `wall.bus` from the CLI
  (`./glyph3d-cli --port 8180 wall.bus`).
- `wall.attach <name[@host]>` (or a click, or Enter in the palette) opens an ORDINARY wall terminal
  running `agent attach <name>[@<host>]`. For another host, `agent attach` itself runs ssh to that
  host's `agent attach` (the destination comes from `agent bus ssh`). **termd is never exposed to the
  network** (its socket has no auth beyond the local uid); the network hop is ssh, as if Ivan had
  typed the attach himself. Don't build a terminal transport over the bus or over termd.
- Code: `wall/WallBus.js` (pure helpers + the tree), `TerminalWall.attach`, the verbs in
  `wall/wallCommands.js`; design notes in `docs/architecture/wall.md` ("gomuxai's agents"). Gate:
  `bun test tools/wall-bus.test.mjs`.
- The wall already reads `host` on each agent and builds `name@host` targets. Agents on this machine
  carry this host's name too; `agent attach name@<this host>` stays local.

## What's missing: the relay drops other hosts' agents

All in `cli/gomux.go`:

1. **Follow the bus.** `GomuxWatcher.follow` runs `agent export --json --follow --all -q`. Add
   `--hosts all` behind a new `serve` flag (e.g. `--gomuxai-hosts all|<h1,h2>`; off by default), and
   turn it on for the wall profile in `tools/dev.sh` (`RELAY_FLAGS` for `wall`). `applyLine` already
   folds export's `host` lines; `--follow` re-lists remote hosts every 30 s.
2. **Stop dropping them.** `publish` skips every agent with `Store == ""` (another host's agent: no
   store, transcript or screen). With the flag on, keep them.
3. **One node per (host, name), not per name.** `publish` dedupes into `byName`. Two hosts can each
   have a `helper`; key by host + name (keep `exportPrefer` within one host).
4. **Unknown is not false.** `exportAgent.Attached` and `gomuxAgent.Attached` are plain `bool`s.
   Export leaves `attached` out when a far host couldn't say ("absent means unknown, not false"), so
   today it decodes as `false`, and the wall reads `false` as "no tmux session" and **refuses the
   attach**. Make both `*bool` with `omitempty` (or equivalent) so unknown stays absent. The wall
   already treats absent as attachable (`busAttachable`). Same for `resumable` if you carry it.
5. **Keep the IDE unharmed.** The IDE's hub (`app/client/GomuxHub.js`) keys nodes by `a.name` and
   opens an agent BOOK per node from its transcript (`agentEvents/*`), which a remote agent doesn't
   have. Either leave the flag off for the IDE profile (simplest; it is off by default), or have the
   hub skip nodes whose `host` isn't this one. Don't let a remote agent collide with a local namesake
   in the hub's maps.

`attachGomuxAgent` / `gomux.attach` (the IDE's read-only screens) are local-only by construction
(tmux capture + the pane's log); leave them alone.

## How to check it

- `cd cli && go test ./...` (add a case to `gomux_test.go`: a `host` line with two hosts' agents of
  the same name both survive `publish`, and an omitted `attached` stays omitted in the node).
- `tools/dev.sh wall refresh` (it builds `g3d-termd` beside `glyph3d-cli` on a fresh checkout), open
  `http://localhost:5180/?relay=8180`, then `./glyph3d-cli --port 8180 wall.bus`: both hosts listed.
- Attach to a REMOTE agent with care: attaching a tmux client resizes that agent's window to the
  wall terminal, so its CLI reflows. Use a throwaway shell agent on the far host (spawn it there
  locally: `agent spawn probe --backend shell`, then `wall.attach probe@<that host>`), and
  `agent cleanup probe` on that host after. ssh must work non-interactively
  (`ssh -o BatchMode=yes <dest> true`), or the attach terminal holds ssh's error until Enter, which
  is the intended failure mode.
- The wall's own checks: `bun tools/check.mjs wall form`. `wall-keys` and `wall-select` were red
  before this work (not yours); `type-imports` needs `typescript` installed.

## Out of scope for now

A snapshot/poll view, a terminal stream on the NATS bus, a PTY backend in the relay, changes to the
gomuxai repo, typing via `agent keys` remote-ops. All were considered and dropped: ssh plus
`agent attach` already does the job.
