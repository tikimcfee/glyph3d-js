# Round 3: components convergence

## Settled

All points now fully resolved. The converged decisions below reflect consensus across all three agents after two rounds of cross-review.

1. **Orientation-aware compound breakpoint.** CSS: `@media (max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))`. JS matchMedia in `IDEShell.js:96` uses the identical compound query string. This catches phones AND portrait tablets without penalizing landscape tablets that have room for an inline sidebar. Layout proposed it, mobile conceded, components agrees -- it is strictly better than a flat 1024px cutoff.

2. **Variable-driven sidebar collapse via `--sidebar-width: 0px`.** `_collapseSidebar()` sets `--sidebar-width: 0px` on `#ide-shell`; `_expandSidebar()` restores the previous value. The `display: none` at `ide.css:93-96` and the mobile `display: flex` override at `ide.css:1091-1098` are both removed. The grid column collapses naturally, no cascade conflict, transitions work. Layout proposed it; both mobile and components endorsed it.

3. **`100vh` then `100dvh` at root level.** The `#ide-shell` rule at `ide.css:68` gets `height: 100vh; height: 100dvh;` (vh first, dvh override -- browsers that understand dvh use it, others fall back to vh). This was already correct in the mobile media query; it just needs to move to the root rule as well. Layout identified the bug; mobile confirmed the fix order; components caught layout's initially-reversed proposal.

4. **`touch-action: manipulation` on html/body, `none` only on canvas.** Replace `touch-action: none` at `ide.css:56` with `touch-action: manipulation`. Apply `touch-action: none` only to `#editor-area #canvas`. This unblocks sidebar scrolling on tablets while still preventing double-tap zoom globally and all gestures on the 3D canvas. Mobile proposed it; components and layout agree.

5. **Touch events on both resize handles.** `_wireSidebarResize()` (IDEShell.js:339-364) and `_wireBottomPanel()` (IDEShell.js:391-414) both gain `touchstart`/`touchmove`/`touchend` listeners mirroring the existing mouse event pattern. Mobile wrote the reference implementation; neither layout nor components contested it.

6. **Sidebar swipe-to-dismiss.** Mobile's `_wireSidebarSwipeDismiss()` implementation is adopted: horizontal swipe threshold (`dx > dy * 2`, minimum 60px), left-to-right direction, calls `_collapseSidebar()`. Wired after `_wireSidebarBackdrop()` in the constructor. The sidebar keeps `touch-action: manipulation` (not `pan-y`) so the horizontal gesture is not suppressed.

7. **Safe-area insets.** Add `viewport-fit=cover` to the `<meta name="viewport">` tag in `ide.html:5`. Apply `padding-bottom: env(safe-area-inset-bottom)` to the status bar and activity bar within the compact media query. Mobile proposed it; layout had no objection; components agrees it is essential for notched devices.

8. **Remove redundant window resize listener.** Delete `window.addEventListener('resize', ...)` at `ide.html:333-335`. The `ResizeObserver` on `#editor-area` already handles canvas resize. The redundant listener causes double-fire of `_onEditorResize()`. Layout identified it; components confirmed; mobile did not contest.

9. **`min-height: 0` on `#sidebar-content`.** Add `min-height: 0` to the `#sidebar-content` rule at `ide.css:208-212`. This ensures `overflow-y: auto` can activate in flex containers where the content exceeds the parent. All three agents agree, though severity assessments varied (it is low-risk, one-property fix).

10. **Viewport-aware resize clamps.** Sidebar drag max: `Math.min(600, window.innerWidth - 300)` in `_wireSidebarResize()`. Bottom panel drag max: `Math.min(600, window.innerHeight - 300)` in `_wireBottomPanel()`. CSS default for bottom panel: `--panel-height: clamp(80px, 25vh, 300px)` with `max-height: min(50vh, calc(100dvh - 300px))` as the absolute cap. Layout proposed the JS clamps; mobile proposed the CSS cap; both are needed.

