# Phase 0: Mobile/Portrait Bug Catalog and Fixes

## 1. Bug Catalog

### BUG-01: Mobile breakpoint misses iPad portrait (810px)

**Root cause:** `IDEShell.js:97` — `window.matchMedia('(max-width: 768px)')` and `ide.css:986` — `@media (max-width: 768px)`. iPad Air portrait is 810px, iPad mini is 768px (borderline). These devices get the full desktop 4-column grid layout, which crams `48px + 280px + 4px + remainder` into 810px, leaving only ~478px for the canvas. The activity bar and sidebar consume 40% of screen width.

**Severity:** High — iPad portrait is a primary tablet use case.

### BUG-02: Bottom panel max-height 600px can consume entire small phone screen

**Root cause:** `ide.css:494` — `#bottom-panel { height: var(--panel-height) }` with `IDEShell.js:396` — `Math.max(80, Math.min(600, startHeight + delta))`. On an iPhone SE (667px viewport), the fixed chrome eats: titlebar 30px + tabbar 35px + breadcrumb 22px + statusbar 22px = 109px. That leaves 558px for canvas + panel. If `--panel-height` is at default 200px, the canvas gets 358px. If the user drags to 400px, canvas is 158px. The `max-height: 40vh` rule at `ide.css:1154` only applies inside the 768px media query, so iPads (810px) get no cap at all.

**Severity:** High — canvas becomes unusably small.

### BUG-03: Sidebar overlay has no swipe-to-dismiss

**Root cause:** The old `Drawer.js:111-119` had `touchstart`/`touchend` on `#drawer-handle` for swipe-to-dismiss. `IDEShell.js:310-317` (`_wireSidebarBackdrop`) only wires a click handler. There is no touch-drag gesture to close the sidebar overlay on mobile. Users must tap the backdrop precisely or find the collapse button.

**Severity:** Medium — basic mobile interaction pattern missing.

### BUG-04: `touch-action: none` on `html, body` breaks all scrolling

**Root cause:** `ide.css:56` — `touch-action: none` on `html, body`. This globally disables browser touch scrolling, including sidebar panel scroll, bottom panel scroll, and file tree scroll. The mobile media query at `ide.css:1015-1017` resets to `touch-action: auto`, but this only applies below 768px. iPad users get zero scroll on any sidebar panel. Even at <768px, the override can conflict with the canvas `touch-action: none` at `ide.css:1031`.

**Severity:** Critical — sidebar content is unscrollable on tablets.

### BUG-05: Sidebar overlay `bottom: 48px` assumes activity bar is at bottom

**Root cause:** `ide.css:1079-1080` — `#sidebar { bottom: 48px }` and `ide.css:1110` — `#sidebar-backdrop { bottom: 48px }`. These assume the activity bar height is always 48px and always at the bottom. If the mobile grid row for activity changes, or if safe-area insets apply, the sidebar won't reach the bottom properly and a gap appears.

**Severity:** Low-Medium — visual gap on devices with home indicator.

### BUG-06: No safe-area-inset handling for notched phones

**Root cause:** `ide.html:5` — viewport meta has `user-scalable=no` but no `viewport-fit=cover`. No CSS uses `env(safe-area-inset-*)`. On iPhone X+ with the notch/Dynamic Island, the status bar and bottom panel can be obscured by the notch or home indicator.

**Severity:** Medium — content hidden behind system chrome.

### BUG-07: Canvas ResizeObserver fires but canvas may have zero computed height

**Root cause:** `IDEShell.js:771-788` — `_onEditorResize()` reads `getBoundingClientRect()` from `#editor-area`. If the CSS grid collapses (e.g., sidebar overlay pushes content, or bottom panel plus fixed chrome exceeds viewport), `#editor-area` gets `flex: 1` in a column that has already allocated all its height to fixed elements. The `min-height: 0` at `ide.css:396` allows it to shrink to zero. The `width <= 0 || height <= 0` guard at `IDEShell.js:778` silently skips the resize, leaving the renderer at stale dimensions.

**Severity:** High — 3D canvas can disappear entirely on small screens.

### BUG-08: `overflow: hidden` on `#sidebar` prevents scroll of long panel content

**Root cause:** `ide.css:184` — `#sidebar { overflow: hidden }`. The intent is that `#sidebar-content` at `ide.css:209` handles scrolling with `overflow-y: auto`. But `.sidebar-panel` at `ide.css:216-218` sets `display: block` with no height constraint. If the sidebar-content's flex child doesn't constrain height, `overflow-y: auto` never activates because the content isn't actually overflowing its container. The sidebar header is `flex-shrink: 0` (correct), but `#sidebar-content` needs `min-height: 0` to let flex truncate it.

**Severity:** Medium — settings panel and file tree can be unscrollable.

### BUG-09: Panel resize uses only mouse events, not touch

