# Post-Implementation Review: parsing

## Bugs Found

### BUG-1: `ConnectionRenderer.clear()` mutates Map during iteration (CRASH)

**File:** `src/annotations/ConnectionRenderer.js`, line 124

```js
clear() {
    for (const id of this._connections.keys()) this.remove(id);
}
```

`remove()` calls `this._connections.delete(id)` (line 114). Iterating a Map with `for...of` on `.keys()` while deleting entries is *sometimes* safe in V8 (it skips the deleted key and continues), but the ES spec says the iterator may throw or produce undefined behavior when the collection is modified during iteration. In practice, V8 will skip every other entry because after deleting entry N, the iterator advances past the slot where N+1 now sits.

**Concrete failure:** If you have connections `['a', 'b', 'c']`, the loop processes 'a' (deletes it), then the iterator skips 'b' and processes 'c'. Connection 'b' is leaked -- its slot is never freed, its vertices remain on screen.

**Fix:** Snapshot the keys first: `for (const id of [...this._connections.keys()]) this.remove(id);`

This is called by `TourSequencer.clear()` at line 181 -- every tour-clear leaks connections.

---

### BUG-2: `TourAnnotator._highlightToken()` uses raw string positions as column indices (WRONG HIGHLIGHTS)

**File:** `src/services/tour/TourAnnotator.js`, lines 135-145

```js
_highlightToken(grid, token, color) {
    if (!grid.lines?.length) return;
    for (let lineIdx = 0; lineIdx < grid.lines.length; lineIdx++) {
        const line = grid.lines[lineIdx];
        let pos = 0;
        while ((pos = line.indexOf(token, pos)) !== -1) {
            grid.highlightRange(lineIdx, pos, lineIdx, pos + token.length, color);
            pos += token.length;
        }
    }
}
```

`line.indexOf(token, pos)` returns a *string offset* (counts whitespace characters). But `highlightRange` expects *visible-character indices* -- buffer slot offsets that skip spaces, tabs, newlines (CodeGrid.js line 583-586 counts only `code !== 10 && code !== 32 && code !== 13 && code !== 9`).

Compare with the correct implementation in `app/commands/handlers/highlightCommands.js` lines 226-240, which converts string positions to visible-char columns by iterating and counting non-whitespace characters before and within the match.

**Concrete failure:** For a line `    const foo = bar;`, searching for `foo`:
- `indexOf` returns 10 (string position).
- `highlightRange(line, 10, line, 13, color)` highlights visible chars 10-13 -- which are completely wrong characters since the 4 leading spaces are not buffer slots.
- The correct visible column is 6 (10 minus 4 spaces).

Every token with leading whitespace on its line will highlight the wrong glyphs.

---

### BUG-3: `TourAnnotator` references `ref.color`, `ref.token`, `ref.label` which don't exist on FileRef

**File:** `src/services/tour/TourAnnotator.js`, lines 45, 60, 65

```js
const color = COLOR_PRESETS[ref.color] || COLOR_PRESETS.blue;
if (ref.token) { ... }
if (ref.label) { ... }
```

The `ref` here is `resolved.ref`, which is a `FileRef` (from `parseFileRef.js` line 3-9). FileRef only has `filePath`, `line`, `col`, `endLine`, `endCol`. There is no `color`, `token`, or `label` property defined anywhere in the parsing layer or the typedef.

For the `tour.load` JSON path, these would need to be on the raw JSON input's ref objects, which would survive through `TourResolver.resolve()` since `_makeResolved()` passes `ref` through untouched. So structured JSON tours *could* work if the caller puts extra fields on the FileRef objects. But for the `tour.load.text` / `parseAuto` path, these fields will always be `undefined`, so:
- `ref.color` -> `undefined` -> falls back to `COLOR_PRESETS.blue` (harmless)
- `ref.token` -> `undefined` -> falsy, skipped (harmless but useless)
- `ref.label` -> `undefined` -> falsy, skipped (no labels ever created from parsed text)

This isn't a crash, but it means the "extra fields on FileRef" contract is undocumented and fragile. If any code ever clones or reconstructs a FileRef using only the typedef fields, these ad-hoc properties are silently lost.

---

### BUG-4: `parseAuto` dedup key breaks on null filePath

**File:** `src/parsing/parseAuto.js`, line 20

