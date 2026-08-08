# Disk-to-GPU byte pipeline — ideal load path for tens of thousands of files

Swarm topic: **load pipeline, filesystem → GPU-resident glyph data**.
Scope: everything from the Go relay reading a file off disk to bytes sitting in
`GlyphPipelineKernels`' `byteWords` storage buffer, flushed and dispatched.
Layout compute internals (walk/scan/paginate), atlas growth, hot-swap, and
restore stacking are other agents' topics; this report touches them only where
the load path forces a decision on them.

---

## 1. Problem framing

### The corpus we must swallow

`torvalds/linux` (v6.x working tree, approximations good to ±20%):

| quantity | value |
|---|---|
| files | ~78–80k |
| UTF-8 text | ~1.2–1.4 GB |
| avg file | ~16 KB |
| lines | ~30M |
| glyphs (bytes minus newlines/continuation) | ~1.1G |

The stated product target is "tens of thousands of files in seconds", so the
design point I use throughout is **20k files / 300 MB** (a large subsystem
tree), with the full kernel tree as the stretch case. The memory math in §5
shows the full tree does *not* fit resident at the current 48 B/glyph instance
layout — that hands off to the LOD/streaming proposals.

### What the current path costs (all seams verified in source)

```
disk ── per-file fs/readFile JSON-RPC, 8 in flight (RemoteFileSystemProvider.getMultipleFiles, CONCURRENCY=8)
     ── 1 binary WS frame per file: [0x02][idLen][id][hdrLen][hdr JSON][raw payload]  (cli/fs.go sendRPCBinaryResult)
     ── TextDecoder → JS string, per file, MAIN THREAD  (RemoteFileSystemProvider.contentOf)
     ── Map<path,{content}> → per-file new CodeGrid     (app/commands/handlers/fileCommands.js openDir)
     ── text.split('\n') + TextEncoder.encode(text) + buildByteLineIndex  (CodeGrid._beginLoad)
        ↑ bytes→string→bytes round-trip: the relay already delivered UTF-8
     ── arena.stage({bytes,...}) → coalesced flush → appendFiles → byteWords.needsUpdate
     ── 9 compute dispatches → slot lanes → MegaGlyphField views
```

Measured symptom: ~1000 files in 20 s ⇒ 20k files ≈ **400 s**. Breakdown of
where that goes at 20k files / 300 MB (measured rates are well-known browser
constants; per-file overheads scale from the observed 20 ms/file):

| stage | cost model | 20k files / 300 MB |
|---|---|---|
| per-file JSON-RPC envelope (hdr JSON build+parse, promise churn, goroutine per RPC, frame demux) | ~0.3–0.5 ms/file even at 8-way concurrency | **6–10 s** |
| TextDecoder on main thread | ~300–500 MB/s | **0.6–1 s of main thread** |
| text.split + TextEncoder + buildByteLineIndex per file, main thread | ~200–400 MB/s combined | **0.8–1.5 s of main thread** |
| CodeGrid construction + registration fan-out | ~1–3 ms/file | **20–60 s** ← dominant, but see note |
| GPU upload + dispatch (this part is already fine) | appendFiles coalesced | ~0.3 s |

(The CodeGrid construction fan-out overlaps with the "current implementation is
naive" agents' territory — I claim only the decode/encode/transport parts. But
note: killing the string *removes work inside* CodeGrid construction too —
`split`, `encode`, `buildByteLineIndex` all happen there.)

### The floor

What physics says 20k files / 300 MB *can* cost:

- **Disk**: warm page cache, 16 concurrent readers in Go: 1.5–3 GB/s ⇒
  **100–200 ms**. Cold NVMe with 20k opens: ~2–4 µs open+read syscall per file
  overlapped ⇒ **0.5–1 s**. (Full kernel tree, cold: 2–4 s.)
- **Transport**: a single binary WebSocket stream on loopback moves 1–2 GB/s
  browser-side receive (ArrayBuffer delivery) ⇒ **150–300 ms**.
- **GPU upload**: 300 MB into a storage buffer via writeBuffer: >2 GB/s ⇒
  **~150 ms**. Compute (decode+trie, scan, walk, paginate over 300M bytes):
  **<300 ms** on any discrete GPU.
- **Floor: ~0.7–1.5 s for 20k files, warm cache.** Full kernel tree: ~4–6 s,
  bounded by cold disk and (if not compacted) VRAM, not by transport.

So the gap between 400 s and ~1 s is *entirely* per-file overhead and the
string round-trip, not bandwidth.

---

## 2. Design

### 2.1 One stream, not N RPCs

