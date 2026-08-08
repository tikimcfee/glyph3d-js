# Multica runbook

Drive a Multica agent team from glyph3d, and watch it work without a browser.

Everything here is verbs and scripts — no Multica UI is built or run at any point. See
`NOTICE.md` for why that boundary matters.

## 0. Bring up a backend (once)

```sh
tools/multica-up.sh up          # postgres + backend from source, on :8099
```

Then pair a daemon, which is what registers runtimes. **No runtime means no agents** —
the backend refuses to create one without a `runtime_id`.

```sh
multica config set server_url http://localhost:8099
multica config set workspace_id <id>        # after step 1 prints it
multica daemon start
multica runtime list                        # one row per CLI found on this box
```

Want more than one CLI on the board? The daemon probes for ~23 known ones (claude,
codex, cursor, copilot, kimi, qwen, grok, opencode, …). A CLI outside that list gets in
as a custom profile:

```sh
multica runtime profile create --display-name GLM --command-name glm --protocol-family claude
multica daemon restart
```

## 1. Seed a workspace

```sh
bun tools/multica-seed.mjs
```

Creates the workspace, spreads a few agents across whatever CLIs exist, files a starter
pipeline, and prints the `multica.connect` line plus the env for the headless tools.
Idempotent — re-running reuses what's there.

Export what it printed:

```sh
export MULTICA_URL=http://localhost:8099
export MULTICA_TOKEN=...
export MULTICA_WORKSPACE=...
export MULTICA_SLUG=glyph3d-pilot
```

## 2. File a real ticket

```sh
bun tools/multica-ticket.mjs --dry-run     # see the shape first
bun tools/multica-ticket.mjs               # file it
bun tools/multica-ticket.mjs --assign      # …and wake stage 1
```

The built-in spec is tree-wide search with instant preview — six sub-issues across four
stages, two of which are barrier groups. Bring your own with `--file spec.json`:

```json
{
  "title": "…",
  "description": "…",
  "stages": [{ "stage": 1, "role": "Surveyor", "title": "…", "description": "…" }]
}
```

`stage` is 1-based. Siblings sharing a stage are one barrier group: the parent advances
only when the whole group finishes.

## 3. Watch it, headlessly

```sh
bun tools/multica-watch.mjs                    # follow
bun tools/multica-watch.mjs --once             # snapshot and exit
bun tools/multica-watch.mjs --board runtime    # a column per CLI
bun tools/multica-watch.mjs --json             # NDJSON, one record per verb
```

This runs the **real** `MulticaBridge` with a recording `execute` standing in for the
router, so every line is a command the browser would have run:

```
  agent.activity  mc-98ab1fba multica issue GLY-46 Design the index … in_progress · stage 2

── board by state · 5 book(s) ──────────────────
  idle  (5)
    · Cartographer      13 sheets  issue GLY-46 Design the index + the search verb surface
    · Zhipu              0 sheets
```

The snapshot is laid out by the same `boardLayout` scheme the field uses, so the columns
you read here are the columns it would place. If the board looks right in the watcher,
the only thing between this and the field is rendering — which makes this the fast loop:
no browser, no WebGPU, no reload.

Snapshots re-print on a 1.5 s settle rather than per frame, for the same reason the log
storm brake exists.

## 4. Drive it in the field

```
multica.connect $MULTICA_URL $MULTICA_TOKEN $MULTICA_WORKSPACE $MULTICA_SLUG
multica.board runtime        # columns by CLI
multica.pipeline GLY-43      # the stage ladder
multica.attach Cartographer  # floating input takes the keyboard
```

Type, Enter sends. Shift+Enter for a newline, ↑/↓ recall, Esc releases.

## 5. Locks

```sh
bun tools/multica-flow.test.mjs     # event → verb mapping (+ live round trip when env is set)
bun tools/multica-input.test.mjs    # prompt semantics + board layout
```

## Gotchas worth not rediscovering

| Thing | Reality |
|---|---|
| Issue update | **PUT**, not PATCH (405) |
| `stage` | **1-based**; 0 → 400 |
| Duplicate title | 409 on an active issue unless `allow_duplicate: true` |
| List responses | `{ issues: [...] }`, not a bare array |
| Entity frames | wrapped (`{issue:…}`, `{comment:…}`); task frames are bare |
| `task:progress` | carries only `{task_id, summary, step, total}` — no agent; routed via the bridge's ledger |
| Comment author | `author_id`/`author_type`, not `actor_*` |
| Agent reply | **`chat:done`**. `chat:message` is the *operator's* echo — mapping it puts your words in the agent's mouth |
| Sending chat | two steps: `POST /api/chat/sessions` then `…/{id}/messages` |
| `provider` | the **protocol family**, not the CLI. A GLM profile reports `claude`. Group by `runtime` to separate them |
| Agent creation | needs a `runtime_id`; pair a daemon first |
