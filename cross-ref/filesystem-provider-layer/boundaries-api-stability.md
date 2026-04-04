# CodeGrid API Surface: Consumer Audit & Stability Analysis

Agent: api-stability | Focus: what consumers depend on, what contracts must hold

---

## 1. Complete External API Surface

Every property and method of CodeGrid accessed by code outside `CodeGrid.js` itself, with exact file:line references.

### 1.1 Direct Property Reads (Public Fields)

| Property | Consumers | Classification |
|---|---|---|
| `grid.content` | HeatmapProvider:72 (`grid.content.length`) | **Abstractable** |
| `grid.lines` | highlightCommands:211,217,218 (length check, iteration, text read); TourAnnotator:143,144,145 (same pattern); ViewerCameraController:412 (`grid.lines.length`) | **Must abstract** |
| `grid.filename` | GitHubRepoViewer:1447,1451 (display); AgentWindowManager:146,476 (identity match); gridCommands:140 (direct write); layout managers via `grid.filename` fallback | **Abstractable** |
| `grid.sourcePath` | AgentWindowManager:146,476 (identity match fallback) | **Abstractable** (getter exists) |
| `grid.userData` | GitHubRepoViewer:746,980,983,1108,1185; highlightCommands:103,137,187,285; HeatmapProvider:68; CodeColorManager:94; all layout managers (sourcePath, layoutHint) | **Stable (Three.js convention)** |
| `grid.name` | GitHubRepoViewer:980; gridCommands:150; layout managers | **Stable (Three.js Object3D)** |
| `grid.metrics` | Not accessed externally | **Internal** |
| `grid._lineSlotBase` | Not accessed externally | **Internal** |
| `grid._collection` | Not accessed externally (accessed via `getCollection()`) | **Internal** |

### 1.2 Direct Property Writes

