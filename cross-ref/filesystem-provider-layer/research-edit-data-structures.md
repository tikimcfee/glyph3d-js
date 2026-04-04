# Research: Text Editing Data Structures, Algorithms & Protocols

> Blind survey of state of the art (March 2026). Focus: collaborative/versioned text editing with undo/redo.

---

## 1. Text Buffer Data Structures

### 1.1 Gap Buffer

**What it is.** A flat character array with a movable "gap" (unused space) at the cursor position. Insertions/deletions at the gap are O(1); moving the gap is O(n) where n is the distance moved.

**Who uses it.** Emacs (since 1985), Scintilla, many lightweight editors. ~60 lines of C for a minimal implementation.

**Key tradeoffs.**
- Strengths: minimal memory overhead, contiguous memory = excellent cache locality, 7x faster text search than ropes on 1GB files (Core Dumped 2023 benchmarks), fastest for sequential local edits.
- Weaknesses: O(n) gap repositioning for scattered edits. **Fundamentally incompatible with multi-cursor editing** — each cursor move requires shifting the gap. Non-local edits (e.g., find-and-replace across file) degrade to O(n) per site.
- With 100 cursors 4KB+ apart, ropes outperform gap buffers (O(log n) vs O(n) gap movement).

**Relevance to GPU glyph rendering.** A gap buffer's contiguous memory layout maps well to GPU buffer uploads — but any edit requires recomputing the entire buffer region after the gap. For a read-heavy viewer (render often, edit rarely), this is acceptable.

### 1.2 Rope

**What it is.** A balanced binary tree (often B-tree) of string chunks. Each internal node stores aggregate metadata (byte count, line count, etc.). O(log n) insert, delete, index.

**Who uses it.** Zed (custom SumTree), Helix (via `ropey` crate), Xi Editor, JetBrains Fleet, Lapce.

**Key tradeoffs.**
- Strengths: stable O(log n) worst-case for all operations regardless of edit locality. Cheap clone via copy-on-write (Arc/Rc nodes) — enables concurrent snapshots for rendering on one thread while editing on another. Natural fit for undo via immutable snapshots.
- Weaknesses: higher constant factor than gap buffer for local edits. Memory fragmentation. Search is ~7x slower than gap buffer due to non-contiguous memory. Not "amazing at anything, but always solidly good" (ropey author).
- Modern editors choose ropes when they need: multi-cursor, collaboration, concurrent access, or non-local edits.

**Zed's SumTree innovation.** Each B+ tree node carries a `Summary` with aggregated metadata: UTF-8 len, UTF-16 len (for LSP compatibility), line count, longest row. Enables O(log n) seeks along multiple dimensions simultaneously. 20+ SumTree instances in Zed's codebase beyond just text — file listings, git blame, diagnostics, display map.

**Relevance to GPU glyph rendering.** Copy-on-write snapshots let the render thread hold an immutable rope snapshot while edits proceed on another thread — critical for 60fps rendering. The tree structure also naturally provides line-count metadata needed for layout.

### 1.3 Piece Table

**What it is.** Two buffers: the original file (read-only) and an append-only "add" buffer for new text. A descriptor table of (buffer, offset, length) pieces describes the logical document order. Edits split pieces and append new text.

**Who uses it.** VS Code (as "piece tree"), original Word for Windows, AbiWord.

**Key tradeoffs.**
- Strengths: the original file is never modified — trivial to implement unlimited undo by replaying piece descriptors. Memory efficient: new text is append-only, no copying. File opening is fast (the original buffer IS the file).
- Weaknesses: naive piece table has O(n) descriptor scan for random access. Solved by VS Code's "piece tree" — a red-black tree of pieces with cached line-break metadata, giving O(log n) access.
- Line reading is O(log n) vs O(1) for line-array — but VS Code measured this as <1% of render time.

**VS Code's piece tree.** Replaced an earlier line-array model that consumed ~600MB for a 35MB file. The piece tree approach reduced memory to near file-size. Key optimization: storing line-break references directly to the buffer (not duplicating arrays) made operations 3x faster. They explicitly rejected native C++ because JS<->C++ boundary crossing overhead dominated on frequent `getLineContent` calls.

**Relevance to GPU glyph rendering.** Piece tables' append-only add buffer maps cleanly to GPU buffer append patterns. The "original buffer = file contents" property means initial rendering can proceed without any data transformation.

### 1.4 Comparison Summary