Replace the per-file `fs/readFile` fan-out with a single streaming endpoint,
`fs/openDirStream`, on the existing binary plane (`cli/fs.go`,
`sendBinToDisplay`). Go side:

1. Walk the tree once (existing `fs/listTree` walk logic, same extension
   whitelist and caps, but cap raised/configurable).
2. Read files with a fixed pool of ~16 goroutines (enough to saturate NVMe
   from page cache; more just burns scheduler time on syscalls).
3. Emit a **pack stream**: an index chunk first, then blob chunks, each chunk
   one binary WS frame of 4–8 MB.

Container format (new frame type `0x03` next to the existing `0x02`; not tar —
tar has 512 B headers, no upfront index, and forces the client to discover
sizes as it goes):

```
frame 0 (index):  [0x03][streamId u32][0x00 INDEX]
                  [totalBytes u64][fileCount u32]
                  per file: [pathLen u16][path utf8][offset u64][len u32][flags u8]
frames 1..n:      [0x03][streamId u32][0x01 BLOB][bytes...]   (concatenation = the blob region)
final:            [0x03][streamId u32][0x02 END][crc u32]
```

Every file's blob region is **padded to 4 B alignment** — `packBytes` packs 4
bytes per u32 word, so aligned offsets let the client hand subarray views
straight to the arena without a realigning copy.

Why index-first: the client knows `totalBytes` before the first blob arrives
and can allocate **one** ArrayBuffer for the entire corpus; blob frames are
then `memcpy` into it at known offsets. No stitching, no per-file allocations,
no GC pressure from 20k transient ArrayBuffers.

The relay currently gives each RPC its own goroutine and a 10 s timeout
(`cli/fs.go:571-610`) — a stream handler must own the connection write loop
for its duration with no per-chunk timeout, or use an idle timeout (no frame
for 30 s) instead. Cancellation = client closes or sends `fs/cancelStream`.

### 2.2 Text never becomes a JS string

The string exists today for exactly three reasons: `CodeGrid.lines`
(bookkeeping / legacy text path), the editor, and the `TextEncoder` that
re-creates the bytes the relay already sent. Under the byte pipeline:

- `RemoteFileSystemProvider` gains `streamDir(root)` alongside `readFile` —
  the string path stays for the editor and one-off reads, but the bulk loader
  never calls `contentOf`.