11. **Component tokens deferred to follow-up PR.** The full `g-btn`/`g-input`/`g-list-item`/`g-badge`/`g-section`/`g-scroll` component library and the `--surface-*`/`--text-*`/`--sp-*` token system are not part of this PR. Keep existing semantic variable names (`--bg-sidebar`, `--bg-panel`, `--border-color`, etc.). Add missing tokens incrementally as needed (e.g., `--text-hint` for `#555`/`#666`, `--border-subtle` for `#333`). Layout recommended deferral; mobile agreed; components accepts that the layout/mobile infrastructure must stabilize first.

## Implementation Plan

### File: `ide.html`

**Modify `<meta viewport>` tag (line 5):**
```html
<!-- Before -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<!-- After -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
```

**Delete redundant resize listener (lines 333-335):**
Remove the `window.addEventListener('resize', () => { ... })` block entirely. The ResizeObserver at IDEShell.js:763-768 already covers this.

### File: `ide.css`

**1. Root touch-action (line 56):**
```css
/* Before */
html, body { touch-action: none; }
/* After */
html, body { touch-action: manipulation; }
```

**2. Root height on `#ide-shell` (line 68):**
```css
/* Before */
height: 100vh;
/* After */
height: 100vh;
height: 100dvh;
```

**3. Sidebar collapse -- replace `display: none` (lines 93-96):**
```css
/* Before */
#ide-shell.sidebar-collapsed #sidebar {
    display: none;
}
/* After -- delete this rule entirely; collapse is driven by --sidebar-width: 0px */
```
Also delete the mobile `display: flex` override at lines 1091-1098 that was counteracting the `display: none`.

**4. `#sidebar-content` flex fix (around line 208-212):**
```css
#sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    min-height: 0; /* ADD: enables flex truncation for overflow scroll */
}
```

**5. Canvas touch-action (add to existing `#editor-area` or canvas rule):**
```css
#editor-area canvas,
#editor-area #canvas {
    touch-action: none;
}
```

**6. Bottom panel default height and max-height cap:**
```css
/* Update existing --panel-height default */
--panel-height: clamp(80px, 25vh, 300px);

/* In the #bottom-panel or equivalent rule: */
#bottom-panel {
    max-height: min(50vh, calc(100dvh - 300px));
}
```

**7. Replace the mobile media query selector (line ~986):**
```css
/* Before */
@media (max-width: 768px) {
/* After */
@media (max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait)) {
```

**8. Safe-area insets inside the compact media query:**
```css
@media (max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait)) {
    #activity-bar {
        padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    #status-bar {
        padding-bottom: env(safe-area-inset-bottom, 0px);
    }
}
```

**9. Remove mobile `touch-action` override (lines ~1015-1017):**
Delete the rule that sets `touch-action: manipulation` only inside the mobile media query, since it is now the global default.

**10. Remove the mobile `display: flex` sidebar override (lines ~1091-1098):**
Delete entirely. No longer needed because sidebar collapse is variable-driven, not display-driven.

### File: `IDEShell.js`

**1. Update matchMedia query (line ~96):**
```javascript
// Before
this._mobileQuery = window.matchMedia('(max-width: 768px)');
// After
this._mobileQuery = window.matchMedia('(max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))');
```

**2. Rewrite `_collapseSidebar()` and `_expandSidebar()`:**
```javascript
_collapseSidebar() {
    const shell = document.getElementById('ide-shell');
    shell.classList.add('sidebar-collapsed');
    shell.style.setProperty('--sidebar-width', '0px');
}

_expandSidebar() {
    const shell = document.getElementById('ide-shell');
    shell.classList.remove('sidebar-collapsed');
    shell.style.removeProperty('--sidebar-width'); // reverts to :root default
}
```

