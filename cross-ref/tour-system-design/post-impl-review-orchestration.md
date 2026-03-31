# Post-Implementation Review: Orchestration

## Bugs Found

### BUG-1: `_highlightToken` uses raw string positions instead of visible-char indices (TourAnnotator.js:135-145)

`_highlightToken` calls `line.indexOf(token, pos)` which returns raw string positions (including whitespace characters), then passes them directly to `grid.highlightRange()`. However, `highlightRange` (CodeGrid.js:595-597) expects visible-char indices -- the buffer only contains non-whitespace characters, and column indices index into that compacted space.

The existing `highlight.token` command in `highlightCommands.js:224-236` handles this correctly by manually counting visible characters before the match position. The tour annotator does not.

**Concrete example:** Line content is `"    const x = 5;"`. Searching for token `"const"`:
- `indexOf("const")` returns 4 (raw position after 4 spaces)
- `highlightRange(lineIdx, 4, lineIdx, 9, color)` is called
- But in visible-char space, "const" starts at index 0 (spaces are stripped)
- Result: the wrong 5 characters get highlighted (probably `"x = 5"` instead of `"const"`)

**Fix:** Port the visible-char conversion from `highlightCommands.js:224-236` into `_highlightToken`, or extract it as a shared utility.

### BUG-2: Tour JSON format has no validation and crashes on bare FileRef objects (tourCommands.js:63-84, TourResolver.js:68-73)

When `tour.load` parses JSON, the resulting `data` is passed directly to `seq.load(data)`. The `TourStepInput.refs` field must contain `ParsedRef`-shaped objects (with a `.ref` sub-object), because `resolveAll` does `pr.ref` on each element.

If a user passes this JSON:
```json
{"steps": [{"refs": [{"filePath": "foo.js", "line": 10}]}]}
```

Then `pr` is `{filePath: "foo.js", line: 10}`, `pr.ref` is `undefined`, and `this.resolve(undefined)` crashes at TourResolver.js:34 accessing `ref.filePath` on undefined.

The expected format would be:
```json
{"steps": [{"refs": [{"ref": {"filePath": "foo.js", "line": 10}, "kind": "file-ref", "rawText": "", "sourceLineIndex": 0}]}]}
```

This is not documented anywhere. No validation exists at the boundary. The JSON-to-internal-type contract is implicit.

**Fix:** Either validate/normalize in `tour.load` (detect bare FileRef objects and wrap them), or document the required format prominently.

### BUG-3: `next()` re-applies the same step when already at the last step (TourSequencer.js:154-157)

```js
async next() {
    const target = this.state === 'loaded' ? 0 : this.stepIndex + 1;
    return this.goto(Math.min(target, this.steps.length - 1));
}
```

When `stepIndex === steps.length - 1` (last step), `target` becomes `steps.length`, clamped back to `steps.length - 1`. `goto()` tears down the current step and re-applies it. This causes:
1. Unnecessary GPU work (clearing and re-writing highlights)
2. Visual flicker (highlights disappear and reappear in the same frame batch)
3. Unnecessary camera re-animation to the same position

Similarly, `prev()` re-applies step 0 when already at step 0.

**Fix:** Early-return in `goto()` if `index === this.stepIndex && this.state === 'active'`, or guard in `next()`/`prev()`.

## State Machine Issues

### SM-1: `prev()` from `loaded` state navigates to step 0 via fragile `||` operator (TourSequencer.js:160-162)

```js
async prev() {
    return this.goto(Math.max((this.stepIndex || 0) - 1, 0));
}
```

When `state === 'loaded'`, `stepIndex` is -1. The expression `this.stepIndex || 0` evaluates `-1 || 0` which gives -1 (because -1 is truthy). Then `Math.max(-1 - 1, 0)` = 0. So `goto(0)` is called, which works by accident.

The `||` operator was clearly intended as null-coalescing (`??`), but the negative value makes it behave differently than expected. If `stepIndex` were ever changed to be `null` or `undefined` instead of -1, this would break.

