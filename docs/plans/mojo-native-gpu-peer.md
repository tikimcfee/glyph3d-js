# Mojo as a native GPU peer

*Context: Modular open-sourced the Mojo compiler, tooling, and stdlib under Apache 2.0
(LLVM exceptions) on 2026-08-18, one week after Mojo 1.0 locked source stability. Mojo
writes GPU kernels natively for NVIDIA, AMD, and Apple hardware — no CUDA C++, one
language for host and device. This doc maps that onto this codebase.*

## The honest boundary first

Mojo does not emit WGSL or SPIR-V. It will not run inside the page, and it will not
replace TSL in `GlyphField` or `GlyphLayoutKernel`. Anyone selling "rewrite the renderer
in Mojo" is selling a rewrite of the one layer that must stay browser-native.

That boundary costs us almost nothing, because this codebase already factored itself so
the boundary doesn't matter. Three standing decisions — none made with Mojo in mind —
mean a native GPU process drops in as a peer, not a port:

1. **The pipeline contract is substrate-independent by construction.**
   `glyphPipelineReference.js` is the semantic oracle; `glyphPipelineScan.js` is the
   algorithm spec, structured dispatch-for-dispatch like the TSL; the TSL kernels are
   "the same code on hardware." Three layers, one contract, byte-in → positions +
   bounds out. Nothing in that contract says *which* hardware.

2. **The bake is a pure monoid fold.** `glyphBake` is "a pure function of (bytes,
   trie)" whose checkpoint records are explicitly designed so "a GPU windowed scan
   seeds from the same records" — and it already runs headlessly (`tools/bake.mjs`).

3. **The relay is substrate-blind.** Three client roles — one DISPLAY, N controllers,
   N SOURCEs — and the command bus doctrine (every action is a verb) mean a native
   process joins the system over a WebSocket with zero relay changes. The CLI already
   proves the controller path; MotionSource already proves the SOURCE path.

The magic is not "Mojo in the browser." It's that the browser was always meant to be
*one GPU peer among several*, and Mojo just became the best open language for the
native peers.

## Projects, ranked

### P1 — Conformance twin: the scan spec on real native GPUs

Port `glyphPipelineScan.js` to Mojo. Same monoid element, same absorbing item-start
resets, same integer row/col discipline, same kernel functions — a **fourth layer** of
the existing contract, running on NVIDIA/AMD/Apple silicon with no browser in the loop.

Why this is worth more than it sounds:

- **Differential fuzzing across substrates.** The reference doc's deepest paranoia is
  f32 non-associativity — "two summation groupings land a few ULPs apart, and
  `floor(y / pageHeight)` at a page boundary flips a glyph a whole page." Today the TSL
  layer is only ever exercised inside a browser on whatever GPU the dev box has. A Mojo
  twin runs the identical scan with a *different* compiler, driver, and grouping on
  real hardware in CI, at gigabytes-of-random-UTF-8 scale, and diffs integer row/col
  and per-item bounds against the oracle. Agreement between three independent
  implementations is a far stronger invariant than agreement between two, and this is
  precisely the bug class (grouping-dependent float behavior) that differential testing
  catches and unit tests don't.
- **A performance ceiling oracle.** Oak Ridge measured Mojo GPU kernels at ~87% of CUDA
  on H100 memory-bound workloads — and this pipeline is memory-bound (tables + scans).
  The native twin tells us, per kernel, what the hardware can do, so we know what the
  WebGPU path leaves on the table and whether a slow load is our algorithm or the
  browser's overhead. Today we can't distinguish those.
- **Smallest possible start.** The scan spec exists specifically to be provable off-GPU;
  porting it is transcription plus a test harness, not design work.

### P2 — Native repo bake: `glyphbake` as a Mojo binary

`glyphBake` is one streaming forward pass per file, O(1) state — embarrassingly
parallel across a repo's files, and each file's checkpoint scan is itself GPU-friendly
(that's what the checkpoint records are *for*). A Mojo bake binary, shipped as a
sidecar the Go CLI execs (the tmux-adapter subprocess pattern), bakes an entire
workspace — totals, checkpoints, scalars, boxes, line histograms, the codepoint census
for atlas pre-baking — before the display ever connects. The relay serves the baked
index; the page measures and places every grid in a 10k-file workspace without loading
a byte of most of them. Same records, same fold, native speed. This upgrades bulk load
from "fast" to "already done."

### P3 — Gesture recognition closes the sensor-plane gap

"Gesture→verb binding is not built yet" is a named hole. Recognition over N
simultaneous hand-landmark streams (the sensor plane explicitly allows many devices) is
a batch GPU inference problem with a latency budget — a poor fit for the page's frame
loop, a natural fit for a native process. A Mojo recognizer sits beside the relay,
consumes `source.frame` streams, and emits either higher-level gesture frames (still
schema-blind to the relay) or command-bus verbs directly as a controller. The page's
pull-style `HandPresence` sampling doesn't change; it just starts seeing *meaning*
arrive alongside pose.

### P4 — Semantic space layout as a controller

"Where do a thousand grids go in 3D space" is a question nobody computes today —
force-directed graphs over import edges, embedding-based clustering, treemap solvers.
All of it is native GPU compute with no business in the page, and all of its *output*
is just verbs (`grid.move`, camera framing) issued over the bus like any other
controller. This is the first project that's a new capability rather than a stronger
version of an existing one — and the bus means it needs no new seam at all.

## The watch item

The compiler is Apache 2.0 on MLIR. A SPIR-V/WGSL backend is now *possible* for anyone
motivated — Modular accepts compiler contributions starting end of 2026. Don't bet the
architecture on it; do watch it. If it lands, `glyphPipelineScan` is already the code
that's written to compile to both worlds, because it was written as a spec, not an
implementation.

## Interop mechanics (all boring, deliberately)

- Mojo ↔ Go has no native FFI story worth wanting. The seam is the WebSocket and the
  command bus — which is already this repo's doctrine. A native peer that needs a new
  action means a missing verb; add the verb.
- Mojo builds standalone binaries. Ship sidecars per-platform the way `make all`
  already cross-compiles the CLI; the CLI execs and supervises them like terminal
  adapters.
- Apache 2.0 with LLVM exceptions is compatible with embedding and redistribution in
  the single-binary model.

## Order of operations

P1 is the keystone: it's small, it hardens the invariant everything else leans on, and
it forces us to make the pipeline contract *actually* language-independent (a Mojo port
will surface any place the spec silently leans on JS semantics). P2 reuses P1's fold
code directly. P3 and P4 are independent of both and of each other.