**3. Add touch events to `_wireSidebarResize()` (lines ~339-364):**
```javascript
_wireSidebarResize() {
    const handle = document.getElementById('sidebar-resize');
    if (!handle) return;

    let startX, startWidth;

    const onStart = (clientX) => {
        startX = clientX;
        startWidth = parseInt(getComputedStyle(document.getElementById('ide-shell')).getPropertyValue('--sidebar-width'));
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    };

    const onMove = (clientX) => {
        const newWidth = Math.max(180, Math.min(600, window.innerWidth - 300, startWidth + clientX - startX));
        document.getElementById('ide-shell').style.setProperty('--sidebar-width', newWidth + 'px');
    };

    const onEnd = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    // Mouse events
    handle.addEventListener('mousedown', (e) => {
        onStart(e.clientX);
        const moveHandler = (e) => onMove(e.clientX);
        const upHandler = () => { onEnd(); document.removeEventListener('mousemove', moveHandler); document.removeEventListener('mouseup', upHandler); };
        document.addEventListener('mousemove', moveHandler);
        document.addEventListener('mouseup', upHandler);
    });

    // Touch events
    handle.addEventListener('touchstart', (e) => {
        onStart(e.touches[0].clientX);
        const moveHandler = (e) => { e.preventDefault(); onMove(e.touches[0].clientX); };
        const endHandler = () => { onEnd(); document.removeEventListener('touchmove', moveHandler); document.removeEventListener('touchend', endHandler); };
        document.addEventListener('touchmove', moveHandler, { passive: false });
        document.addEventListener('touchend', endHandler);
    }, { passive: true });
}
```

**4. Add touch events to `_wireBottomPanel()` (lines ~391-414):**
Same pattern as sidebar resize, but vertical axis. Clamp: `Math.max(80, Math.min(600, window.innerHeight - 300, startHeight - (clientY - startY)))`. Apply to `--panel-height`.

**5. Add `_wireSidebarSwipeDismiss()` method:**
```javascript
_wireSidebarSwipeDismiss() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    let startX, startY;

    sidebar.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });

    sidebar.addEventListener('touchend', (e) => {
        if (startX === undefined) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = Math.abs(e.changedTouches[0].clientY - startY);
        // Left-to-right swipe, at least 60px, primarily horizontal
        if (dx < -60 && Math.abs(dx) > dy * 2) {
            this._collapseSidebar();
        }
        startX = startY = undefined;
    }, { passive: true });
}
```
Call `this._wireSidebarSwipeDismiss()` in the constructor, after the existing `_wireSidebarBackdrop()` call.

**Note on swipe direction:** The sidebar is on the left, so swiping *left* (negative dx, `dx < -60`) dismisses it. This is the standard iOS/Android pattern for dismissing a left-side drawer.

### Files NOT modified (deferred to follow-up PR)

- `Drawer.js`, `DiffPanel.js`, `LogCapturePanel.js`, `InstallerPanel.js`, `GroupsPanel.js`, `StatePanel.js`, `CommandBar.js` -- component token unification
- No new `--surface-*`, `--text-*`, `--sp-*` token variables (use existing semantic names)
- No `.g-btn`, `.g-input`, `.g-list-item` class renames
- CommandBar's injected `<style>` block -- move to ide.css in the component token PR

### Summary of changes by file

| File | Changes |
|------|---------|
| `ide.html` | Add `viewport-fit=cover` to meta tag; delete redundant resize listener |
| `ide.css` | 10 modifications: touch-action, dvh height, sidebar collapse removal, min-height fix, canvas touch-action, panel height defaults, breakpoint update, safe-area insets, remove mobile overrides |
| `IDEShell.js` | 5 modifications: matchMedia query, collapse/expand rewrite, touch events on both resize handles, swipe-to-dismiss |

## Implementer Vote

**layout** should implement this.

Layout's Phase 0 analysis is closest to the converged plan: the variable-driven sidebar collapse (`--sidebar-width: 0px`), the compound orientation-aware breakpoint, the 3-column grid restructure, the `100dvh` fix, and the resize clamp logic all originated from layout's analysis. The implementation is primarily a grid/CSS structural change with JS wiring updates -- exactly layout's domain. Mobile's touch event code will be incorporated, but the structural skeleton that everything hangs on is layout's work. Components' token system is explicitly deferred, so the components agent has no work in this PR.
