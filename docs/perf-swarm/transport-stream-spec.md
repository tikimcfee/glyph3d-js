# Transport streams — keyed binary planes over the relay

**Status: spec · 2026-08-09 · anchor for the load-transport lanes (fs pour, agent
sessions, watch deltas, frustum paging). First implementation: agentSessions tail
reads. Coordination artifact — any lane touching bulk transport lands against this.**

## Why

The relay is loopback — bandwidth is free, *envelopes* are not. A 1,018-file pour
costs ~1,017 `fs/readFile` JSON-RPC round trips (~0.65ms each, fetch ≈ 0.7–1.2s);
an agent-books restore reads ~30MB of JSONL to hydrate 20 spreads per book. The
cost is per-request framing + JSON transcription + bytes-we-discard, not I/O.

The design north star (Ivan, 2026-08-09): **not a load-once scheme — a full
transport stream that keeps per-request work down**, with records whose **wire
form is their memory form** (bake records are flat numerics; a received buffer is
overlaid with typed-array views, never parsed).

## Two planes, one socket

- **Verb plane (JSON, unchanged):** the command bus stays human-readable. Verbs
  are typed, logged, grep'd — ergonomics are the point, volume is trivial.
- **Bulk plane (binary frames):** length-prefixed frames on the existing
  WebSocket binary path (the result plane that already ships file bytes as
  bytes). No JSON, no base64, in either direction, for anything larger than a
  verb.

Frame grammar (little-endian):

```
frame  := u32 len · u8 type · u8 flags · u16 reserved · u32 streamId · payload
types  := MANIFEST | FILE_BYTES | BAKE_RECORDS | SESSION_EVENTS | DELTA | END | ERR
```

`MANIFEST` opens a stream: the query's answer as a table (pathId → path, size,
mtime, contentKey, bakeOffset), itself flat binary + a small string table.
Payload frames reference pathId, never repeat paths. `END` carries the stream's
generation cursor. `ERR` is loud and terminal (fail-loud law — no silent
truncation; a partial stream must say so).

## Stream keys

A stream is minted by a **query**, not a path:

```
key := (root, filter, cursor)
```

- `cursor: 0` — the bulk pour (openDir).
- `cursor: generation N` — deltas since N (the watch lane; a worktree coming
  alive mid-session is exactly this: delta manifest → pour the new subtree).
- `filter: paths[] | window` — demand paging (the frustum-driven load: "these
  files, now"), and a book paging BACK through an agent session.
- Range-of-one-file stays `fs/readRange` (already binary-planed).

Cursor streams are resumable and incremental by construction — that is what
makes this structurally not-load-once.

## The checkpoint discipline (one primitive, N consumers)

Every append-only or foldable store gets the bake treatment: **checkpoints =
monoid prefixes at fixed intervals**, so any suffix/window is a seek + a bounded
fold, never a full read.

- **Bake index (exists):** checkpoints over file bytes. TO DO: (a) **write-back**
  — a self-baked record is written home (the index learns; 549 twin self-bakes
  per load today); (b) **content-addressed keys** — twin worktree files share
  bytes → share records; path is residency, content is identity.
- **Agent sessions (first implementation):** JSONL is newline-delimited — tail
  hydration needs no sidecar in v1: seek `size − N`, scan to a record boundary,
  stream; double N until the spread quota is met (tail-grow). Older spreads =
  `fromOffset` cursor reads on demand (book paging back). Sidecar offset index
  is the v2 horizon if tail-grow ever measures poorly.
- **Layout generations (horizon):** a dir's arrangement is a deterministic fold
  over (member set, sizes, scheme params) → hash that tuple, memoize poses,
  compose hierarchically (edit one file → one dir regenerates). Cached layout
  SEEDS the live path; `layout.verify` remains truth (LOAD-IS-NOT-REPLAY).

## Overlap rules

Known sizes stream while other work runs: the walker's listing arrives before
any byte — arena lane creation (the ~500ms createBuffer wall) belongs INSIDE the
fetch wait, not after it. Generally: anything derivable from the MANIFEST starts
at manifest time.

## Non-goals

- No embedded database as truth. Flat per-file records stay the store
  (git-friendly, worker-writable). The relay MAY build an in-memory index over
  them at serve time to answer queries/mint manifests — a serve-time luxury,
  rebuilt freely, never authoritative.
- No general serialization framework. Two planes, fixed frame grammar, done.
- No speculative arena dedup of twin content (noted, not chased).

## Gates

Each lane lands with: a headless round-trip test of its frames (the
bridge-binary pattern), a byte-identity check against the old path (same spreads
/ same file bytes / same records), and a before/after `[load]` trace line in the
commit message (Σread / fetch / stage walls). Coverage, not just pass: name what
the harness cannot see (live WS behavior, relay restarts).