| Property | Gap Buffer | Rope | Piece Table/Tree |
|---|---|---|---|
| Insert at cursor | O(1) | O(log n) | O(log n) |
| Insert at arbitrary pos | O(n) | O(log n) | O(log n) |
| Line lookup | O(n) | O(log n) | O(log n) |
| Search | O(n), fast cache | O(n), slow cache | O(n), moderate |
| Memory overhead | Minimal | Moderate | Minimal |
| Multi-cursor | Poor | Good | Good |
| Undo (snapshots) | Expensive copy | Cheap (COW) | Cheap (descriptors) |
| Concurrent access | No | Yes (COW) | Possible |
| Complexity to implement | ~60 LOC | ~1000 LOC | ~500 LOC |

**2026 consensus:** Ropes for collaborative/multi-cursor editors. Piece trees for editors prioritizing memory efficiency and undo. Gap buffers for single-cursor, search-heavy tools.

---

## 2. Edit Representation & Undo

### 2.1 Operational Transformation (OT)

**What it is.** Edits expressed as operations (insert/delete at position). Concurrent ops from different clients are *transformed* against each other to maintain consistency. Requires a central server to serialize the canonical operation order.

**Who uses it.** Google Docs, ShareDB, Apache Wave.

**Key limitations.**
- Central server is a hard requirement — no true peer-to-peer.
- Transform function combinatorial explosion: for n operation types, need n^2 transform pairs. Correctness proofs are notoriously difficult.
- Character interleaving during simultaneous edits. Google's mitigation: client-side heuristics group ops arriving within 50ms at the same cursor as "typing bursts" — works ~95% of the time.
- Scaling issues: Google Docs shows "overloaded" warnings under heavy concurrent editing.

### 2.2 CRDTs for Text

**What it is.** Data structures where concurrent operations are *inherently commutative* — can be applied in any order on any replica and converge to the same state. No central server required.

**Production implementations (ranked by maturity).**

| Library | Language | Algorithm | Production Users | Perf (editing trace) | RAM |
|---|---|---|---|---|---|
| **Yjs** | JS | YATA | Braid, Row Zero, many | 0.97s | 3.3 MB |
| **Automerge** | Rust+WASM | RGA variant | Ink & Switch | 291s (old), much improved in 2.0 | 880 MB (old) |
| **Loro** | Rust+WASM | Fugue + Peritext | Early adopters | Competitive with Yjs | Low |
| **Diamond Types** | Rust | YATA variant | Experimental | **0.056s** | **1.1 MB** |

**Key insights.**
- Diamond Types achieved 5000x speedup over Automerge via: range tree (B-tree) instead of linked list, run-length encoding of consecutive ops (14x fewer entries), tight memory packing in fixed-size arrays for cache efficiency.
- CRDT metadata overhead: naive implementations add 16-32 bytes per character. Kleppmann's columnar encoding reduced Automerge from 1.1GB to 3MB for a 100KB doc. Yjs stores 100KB doc in 160KB on disk (~1.6x overhead).
- Tombstone problem: deleted characters stay as metadata forever. Garbage collection is possible but complicates the protocol.
- Undo in CRDTs is non-trivial: Zed uses an "undo map" (operation ID -> count; odd=undone, even=redone) rather than a stack, because each collaborator needs independent undo history.

**Loro** is notable for supporting movable trees (drag-and-drop reordering) and rich text (Peritext algorithm for formatting spans), plus time-travel through history.

### 2.3 Edit Scripts & Diff Algorithms

**Myers diff (1986).** O(ND) algorithm where N is document size and D is edit distance. Finds shortest edit script (minimal insertions + deletions) by modeling the problem as shortest path over an edit graph. Used by `git diff`, most diff tools. O(N) space with refinement.

**Relevance.** When computing what changed between document versions (for incremental GPU buffer updates), Myers diff gives the minimal set of changed regions. This maps directly to `addUpdateRange()` for partial GPU uploads.

### 2.4 Undo Models

**Linear undo stack.** Most editors. Push edits on undo stack; undo pops and pushes onto redo stack. Making a new edit after undo discards the redo stack. Simple but loses history branches.

**Vim's undo tree.** Every edit creates a new branch — no history is ever lost. `u`/`Ctrl-R` navigate the current branch (stack-like), while `g-`/`g+` traverse all branches chronologically. Persistent undo (Vim 7.3+) serializes the entire tree to disk, surviving editor restarts. Plugins like undotree/Mundo visualize the tree graphically.

