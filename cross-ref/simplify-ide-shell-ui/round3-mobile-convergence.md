# Round 3: mobile convergence

## Settled

All points now fully resolved. Numbered list with brief rationale.

1. **Orientation-aware compound breakpoint adopted.** Layout's `(max-width: 768px)` for phones plus `(min-width: 769px) and (max-width: 1024px) and (orientation: portrait)` for portrait tablets. I conceded my flat 1024px proposal in Round 1 -- layout is right that landscape tablets at 1024px have sufficient room for inline sidebar. Both CSS media query and `IDEShell.js:96` matchMedia must use the compound form.

2. **`--sidebar-width: 0px` variable-driven collapse.** Layout's approach wins over my `width: 0; min-width: 0` proposal. Setting the CSS variable is single-source-of-truth: the grid column itself disappears without fighting `display: none` / `display: flex` cascade conflicts. My Phase 0 fix at `ide.css:93-96` is superseded. The `_collapseSidebar()` and `_expandSidebar()` methods in IDEShell.js toggle the variable plus a class for transition.

3. **`100vh` then `100dvh` at root level.** Components correctly flagged layout's proposed fallback order as backwards. The root `#ide-shell` rule gets `height: 100vh; height: 100dvh;` -- vh first, dvh override. Applied at root, not only in the media query. This fixes iPad portrait where the address bar presence changes viewport height.

4. **`touch-action: manipulation` on html/body, `none` only on canvas.** All three agents agree `touch-action: none` on `html, body` is wrong. Replace with `manipulation` at `ide.css:56`, which allows scroll/pinch but disables double-tap zoom. `touch-action: none` stays only on `#editor-area #canvas` for camera control. Layout's note about the mobile `touch-action` override at `ide.css:1015-1017` becoming redundant is correct -- remove it.

5. **Touch events on both resize handles.** Neither layout nor components flagged this; it was my exclusive finding. My code samples for `_wireBottomPanel()` and `_wireSidebarResize()` touch listeners are adopted. Both use `touchstart`/`touchmove`/`touchend` parallel to mouse events, with viewport-aware clamping (`Math.min(600, window.innerHeight - 300)` for panel, `Math.min(600, window.innerWidth - 300)` for sidebar).

6. **Sidebar swipe-to-dismiss.** My `_wireSidebarSwipeDismiss()` implementation adopted. Horizontal threshold check (`dx > dy * 2`, `dx < -60`) ensures vertical scroll is not blocked. All listeners are `{ passive: true }`. Components endorsed this verbatim.

7. **Safe-area insets.** `viewport-fit=cover` on the meta tag at `ide.html:5`. `env(safe-area-inset-bottom)` padding on status bar and activity bar (mobile query). Sidebar `bottom` adjusted to `calc(48px + env(safe-area-inset-bottom))`. Layout did not address this; components and I agree it is essential for notched iPhones.

8. **Remove redundant window resize listener.** The `window.addEventListener('resize')` at `ide.html:333-335` is removed. The `ResizeObserver` on `#editor-area` at `IDEShell.js:763-768` is sufficient. Layout flagged this, I missed it in Phase 0, all agree it causes double-fire of `_onEditorResize()`.

9. **`min-height: 0` on `#sidebar-content`.** Added to `ide.css:208-213`. One property, zero risk. Enables flex truncation so `overflow-y: auto` activates when panel content exceeds sidebar height. All three agents converge on this fix. Components' severity downgrade (rare in practice because only one panel is visible) is noted but the fix is still warranted for robustness.

10. **Viewport-aware resize clamps.** Both sidebar drag and panel drag handlers get viewport-relative caps. Sidebar: `Math.min(600, window.innerWidth - 300)`. Panel: `Math.min(600, window.innerHeight - 300)`. CSS-side: `max-height: min(50vh, calc(100dvh - 300px))` as an absolute cap in the compact media query. Layout's `clamp(80px, 25vh, 300px)` default for `--panel-height` is complementary and adopted.

11. **Component tokens deferred to follow-up PR.** Layout recommended this, I agree. The existing semantic names (`--bg-sidebar`, `--bg-panel`, `--text-primary`) are kept. Missing tokens (`--text-hint`, `--border-subtle`, `--accent-warm`) are added incrementally. Components' full `--surface-0` through `--surface-5` rename and `g-btn`/`g-input`/`g-list-item` class unification is a separate PR. The layout and mobile fixes are independently valuable and lower risk.

## Implementation Plan

### File: `ide.html`

**Modify** line 5 -- add `viewport-fit=cover` to viewport meta:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
```

**Delete** lines 333-335 -- remove redundant resize listener:
```js
// DELETE this block:
window.addEventListener('resize', () => {
    shell._onEditorResize();
});
```

### File: `ide.css`

**Modify** line 56 -- `touch-action`:
```css
/* BEFORE */ touch-action: none;
/* AFTER  */ touch-action: manipulation;
```

**Modify** `#ide-shell` rule (~line 68) -- add dvh with fallback:
```css
#ide-shell {
    /* existing properties... */
    height: 100vh;
    height: 100dvh;  /* override for modern browsers */
}
```

**Replace** `#ide-shell.sidebar-collapsed` rules (~lines 85-96) -- variable-driven collapse:
```css
#ide-shell.sidebar-collapsed {
    --sidebar-width: 0px;
}
#ide-shell.sidebar-collapsed #sidebar {
    overflow: hidden;
    border-right: none;
}
#ide-shell.sidebar-collapsed #sidebar-resize {
    display: none;
}
```

**Add** to `#sidebar-content` (~line 208):
```css
min-height: 0;
```

