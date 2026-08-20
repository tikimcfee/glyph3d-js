# The arena ceiling, measured

Perf-swarm topic: what actually exhausts the glyph address space, measured against a
real corpus rather than estimated. Companion to `vram-memory-architecture.md`, which
treats the 2²⁴ f32-ordinal limit as a design parameter — this is the first record of a
load hitting it.

Measured 2026-08-10, macOS M-series, `apple/metal-3`, built app on a scratch relay,
ephemeral session (`?session=off`, so no restored field underneath).

## The ceiling

`GlyphPipelineArena` is a flat byte-addressed space. Slot ordinals are **f32 lanes,
exact only to 2²⁴**, so the whole arena is:

```
ORDINAL_EXACT_BYTES = 2**24 = 16,777,216 B = 16.0 MB
```

That is not per-file or per-view. It is **every glyph the application can address at
once**, across every open file, filename label, and panel.

## The corpus that found it

`examples/word-wall/` — dictionaries in both shapes: single giant reams
(`WebstersEnglishDictionary.txt` 28.3 MB, three `dictionary*.json` at ~22 MB) and a
prefix-split set (`generated_dictionary/dictgen-output/`, 694 files, 84 MB, one file
per two-letter prefix: `co.txt`, `re.txt`, `mi.txt`…).

Loading `dictgen-output` alone:

```
fetch  285.2ms (files:677  kb:57966)      ← 56.6 MB readable
seat  4776.9ms                             ← 94% of the load
build    0.3ms (grids:542 · kernels:498/682ms · selfBakes:694/1668ms
                commits:1085/670ms · yields:56/2544ms)
total 5093.4ms (opened:542  placeholders:17)
```

Arena afterwards:

```
LIVE 16,777,185 B of 16,777,216 B   → 100.0%, free: 0, 31 bytes spare
items alive 1085, sum(byteCount) == live exactly (zero fragmentation)
```

## What consumes it

Staging is whole-file, byte-for-byte — six of the largest were checked against disk
and every ratio was **1.000**. There is no windowing on the `FileRow` load path, and
no edit slack (that path passes no `capacity`).

| bucket | files | bytes | share of the ENTIRE address space |
|---|---:|---:|---:|
| <1 KB | 712 | 129 KB | 0.8% |
| 1–10 KB | 194 | 621 KB | 3.7% |
| 10–100 KB | 137 | 5.98 MB | 35.6% |
| **100 KB – 1 MB** | **42** | **10.05 MB** | **59.9%** |

**42 files consume 60% of everything the system can address.** One of them,
`mi.txt` at 969,648 B, is **5.8% of the total on its own**. Seventeen files of that
size would exhaust the arena completely.

The existing per-file guard is `READABLE_MAX_CHARS = 1_000_000`
(`core/readability.js`) — which is why the 28 MB dictionaries never enter the arena at
all (17 of them landed as not-rendered placeholders). But 1 MB per file against a
16 MB total means **the per-file limit and the global limit are only 16 files apart**.

## How it fails (well)

Gracefully, and this is worth preserving through any lift:

- The refusal is per item and loud: `staging NNN B needs address … past the
  f32-ordinal wall … this file stays unlaid (u32 ordinal lanes are the lift)`.
- The allocation is undone before throwing, so a refusal leaks no range.
- The storm **continues** — 542 of 677 laid, 135 refused, 435 refusal lines logged.
- No crash, no corruption, 62 fps afterwards, `free: 0` with zero fragmentation:
  the free-list and compaction behave correctly right up to the boundary.

## Known gap: the loss is under-reported

`file.openDir` returns `OK: opened 542 file(s) … 17 as not-rendered placeholders`.
The 17 are the >1M-char refusals. The **135 files dropped by the wall are not counted
in that summary** — they exist only in the log. A fifth of a directory silently absent
behind an "OK".

## The lift

The error message names the fix, and there are three candidates:

| approach | ceiling | cost |
|---|---:|---|
| **u32 ordinal lanes** | 2³² = 4.0 GB (**256×**) | kernel surgery; one change, no new addressing concept |
| chunking at newline boundaries (`vram-memory-architecture.md`) | per-job scratch, corpus unbounded | large files split into jobs; layout must stitch across chunks |
| multiple arenas / sharding | n × 16 MB | views become (shard, ordinal); every consumer learns two-part addresses |

At 289 MB of dictionaries, u32 alone would put this corpus at ~7% of the space, with
no second addressing concept anywhere in the system. Sharding earns its complexity
only past 4 GB, or when per-shard eviction is wanted for its own sake.

## Reproducing

```
./glyph3d-cli serve --local --port 8099 .
bun tools/loadcurve.mjs --dir examples/word-wall/generated_dictionary/dictgen-output --relay 8099 --url http://localhost:8099/
bun tools/buslog.mjs --port 8099 q "SELECT count(*) FROM logs WHERE msg LIKE '%ordinal wall%'"
```

The arena itself is reachable in-page at `ctx.renderer.glyphPipelineArena`
(`_byteTotal`, `_free`, `_items[].byteCount`) — that is how the table above was taken.

**Measure from a clean boot.** A restored session sits underneath and doubles the
corpus; that is what first drove this load past the wall into ~3 GB of heap and locked
the browser. Every measurement tool now opens `?session=off` (see CHECKS.md).
