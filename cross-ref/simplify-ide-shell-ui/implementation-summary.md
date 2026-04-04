# IDE Shell UI Simplification -- Implementation Summary

All 22 changes from `round3-layout-convergence.md` have been applied across 3 files.

## Files Modified

### `app/ide.html` (3 changes)

| # | Change | Details |
|---|--------|---------|
| 1 | viewport-fit=cover | Added to meta viewport tag for notched device support |
| 2 | Remove redundant resize listener | Deleted `window.addEventListener('resize', ...)` block (lines 329-335). The ResizeObserver on `#editor-area` already handles this; the listener caused double-firing. |
| 13 | Move #sidebar-resize inside #sidebar | Moved from a sibling of `#sidebar` (grid column) to the last child of `#sidebar` (absolutely positioned). |

### `app/ide.css` (12 changes)

| # | Change | Details |
|---|--------|---------|
| 3 | touch-action on html/body | Changed from `none` to `manipulation`. Unblocks sidebar scrolling on tablets while still disabling double-tap-zoom. |
| 4 | 100dvh at root | Added `height: 100dvh` after `height: 100vh` on `#ide-shell` for dynamic viewport height on mobile. |
| 5 | 3-column grid | Dropped the `var(--resize-handle)` 4th column. Grid is now 3 columns: activitybar / sidebar / 1fr. Template areas updated. |
| 5b | #sidebar-resize inset | Restyled from `grid-area: resize-s` to `position: absolute; top: 0; right: -2px; width: 4px; height: 100%; z-index: 5`. Added `position: relative` to `#sidebar`. |
| 6 | Variable-driven collapse | Replaced `grid-template-columns` override and `display: none` with `overflow: hidden; border-right: none`. Grid column collapses via `--sidebar-width: 0px` set in JS. |
| 7 | min-height: 0 on #sidebar-content | Ensures flex child can shrink below content size so `overflow-y: auto` activates in all browsers. |
| 8 | Compound breakpoint | Media query expanded to `(max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))`. |
| 9 | Remove mobile touch-action override | Deleted the `html, body { touch-action: auto; }` block inside the media query. Root `manipulation` handles it. |
| 10 | Fix sidebar overlay bottom offset | Changed `bottom: 48px` to `bottom: calc(var(--activitybar-width, 48px) + var(--statusbar-height, 22px))` on both `#sidebar` and `#sidebar-backdrop`. |
| 11 | Simplify sidebar transform rules | Removed `display: flex` from the collapsed/not-collapsed overrides. `display: flex` is now always on since collapse no longer uses `display: none`. |
| 12 | Safe-area insets | Added `padding-bottom: env(safe-area-inset-bottom, 0px)` to `#activity-bar` and `#status-bar` inside the compact media query. |

Note: The plan specified `.status-bar` (class) for change 12, but the actual element is `<footer id="status-bar">`. Corrected to `#status-bar`.

### `app/IDEShell.js` (9 changes)

| # | Change | Details |
|---|--------|---------|
| 14 | Compound matchMedia | Updated to match the CSS compound breakpoint exactly. |
| 15 | Variable-driven collapse/expand | `_collapseSidebar()` sets `--sidebar-width: 0px`. `_expandSidebar()` restores to `_lastSidebarWidth`. |
| 16 | Viewport-aware sidebar resize clamp | `Math.min(600, window.innerWidth - 300)` ensures editor gets at least 300px. |
| 17 | Viewport-aware bottom panel resize clamp | `Math.min(600, window.innerHeight - 300)` ensures editor gets at least 300px vertically. |
| 18 | Touch events on sidebar resize | Added `touchstart`/`touchmove`/`touchend` with single-touch guard, passive:false, and same viewport-aware clamp. |
| 19 | Touch events on bottom panel resize | Same pattern as sidebar touch events, applied to `#panel-resize`. |
| 20 | Sidebar swipe-to-dismiss | New `_wireSidebarSwipeDismiss()` method. Horizontal threshold: `dx > 60 && dx > dy * 2`. All listeners passive. Wired in constructor after `_wireSidebarBackdrop()`. |
| 21 | Track _lastSidebarWidth | Initialized to 280 in constructor. Updated in both mouse and touch sidebar resize handlers. |
| 22 | rAF debounce on ResizeObserver | `_resizePending` flag prevents multiple `_onEditorResize()` calls per frame. |

## Deferred (not in this changeset)

- **Component tokens** (--surface-0..5, .g-btn, .g-scroll) -- separate workstream
- **Panel JS files** (Drawer.js, DiffPanel.js, InstallerPanel.js, LogCapturePanel.js) -- no modifications
- **CommandBar.js injected styles** -- move to ide.css in follow-up
- **src/ files** -- no rendering pipeline changes needed
