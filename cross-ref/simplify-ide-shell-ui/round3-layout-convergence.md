# Round 3: layout convergence

## Settled

All points now fully resolved. Below is the numbered list with brief rationale for each.

1. **Orientation-aware compound breakpoint.** Use `@media (max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))` for compact/overlay mode. All three agents converged: mobile agreed layout's orientation-aware approach is superior to a flat 1024px cutoff because it avoids penalizing landscape tablets with plenty of horizontal room. Components agreed the compound query is correct. The JS `matchMedia` string must match exactly.

2. **`--sidebar-width: 0px` variable-driven collapse.** Replace both `display: none` (desktop collapsed) and `width: 0` (mobile's proposal) with setting `--sidebar-width: 0px`. The grid column collapses naturally, no `display` cascade conflict, no focusable 0-width element. All three agents agreed layout's approach is the cleanest single-source-of-truth mechanism.

3. **`100vh` then `100dvh` at root level.** Components correctly identified that my Phase 0 had the fallback order backwards (`100dvh` first, then `100vh`). The correct order is `height: 100vh; height: 100dvh;` -- vh first as fallback, dvh second as the override. Apply at the `#ide-shell` root, not only inside the mobile media query.

4. **`touch-action: manipulation` on html/body, `none` only on canvas.** Replace `touch-action: none` on `html, body` (ide.css:56) with `touch-action: manipulation`. Apply `touch-action: none` only to `#editor-area #canvas`. This unblocks sidebar scrolling on tablets while still disabling double-tap-zoom globally. Components confirmed mobile's proposal; my Phase 0 missed this entirely.

5. **Touch events on both resize handles.** Add `touchstart`/`touchmove`/`touchend` listeners to `_wireSidebarResize()` and `_wireBottomPanel()` in IDEShell.js, using mobile's code pattern. Neither layout nor components flagged this -- mobile correctly identified that resize handles are dead on touch devices.

6. **Sidebar swipe-to-dismiss.** Add mobile's `_wireSidebarSwipeDismiss()` implementation after `_wireSidebarBackdrop()` in the constructor. The swipe uses a horizontal threshold check (`dx > dy * 2`) and the sidebar's `touch-action` stays `manipulation` (not `pan-y`, which would suppress the horizontal gesture).

7. **Safe-area insets.** Add `viewport-fit=cover` to the meta viewport tag at ide.html:5. Apply `env(safe-area-inset-bottom)` padding to the activity bar and status bar in the compact media query. My Phase 0 missed this entirely; mobile and components both flagged it.

8. **Remove redundant window resize listener.** Delete `window.addEventListener('resize', ...)` at ide.html:333-335. The ResizeObserver on `#editor-area` (IDEShell.js:763-768) already handles this. The redundant listener causes double-firing of `_onEditorResize()`. Layout flagged it; mobile and components both agreed.

9. **`min-height: 0` on `#sidebar-content`.** Add to ide.css at the `#sidebar-content` rule (line 208). Without it, the flex child cannot shrink below its content size, so `overflow-y: auto` never activates in some browsers (older Safari). All three agents agreed. One property, zero risk.

10. **Viewport-aware resize clamps.** Sidebar drag: `Math.min(600, window.innerWidth - 300)` instead of flat `Math.min(600, ...)`. Bottom panel drag: `Math.min(600, window.innerHeight - 300)` instead of flat `Math.min(600, ...)`. Both ensure the editor always gets at least 300px. Layout proposed the sidebar fix; mobile proposed the panel fix; both are needed.

11. **Component tokens deferred to follow-up PR.** Keep existing semantic names (`--bg-sidebar`, `--bg-panel`, etc.). Add missing tokens incrementally (`--text-hint`, `--border-subtle`, etc.) as needed. Do NOT rename 20+ existing variables in a "simplify" PR. The full `--surface-0`..`--surface-5` / `.g-btn` / `.g-scroll` component library is a separate workstream that depends on the layout/mobile fixes being stable first.


## Implementation Plan

### File: `app/ide.html`

**Change 1: Add `viewport-fit=cover` to meta tag (line 5)**

```html
<!-- Before -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">

<!-- After -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
```

**Change 2: Remove redundant window resize listener (lines 329-335)**

Delete this entire block:
```js
// After init: the viewer set window.addEventListener('resize') which
// calls renderer.setSize(window.innerWidth, window.innerHeight).
// In IDE mode the canvas is sized by ResizeObserver on #editor-area.
// Add a resize listener that forces the IDE shell sizing path.
window.addEventListener('resize', () => {
    ide._onEditorResize();
});
```

---

### File: `app/ide.css`

**Change 3: `touch-action` on html/body (line 56)**

```css
/* Before */
touch-action: none;

/* After */
touch-action: manipulation;
```

**Change 4: Root `#ide-shell` height -- add `100dvh` (line 68)**

```css
/* Before */
#ide-shell {
    display: grid;
    width: 100vw;
    height: 100vh;

/* After */
#ide-shell {
    display: grid;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
```

**Change 5: Drop resize-handle grid column, simplify to 3 columns (lines 69-81)**

```css
/* Before */
    grid-template-columns:
        var(--activitybar-width)
        var(--sidebar-width)
        var(--resize-handle)
        1fr;
    grid-template-rows:
        var(--titlebar-height)
        1fr
        var(--statusbar-height);
    grid-template-areas:
        "titlebar   titlebar   titlebar   titlebar"
        "activity   sidebar    resize-s   editor"
        "statusbar  statusbar  statusbar  statusbar";

/* After */
    grid-template-columns:
        var(--activitybar-width)
        var(--sidebar-width)
        1fr;
    grid-template-rows:
        var(--titlebar-height)
        1fr
        var(--statusbar-height);
    grid-template-areas:
        "titlebar  titlebar  titlebar"
        "activity  sidebar   editor"
        "statusbar statusbar statusbar";
```

The `#sidebar-resize` element moves inside `#sidebar` as an absolutely-positioned right-edge handle (see Change 5b below).

**Change 5b: Restyle `#sidebar-resize` as inset element inside `#sidebar`**

Add/replace the `#sidebar-resize` rule:
```css
#sidebar-resize {
    position: absolute;
    top: 0;
    right: -2px;
    width: 4px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
    background: transparent;
}

#sidebar-resize:hover,
#sidebar-resize.dragging {
    background: var(--accent);
}
```

And ensure `#sidebar` has `position: relative`:
```css
#sidebar {
    grid-area: sidebar;
    position: relative;    /* for the resize handle */
    background: var(--bg-sidebar);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border-color);
    min-width: 0;
}
```

**Change 6: Replace sidebar-collapsed `display: none` with variable-driven collapse (lines 84-96)**

```css
/* Before */
#ide-shell.sidebar-collapsed {
    grid-template-columns:
        var(--activitybar-width)
        0px
        0px
        1fr;
}

#ide-shell.sidebar-collapsed #sidebar,
#ide-shell.sidebar-collapsed #sidebar-resize {
    display: none;
}

/* After */
#ide-shell.sidebar-collapsed #sidebar {
    overflow: hidden;
    border-right: none;
}
```

The grid columns no longer need overriding -- `_collapseSidebar()` sets `--sidebar-width: 0px` which collapses the column naturally.

**Change 7: `min-height: 0` on `#sidebar-content` (line 208)**

```css
/* Before */
#sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
}

/* After */
#sidebar-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
}
```

**Change 8: Expand the media query to compound breakpoint (line 986)**

```css
/* Before */
@media (max-width: 768px) {

/* After */
@media (max-width: 768px),
       ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait)) {
```

**Change 9: Remove mobile touch-action override (lines 1014-1017)**

Delete this block entirely -- the root `touch-action: manipulation` (Change 3) already handles it:
```css
    /* ---- Fix touch-action: allow scroll on UI, block only on canvas ---- */
    html, body {
        touch-action: auto;
    }
```

**Change 10: Fix sidebar overlay bottom offset (lines 1080, 1110)**

```css
/* Before (line 1080) */
    bottom: 48px;

/* After */
    bottom: calc(var(--activitybar-width, 48px) + var(--statusbar-height, 22px));
```

Apply the same to the backdrop at line 1110.

**Change 11: Remove the `display: none`/`display: flex` cascade overrides (lines 1091-1098)**

Delete:
```css
    /* Override desktop collapsed display:none — controlled by transform instead */
    #ide-shell.sidebar-collapsed #sidebar {
        display: flex;
        transform: translateX(-100%);
    }

    #ide-shell:not(.sidebar-collapsed) #sidebar {
        display: flex;
        transform: translateX(0);
    }
```

Replace with simpler transform toggle (the `display: flex` is now always on since we no longer use `display: none` for collapse):
```css
    #ide-shell.sidebar-collapsed #sidebar {
        transform: translateX(-100%);
    }

    #ide-shell:not(.sidebar-collapsed) #sidebar {
        transform: translateX(0);
    }
```

**Change 12: Safe-area inset padding inside the compact media query**

Add at the end of the compact media query block:
```css
    /* ---- Safe-area insets for notched devices ---- */
    #activity-bar {
        padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .status-bar {
        padding-bottom: env(safe-area-inset-bottom, 0px);
    }
```

---

### File: `app/ide.html` (DOM change)

**Change 13: Move `#sidebar-resize` inside `#sidebar`**

The `#sidebar-resize` div currently sits as a sibling of `#sidebar` in the grid. Move it to be the last child of `#sidebar`:

```html
<!-- Before (approximate structure) -->
<div id="sidebar">
    <div class="sidebar-header">...</div>
    <div id="sidebar-content">...</div>
</div>
<div id="sidebar-resize"></div>

<!-- After -->
<div id="sidebar">
    <div class="sidebar-header">...</div>
    <div id="sidebar-content">...</div>
    <div id="sidebar-resize"></div>
</div>
```

---

### File: `app/IDEShell.js`

**Change 14: Update `matchMedia` query (line 96)**

```js
// Before
this._mobileQuery = window.matchMedia('(max-width: 768px)');

// After
this._mobileQuery = window.matchMedia(
    '(max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))'
);
```

**Change 15: Variable-driven sidebar collapse/expand (lines 320-332)**

```js
// Before
_collapseSidebar() {
    this._sidebarVisible = false;
    this._shell.classList.add('sidebar-collapsed');
    this._activityBtns.forEach(btn => btn.classList.remove('active'));
    this._onEditorResize();
}

_expandSidebar() {
    this._sidebarVisible = true;
    this._shell.classList.remove('sidebar-collapsed');
    this._onEditorResize();
}

// After
_collapseSidebar() {
    this._sidebarVisible = false;
    document.documentElement.style.setProperty('--sidebar-width', '0px');
    this._shell.classList.add('sidebar-collapsed');
    this._activityBtns.forEach(btn => btn.classList.remove('active'));
    this._onEditorResize();
}

_expandSidebar() {
    this._sidebarVisible = true;
    document.documentElement.style.setProperty('--sidebar-width', `${this._lastSidebarWidth || 280}px`);
    this._shell.classList.remove('sidebar-collapsed');
    this._onEditorResize();
}
```

Note: `_lastSidebarWidth` must be tracked. Initialize `this._lastSidebarWidth = 280` in the constructor. Update it in the sidebar resize handler before collapsing.

**Change 16: Viewport-aware sidebar resize clamp (line 345)**

```js
// Before
const newWidth = Math.max(150, Math.min(600, startWidth + delta));

// After
const maxWidth = Math.min(600, window.innerWidth - 300);
const newWidth = Math.max(150, Math.min(maxWidth, startWidth + delta));
```

**Change 17: Viewport-aware bottom panel resize clamp (line 396)**

```js
// Before
const newHeight = Math.max(80, Math.min(600, startHeight + delta));

// After
const maxHeight = Math.min(600, window.innerHeight - 300);
const newHeight = Math.max(80, Math.min(maxHeight, startHeight + delta));
```

**Change 18: Add touch events to sidebar resize (inside `_wireSidebarResize()`)**

Add after the existing `mousedown` listener (line 356-363):

```js
this._sidebarResize.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const touch = e.touches[0];
    startX = touch.clientX;
    startWidth = this._sidebar.getBoundingClientRect().width;
    this._sidebarResize.classList.add('dragging');

    const onTouchMove = (e) => {
        const t = e.touches[0];
        const delta = t.clientX - startX;
        const maxWidth = Math.min(600, window.innerWidth - 300);
        const newWidth = Math.max(150, Math.min(maxWidth, startWidth + delta));
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
    };

    const onTouchEnd = () => {
        this._sidebarResize.classList.remove('dragging');
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        this._onEditorResize();
    };

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
}, { passive: false });
```

**Change 19: Add touch events to bottom panel resize (inside `_wireBottomPanel()`)**

Add after the existing `mousedown` listener (line 407-414):

```js
this._panelResize.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const touch = e.touches[0];
    startY = touch.clientY;
    startHeight = this._bottomPanel.getBoundingClientRect().height;
    this._panelResize.classList.add('dragging');

    const onTouchMove = (e) => {
        const t = e.touches[0];
        const delta = startY - t.clientY;
        const maxHeight = Math.min(600, window.innerHeight - 300);
        const newHeight = Math.max(80, Math.min(maxHeight, startHeight + delta));
        document.documentElement.style.setProperty('--panel-height', `${newHeight}px`);
    };

    const onTouchEnd = () => {
        this._panelResize.classList.remove('dragging');
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        this._onEditorResize();
    };

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
}, { passive: false });
```

**Change 20: Add sidebar swipe-to-dismiss**

Add new method and wire it in the constructor after `_wireSidebarBackdrop()`:

```js
// In constructor, after _wireSidebarBackdrop():
this._wireSidebarSwipeDismiss();

// New method:
_wireSidebarSwipeDismiss() {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    this._sidebar.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    this._sidebar.addEventListener('touchmove', (e) => {
        if (!tracking || !this._sidebarVisible) return;
        const dx = startX - e.touches[0].clientX;
        const dy = Math.abs(e.touches[0].clientY - startY);
        // Only dismiss on a clear leftward horizontal swipe
        if (dx > 60 && dx > dy * 2) {
            tracking = false;
            this._collapseSidebar();
        }
    }, { passive: true });

    this._sidebar.addEventListener('touchend', () => {
        tracking = false;
    }, { passive: true });
}
```

**Change 21: Track `_lastSidebarWidth` for restore after collapse**

In the constructor (around line 75-80), add:
```js
this._lastSidebarWidth = 280;
```

In `_wireSidebarResize()`, after setting the CSS variable (line 346), add:
```js
this._lastSidebarWidth = newWidth;
```

**Change 22: Debounce `_onEditorResize` with rAF guard**

```js
// Before
_wireResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => {
        this._onEditorResize();
    });
    this._resizeObserver.observe(this._editorArea);
}

// After
_wireResizeObserver() {
    this._resizePending = false;
    this._resizeObserver = new ResizeObserver(() => {
        if (!this._resizePending) {
            this._resizePending = true;
            requestAnimationFrame(() => {
                this._resizePending = false;
                this._onEditorResize();
            });
        }
    });
    this._resizeObserver.observe(this._editorArea);
}
```

---

### Files NOT modified (deferred)

- **Panel JS files** (Drawer.js, DiffPanel.js, InstallerPanel.js, LogCapturePanel.js, etc.): Component token unification is a follow-up PR.
- **CommandBar.js**: Moving injected `<style>` to ide.css is a follow-up PR.
- **src/** files: No rendering pipeline changes needed for layout fixes.

### Summary of changes by file

| File | Changes |
|------|---------|
| `app/ide.html` | viewport-fit=cover meta tag; move #sidebar-resize inside #sidebar; remove redundant resize listener |
| `app/ide.css` | touch-action fix; 100dvh at root; 3-column grid; variable-driven collapse; min-height:0 on sidebar-content; compound breakpoint; remove mobile touch-action override; fix sidebar overlay bottom offset; simplify sidebar transform rules; safe-area inset padding |
| `app/IDEShell.js` | compound matchMedia query; variable-driven collapse/expand; viewport-aware resize clamps; touch events on both resize handles; swipe-to-dismiss; _lastSidebarWidth tracking; rAF debounce on ResizeObserver |


## Implementer Vote

**mobile** should implement.

Rationale: The converged plan is predominantly interaction and viewport work -- touch events on resize handles, swipe-to-dismiss, safe-area insets, viewport-aware clamps, compound breakpoint queries, `touch-action` fixes. These are mobile's core competency as demonstrated in their Phase 0. The CSS grid structural changes (3-column grid, variable-driven collapse) are straightforward mechanical edits that any agent can execute, but the touch event wiring requires careful attention to passive listeners, multi-touch guards, threshold tuning, and the interaction between `touch-action` values and gesture recognizers -- all areas where mobile's Phase 0 analysis was the most detailed and correct. Components' Phase 0 is focused on token/class unification which is explicitly deferred. My own Phase 0 grid restructuring is incorporated into the plan but is the simpler half of the work.
