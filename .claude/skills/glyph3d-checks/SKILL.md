---
name: glyph3d-checks
description: Which command answers which question in glyph3d-js — running the checks (tools/check.mjs, tiers, scopes), finding code (lsp.mjs, srcwalk, ast-grep, verb.mjs, rg), the layering and dead-code reports, and recording performance (frame-profile, the perf ledger, VRAM). Use before verifying a change, landing a branch, hunting callers of something, or measuring a frame.
---

# glyph3d checks — intent → command

`tools/CHECKS.md` is canonical for what each tool compares and what it can't see; the
manifest (`tools/check-manifest.mjs`) holds the same per check, and `--list` prints it.
This is the working procedure. Counts are printed by the tools on every run and are not
repeated here: a number in prose is a number that rots.

## 1. Verify a change

| Intent | Command | What it does |
| :--- | :--- | :--- |
| After each change | `bun tools/check.mjs --tier inner` | Every fast headless check in parallel (a few seconds). Not a landing run. |
| Only what you touched | `bun tools/check.mjs <scope…>` | Scopes: render, layout, books, agents, desk, camera, persist, terminal, shell, relay, wall, form, corpus. Scoped runs skip the floor. |
| One check | `bun tools/check.mjs <name>` | Any tier; `--list` names them all. |
| Land | `bun tools/check.mjs` then `--tier browser` and `--tier gpu` | `full` = every headless check; browser/gpu start their own Vite + a private relay per check, or SKIP with a NOTE saying what's missing. |
| What would run | `bun tools/check.mjs --list [--tier T] [scope…]` | Command, needs, compares, blind to, known reds. |
| Parked hand tests | `bun tools/check.mjs --tier parked` | Hand tracking is parked; no other tier runs these. |

Read the LAST line: `ALL GREEN — n of m ran (…)`, `RED — k failed: …`, or
`NOTHING RAN — not a pass`. A green line with `· k skipped` ran less than you asked for —
the NOTE lines say why. A `KNOWN` line is a red the repo carries on purpose (the manifest
says why); if a known red starts passing, the run goes RED until you delete its `known`
entry. A failure's whole output is at the `kept:` path it prints.

Never hand the runner's job to ports or sockets a person uses: it takes free ports, never
5173/5174/5180/8080/8099, never the `glyphd` tmux socket, never gomuxai. Don't run the
browser/gpu tools by hand against the live dev loop either — a relay takes one display.

After adding a check: give it a manifest entry (the run is RED while a `*.test.mjs`,
`*-check.mjs`, `*.itest.mjs` or `wall-*.mjs` is missing from it), then raise the floor on
a green unscoped run: `bun tools/check.mjs --tier <t> --ratchet`.

## 2. Find code — say which lane you used

| Question | Lane | Command |
| :--- | :--- | :--- |
| What type is this / where is it defined / typed refs | LSP | `bun tools/lsp.mjs hover\|def\|refs\|impl <file:symbol>` |
| Who calls this NAME, what does it call, who imports this file | srcwalk | `bunx srcwalk trace callers <name>`, `trace callees`, `deps <file>`, `context <file:line>` |
| Where does this SHAPE of code occur | ast-grep | `bunx ast-grep run -p '<pattern>' -l js packages app wall` |
| Where is a verb handled, and what does it touch | verb.mjs | `bun tools/verb.mjs grid.move`, `'carrel.*'`, `--list` |
| Every textual occurrence (the completeness check) | rg | `rg -n '<text>' packages app wall tools` |

The blind spots: LSP only sees calls through a receiver whose type it knows. srcwalk is
by NAME (every `execute` is a caller of `execute`), includes `tools/`, and budgets its
output (`+N more` → `--no-budget`). ast-grep matches exactly the pattern (a verb pattern
needs `NAME` constrained to a string). verb.mjs can't see verbs registered under a computed
name, nor what helpers do with `ctx`. When the structural lanes disagree with rg, rg is
the floor and the difference is the dynamic code.

## 3. Structure and dead code

| Intent | Command |
| :--- | :--- |
| Layering (core ↛ app/wall/r3f/react, workers ↛ three, wall ↛ app, no core cycles) | `bun tools/check.mjs layering` (or `bunx depcruise --config .dependency-cruiser.cjs packages app wall`) |
| Saved structural rules | `bun tools/check.mjs sg-rules`; add a rule as `tools/sg/rules/<id>.yml` |
| Unused exports / files / deps (report only) | `bunx knip` |
| JSDoc type imports resolve | `bun tools/check.mjs type-imports` |

## 4. Measure a frame

```sh
# Vite + a PRIVATE relay serving a scratch root (frame-profile's header has the serve line)
bun tools/frame-profile.mjs --url <vite> --relay <port> --dir <root>/src --ledger <scenario>
bun tools/frame-profile.mjs … --vram                      # + GPU bytes by type (webgl-memory)
bun tools/perf-ledger.mjs compare [--scenario S]          # latest vs this host's rolling median
bun tools/perf-ledger.mjs host                            # this machine's key and ledger file
```

`--ledger` appends this run's headline numbers to `perf/<host-key>.jsonl` (the main
checkout's, shared by every worktree, never committed) and prints each against the
host's history, inside its noise band (`tools/perf-bands.json`) or not. `--vram` wraps every
GL call, so its timings land under `<scenario>+vram`, apart from clean ones. Report numbers
with the machine's load noted (each row carries it); interleave A/B in one page when the
difference is small.