| Write | Location | Risk |
|---|---|---|
| `grid.filename = name` | gridCommands:140 | **Breaking** -- bypasses `setFilenameLabel()`, must migrate to setter/method |
| `grid.userData.sourcePath = path` | GitHubRepoViewer:1108 | Safe (Three.js userData is a user bag, not CodeGrid's own property) |
| `grid.userData.layoutHint = ...` | GridLayoutManager:194,201,487 | Safe (same reason) |

### 1.3 Method Calls

| Method | Consumer Files | Call Count | Classification |
|---|---|---|---|
| `getCollection()` | GitHubRepoViewer:1105; DiffController:283; CodeColorManager:182; gridCommands:98; agentLayoutCommands:195,251,331; gridVisualState:49; annotationCommands:183 | ~10 | **Stable** (primary escape hatch to renderer) |
| `getGlyphCount()` | IDEShell:802; GitHubRepoViewer:1631; systemCommands:50; sceneCommands:15; agentLayoutCommands:389,400; gridCommands:149,150,180,181 | ~10 | **Stable** |
| `getLineCount()` | HeatmapProvider:71; gridCommands:149,150,180,181 | ~6 | **Stable** |
| `getMaxLineWidth()` | HeatmapProvider (comment at :11) | ~1 | **Stable** |
| `getFilename()` | searchCommands:19; selectCommands (multiple); gridCommands:160; navigationCommands:336; compositionCommands:175,258,398; annotationCommands:302 | ~10 | **Stable** |
| `getSourcePath()` | searchCommands:19; selectCommands:19,26,45,52 | ~5 | **Stable** |
| `setSourcePath()` | Not called externally (viewer uses `userData.sourcePath` instead) | 0 | **Dead code candidate** |
| `getBounds()` | spatialHelpers:90,104; TourAnnotator:126; ViewerCameraController:403; MinimapOverlay:92,126; GridLayoutManager:68,186,260,295,564; agentLayoutCommands:58; annotationCommands:285; TreemapLabelManager:171 | ~15 | **Stable** |
| `getContentBounds()` | Not called externally | 0 | **Internal** |
| `loadText(text)` | gridCommands:142,178; annotationCommands:61,353; TourAnnotator:123 | ~5 | **Stable** |
| `loadFileAsync(filename, content)` | GitHubRepoViewer:1107 | 1 | **Stable** |
| `loadFile(filename, content)` | TUIWindow:409 | 1 | **Stable** |
| `loadTextAsync(text)` | Not called externally | 0 | **Internal** |
| `highlightRange(...)` | highlightCommands:100,133,181,239; TourAnnotator:55,165 | ~6 | **Stable** |
| `clearLineHighlight(line)` | highlightCommands:295; TourAnnotator:103 | ~2 | **Stable** |
| `clearAllHighlights()` | highlightCommands:267,283 | ~2 | **Stable** |
| `getSlotForChar(line, col)` | highlightCommands:95 | 1 | **Stable** |
| `getVisibleCharCount(line)` | highlightCommands:179; TourAnnotator:53 | ~2 | **Stable** |
| `dispose()` | GitHubRepoViewer:1116; navigationCommands:106; annotationCommands:103,383,408,427; terminalCommands:201; TourAnnotator:86 | ~7 | **Stable** |
| `clear()` | Not called externally | 0 | **Internal** |

---

## 2. Raw Content Access Patterns (The Critical Issue)

Two properties are accessed as raw data by consumers: `grid.content` and `grid.lines`. These are the fields that would break if the internal buffer changed from a flat string.

### 2.1 `grid.content` (string)

Only one external reader: `HeatmapProvider:72` reads `grid.content.length` for file size metrics. This is trivially replaced by a `getContentLength()` method or `grid.getContent().length`.

**Impact of `grid.getContent()` returning a string:** Zero breakage if the method exists alongside the property during migration. HeatmapProvider would need a one-line change.

### 2.2 `grid.lines` (string array)

This is the high-risk surface. Three consumers read it as a raw array:

1. **highlightCommands.js (highlight.token)** -- lines 211-239: checks `grid.lines.length`, iterates with `for` loop, reads `grid.lines[lineIdx]` for `indexOf` token search. Pattern: sequential scan of all lines for substring matching.

2. **TourAnnotator.js (_highlightToken)** -- lines 143-165: identical pattern. Checks `.length`, iterates, reads line text, does `indexOf`.

3. **ViewerCameraController.js** -- line 412: reads `grid.lines.length` for line count (could use `getLineCount()`).

**Impact of `grid.getLine(n)` / `grid.getLineCount()`:** The iteration patterns in highlight and tour would change from:
```js
for (let i = 0; i < grid.lines.length; i++) {
    const lineText = grid.lines[i];
```
to:
```js
for (let i = 0; i < grid.getLineCount(); i++) {
    const lineText = grid.getLine(i);
```

This is mechanical. The ViewerCameraController already has `getLineCount()` available.

**Key observation:** Both highlight.token and TourAnnotator._highlightToken perform the same token-search-and-highlight logic. This duplicated pattern should become a CodeGrid method: `grid.highlightToken(pattern, color)` -- which would internalize the line iteration entirely and make both consumers buffer-agnostic.

---

## 3. FileSystemProvider Interface: Already Buffer-Agnostic

Yes. The provider deals in strings over the wire:
- `readFile(uri)` returns `FileContent { content: string }`
- `writeFile(uri, content: string)` accepts a string
- `applyEdits(uri, EditBatch)` uses `TextEdit { range, newText }` -- position-based, not buffer-dependent

The provider layer never touches CodeGrid internals. It produces strings that CodeGrid consumes. The internal representation (flat string, piece table, CRDT) is invisible to providers.

---

## 4. Picking System: Buffer-Agnostic After Resolution

The picking pipeline: `pickingId` -> `PickingSystem.resolve()` -> `{ renderer, slotIndex }` -> `PickingSystem.resolveGlyph()` -> `{ textId, charIndex }`.

`slotIndex` is a buffer position, not a string offset. Nothing downstream of `resolve()` reads `grid.content` or `grid.lines`. The slot-to-position mapping (`_lineSlotBase`, `getSlotForChar`) is internal to CodeGrid and rebuilt on every flush. A piece table or rope would just produce different `lineSlotOffsets` in the builder -- the public API (`getSlotForChar`, `getVisibleCharCount`) stays identical.

**Verdict:** Picking is already buffer-agnostic.

---

## 5. Package Exports Impact

From `src/index.js:17` and `src/collections/index.js:3`: `CodeGrid` is exported as a default export.

Adding new methods to CodeGrid changes nothing in exports. The class is the export -- its API surface is what matters, not the export shape. No re-export changes needed.

If `grid.content` and `grid.lines` become methods, consumers importing CodeGrid get the new API automatically. The only question is backward compatibility during the transition.

---

## 6. Backward Compatibility Strategy: Deprecation via Getter

JavaScript allows defining getters on existing property names. This enables a non-breaking migration:

```js
// Phase 1: Add getters that wrap internal representation
get content() { return this._buffer.toString(); }
get lines()   { return this._buffer.getLines(); } // returns string[]

// New position-based API alongside
getContent()      { return this._buffer.toString(); }
getLine(n)        { return this._buffer.getLine(n); }
getLineCount()    { /* already exists */ }
```

**This means zero breakage.** `grid.content` and `grid.lines` continue to work via getters. The getters materialize strings on demand from whatever internal buffer is in use. Consumers can migrate to position-based methods at their own pace.

The only breaking case is `grid.filename = name` (gridCommands:140), which directly writes the property. If `filename` becomes a getter/setter pair, the setter can call the internal update logic -- again, no breakage.

---

## 7. Recommended API Tiers

### Tier 1: Stable (must not change signatures)
- `loadText(text)`, `loadFile(filename, content)`, `loadFileAsync(...)`, `loadTextAsync(...)`
- `getCollection()`, `getBounds()`, `getGlyphCount()`, `getLineCount()`, `getMaxLineWidth()`
- `getFilename()`, `getSourcePath()`, `setSourcePath(path)`
- `highlightRange(startLine, startCol, endLine, endCol, color)`
- `clearLineHighlight(line)`, `clearAllHighlights()`
- `getSlotForChar(line, col)`, `getVisibleCharCount(line)`
- `dispose()`

### Tier 2: Abstract with backward-compatible getters
- `content` -> getter that materializes string from internal buffer
- `lines` -> getter that materializes string[] from internal buffer
- `filename` -> getter/setter pair (setter calls `setFilenameLabel` internally)

### Tier 3: New position-based API (add alongside existing)
- `getContent()` -- explicit method, same as getter but signals intent
- `getLine(n)` -- single line without materializing the full array
- `highlightToken(pattern, color)` -- internalizes the duplicated token-search pattern from highlightCommands and TourAnnotator
- `uri` field (new, for provider identity)
- `_version` field (new, internal)

### Tier 4: Internal (no external access, free to change)
- `_collection`, `_lineSlotBase`, `_contentTextIds`, `_filenameTextId`
- `_buildLineSlotBase()`, `_getContentItemMeta()`
- `_layoutContent()`, `_layoutContentAsync()`, `_clearContent()`
- `metrics` (not accessed externally)

---

## 8. Summary

The API surface is narrow and well-defined. Only two properties (`content`, `lines`) need abstraction for buffer-agnostic internals, and both can be handled with backward-compatible getters that materialize strings on demand. The provider layer is already buffer-agnostic by design. The picking system is already buffer-agnostic. The only truly duplicated consumer pattern (token search + highlight) should become a first-class CodeGrid method. One direct property write (`grid.filename = name`) needs a setter. No clean break required -- deprecation via getters gives a smooth migration path.