- `CodeGrid._beginLoad` gets a `loadBytes(uint8View, meta)` entry that skips
  `split('\n')`, `_textEncoder.encode`, and `buildByteLineIndex` — the GPU
  pipeline is byte-indexed throughout and needs no CPU line index (per
  `docs/plans/gpu-bounds-and-byte-pipeline.md`: "No string is built, no
  newline split happens, no line table exists"). `lines` is populated lazily
  (decode on demand) or left null for byte-pipeline grids; consumers that
  speak (line, col) go through the byte-backed LayoutDescription internals
  described in the Layer-2 wiring plan.
- UTF-8 validation: the GPU decode handles ill-formed bytes deterministically
  (a miss is a value). Drop the relay's UTF-8 gate on the stream path — it's a
  full extra pass over every byte in Go. Keep `maxFileSize` as a stream flag
  (skip-and-report), don't decode to check.

### 2.3 Zero-copy path, concretely

```
WS frame (ArrayBuffer, ws.binaryType='arraybuffer')
  → StreamAssembler: new Uint8Array(corpusBuf, frameOffset).set(new Uint8Array(frame))
      — ONE copy per byte, unavoidable across the WS boundary (browser gives us
        the frame buffer; we can't receive into ours). 300 MB memcpy ≈ 30–60 ms.
  → per-file Uint8Array views: new Uint8Array(corpusBuf, file.offset, file.len)  — free
  → GlyphPipelineKernels.appendFiles: byteWords.value.array.set(view, wordOffset)
      — second and last copy, straight into the staging Float32/Uint32Array that
        needsUpdate uploads. Also ~50 ms at 300 MB.
```

Two copies per byte total, both large-block memcpys: ~100 ms at 300 MB. That
is the zero-copy floor on the web platform without SharedArrayBuffer.

**Optional upgrade — SAB:** with COOP/COEP headers the app can run
cross-origin-isolated; then the corpus buffer is a SharedArrayBuffer and
workers (§2.4) read it with no transfer at all, and the arena staging copy can
happen off-thread. Worth doing if isolation is acceptable (it gates
third-party embeds); not required for the 1 s target.

**OPFS: skip for v1.** OPFS buys cross-session caching (persist the pack,
reload without the relay), but adds an async IO layer, quota management, and a
consistency story (mtime invalidation) for a win that only matters on repeat
loads. The relay on loopback is already faster than OPFS sync access handles
in a worker. Note it as a follow-up cache tier, not a load-path component.

### 2.4 Worker pool: only for what actually needs a CPU

With decode/encode dead, the load path has **no required CPU work** between
socket and GPU — assembly is two memcpys, which is why the design moves them
to the assembler and keeps them small. Workers re-enter only for genuinely
parallel CPU work the corpus creates:

- **Syntax/color classification** (if colors come from tree-sitter or a
  tokenizer rather than per-group tint): pool sized
  `hardwareConcurrency - 1`, jobs = per-file views of the corpus buffer.
  Transferable ping-pong (transfer the view's buffer out, worker transfers it
  back with a color-index buffer attached) is zero-copy; or SAB removes even
  that. Output: one `u8` color-index per byte leader, staged into a color
  storage buffer parallel to the slots — kernel 1 or the paginate kernel
  splats it into `instanceColor`. Use the `SessionParsePool` model
  (demand-grown, explicit job queue, backpressure), not `WorkerBridge`'s
  fire-and-forget FIFO — the assembler must not run 300 MB ahead of the GPU.
- Nothing else. No shaping round-trip (the trie replaces it), no line tables,
  no per-file parse.

### 2.5 Pipelining the stages

The four stages — disk read, WS transport, assembly, GPU flush — must overlap
rather than barrier per file:

```
Go read pool ──▶ pack frames ──▶ WS ──▶ StreamAssembler ──▶ flush batches ──▶ GPU
   (16-way)      (as read)               (memcpy at offset)   (every 8–16 MB     (appendFiles +
                                                               or 512 files,      9 dispatches,
                                                               whichever first)   coalesced per
                                                                                  macrotask batch)
```

- The assembler doesn't wait for END: the index gives every file its offset,
  and blob frames arrive in offset order (Go writes them in read-completion
  order with a small reorder buffer — or simply sequentially; at loopback
  speeds strict order is fine and simpler). A contiguous-arrival watermark
  tells the assembler which files are complete.
- Flush granularity: when the watermark covers ≥ 8 MB of new bytes or ≥ 512
  files, stage those files into the arena (`arena.stage` per file,
  `requestFlush` coalesces into one `appendFiles` + one dispatch set). This
  turns one 300 MB flush into ~20–35 flushes of 8–16 MB — each upload+dispatch
  ~20–40 ms, first pixels on screen in <500 ms, steady overlap of transport
  and GPU.
- Backpressure: assembler pauses (stops reading WS events → TCP backpressure
  → Go write blocks) if staged-but-unflushed bytes exceed ~64 MB or VRAM
  growth would exceed budget. `registry.holdChanges` (already used in
  `fileCommands.js:238`) spans the whole stream so the scene graph commits
  once at END.

### 2.6 Per-stage budget, 20k files / 300 MB

| stage | budget | notes |
|---|---|---|
| Go: walk + read + pack | 150–500 ms | warm/cold cache; fully overlapped with send |
| WS transport | 150–300 ms | 4–8 MB frames ⇒ ~40–75 frames, no per-file overhead |
| assembly memcpy | 30–60 ms | one pass |
| arena stage + appendFiles | 50–100 ms | second memcpy + ~30 flushes |
| GPU dispatch (9 kernels × ~30 flushes) | 200–400 ms | overlapped with transport of later batches |
| **wall clock (overlapped)** | **~0.8–1.2 s** | vs ~400 s extrapolated today |

Full kernel tree (80k files / 1.3 GB): ~4–6 s wall, *if* the memory problem
in §5 is solved.

---

## 3. Buffer layout at the receiving end

```
corpusBuf: ArrayBuffer(totalBytes)                    ← allocated from INDEX frame
  file i bytes at [offset_i, offset_i+len_i), 4 B aligned

per flush batch:
  views[] = Uint8Array(corpusBuf, offset_i, len_i)    ← free
  → arena.stage({bytes: view, origin, page, ...})     ← existing API, unchanged
  → appendFiles: byteWords.value.array.set(...)       ← existing, one upload per batch
  → itemTable rows (ITEM_STRIDE floats/item)          ← existing
```

Nothing here is new API surface in `glyphPipelineKernels.js` — `setFiles` /
`appendFiles` already take "many raw byte blobs → one upload". The work is
upstream (stream, assembler) and in flush policy (chunked instead of
one-shot), plus arena capacity defaults: `maxBytes` default is 1 MB
(`GlyphPipelineArena` opts) and growth reallocates kernels — the stream's
`totalBytes` lets the arena pre-size to the corpus *before the first flush*,
eliminating the 1.25×–2× realloc chain entirely.

---

## 4. Mapping onto existing seams

| existing seam | change |
|---|---|
| `cli/fs.go` — `fs/readFile` / `sendRPCBinaryResult` / frame `0x02` | add `fs/openDirStream`, frame type `0x03`, stream handler outside the per-RPC 10 s timeout; drop UTF-8 gate on stream path |
| `cli/relay.go:343` FSHandler dispatch | route stream method; handle `fs/cancelStream` |
| `WebSocketBridge._handleRPCBinary` | demux `0x03` frames to a new `StreamAssembler` (by streamId) |
| `RemoteFileSystemProvider.getMultipleFiles` (concurrency 8) / `contentOf` | bypassed by `streamDir(root)`; string path kept for editor/one-off reads |
| `app/commands/handlers/fileCommands.js` openDir | consume stream events (index → create grids with origins; watermark → stage) instead of awaiting a full Map; keep `registry.holdChanges` across the stream |
| `CodeGrid._beginLoad` | add `loadBytes(view)` — no split, no TextEncoder, no `buildByteLineIndex` |
| `GlyphPipelineArena` | `reserve(totalBytes, fileCount)` up front; chunked flush trigger; existing `requestFlush` coalescing does the rest |
| `GlyphPipelineKernels.appendFiles` | unchanged — it is already the tar-feed API |
| `SessionParsePool` | template for the optional color-worker pool; `WorkerBridge` stays for the legacy path |

---

## 5. Risks / open questions

1. **Resident VRAM is the real wall, not transport.** Slots are 14 lanes/byte
   (56 B/byte transient) and today's instance attrs are ~48 B/glyph resident.
   300 MB source ⇒ ~270M glyphs ⇒ **~13 GB resident at 48 B** — impossible.
   Even packed minimal (pos 12 B + packed u32 [glyphId u16 | colorIdx u8 |
   flags u8] = 16 B/glyph) it's 4.3 GB + 300 MB byteWords. This load design
   therefore either (a) scopes to corpora ≤ ~100–200 MB fully resident, or
   (b) **depends on the compaction/LOD proposals**: keep bytes resident (300 MB
   is cheap), layout only the visible/working set, evict by LRU. The load
   pipeline is agnostic — chunked flush + watermarks work either way — but the
   "millions of glyphs all resident" story is *their* report, not this one.
2. **Coherence window / walk cost on real hardware** (from
   gpu-bounds-and-byte-pipeline.md, still unmeasured): if the layout walk is
   slower than simulated, chunked flush makes it *worse* per-byte (9 dispatches
   × 30 batches). Mitigation: flush size is a knob; if dispatch overhead
   dominates, raise to 32–64 MB.
3. **Frame size vs browser WS implementation**: very large frames (>16 MB)
   hit slow paths in some browsers; very small ones (per-file, 16 KB avg)
   recreate the 20k-message overhead (~100k msg/s dispatch ceiling ⇒ ~2 s
   just in message dispatch for the kernel tree). 4–8 MB is the sweet spot;
   verify on Chromium + WebKit.
4. **Single WS, head-of-line**: the relay's text plane (terminal output)
   shares the connection. A 1.3 GB stream will starve it unless blob writes
   yield or a second WS carries the bulk channel. Prefer a second connection:
   cleanest isolation, no mux complexity.
5. **Alignment discipline**: the whole zero-copy story rests on 4 B-aligned
   per-file offsets in the pack. Any future per-file transform (decompression,
   transcoding) breaks view-sharing and reintroduces a copy. Gzip on the wire
   (~4× on source) is tempting for slow links but *slower* on loopback
   (compress+decompress ≥ 2×300 MB passes vs 150 ms transport) — make it a
   negotiated flag, off by default locally.
6. **Cancellation/staleness**: the corpus can change mid-stream (the vite
   reload storm in the layer-2 plan). Stream carries a generation id; a newer
   `openDirStream` for the same root cancels the old one (latest-wins, same
   rule as restore coalescing).

---

## 6. Effort estimate

| piece | effort |
|---|---|
| Go: `fs/openDirStream` + pack writer + cancel + second WS route | 2–3 days |
| Client: StreamAssembler + `streamDir` + openDir rewiring | 2–3 days |
| `CodeGrid.loadBytes` + lazy/null `lines` + provider string-path split | 1–2 days |
| Arena `reserve` + chunked flush policy + backpressure | 1–2 days |
| Optional: color worker pool on corpus views | 2–3 days |
| Testing: pack round-trip vs `?raw` corpus, bench harness stream mode in `app/glyph-bench.jsx` | 2 days |
| **total** | **~2 weeks** (excl. compaction/LOD dependency) |
