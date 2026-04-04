# Stats Agent — Phase 0 Analysis and Implementation

## Target
`updateStats` consuming 7.8% of total frame time (Firefox profiler).
Related: `getStats` 4.9%, `updateStatusBar` 3.1%.

## Call Chain (before fix)

Every animation frame (60 Hz):

```
animate()
  → updateStats(deltaTime)            [GitHubRepoViewer.js:2156]
      → fpsBadge.fpsSpan.textContent  [only once per second, benign]
      → statFpsEl.textContent         [same]
      → fileCountEl.textContent       [DOM write, every frame]
      → gridCountEl.textContent       [DOM write, every frame]
      → for grid of grids:            [N iterations, every frame]
            grid.getGlyphCount()
              → GlyphCollection.getGlyphCount()
                  → GlyphRenderer.getStats()     [iterates renderedTexts Map]
      → glyphCountEl.textContent      [DOM write, every frame]
      → cameraPosEl.textContent       [DOM write + toFixed x3, every frame]
  → ide.updateStatusBar(deltaTime)    [ide.html:245, patched wrapper]
      [same glyph-count loop again, independently]
      → _statusFps.textContent        [only once per second, benign]
      → _statusGlyphCount.textContent [DOM write, every frame]
      → _statusGridCount.textContent  [DOM write, every frame]
      → _statusCamera.textContent     [DOM write + toFixed x3, every frame]
      → _statusSource.textContent     [DOM write, every frame]
      → _statusLayout.textContent     [DOM write, every frame]
      → _statusWs.textContent         [DOM write, every frame]
```

### Why this is expensive

At 1500 loaded files (`grids.length = 1500`):

- The glyph-count loop runs **twice** per frame (once in `updateStats`, once in `updateStatusBar`)
- Each call reaches `GlyphRenderer.getStats()` which iterates a `Map` of `renderedTexts` entries
- Total Map iterations per frame: up to 3000+ (two full scans over all grids)
- DOM `textContent` writes: ~10 per frame across both functions
- `toFixed()` calls: 6 per frame (camera position in each function)
- At 60 Hz that is 180,000+ Map iterations/second and 600 `textContent` writes/second for data the user reads at most a few times per second

No domain conflict observed. This code is purely in the app layer (`app/GitHubRepoViewer.js`, `app/IDEShell.js`). No overlap with grapheme segmentation, bounds computation, or eviction code.

## Fix

Added a `_statsThrottleTime` accumulator in `GitHubRepoViewer` and a `_statusBarThrottleTime` accumulator in `IDEShell`. Both are initialized to `0` alongside the existing FPS-counting state.

On each frame, the accumulator advances by `deltaTime`. If it has not yet reached `0.5` seconds, the function returns immediately after incrementing the frame counter — no DOM access, no Map iteration. When the threshold is crossed, the accumulator resets to `0` and the full update runs.

FPS computation was also corrected: the old code compared accumulated frames over a 1-second window; with a 500ms flush the window now spans however many throttle intervals have elapsed, so FPS is computed as `Math.round(frameCount / fpsTime)` to keep the displayed value accurate.

### Theoretical reduction

| Site | Before | After | Reduction |
|---|---|---|---|
| `GitHubRepoViewer.updateStats` — glyph loop | 60×/s | 2×/s | 97% |
| `GitHubRepoViewer.updateStats` — DOM writes | 60×/s | 2×/s | 97% |
| `IDEShell.updateStatusBar` — glyph loop | 60×/s | 2×/s | 97% |
| `IDEShell.updateStatusBar` — DOM writes | 60×/s | 2×/s | 97% |

Combined the three profiler buckets were 7.8 + 4.9 + 3.1 = 15.8% of frame time. After the fix, virtually all of that budget is freed: the per-frame cost is two counter increments and two float additions — unmeasurable.

## Files Changed

- `/home/user/dev/glyph3d-js/app/GitHubRepoViewer.js`
  - Added `this._statsThrottleTime = 0` in constructor (near `frameCount`/`fpsTime`)
  - `updateStats`: throttle guard at top; FPS normalised over accumulated window

- `/home/user/dev/glyph3d-js/app/IDEShell.js`
  - Added `this._statusBarThrottleTime = 0` in constructor (near `_frameCount`/`_fpsTime`)
  - `updateStatusBar`: throttle guard at top; FPS normalised over accumulated window

## No conflicts with other agents

The only code touched is DOM-update logic in the app shell. No rendering buffers, no shader code, no glyph layout, no eviction, no grapheme segmentation paths were modified.