**Root cause:** `IDEShell.js:391-414` — `_wireBottomPanel()` uses `mousedown`/`mousemove`/`mouseup`. Similarly, `IDEShell.js:340-364` — `_wireSidebarResize()` uses only mouse events. Touch users cannot resize either panel.

**Severity:** Medium — resize handles are dead on touch devices.

### BUG-10: TouchController prevents all default touch on canvas, including scroll momentum

**Root cause:** `TouchController.js:28-30` — `{ passive: false }` on all touch events, plus `e.preventDefault()` at lines 34 and 49. This is correct for the canvas (camera control needs it), but the canvas touch area covers the entire `#editor-area` which in turn is `flex: 1` of the editor column. If the canvas overlaps any UI element (minimap, command palette), those elements lose touch scrolling too.

**Severity:** Low — correctly scoped to canvas, but worth noting for palette scroll.

### BUG-11: Desktop sidebar collapse uses `display: none`, mobile uses `transform`

**Root cause:** `ide.css:93-96` — desktop collapse sets `display: none` on sidebar and resize handle. `ide.css:1091-1094` — mobile overrides this to `display: flex; transform: translateX(-100%)`. When transitioning between breakpoints (e.g., iPad rotation from portrait to landscape), the class `sidebar-collapsed` is already set, and the display/transform conflict can leave the sidebar invisible or stuck.

**Severity:** Medium — sidebar can vanish on orientation change.

### BUG-12: Status bar items overflow on narrow screens

**Root cause:** `ide.css:572-577` — `.status-left, .status-right` use `display: flex` with `gap: 2px` but no `overflow: hidden` or flex-wrap. On a 375px screen, 8+ status items overflow the status bar, either extending off-screen or causing a horizontal scroll on the body.

**Severity:** Low — cosmetic but disorienting.

---

## 2. Viewport Analysis

Fixed chrome height: titlebar(30) + tabbar(35) + breadcrumb(22) + panel-resize(4) + statusbar(22) = 113px.
With bottom panel (default 200px): 313px total chrome.
With activity bar at bottom (mobile, 48px): 313 + 48 = 361px.

| Device | Viewport | Hits 768px query? | Canvas height (panel open) | Canvas height (panel closed) | Sidebar fit? |
|--------|----------|-------------------|---------------------------|-------------------------------|--------------|
| iPhone SE | 375x667 | Yes | 667 - 361 = 306px | 667 - 161 = 506px | Overlay, OK |
| iPhone 14 | 390x844 | Yes | 844 - 361 = 483px | 844 - 161 = 683px | Overlay, OK |
| iPad 10th | 810x1080 | **No** | 1080 - 313 = 767px | 1080 - 113 = 967px | **Desktop 4-col, sidebar eats 328px** |
| iPad Air landscape | 1180x820 | No | Fine | Fine | Desktop, fine |
| iPad mini portrait | 768x1024 | **Borderline** | Depends on exact pixel | ... | Flaky |

Key issue: The 768px breakpoint misses all iPads in portrait. They get the 4-column desktop grid, which allocates `48px + 280px + 4px = 332px` to activity bar + sidebar + resize handle, leaving only `478px` (on 810px iPad) for the entire editor column.

---

## 3. Proposed Mobile Architecture

### Breakpoint strategy
- Replace `768px` with `1024px` for the "compact" layout, catching all iPads in portrait.
- Add an intermediate `768px` breakpoint for "phone" overrides (smaller tabs, hidden status items).

### Sidebar: overlay on compact, inline on wide
- Below 1024px: sidebar is `position: fixed`, slide-in from left, with backdrop.
- Above 1024px: sidebar is inline grid column (current desktop behavior).
- Sidebar gets swipe-to-dismiss via touchstart/touchmove/touchend on the sidebar element itself.

### Bottom panel: smart capping
- Below 1024px: `max-height: min(40vh, calc(100dvh - 300px))` so the canvas always gets at least 300px.
- Resize handle gets touch events in addition to mouse.

### Scroll containment
- Every scrollable panel uses `overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch`.
- `#sidebar-content` gets `min-height: 0` to enable flex truncation.
- `touch-action: none` is removed from `html, body` globally and placed only on `#canvas`.

### Safe area
- `viewport-fit=cover` added to meta tag.
- Activity bar bottom and status bar get `padding-bottom: env(safe-area-inset-bottom)`.

---

## 4. Touch Conflict Resolution

The core conflict: canvas needs `touch-action: none` and `preventDefault()` for camera control, but sidebar/panels need native touch scrolling.

