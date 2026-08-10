## What's new in v0.3.0

**Thousands of files and millions of glyphs, at frame rate.** This release is
mostly one story told in twenty commits: the per-file cost of being on screen
went to nearly nothing. A file no longer builds a renderer. Every byte grid is
now a *view* into one arena-backed mega-field — a single `GlyphField` at arena
capacity, one draw — where a grid's entire render presence is `{ groupId,
slotBase, byteCount }` and its whole pose is a single texel in a storage-buffer
pose table. Opening a directory pours bare data rows instead of constructing a
`CodeGrid`, a unique panel material, and a scene-graph group per file; the real
grid materializes only when you interact with it. The load's first O(N²) — a
full registry scan three times per file, before a single object existed — falls
to a maintained index. The arena pre-sizes itself from the directory listing, so
the growth ladder never runs mid-storm.

**The frame stops paying for what it doesn't show.** Draw submission is now
per-range indirect: a CPU frustum test over each view's GPU-computed bounds
submits only visible slots, with adjacent survivors coalesced into gap-tolerant
runs — an all-visible scene collapses to a handful of draws rather than ~2k
encoder calls. Occlusion queries feed the same path, a disabled culler owns no
proxies at all, and a large file stages only the rows you're actually looking
at. The minimap uploads zero bytes when nothing changed.

**Layout moved onto the GPU.** Glyph positions come from a deterministic scan
pipeline in TSL — nine dispatches, no races — folding CPU-authored tables and
parameters with no CPU fallback path to drift from. Uploads are append-only and
incremental, freed ranges tombstone and feed a free list so the arena stops
burning capacity, and the GPU owns bounds. Colorization moved to a worker pool.
Editing writes in place against edit slack instead of restaging, so typing
latency stops waiting on a readback.

**A per-glyph memory diet.** Instance color went from `vec4` f32 to RGBA8 unorm
— 16 bytes to 4 per source byte, with the render path untouched because unorm8x4
reads back as the same normalized value. The codepoint lane was deleted outright:
a slot index *is* its source byte offset, so the only reader left (a newline
test) now reads a decode-time flag bit instead, retiring 4 bytes per slot — 64MB
at full arena capacity. Picking IDs widened to 32-bit in the same pass, so the
pick space stops being anyone's ceiling.

**Minified text is prefiltered mass, not strobing strokes.** The far LOD is no
longer a content-blind block: every file gets a small GPU-generated texture —
average syntax color × ink density per texel, computed by two new pipeline
kernels from the byte lanes the layout already owns — that the fragment samples
with an explicit mip level in place of the old impostor. Distant text stops
fuzzing, moiré-ing, and blinking in and out; it dims physically (colors are
linearized before averaging, so mips conserve ink energy) and keeps its syntax
pattern. New `glyph.farBias` dial; `tools/far-texels-check.mjs` gates the
kernels bit-exact against their oracles.

**Emoji handling, three ways healed.** Runtime-sighted emoji finally get their
glyph-map entries (they were structurally invisible before), the emoji atlas
re-creates its GPU texture when it grows (cells past the old size garbled),
and the pipeline's trie now heals whenever shaping outruns it — an encoded-
but-unknown codepoint no longer sticks `F_MISSING` for the whole session.
Slug-core cache bumps to format v2 so stale cores rebuild clean. And a subtle
one: decode re-zeroes the edit slack's size lanes every run, so backspaced
content can't ghost at its old position.

**Experimental: hands in the scene.** A phone running the MotionSource iOS app
can stream LiDAR hand tracking into the 3D view. The relay gained a third client
role — `SOURCE <kind>`, beside the browser display and the CLI controllers —
with no singleton restriction, so several capture devices can attach at once,
each addressable by its own id. Frames ride the display's existing socket on
their own write plane with drop-oldest backpressure, and the relay stays
schema-blind, so a new device class costs no server code. `hand.*` verbs cover
placement and diagnosis, and `hand.simulate` runs the whole path with no device
attached. This one is early and moving — treat the shape of it as provisional.

## What's new in v0.2.1

v0.2.0 served one directory; v0.2.1 makes the whole filesystem selectable —
and gives every file a durable spatial body.

**The Files panel is a real file browser.** Quiet `~` and `/` anchors browse
the entire machine lazily — one shallow listing per expanded directory,
nothing loads until asked, and hidden files and binaries show, because
selection needs truth. Click a file to open and focus it, ⊞ to pop a whole
directory into the world, ✕ on a directory to close everything under it.
Loaded state is derived live from the scene, never stored. The Sources panel
shows what the binary is serving, opens any typed path (`~/…` works), and
lists every opened root with per-root close.

**The world is additive multi-root.** Opening a second project doesn't
replace the first — each opened directory becomes another root in the field,
sessions capture and restore all of them, and closing a root forgets it. One
canonical identity per file (its absolute path) means the same file reached
by any route — relative argument, browse selection, saved session — is the
same entity: overlapping roots need no special cases, and dead ancestor
chains (`/home/you/dev/…`) collapse to a single level in every layout scheme
instead of stacking empty corridors.

**Every file rides a Book.** A durable, addressable carrier that outlives
every relayout: layout schemes arrange books, they no longer create or
destroy form. The new `library` scheme asks each book to take page form —
one uniform contain-fit onto an identical bound page — and stacks a
directory's collection as a deck (z), a shelf (x), or a pile (y), sorted by
name, size, or extension. The repository as a library: the same content,
mutable in form. `book.list` inspects the collection.

**The filesystem RPC grew three verbs and lost a lie.** `fs/readDir`
(shallow browse of any absolute path), `fs/addRoot` (runtime reach — the
`--reach` flag is now the static seed of a dynamic set), and `fs/roots` (the
page finally knows what it's attached to). `fs/listTree` now walks the
directory its URI names and reports truncation explicitly instead of passing
a capped walk off as complete. Content read/write stays gated through the
same hardened resolution path as before. New bus verbs: `file.list` (look
without loading — also from the CLI: `glyph3d-cli file.list ~/dev`) and
`file.closeDir` (unload a whole directory in one pass).

**Upgrade note:** the `fs/listTree` wire shape changed — a v0.2.0 binary and
a v0.2.1 page (or vice versa) will not agree. Restart the binary after
updating; terminals re-adopt and the session restores itself.

Also: npm publishing split from the release build (auth by security key),
and the headless suites grew to cover the new ground — canonical keys, chain
compression, multi-root session restore, dynamic-root race safety.

---

**glyph3d-cli** — a single self-contained binary. Download the one for your OS,
run it, and it serves glyph3d in your browser at http://localhost:8080. No
install, no dependencies; the whole app is baked into the binary.

### macOS / Linux

```sh
chmod +x glyph3d-cli-<platform>
./glyph3d-cli-<platform> serve            # browse the current directory
./glyph3d-cli-<platform> serve ~/project  # …or point it at a repo
```

macOS is unsigned here, so Gatekeeper may say it's from an "unidentified
developer." Clear the quarantine flag once:

```sh
xattr -d com.apple.quarantine glyph3d-cli-darwin-*
```

…or right-click the binary → **Open** the first time.

### Windows

```
glyph3d-cli-windows-amd64.exe serve
```

SmartScreen may warn (unsigned) — **More info → Run anyway**.

---

Then open **http://localhost:8080**. `Ctrl-C` to stop.

| platform | file |
| --- | --- |
| macOS (Apple Silicon) | `glyph3d-cli-darwin-arm64` |
| macOS (Intel) | `glyph3d-cli-darwin-amd64` |
| Linux (x86-64) | `glyph3d-cli-linux-amd64` |
| Linux (ARM64) | `glyph3d-cli-linux-arm64` |
| Windows (x86-64) | `glyph3d-cli-windows-amd64.exe` |