**CodeMirror 6's invertible effects.** Functional/immutable model. Each transaction carries a `ChangeSet` that can produce its own inverse via `changeset.invert(doc)`. The history extension stores inverted changesets. Undo = dispatch a transaction containing the inverse changeset. Effects can register inversion functions so custom state changes are also undoable. All change positions reference the original document state — "they conceptually all happen at once."

**Helix.** Uses OT-like `Transaction` objects on top of ropey. A transaction can be inverted to produce an undo. Document `History` stores snapshots enabled by rope's cheap clone.

**VS Code / Monaco.** Edit stacks managed by `_undoRedoService`. `pushStackElement()` creates undo stops. Version ID increments on every change; "alternative version ID" stays stable across undo/redo cycles. Inverse edits computed from the piece tree's descriptor changes.

**Two fundamental patterns across all editors:**
1. **Command pattern** (Nano, Emacs, CodeMirror): store the operation + its inverse. Low memory, but requires explicit inverse logic per operation type.
2. **Memento pattern** (Neovim, Redux-style): store previous states. Simpler, but higher memory unless using structural sharing (ropes) or diffs.

### 2.5 Inverse Edit Computation

The standard approach: an edit `{from, to, insert}` has inverse `{from, from + insert.length, originalText[from..to]}`. You must capture the replaced text *before* applying the edit. CodeMirror's `ChangeSet.invert(doc)` does exactly this — it reads the replaced ranges from the original document to build the inverse. This is why the document reference is required at inversion time.

---

## 3. Change Watching & Synchronization

### 3.1 LSP textDocument/didChange

**Three sync modes:**
- `None` (0): no sync
- `Full` (1): send entire document content on every change
- `Incremental` (2): send `{range, text}` deltas after initial full sync

**Version tracking.** Each `didChange` includes a monotonically incrementing version number. The version after all changes in the notification have been applied. Known issue: no starting version field, so servers can't detect drift. Different editors (VS Code, Neovim, Emacs, Helix) implement versioning slightly differently, causing subtle interop bugs.

**Batching.** Multiple content changes can be sent in a single `didChange` notification. Changes must be applied sequentially — change N operates on the document resulting from changes 0..N-1. Editors typically debounce changes, but whether debounce is on or off should produce the same eventual state.

**Relevance.** The `{range, text}` delta format maps directly to the edit representation needed for incremental GPU buffer updates. A `didChange`-style protocol between an edit source and the glyph renderer would enable minimal re-rendering.

### 3.2 File System Watching (inotify / kqueue / FSEvents)

**Platform differences.**
- **inotify (Linux):** No native recursive watching. `max_user_watches` limit (default ~8192) causes "no space left on device" errors. `ErrEventOverflow` when queue fills. No `IN_CLOSE_WRITE` exposure in most abstractions — risk of reading half-written files.
- **kqueue (BSD/macOS):** Requires one file descriptor per watched file — hits `kern.maxfiles` limit fast. Also no native recursive watching.
- **FSEvents (macOS):** Directory-level, not file-level. Coalesces events with latency.

**Universal gotchas.**
- Atomic saves (rename temp file over original) cause the watch to break — inotify removes the watcher on rename. Must re-watch.
- Single "save" produces multiple write events depending on kernel sync timing. Must debounce.
- Recursive watching requires user-space traversal on all platforms.
- Half-written file reads after write notification are common; no reliable "write complete" signal across platforms.

### 3.3 File Versioning Strategies

| Strategy | Used By | Tradeoff |
|---|---|---|
| Monotonic counter | LSP, VS Code | Simple, no content inspection needed, but meaningless across sessions |
| Content hash (SHA-256) | Git, CAS systems | Content-addressable, deduplicates, but expensive to compute on large files |
| ETag (HTTP) | Web APIs | Server-defined, opaque, good for cache validation |
| mtime + size | Most file watchers | Fast but unreliable (clock skew, same-size edits) |
| Lamport timestamp | CRDTs, Zed | Causally ordered, works in distributed systems |

---

## 4. Relevant Open Source Architectures

### 4.1 CodeMirror 6

**Architecture.** Redux-inspired functional state management. `EditorState` is immutable. All changes flow through `Transaction` objects containing: document changes (as `ChangeSet`), selection updates, annotations (metadata), effects (extension actions), and config changes.

**Key design decisions.**
- Document stored as flat string in a tree-shaped structure, indexed by line. Positions are UTF-16 code units.
- Change positions reference the *pre-transaction* document — "they conceptually all happen at once." This enables clean composition and inversion.
- Undo is an extension, not core. The `@codemirror/history` package stores inverted changesets and inverted effects.
- State fields update via reducer functions: `(currentValue, transaction) -> newValue`.
- Facets provide configuration composition — multiple extensions can contribute values that are combined via custom functions.