**Add** safe-area support after status bar rules (~line 570):
```css
@supports (padding-bottom: env(safe-area-inset-bottom)) {
    #status-bar {
        padding-bottom: env(safe-area-inset-bottom);
    }
}
```

**Replace** main mobile media query breakpoint (~line 986):
```css
@media (max-width: 768px),
       ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait)) {
    /* all existing mobile rules */
}
```

**Add** inside the compact media query -- safe-area insets:
```css
#activity-bar {
    padding-bottom: env(safe-area-inset-bottom);
}
#sidebar {
    bottom: calc(48px + env(safe-area-inset-bottom));
}
#sidebar-backdrop {
    bottom: calc(48px + env(safe-area-inset-bottom));
}
```

**Add** inside the compact media query -- panel height cap:
```css
#bottom-panel {
    max-height: min(50vh, calc(100dvh - 300px));
}
```

**Remove** the mobile `touch-action` override (~line 1015-1017) since root is now `manipulation`.

**Add** status bar overflow handling inside compact query:
```css
.status-left, .status-right {
    overflow: hidden;
}
```

**Remove** the `display: flex` override on `.sidebar-collapsed #sidebar` inside the mobile query (~line 1091-1094) since collapse is now variable-driven and consistent across breakpoints.

### File: `IDEShell.js`

**Modify** line 96-97 -- compound matchMedia query:
```js
this._mobileQuery = window.matchMedia(
    '(max-width: 768px), ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait))'
);
```

**Modify** `_collapseSidebar()` -- set CSS variable instead of toggling display:
```js
_collapseSidebar() {
    this._shell.classList.add('sidebar-collapsed');
    // --sidebar-width: 0px is driven by CSS rule on .sidebar-collapsed
}
```

**Modify** `_expandSidebar()` -- restore CSS variable:
```js
_expandSidebar() {
    this._shell.classList.remove('sidebar-collapsed');
    // --sidebar-width restored to :root default
}
```

**Modify** `_wireBottomPanel()` (~line 396) -- viewport-aware max:
```js
const maxH = Math.min(600, window.innerHeight - 300);
const newHeight = Math.max(80, Math.min(maxH, startHeight + delta));
```

**Modify** `_wireSidebarResize()` (~line 345) -- viewport-aware max:
```js
const maxW = Math.min(600, window.innerWidth - 300);
const newWidth = Math.max(200, Math.min(maxW, startWidth + delta));
```

**Add** touch events inside `_wireBottomPanel()` after the mousedown block:
```js
this._panelResize.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    startY = touch.clientY;
    startHeight = this._bottomPanel.getBoundingClientRect().height;
    this._panelResize.classList.add('dragging');

    const onTouchMove = (e) => {
        const delta = startY - e.touches[0].clientY;
        const maxH = Math.min(600, window.innerHeight - 300);
        const newHeight = Math.max(80, Math.min(maxH, startHeight + delta));
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

**Add** similar touch events inside `_wireSidebarResize()` (same pattern, horizontal axis).

**Add** new method `_wireSidebarSwipeDismiss()`:
```js
_wireSidebarSwipeDismiss() {
    let startX = 0, startY = 0, tracking = false;

    this._sidebar.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    this._sidebar.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 2) {
            if (dx < -60) {
                this._collapseSidebar();
                tracking = false;
            }
        }
    }, { passive: true });

    this._sidebar.addEventListener('touchend', () => {
        tracking = false;
    }, { passive: true });
}
```

**Call** `this._wireSidebarSwipeDismiss()` in the constructor after `_wireSidebarBackdrop()`.

### Files NOT modified (deferred)

- **`CommandBar.js`** -- moving the 70-line injected `<style>` to `ide.css` is deferred to the component token PR.
- **Panel JS files** (Drawer.js, DiffPanel.js, InstallerPanel.js, etc.) -- `g-btn`/`g-input`/`g-list-item` class unification deferred.
- **`TouchController.js`** -- correctly scoped to canvas already; no changes needed.
- **`#editor-area min-height`** -- kept at `0`, not raised to `120px`. Layout is right that the canvas is protected via panel height caps, not editor-area floors.

### Deletions

- Remove `window.addEventListener('resize')` block from `ide.html:333-335`.
- Remove the mobile `touch-action` override at `ide.css:1015-1017`.
- Remove the mobile `.sidebar-collapsed #sidebar { display: flex; transform: translateX(-100%) }` override at `ide.css:1091-1094`.

### Summary of changes by file

| File | Lines added (approx) | Lines removed (approx) | Nature |
|------|---------------------|------------------------|--------|
| `ide.html` | 1 (viewport-fit) | 3 (resize listener) | Meta tag + cleanup |
| `ide.css` | ~30 | ~15 | Breakpoint, collapse, dvh, safe-area, touch-action |
| `IDEShell.js` | ~70 | ~10 | Touch events, swipe, matchMedia, viewport clamps |

## Implementer Vote

**Layout agent should implement.**

Rationale: The converged plan's center of gravity is the CSS grid restructure -- variable-driven sidebar collapse, compound breakpoint media queries, dvh fallback, and the cascade cleanup that follows. Layout's Phase 0 already has the correct `--sidebar-width: 0px` mechanism, the correct compound breakpoint query, and the correct grid analysis. The JS touch additions (my code) are additive and can be spliced in verbatim; they do not require the implementer to re-derive the touch interaction model. The CSS changes, on the other hand, require understanding the grid column math, the cascade order between desktop and mobile rules, and the interaction between `display`/`overflow`/`grid-template-columns` -- all of which layout has already mapped in detail. Components agent's scope (token system) was explicitly deferred, making layout the natural choice.