**Resolution strategy:**
1. `touch-action: none` stays ONLY on `#editor-area #canvas` (`ide.css:1031` already does this in mobile query; extend to all viewports).
2. Remove `touch-action: none` from `html, body` (`ide.css:56`). Replace with `touch-action: manipulation` (allows scroll/pinch, disables double-tap zoom).
3. `TouchController.js` already scopes to the canvas element; no change needed there.
4. Sidebar overlay: `touch-action: pan-y` to allow vertical scroll. The backdrop gets `touch-action: manipulation`.
5. Sidebar swipe-to-dismiss: listen for horizontal touchmove on the sidebar itself. If `dx > 60px` leftward, collapse. Use `touch-action: pan-y` so vertical scroll is not blocked by the swipe listener (check dx vs dy angle before deciding).
6. Panel resize handle: add `touchstart`/`touchmove`/`touchend` parallel to existing mouse events.

---

## 5. Concrete Fixes

### Fix BUG-01 + BUG-04: Expand breakpoint, fix touch-action

```css
/* ide.css:56 — REPLACE */
html, body {
    height: 100%;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--text-primary);
    background: var(--bg-editor);
    touch-action: manipulation;  /* was: none */
}

/* ide.css:986 — CHANGE breakpoint from 768px to 1024px */
@media (max-width: 1024px) {
    /* ... all existing mobile rules unchanged ... */
}
```

```js
// IDEShell.js:97 — CHANGE breakpoint
this._mobileQuery = window.matchMedia('(max-width: 1024px)');
```

### Fix BUG-02: Smart bottom panel height cap

```css
/* ide.css, inside the @media (max-width: 1024px) block, REPLACE line 1153-1155 */
#bottom-panel {
    max-height: min(40vh, calc(100dvh - 300px));
}
```

```js
// IDEShell.js:396 — CHANGE max panel height to be viewport-aware
const onMouseMove = (e) => {
    const delta = startY - e.clientY;
    const maxH = Math.min(600, window.innerHeight - 300);
    const newHeight = Math.max(80, Math.min(maxH, startHeight + delta));
    document.documentElement.style.setProperty('--panel-height', `${newHeight}px`);
};
```

### Fix BUG-03: Add swipe-to-dismiss on sidebar

```js
// IDEShell.js — ADD after _wireSidebarBackdrop() call in constructor (~line 108)
this._wireSidebarSwipeDismiss();

// IDEShell.js — ADD new method
/** @private Swipe left on sidebar to dismiss (mobile overlay) */
_wireSidebarSwipeDismiss() {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    this._sidebar.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    this._sidebar.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        // Only track horizontal swipes (angle < 30 degrees)
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

### Fix BUG-05 + BUG-06: Safe area insets

```html
<!-- ide.html:5 — REPLACE -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
```

```css
/* ide.css — ADD after status bar rules (~line 570) */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
    #status-bar {
        padding-bottom: env(safe-area-inset-bottom);
    }
    @media (max-width: 1024px) {
        #activity-bar {
            padding-bottom: env(safe-area-inset-bottom);
        }
        #sidebar {
            bottom: calc(48px + env(safe-area-inset-bottom));
        }
        #sidebar-backdrop {
            bottom: calc(48px + env(safe-area-inset-bottom));
        }
    }
}
```

### Fix BUG-07: Ensure editor-area always has minimum height

```css
/* ide.css:393-398 — REPLACE */
#editor-area {
    flex: 1;
    position: relative;
    min-height: 120px;  /* was: 0 — guarantees canvas is never invisible */
    overflow: hidden;
    background: var(--bg-editor);
}
```

### Fix BUG-08: Sidebar content needs min-height: 0 for flex scroll

```css
/* ide.css:208-213 — REPLACE */
#sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    min-height: 0;  /* ADD — allows flex parent to truncate, enabling scroll */
}
```

### Fix BUG-09: Touch events for panel resize

```js
// IDEShell.js — ADD inside _wireBottomPanel(), after the mousedown block (~line 414)
// Touch support for panel resize
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

### Fix BUG-11: Consistent sidebar show/hide across breakpoints

```css
/* ide.css:93-96 — REPLACE with transition-based approach */
#ide-shell.sidebar-collapsed #sidebar {
    /* Desktop: use width collapse instead of display:none for consistency */
    width: 0;
    min-width: 0;
    overflow: hidden;
    border-right: none;
}

#ide-shell.sidebar-collapsed #sidebar-resize {
    display: none;
}

/* ide.css:85-91 — REPLACE */
#ide-shell.sidebar-collapsed {
    grid-template-columns:
        var(--activitybar-width)
        0px
        0px
        1fr;
}
```

### Fix BUG-12: Status bar overflow on narrow screens

```css
/* ide.css — ADD inside @media (max-width: 1024px) block */
.status-left,
.status-right {
    overflow: hidden;
}

/* Hide non-essential status items on phones */
@media (max-width: 480px) {
    #status-camera,
    #status-glyph-count,
    #status-grid-count,
    #status-layout {
        display: none;
    }
}
```
