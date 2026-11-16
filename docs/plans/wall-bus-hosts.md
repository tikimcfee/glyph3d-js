# The wall sees every host on the gomuxai bus — done

A record (2026-11-15, branch `wall`). The design lives in `docs/architecture/wall.md` ("gomuxai's
agents") and `docs/architecture/agents.md`; this page says what landed and what was left out.

## The goal

One wall that shows the gomuxai agents on every machine on the bus (a laptop and a workstation),
so Ivan can watch and steer them without hopping between computers and terminals. Helpers around the
`agent` CLI, nothing more.

## What landed

- **The wall** (`d7b87207`, names made neutral in `d01f454a`): the agents by host with status in the
  sidebar, the palette and `wall.bus`; `wall.attach <name[@host]>` opens an ORDINARY wall terminal
  running `agent attach <name>[@<host>]`, which runs ssh to the far host's `agent attach` itself
  (`agent bus ssh` says where). termd is never exposed to the network: the far hop is ssh, as if Ivan
  had typed the attach. `wall/WallBus.js`, `TerminalWall.attach`; gate `tools/wall-bus.test.mjs`.
- **The relay** (`66717a25`): `serve --gomuxai-hosts all|<list>` (off by default; the wall profile in
  `tools/dev.sh` turns it on) adds `--hosts` to the export it follows; one node per (host, name); an
  `attached` a far host couldn't report stays absent (`*bool`), so the wall doesn't refuse the
  attach; screens, resize and reach use only this machine's agents (`localAgent`), and the IDE's hub
  keeps only this host's (`localTree`). Gates: `cd cli && go test ./...`,
  `tools/agent-visibility.test.mjs`.
- Proven live both ways: from the workstation, `wall.bus` listed every host and `wall.attach` reached
  a throwaway shell on the laptop; from the laptop, `wall.bus` lists both hosts' agents.

## Attaching to a remote agent, with care

Attaching a tmux client resizes that agent's window to the wall terminal, so its CLI reflows. To
test, use a throwaway shell agent spawned on the far host (`agent spawn probe --backend shell`
there, `wall.attach probe@<that host>`, `agent cleanup probe` there after). ssh must work
non-interactively (`ssh -o BatchMode=yes <dest> true`), or the attach terminal holds ssh's error
until Enter, which is the intended failure.

## Considered and dropped

A snapshot/poll view (`capture --follow`), a terminal stream on the NATS bus, a PTY backend with
its own key encoder in the relay, changes to the gomuxai repo, typing via `agent keys` remote-ops.
ssh plus `agent attach` in an ordinary terminal already does the job.