```js
const k = `${r.sourceLineIndex}:${r.ref.filePath}:${r.ref.line}:${r.ref.col}`;
```

When `parseLogLine` emits refs with `filePath: null` (line 53 of parseLogLine.js), the key becomes `"5:null:null:null"`. If two different log lines at different sourceLineIndex values both have null filePath/line/col, they're fine (different sourceLineIndex). But if the same line produces a log-line ref with null filePath AND parseFileRef also doesn't match it (so it's in unmatched), the dedup works. However, there's a subtle issue: `parseLogLine` can emit a ref for a line that `parseStackTrace` didn't match, and `parseFileRef` also didn't match. The log-line ref with null filePath gets added. Then for the `unmatched` computation on line 27, `matchedLines` includes this line index, so it's excluded from `unmatched` -- correct behavior, but worth noting that "unmatched" actually means "no parser emitted any ref for this line," not "no file reference found."

Not a crash, but a semantic gap: lines that are matched as log lines (timestamp/level only, no file ref) are excluded from `unmatched` even though they contain no actionable file reference.

---

### BUG-5: `TourSequencer.prev()` uses `this.stepIndex || 0` instead of null-safe check

**File:** `src/services/tour/TourSequencer.js`, line 161

```js
async prev() {
    return this.goto(Math.max((this.stepIndex || 0) - 1, 0));
}
```

When `stepIndex` is `0` (first step, active), `this.stepIndex || 0` evaluates to `0 || 0 = 0`. Then `0 - 1 = -1`, `Math.max(-1, 0) = 0`. That's correct -- stays at step 0.

But when state is `'loaded'` (just loaded, no step visited yet), `stepIndex` is `-1`. `-1 || 0` evaluates to `-1` (because -1 is truthy!). Then `-1 - 1 = -2`, `Math.max(-2, 0) = 0`. That also happens to work.

Actually, the `||` operator is wrong for a different reason: if `stepIndex` were ever set to `0` and we wanted to distinguish it from "unset," but since `0` is a valid index, `|| 0` would mask it. In this specific case, the math happens to work out, but the *intent* is fragile. Compare with `next()` which handles the `'loaded'` state explicitly. `prev()` should do the same.

Not a runtime crash in current code, but a latent correctness issue.

---

## Design Drift

### DRIFT-1: TourAnnotator accesses `resolved.ref` for tour-specific fields instead of `resolved.parsedRef`

The `TourResolver.resolveAll()` method (line 71) attaches `parsedRef` to each resolved reference:
```js
return { ...resolved, parsedRef: pr };
```

But `TourAnnotator.apply()` (line 42) reads `resolved.ref` (the raw FileRef), not `resolved.parsedRef` (the full ParsedRef which carries `kind`, `rawText`, `meta`). The log-line metadata (timestamp, level, message) from `parseLogLine` is therefore completely inaccessible to the annotator -- it's on `resolved.parsedRef.meta` but never read.

For structured JSON tours, this might be intentional (the caller puts everything on the FileRef). But for text-parsed tours, the parsed metadata is silently discarded.

### DRIFT-2: TourAnnotator creates CodeGrid labels but doesn't set atlas

**File:** `src/services/tour/TourAnnotator.js`, line 109

```js
const grid = new CodeGrid(this._ctx.scene, this._ctx.atlas, { ... });
```

This assumes `this._ctx.atlas` exists. The command context bag (`ctx`) in `tourCommands.js` comes from the command center's context. Let me check if `atlas` is a standard context field...

Looking at `tourCommands.js` line 36:
```js
ctx._tourSequencer = new TourSequencer(ctx, { ... });
```

And TourAnnotator is constructed at TourSequencer line 60:
```js
this._annotator = new TourAnnotator(ctx);
```

The `ctx` object needs `.atlas`, `.scene`, `.registry`. If the command context doesn't have `.atlas`, `new CodeGrid(scene, undefined, ...)` will fail when it tries to call methods on the atlas. This is a potential integration gap -- the command context must include `atlas`.

### DRIFT-3: Registry type mismatch between TourResolver and actual registrations

TourResolver._findBySuffix (line 88) does:
```js
const entries = this._registry.findByType('grid');
```

But when `tourCommands.js` registers label grids via TourAnnotator._createLabel (line 129):
```js
this._ctx.registry.register(id, grid, { type: 'tour-annotation', stepId });
```

These are type `'tour-annotation'`, not `'grid'`. So the resolver never accidentally matches tour labels as file targets. This is *correct* behavior, but it means the resolver will also miss any grids registered with types like `'window'` (from windowCommands.js line 62). If a stack trace references a file displayed in a TUI window, the resolver won't find it.

---

## Missing Edge Cases

### EDGE-1: Windows-style paths with backslashes

`parseFileRef.js` pattern character class `[^\s"'():]+` accepts backslashes, so `C:\Users\foo\bar.js:10:5` would match. But `looksLikeFilePath` (line 52) checks `path.includes('/')` -- Windows paths use `\`. The `||` clause `path.includes('\\')` handles this. OK, actually this is covered.

But the `_findBySuffix` in TourResolver uses `sp.endsWith(file)`, which would fail for mixed separators: ref says `foo/bar.js` but registry has `foo\bar.js`. Unlikely in browser context but worth noting.

### EDGE-2: Rust/TypeScript error spans with range syntax

Rust compiler output: `src/main.rs:10:5: 10:15` (start:end range on same line). The first pattern matches `src/main.rs:10:5` but the `: 10:15` part is lost. No endLine/endCol extracted. The FileRef typedef supports `endLine`/`endCol` but no parser ever populates them.

### EDGE-3: Node.js internal frames

Stack traces from Node.js contain frames like:
```
    at internal/modules/cjs/loader.js:1032:30
```

`looksLikeFilePath` would accept `internal/modules/cjs/loader.js` (contains `/`, has extension). These would show up as unresolvable refs, polluting the tour with noise. The NOISE set only filters out `Error.js`, `Object.js`, etc. -- not `internal/` paths.

### EDGE-4: Webpack/bundler transformed paths

Paths like `webpack:///src/app.js` or `webpack-internal:///./src/app.js` would match the file:line:col pattern, extracting `webpack:` as a path prefix. The `///` would be consumed as part of the path. `looksLikeFilePath` would accept it (contains `/`). The resolver would then fail to match anything.

### EDGE-5: Multiple stack traces in one input

`parseStackTrace` resets `depth` when `lastLang` changes or on a non-empty unmatched line (line 96). But if two JS stack traces are separated by a blank line:
```
Error: first
    at foo (a.js:1:1)

Error: second
    at bar (b.js:2:2)
```

The blank line between them triggers `unmatched.push(line)` without resetting `lastLang`/`depth` (because `line.trim() === ''` on line 96). So the second trace's first frame gets `depth: 1` instead of `depth: 0`. The reset only happens on non-empty unmatched lines.

### EDGE-6: Log lines with ANSI escape codes

Terminal output pasted into the tour system would contain ANSI color codes like `\x1b[31m`. These would:
1. Interfere with timestamp/level regex matching
2. Be embedded in extracted file paths
3. Appear as garbage in label text

No ANSI stripping is done anywhere in the parsing pipeline.

---

## Integration Seams

### SEAM-1: `tour.load` JSON path vs. text path have different ref shapes

In `tourCommands.js`, the JSON path (line 63-81) passes `data.steps[].refs` directly to `TourSequencer.load()`, which calls `this._resolver.resolveAll(input.refs)`. `resolveAll` expects `ParsedRef[]` (objects with `.ref` being a FileRef).

For the JSON path, these refs come from user-authored JSON. If the user writes:
```json
{ "steps": [{ "refs": [{ "filePath": "foo.js", "line": 10 }] }] }
```

Then `input.refs[0]` is `{ filePath: "foo.js", line: 10 }` -- a bare FileRef, not a ParsedRef wrapping a FileRef. `resolveAll` does `pr.ref` (line 70), which would be `undefined` because the object IS the ref, not a wrapper around one.

The text fallback path (line 67-79) correctly produces ParsedRef objects from `parseAuto`. But the JSON path assumes the user wraps their refs in `{ ref: {...} }` format, which is non-obvious and undocumented.

**This will crash on `this.resolve(pr.ref)` when `pr.ref` is `undefined` because `ref.filePath` on undefined throws TypeError.**

### SEAM-2: `frameBounds` vs `animateCamera` -- conflicting camera behaviors

In `TourSequencer._animateToStep()` (line 261-298):
- If `step.cameraTarget` exists: calls `animateCamera` (smooth animated transition)
- Otherwise: calls `frameBounds` (instant snap, no animation)

The `frameBounds` helper (spatialHelpers.js line 232) does `ctx.camera.position.set(...)` immediately -- no animation. So auto-framed steps will snap the camera while explicit-target steps animate smoothly. This is inconsistent UX. The design called for animated transitions in both cases.

### SEAM-3: TourAnnotator.apply() returns annotation IDs but not highlight tracking

`apply()` returns `string[]` of annotation label IDs (line 36). But highlight tracking is stored internally in `_stepHighlights` (line 71). When `_teardownStep` is called, it:
1. Calls `removeHighlights(step.id)` -- uses internal map
2. Calls `remove(step.annotations)` -- uses returned IDs

This split works but means the caller can't independently query or manipulate highlights. If a step is re-applied (e.g., goto same step twice), `apply()` overwrites `_stepHighlights[step.id]` without first clearing the previous highlights. The old highlights stay on screen.

**Concrete scenario:** `goto(2)` -> `goto(2)` again. First call: `_teardownStep` is called for the *previous* step (if any), then step 2's highlights are applied. Second call: `_teardownStep` is called for step 2, clearing its highlights. Then step 2's highlights are re-applied. `_stepHighlights.set(step.id, highlights)` is called again. This actually works because `goto()` tears down before re-applying. However, if `apply()` is called directly without teardown (not via goto), highlights accumulate.

### SEAM-4: `ctx.getGrids()` vs `ctx.registry.findByType('grid')` -- two different grid lists

`tourCommands.js` uses `getSequencer(ctx)` which creates `TourResolver(ctx.registry)`. The resolver uses `this._registry.findByType('grid')` to search grids.

Meanwhile, other command handlers use `ctx.getGrids()` which calls `registry.toArray('grid')`. These return different shapes: `findByType` returns `RegistryEntry[]` (with `.grid`, `.meta`, `.id`), while `toArray` returns `Object[]` (just grid instances).

The resolver correctly uses `findByType` and accesses `.meta.sourcePath`. But if grids are registered without `sourcePath` in meta (e.g., dynamically created grids), the resolver falls back to `entry.meta.filename` then `entry.id`. This fallback chain is reasonable but the inconsistency between grid access patterns across the codebase means a grid visible to commands might be invisible to the resolver if registered with a non-standard type.

---

## What Works Well

1. **Coordinate conversion is centralized.** The 1-based to 0-based conversion happens exactly once, in `TourResolver._makeResolved()` (line 142-153). Every downstream consumer (annotator, sequencer) uses 0-based coordinates without re-converting. This was the design's most important invariant and it's correctly implemented.

2. **The dedup strategy in `parseAuto`** is clean and correct for the common case. Running all three parsers and deduplicating by `(sourceLineIndex, filePath, line, col)` with priority ordering (stack > log > file-ref) means the most specific parser wins. The sort by sourceLineIndex preserves document order.

3. **ConnectionRenderer's slot-based buffer management** is well-designed. The free-list allocator (`_slotFree`), partial GPU uploads via `addUpdateRange`, and frustum-aware visibility toggling (`refreshVisibility`) are GPU-efficient patterns. One draw call for all connections is the right architecture.

4. **TourResolver's confidence-based matching** with the exact > suffix > basename fallback chain is pragmatic. The confidence scores (1.0 / 0.5-0.9 / 0.2-0.4) give downstream code a way to warn about ambiguous matches without refusing to operate.

5. **The helpers injection pattern** in TourSequencer (line 52-55) keeps the `src/services/` layer free of `app/` imports. Camera animation, bounds computation, and anchor resolution are injected as a plain object of functions. This preserves the layering discipline.

6. **Guard against null filePath** in TourResolver.resolve() (line 34) correctly handles the parseLogLine case where timestamp-only log lines emit refs with null filePath. The resolver returns `matchType: 'none'` and the annotator skips them (line 42: `if (!resolved.grid) continue`).

7. **Stack trace parser's Go function name peek** (parseStackTrace.js lines 81-85) is a nice touch -- Go stack traces put the function name on the line *above* the file:line reference, so peeking backward is correct.

8. **Idempotent `ConnectionRenderer.set()`** -- calling set with the same id updates the existing connection in-place rather than leaking a slot. The slot reuse logic (line 87-96) is correct.