Compare with `next()` which explicitly handles the `loaded` state:
```js
const target = this.state === 'loaded' ? 0 : this.stepIndex + 1;
```

`prev()` should mirror this pattern.

### SM-2: No guard against calling `next()`/`prev()` on a zero-step tour (TourSequencer.js:154-161)

If a tour is loaded with `steps: []` (empty array), `this.steps.length` is 0, and `steps.length - 1` is -1. `goto(-1)` throws `"Step -1 out of range (0--1)"` which is a confusing error message. The `load()` method should reject empty tours, or `next()`/`prev()` should check for zero steps.

### SM-3: Double disposal in `clear()` is safe but fragile (TourSequencer.js:167-187)

`clear()` first calls `_teardownStep(this.stepIndex)` (which removes current step's annotations via `annotator.remove()`), then calls `unregisterByType('tour-annotation')`. Both paths call `grid.dispose()` and `scene.remove(grid)`. Currently this is safe because `_teardownStep` unregisters the entries first, so `unregisterByType` finds nothing. But if `_teardownStep` is ever modified to not unregister (e.g., for undo support), the double-dispose path activates. A comment noting the intentional belt-and-suspenders pattern would help.

## Command Integration Issues

### CMD-1: Async handlers in synchronous command registration (tourCommands.js:149, 169, 189)

`tour.next`, `tour.prev`, and `tour.goto` are registered as `async` handlers. The `CommandRouter.execute()` method (CommandRouter.js:117) does `await cmd.handler(args, ctx)`, so async handlers are supported. This is correct and works.

However, `tour.load` and `tour.load.text` are synchronous, while `tour.clear` and `tour.status` are also synchronous. This mixing is fine architecturally but means callers cannot assume all tour commands are sync or all are async.

### CMD-2: `tour.status` in idle state shows misleading step count (tourCommands.js:233)

```js
text: `OK: state=${seq.state}, step=${seq.stepIndex + 1}/${seq.steps.length}`,
```

When idle: `stepIndex` is -1, `steps.length` is 0. Output: `"OK: state=idle, step=0/0"`. This is confusing -- "step 0 of 0" looks like an error. Should show "no tour loaded" or omit step info when idle.

### CMD-3: No `tour.list` or `tour.info` command to inspect step details

Once a tour is loaded, there is no way to see what steps exist, what refs they contain, or what was resolved vs unresolved per step. The only introspection is `tour.status` which shows count and current index. For debugging, a `tour.info [step-index]` command that dumps the resolved refs would be valuable.

## Data Flow Issues

### DF-1: `FileRef` has no `color`, `token`, or `label` properties (parseFileRef.js:3-10 vs TourAnnotator.js:44-66)

The `TourAnnotator.apply()` method accesses:
- `ref.color` (line 45) -- falls back to blue, so no crash
- `ref.token` (line 61) -- `undefined`, so the `if` guard prevents the call, no crash
- `ref.label` (line 66) -- `undefined`, so the `if` guard prevents the call, no crash

This means the `parseAuto` -> `tour.load.text` pathway can NEVER produce highlights with custom colors, token searches, or floating labels. These features only work with hand-crafted JSON tour data that adds these non-standard fields to the `FileRef`-like objects.

This is a design gap, not a crash bug. The auto-parsed path gets only line-range highlighting with the default blue color. For the text-parsing use case, this may be acceptable. But the fact that `ref.color`, `ref.token`, and `ref.label` are undocumented extension fields that must be injected by the JSON author is worth noting.

### DF-2: `TourResolver._findBySuffix` suffix matching is backwards (TourResolver.js:90)

```js
if (!sp || !sp.endsWith(file)) continue;
```

This checks if the registry's sourcePath ends with the query file path. For example, if `ref.filePath` is `"src/GlyphAtlas.js"` and the registry has `"full/path/to/src/GlyphAtlas.js"`, `sp.endsWith(file)` is true. This works.

But if `ref.filePath` is `"/home/user/project/src/GlyphAtlas.js"` (absolute path from a stack trace) and the registry has `"src/GlyphAtlas.js"` (relative), `"src/GlyphAtlas.js".endsWith("/home/user/project/src/GlyphAtlas.js")` is false. The longer query fails to match the shorter registry path.

The check should be bidirectional: `sp.endsWith(file) || file.endsWith(sp)`.

### DF-3: `TourAnnotator.removeHighlights` clears by line, not by the exact range that was highlighted (TourAnnotator.js:95-104)

```js
for (let line = startLine; line <= endLine; line++) {
    grid.clearLineHighlight(line);
}
```

`clearLineHighlight` (CodeGrid.js:620-628) clears ALL highlights on a line, not just the ones applied by this tour step. If another system (e.g., the `highlight.*` commands) has independently highlighted characters on the same lines, those highlights are destroyed when the tour step is torn down.

This is an inherent limitation of the highlight architecture (no highlight layers/ownership), but it's worth noting that tour teardown is destructive to non-tour highlights.

### DF-4: `_lineSlotBase` may not be populated when `highlightRange` is called (CodeGrid.js:602)

`highlightRange` silently returns if `this._lineSlotBase` is falsy. `_lineSlotBase` is built during `_buildLineSlotBase()` (CodeGrid.js:525-548), which is called after content is loaded and flushed. If a tour step references a grid that has been registered but whose content hasn't been flushed yet (e.g., async loading), highlights silently fail. No error, no warning.

### DF-5: `TourAnnotator._createLabel` accesses `resolved.grid.getBounds?.()` but `getWorldBounds` would be more correct (TourAnnotator.js:123)

`getBounds()` returns world-space bounds (CodeGrid.js:236-258) which includes the matrixWorld transform. But the label grid is positioned in scene-space coordinates (line 125: `grid.position.set(...)`). If the resolved grid is a child of a transformed parent Object3D, `getBounds()` gives world coordinates and `grid.position.set()` sets local coordinates -- the label appears in the wrong place because the label grid is added directly to the scene (line 128).

In practice, most CodeGrids are direct children of the scene, so this works. But for nested grid hierarchies, the label position would be wrong.

## What Works Well

1. **Clean state machine**: The idle/loaded/active transitions in TourSequencer are straightforward, with `load()` correctly calling `clear()` on re-entry. The states are explicit and the transitions are guarded.

2. **Single coordinate conversion point**: TourResolver._makeResolved (line 142-154) converts 1-based to 0-based coordinates in exactly one place. Downstream code never has to worry about off-by-one. This was a key design requirement and it is correctly implemented.

3. **Lazy initialization pattern**: `getSequencer(ctx)` (tourCommands.js:31-41) creates the TourSequencer and ConnectionRenderer only when first needed, and reuses them across commands. This avoids paying the GPU allocation cost for ConnectionRenderer until a tour is actually used.

4. **Resolver fallback chain**: The exact -> suffix -> basename resolution cascade in TourResolver (lines 40-59) is well-designed. Each level has decreasing confidence, and the confidence values (1.0, 0.5-0.9, 0.2-0.4) provide clear signal for downstream consumers. The basename match correctly handles ambiguity (multiple matches = lower confidence).

5. **Connection slot allocator**: ConnectionRenderer uses a slot-based approach with a free list (line 49), partial buffer uploads via `addUpdateRange` (line 256-257), and degenerate-vertex zeroing for removal (line 263-268). This is GPU-efficient and avoids buffer reallocation.

6. **parseAuto deduplication**: The `parseAuto` function (parseAuto.js:14-29) correctly deduplicates across parser outputs by composite key and preserves source order. The priority-by-parser-order (stack-frame > log-line > file-ref) is a good heuristic.

7. **Error handling in commands**: All tour commands check for argument count, validate parsed integers, catch async exceptions, and return consistent `{ text, data }` format. The error path through `seq.goto()` -> thrown Error -> caught in command handler -> `ERR:` response is clean.

8. **Idempotent `ConnectionRenderer.set()`**: Calling `set()` with the same ID replaces the connection in-place without leaking slots (line 87-104). This makes the system tolerant of redundant calls.
