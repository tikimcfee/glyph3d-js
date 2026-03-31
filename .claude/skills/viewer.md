---
name: viewer
description: Interact with the glyph3d-js 3D code viewer — frame files, take screenshots, highlight code, run tours, manage windows.
user_invocable: true
---

# 3D Viewer Interaction Skill

Control the glyph3d-js 3D code viewer via WebSocket commands through the Go CLI.

## Setup

```
CLI=/home/user/dev/glyph3d-js/cli/glyph3d-cli
```

All commands below use pipe mode for reliability (one connection, sequential execution):

```bash
printf 'command1\ncommand2\n' | $CLI --timeout 8s 2>/dev/null
```

## Readability Settings

The camera Z distance controls zoom. After `camera.frame <file>`, the Z value determines readability:

| Z distance | View | Use for |
|-----------|------|---------|
| ~120 | Full file visible | Overview, seeing file structure |
| ~60 | Half file, glyphs readable | Reading code, verifying highlights |
| ~30 | Quarter file, large glyphs | Detail inspection, showing specific functions |

**To frame a file at readable zoom:**
```bash
printf 'camera.frame <file-path>\n' | $CLI --timeout 5s 2>/dev/null
# Then halve the Z to get readable:
printf 'camera.info\n' | $CLI --timeout 3s 2>/dev/null
# Take the Z value, halve it:
printf 'camera.move <x> <y> <z/2>\n' | $CLI --timeout 3s 2>/dev/null
```

## Screenshot

Capture what the viewer shows and view it:
```bash
$CLI screenshot -o /tmp/glyph-screenshot.png 2>&1
```
Then use the Read tool on `/tmp/glyph-screenshot.png` to see the image.

## Core Commands Reference

### Camera
- `camera.frame <file-path-or-index>` — fit file in view
- `camera.move <x> <y> <z>` — set camera position
- `camera.info` — get current position/rotation/fov

### Highlights
- `highlight.lines <file> <startLine> <endLine> [r g b]` — highlight line range
- `highlight.range <file> <line> <colStart> <colEnd> [r g b]` — highlight columns
- `highlight.token <file> <text> [r g b]` — highlight all occurrences of text
- `highlight.clear [file]` — clear highlights

### Tour System
- `tour.show <base64-text>` — one-shot: parse text, highlight all refs, draw arrows, frame camera
- `tour.load <base64-json>` — load structured tour with steps
- `tour.next` / `tour.prev` / `tour.goto <n>` — navigate steps
- `tour.clear` — remove all tour visuals
- `tour.status` — current state

Tour JSON format (auto base64-encoded by CLI):
```json
{"steps":[{"title":"...","refs":[{"filePath":"src/foo.js","line":10,"endLine":25}]}]}
```

### Windows
- `window.create <id> <cols> <rows> <title>` — create TUI window
- `window.append <id> <base64-text>` — append text
- `window.write <id> <base64-text>` — replace content
- `window.move <id> <x> <y> <z>` — position in 3D
- `window.scale <id> <factor>` — scale
- `window.close <id>` — remove
- `window.list` — list all windows

### Scene
- `grid.list` — list all loaded grids (files)
- `reload` — hard-refresh the browser page
- `screenshot` — capture canvas to PNG

### Connection Arrows
Arrows are drawn automatically between sequential refs in tour steps. For manual control:
- Arrows connect from the trailing (right) edge of one grid to the leading (left) edge of the next
- Connection lines use a single draw call (ConnectionRenderer) regardless of count

## Workflow: Verify Visual Changes

1. Make a code change
2. `reload` — refresh browser
3. Wait for repo to load (~5-8s)
4. `camera.frame <file>` — navigate to the file
5. `screenshot` — capture
6. Read the screenshot to verify

## Workflow: Highlight and Show

1. `highlight.lines src/foo.js 10 25 0.3 0.8 1.0` — blue highlight
2. `camera.frame src/foo.js` — frame the file
3. Halve Z distance for readability
4. `screenshot` — verify

## Named Colors (0-1 float RGB)

| Name | R | G | B |
|------|---|---|---|
| Blue | 0.3 | 0.8 | 1.0 |
| Green | 0.2 | 1.0 | 0.4 |
| Red | 1.0 | 0.3 | 0.3 |
| Yellow | 1.0 | 0.9 | 0.2 |
| Purple | 0.7 | 0.3 | 1.0 |
| Cyan | 0.0 | 1.0 | 0.8 |

## Hook Log

The PostToolUse hook logs all Claude tool calls to `/tmp/glyph-hook.log`. Read this file to diagnose hook issues.
