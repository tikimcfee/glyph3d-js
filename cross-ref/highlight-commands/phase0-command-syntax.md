# Phase 0: Glyph-Level Highlight Command Syntax

## Conventions Inherited from Existing Commands

- Commands register via `router.register('name', (args, ctx) => ...)`.
- Grids are resolved by path suffix or numeric index (see `resolveGridByIdOrIndex`).
- Colors are `r g b` floats in 0-1 range, appended as trailing optional args.
- Return shape: `{ text: 'OK: ...' | 'ERR: ...', data: {...} }`.
- Highlighting uses **additive color** (`instanceAddedColor`), not base color replacement.

## Addressing Model

### The problem

CodeGrid stores content in two modes:
1. **Sync path** (`loadText`): one `addText` call per non-empty line. `_contentTextIds[i]` maps to line `i`.
2. **Async path** (`loadTextAsync`): entire file as a single `addText` call. One textId, all lines concatenated.

Both paths end up as glyph entries in `GlyphRenderer.renderedTexts`, each with `bufferStartIndex` and `glyphs[]`.

### Resolution: file + line + column

The user-facing address is `(grid, line, col)` -- the same coordinate system every editor uses. The command layer resolves this to buffer slot indices internally:

```
grid  -->  resolveGridByIdOrIndex(ctx, arg)  -->  CodeGrid
line  -->  CodeGrid._contentTextIds[line]     -->  textId in renderer
col   -->  renderer.renderedTexts.get(textId).bufferStartIndex + col  -->  slot index
```

For the async single-text-entry path, the command layer walks the entry's glyph array to find line boundaries by scanning for position-Y discontinuities.

Users never see buffer slot indices. They never need to.

## Commands

### highlight.glyph

Highlight a single character.

```
highlight.glyph <grid> <line> <col> [r g b]
```

- `grid`: path suffix or numeric index
- `line`: 0-based line number
- `col`: 0-based column number
- `r g b`: additive color (default: `0.3 0.8 1.0`, a bright blue)

Returns: `{ grid, line, col, slotIndex }`.

### highlight.range

Highlight a contiguous range of characters within a single line.

```
highlight.range <grid> <line> <colStart> <colEnd> [r g b]
```

- `colEnd` is exclusive (matches `String.slice` semantics).
- Omitting `colEnd` highlights to end of line.

Returns: `{ grid, line, colStart, colEnd, count }`.

### highlight.lines

Highlight one or more full lines.

```
highlight.lines <grid> <lineStart> [lineEnd] [r g b]
```

- Single line: `highlight.lines src/index.js 5`
- Range: `highlight.lines src/index.js 5 12`
- `lineEnd` is inclusive. If omitted, highlights only `lineStart`.
- Color args follow the last numeric arg.

Returns: `{ grid, lineStart, lineEnd, glyphCount }`.

### highlight.token

Highlight all occurrences of a text pattern on a specific line, or across the whole grid.

```
highlight.token <grid> <pattern> [--line <n>] [r g b]
```

- `pattern`: literal string (not regex). Matched case-sensitively against glyph content.
- `--line <n>`: restrict to a single line. Without it, highlights every occurrence in the grid.
- Color args are positional after the last flag.

Returns: `{ grid, pattern, matches: [{ line, colStart, colEnd }], count }`.

### highlight.clear

Remove highlights. Three modes:

```
highlight.clear                          # clear ALL glyph highlights everywhere
highlight.clear <grid>                   # clear all glyph highlights on one grid
highlight.clear <grid> <line>            # clear highlights on one line
```

Clearing writes `{0, 0, 0}` back into `instanceAddedColor` for affected slots.

Returns: `{ cleared: <count>, scope: 'all' | 'grid' | 'line' }`.

### highlight.list

Show active highlights (for debugging / agent state inspection).

```
highlight.list [grid]
```

Returns a summary table: grid, line range, color, glyph count per active highlight group.

## Color Handling

### Positional RGB (primary path)

All commands accept trailing `r g b` floats (0-1 range), matching `highlight.grid`, `label.create`, and `scene.annotate`.

### Named color presets

If a single non-numeric color arg is provided where `r g b` would go, it resolves via a preset map:

| Name      | RGB             | Use case            |
|-----------|-----------------|---------------------|
| `blue`    | 0.3 0.8 1.0    | Default highlight   |
| `green`   | 0.2 1.0 0.4    | Correct / added     |
| `red`     | 1.0 0.3 0.3    | Error / removed     |
| `yellow`  | 1.0 0.9 0.2    | Warning / attention |
| `orange`  | 1.0 0.6 0.1    | Secondary attention |
| `purple`  | 0.7 0.3 1.0    | Decoration          |
| `cyan`    | 0.2 1.0 1.0    | Match (search)      |
| `white`   | 0.6 0.6 0.6    | Subtle emphasis     |

This is a convenience layer. The positional `r g b` path takes priority and supports arbitrary colors.

### Stacking behavior

Highlights **replace** on the same slot. The last `setGlyphHighlight` call wins. This is correct for the additive color model -- stacking would cause color blowout. `highlight.clear` resets to `{0, 0, 0}` (no additive contribution).

The command layer tracks active highlights in `ctx.glyphHighlights` (a Map keyed by `gridId:line:col` or a range key), so `highlight.clear` and `highlight.list` can enumerate them without scanning every buffer slot.

## Tour Commands

Tours are sequenced highlight steps with optional camera movement and narration. An agent builds a tour as a series of steps, then plays them.

### tour.define

```
tour.define <tour-id>
```

Creates an empty tour. Returns: `{ tourId }`.

### tour.step

```
tour.step <tour-id> <base64-json>
```

Appends a step. The base64-encoded JSON payload:

```json
{
  "highlight": { "grid": "src/index.js", "lines": [10, 15], "color": "green" },
  "camera": { "x": 0, "y": -10, "z": 50, "duration": 800 },
  "narration": "This section initializes the atlas.",
  "duration": 3000
}
```

All fields optional. `highlight` can be any of the highlight command shapes (`glyph`, `range`, `lines`, `token`). `camera` triggers `camera.animate`. `narration` creates a temporary `scene.annotate` near the highlighted grid. `duration` is how long the step holds before auto-advancing.

Returns: `{ tourId, stepIndex }`.

### tour.play

```
tour.play <tour-id> [--speed <multiplier>]
```

Plays the tour. Each step: clears previous highlights, applies new highlights, moves camera, shows narration. Steps auto-advance after their `duration` (scaled by `--speed`, default 1.0).

Returns immediately: `{ tourId, stepCount, status: 'playing' }`.

### tour.stop

```
tour.stop [tour-id]
```

Stops playback. Clears highlights and narration from the current step. Without `tour-id`, stops whatever tour is currently playing.

### tour.next / tour.prev

```
tour.next [tour-id]
tour.prev [tour-id]
```

Manual step navigation. Pauses auto-advance.

## Registration

All commands register in a new `highlightCommands.js` module, added to `handlers/index.js`:

```js
import registerHighlightCommands from './highlightCommands.js';
// in registerAllCommands():
registerHighlightCommands(router);
```

Tour commands register in a separate `tourCommands.js` module -- they compose highlight commands but have distinct lifecycle concerns.

## Context Requirements

Commands need these on `ctx`:

| Key                    | Type                | Purpose                           |
|------------------------|---------------------|-----------------------------------|
| `ctx.glyphHighlights`  | `Map<string, entry>`| Track active highlights for clear/list |
| `ctx.tours`            | `Map<string, Tour>` | Tour definitions and playback state |
| `ctx.activeTour`       | `string \| null`    | Currently playing tour ID         |

These are initialized by the command module's registration function (same pattern as `ctx.windowTracking` in orchestrationCommands.js).

## Examples

```bash
# Highlight line 42 of a file in default blue
highlight.lines src/GlyphRenderer.js 42

# Highlight columns 4-15 on line 10 in green
highlight.range src/GlyphRenderer.js 10 4 15 green

# Highlight all occurrences of "flush" in a file in yellow
highlight.token 3 flush yellow

# Highlight a single character
highlight.glyph src/index.js 0 0 1.0 0.0 0.0

# Clear just one file's highlights
highlight.clear src/GlyphRenderer.js

# Build a tour
tour.define arch-overview
tour.step arch-overview eyJoaWdobGlnaHQi...   # base64 JSON step
tour.step arch-overview eyJoaWdobGlnaHQi...
tour.play arch-overview --speed 1.5

# Manual stepping
tour.next arch-overview
tour.prev arch-overview
tour.stop
```