**Relevance.** CodeMirror's transaction model is the gold standard for representing edits in a functional system. Its `ChangeSet` maps directly to the kind of edit descriptors needed for incremental GPU buffer updates.

### 4.2 Monaco Editor (VS Code's editor component)

**Architecture.** Piece tree text buffer (see 1.3). TextModel wraps the buffer with line-level API. Undo via edit stacks with undo stops (`pushStackElement()`). Version ID tracking for change detection. Content change events carry `isUndoing`/`isRedoing` flags.

**Key insight.** Monaco rejected native C++ for the text buffer because JS<->C++ boundary crossing overhead on frequent `getLineContent` calls was worse than staying in JS. This is relevant for any WASM-based approach.

### 4.3 Zed Editor

**Architecture.** Layered buffer design in Rust:
1. `Rope` (SumTree) — immutable string chunks in a B+ tree with rich metadata summaries
2. `text::Buffer` — CRDT layer wrapping the rope. Lamport timestamps, anchor system for stable positions, operation-based replication
3. `language::Buffer` — adds tree-sitter syntax tree, diagnostics, LSP integration
4. `MultiBuffer` — aggregates excerpts from multiple files into a single virtual document

**Novel contributions.**
- Anchor system: positions identified by `(insertion_id, offset)` rather than byte offset. Survives concurrent edits.
- Undo map: `{operation_id: count}` where odd = undone, even = redone. Enables per-user undo in collaboration.
- Copy-on-write B-tree for fragment indexing — avoids linear scans when applying remote edits.
- SumTree used for 20+ purposes beyond text: diagnostics, git data, display mapping.

### 4.4 Helix Editor

**Architecture.** Core heavily based on CodeMirror 6's functional model, implemented in Rust with the `ropey` crate for text storage.
- Ropes are cheap to clone — enables snapshots for undo history.
- Edits expressed as OT-like `Transaction` objects that can be inverted.
- `Document` ties together rope, selections, syntax (tree-sitter), history, and language server.
- Multiple selections are a core primitive (not an add-on). Each `Range` has a moving head and immovable anchor.

### 4.5 JetBrains Fleet

**Architecture.** Rope with B-tree nodes (32 chunks of 64 chars per leaf). Each node stores weight + line count as "metrics." Also uses interval-tree ropes for widget positioning.

### 4.6 Tree-sitter Integration

**How it works with edits.** Three-step process:
1. **Notify** the old tree of the edit via `ts_tree_edit(tree, &edit)` where edit = `{start_byte, old_end_byte, new_end_byte, start_point, old_end_point, new_end_point}`. This adjusts node ranges to stay in sync.
2. **Re-parse** by calling `ts_parser_parse(parser, old_tree, input)`. The parser reuses unchanged subtrees, only re-parsing affected regions.
3. **Query changed ranges** via `ts_tree_get_changed_ranges(old_tree, new_tree)` to know which syntax regions changed.

**Key property.** The edit descriptor format (`start, old_end, new_end`) is the minimal information needed — it's the same format as a text edit `{from, to, insert.length}`. Any text buffer that tracks edits can trivially produce tree-sitter edit descriptors.

**Relevance.** For syntax-highlighted GPU glyph rendering, tree-sitter's changed ranges tell you exactly which glyphs need color updates after an edit — no need to re-highlight the entire file.

---

## 5. Key Papers & Blog Posts

### Foundational

- **Myers 1986** — "An O(ND) Difference Algorithm and Its Variations." Minimal edit scripts. Basis of `git diff`. [Original paper](http://www.xmailserver.org/diff2.pdf)
- **Gu et al. 2005** — "Undo as Concurrent Inverse in Group Editors." Formalizes undo in collaborative editing with OT. [ACM](https://dl.acm.org/doi/10.1145/586081.586085)

### Blog Posts (High Signal)

- **VS Code text buffer reimplementation (2018)** — Why piece tree beat line-array, benchmark methodology, why they stayed in JS. [VS Code Blog](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)
- **Xi editor retrospective (2020)** — Raph Levien's post-mortem. Key lessons: CRDT complexity exceeded expectations, process separation between frontend/core was the biggest mistake, monolithic architectures are better for contributors, JSON IPC was surprisingly problematic (Swift JSON perf "shockingly slow", serde bloated binary to 9.3MB). Rope was the most reusable artifact. [raphlinus.github.io](https://raphlinus.github.io/xi/2020/06/27/xi-retrospective.html)
- **"I was wrong. CRDTs are the future" (Seph Gentle)** — Makes the case that CRDTs have overcome their performance limitations. Diamond Types: 6M edits/sec in Rust. Kleppmann's columnar encoding solved the metadata bloat problem. [josephg.com](https://josephg.com/blog/crdts-are-the-future/)
- **"CRDTs go brrr" (Seph Gentle)** — How Diamond Types achieved 5000x speedup: range tree, RLE ops, cache-friendly memory layout. [josephg.com](https://josephg.com/blog/crdts-go-brrr/)
- **Zed: "How CRDTs make multiplayer text editing part of Zed's DNA"** — Anchor-based positioning, Lamport timestamps, undo maps, tombstone design. [zed.dev](https://zed.dev/blog/crdts)
- **Zed: "Rope & SumTree"** — B+ tree rope with rich metadata summaries, copy-on-write, multi-dimensional seeking. [zed.dev](https://zed.dev/blog/zed-decoded-rope-sumtree)
- **"Gap Buffers Are Not Optimized for Multiple Cursors" (Chris Wellons, 2017)** — Formal argument for why gap buffers can't support multi-cursor efficiently. [nullprogram.com](https://nullprogram.com/blog/2017/09/07/)
- **"Text showdown: Gap Buffers vs Ropes" (Core Dumped, 2023)** — Benchmarks with real editing traces. Gap buffer wins on search (7x), ties on typical editing, loses on scattered edits. [coredumped.dev](https://coredumped.dev/2023/08/09/text-showdown-gap-buffers-vs-ropes/)
- **"Text Editor Data Structures" (cdacamar)** — Piece tree analysis, multi-cursor argument, undo via immutable snapshots. [cdacamar.github.io](https://cdacamar.github.io/data%20structures/algorithms/benchmarking/text%20editors/c++/editor-data-structures/)
- **"Undo/redo implementations in text editors" (Matt Duck)** — Survey of Nano, Emacs, Neovim, Redux approaches. [mattduck.com](https://www.mattduck.com/undo-redo-text-editors)

---

## 6. Synthesis: Relevance to GPU-Instanced 3D Code Viewer

### The glyph3d-js context

The renderer converts text into GPU instance buffers (40 bytes/glyph). Edits must map to partial buffer updates via `addUpdateRange()`. The system already has: deferred batch rendering, worker-based buffer builders, frustum culling, and incremental highlight texture updates.

### Recommended architecture for edit support

1. **Buffer data structure: Piece table variant.** The append-only add buffer maps naturally to GPU buffer append. The original-file-as-buffer property means no data transformation for initial render. O(log n) piece tree gives fast line lookup for layout. Piece descriptors trivially produce tree-sitter edit descriptors and LSP-compatible `{range, text}` deltas.

2. **Edit representation: CodeMirror-style ChangeSets.** Immutable, composable, invertible. `ChangeSet.invert(doc)` gives undo for free. Positions reference pre-edit document, enabling clean batching. Maps directly to the `{from, to, insert}` format needed for `addUpdateRange()`.

3. **Undo model: Inverted changeset stack with branching option.** Store inverted changesets (command pattern). Cheap because piece table descriptors capture the inverse naturally. Add Vim-style tree branching later if needed — the changeset model supports it.

4. **Collaboration (future): Yjs or Loro.** Yjs for immediate production use (editor bindings exist). Loro for richer data types (movable trees for file explorer, rich text for annotations). Both have WASM builds suitable for browser.

5. **Change propagation: LSP-style incremental deltas.** The `{range, text}` format is the lingua franca. Edit -> delta -> tree-sitter edit -> syntax re-highlight -> GPU buffer partial update. Each step consumes the same format.

6. **File watching: Content hash + monotonic version.** Hash for cross-session identity, version counter for intra-session ordering. Debounce file system events aggressively (atomic saves produce multiple events).

### What NOT to do (lessons from Xi)

- Don't separate edit engine and renderer into separate processes. The async IPC overhead kills responsiveness for interactive editing.
- Don't use JSON for high-frequency edit messages. Binary format or shared memory.
- Don't implement CRDTs from scratch — use Yjs/Loro. "The depth of research required exceeded expectations" (Levien).
- Don't use gap buffers if multi-cursor or collaborative editing is on the roadmap.
