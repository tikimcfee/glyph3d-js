# Phase 0: Layout Architecture Analysis

Agent perspective: CSS Grid layout, viewport handling, portrait/landscape, sidebar/panel sizing.

---

## 1. Current Layout Analysis

### Grid Structure (ide.css:64-82)

The shell uses a 4-column x 3-row CSS grid:

```
Columns: activitybar(48px) | sidebar(280px) | resize-handle(4px) | editor(1fr)
Rows:    titlebar(30px) | main-content(1fr) | statusbar(22px)

Areas:   "titlebar   titlebar   titlebar   titlebar"
         "activity   sidebar    resize-s   editor"
         "statusbar  statusbar  statusbar  statusbar"
```

The editor column (`#editor-column`, ide.css:280-287) is a flex column internally:
```
tab-bar (35px) -> breadcrumb (22px) -> editor-area (flex:1) -> panel-resize (4px) -> bottom-panel (200px)
```

### Sizing Chain

1. `#ide-shell` is 100vw x 100vh -- the outer grid.
2. `--sidebar-width` (CSS var, default 280px) drives the second grid column.
3. `#editor-area` gets whatever remains after titlebar, tabs, breadcrumb, resize handle, bottom panel, and status bar.
4. The 3D canvas is sized by `ResizeObserver` on `#editor-area` (IDEShell.js:763-768), calling `_onEditorResize()` (IDEShell.js:771-788) which reads `getBoundingClientRect()` and sets renderer size.
5. Sidebar resize drag (IDEShell.js:339-364) clamps to `Math.max(150, Math.min(600, ...))` and writes `--sidebar-width`.
6. Bottom panel resize (IDEShell.js:391-414) clamps to `Math.max(80, Math.min(600, ...))` and writes `--panel-height`.

### Mobile Media Query (ide.css:986-1161)

At `max-width: 768px`, the grid restructures to single-column:

```
Columns: 1fr
Rows:    titlebar(30px) | editor(1fr) | statusbar(22px) | activity-bar(48px)

Areas:   "titlebar"
         "editor"
         "statusbar"
         "activity"
```

Sidebar becomes a fixed-position overlay (`position: fixed`, 85vw wide, max 360px), translated offscreen with `transform: translateX(-100%)`.

### JS Mobile Detection (IDEShell.js:96-103)

Uses `window.matchMedia('(max-width: 768px)')` to set `this._isMobile`. On mobile:
- Sidebar starts collapsed (IDEShell.js:116-120)
- Bottom panel starts collapsed
- File selection auto-dismisses sidebar (IDEShell.js:486-488)

---

## 2. Bug Inventory

### BUG 1: 100vh on mobile browsers (ide.css:67-68)

**File:** `ide.css:67-68`
```css
width: 100vw;
height: 100vh;
```

The outer grid uses `100vh` which on iOS/Android includes the URL bar space. Content overflows the visible area. The mobile media query (ide.css:992) does add `100dvh` as an override, but the desktop rule at line 68 applies first on intermediate-sized tablets that don't hit the 768px breakpoint.

**Fix:** Use `100dvh` with `100vh` fallback at the root level, not only inside the media query.

### BUG 2: Sidebar min-width 150px breaks portrait phones (IDEShell.js:344)

**File:** `IDEShell.js:344`
```js
const newWidth = Math.max(150, Math.min(600, startWidth + delta));
```

The drag resize clamps to 150-600px. On a 375px phone in landscape, a 150px sidebar leaves only 177px (375 - 48 - 150) for the editor. In portrait mode this isn't directly hit because the sidebar is an overlay, but on tablets (769-1024px range) the sidebar is NOT an overlay -- it's an inline grid column, and 150px minimum is too large for a 768px portrait tablet (leaves ~568px for editor, which is fine, but the 600px maximum means a user could drag it to consume 78% of the viewport).

**Fix:** Clamp max to `min(600, viewportWidth - 300)` so the editor always gets at least 300px.

### BUG 3: Bottom panel max-height 600px in landscape, 40vh in portrait -- but only mobile (ide.css:1153, IDEShell.js:395)

**File:** `IDEShell.js:395`
```js
const newHeight = Math.max(80, Math.min(600, startHeight + delta));
```

**File:** `ide.css:1153`
```css
#bottom-panel { max-height: 40vh; }
```

The JS clamp allows 600px. On a phone in landscape (375px tall), 600px exceeds the viewport. The CSS `max-height: 40vh` only applies inside the `@media (max-width: 768px)` query. A landscape phone can be wider than 768px (e.g., iPhone 14 Pro Max: 932x430), so it hits the desktop code path with a 600px panel max on a 430px-tall viewport.

**Fix:** The JS resize handler should respect viewport height: `Math.min(600, window.innerHeight * 0.5)`.

### BUG 4: Sidebar overlay bottom offset hardcoded to 48px (ide.css:1080)

**File:** `ide.css:1080`
```css
bottom: 48px;
```

The sidebar overlay and backdrop both use `bottom: 48px` (lines 1080, 1110) to account for the activity bar at the bottom. But this is a magic number duplicating `--activitybar-width`. If the activity bar height changes (or if the status bar moves), these go out of sync.

**Fix:** Use `calc(var(--activitybar-width) + var(--statusbar-height))` or restructure so the sidebar overlay doesn't need to know about elements below it.

### BUG 5: No portrait tablet layout (768-1024px range)

There is no media query for tablets in portrait orientation (768-1024px). At 769px, the full desktop layout applies with a 280px sidebar + 48px activity bar, leaving only ~441px for the editor. The bottom panel at its default 200px can consume nearly half the remaining editor height.

**Fix:** Add a media query for `(max-width: 1024px) and (orientation: portrait)` or use a fluid sidebar width.

### BUG 6: editor-column has no grid-area fallback for mobile (ide.css:1007-1012)

**File:** `ide.css:1007-1012`

The mobile media query sets `grid-template-areas` with `"editor"` but `#editor-column` still has `grid-area: editor` from the desktop rule (ide.css:281). This works. BUT: the `#sidebar` and `#activity-bar` are pulled out of the grid flow by `grid-area: unset` (sidebar, line 1076) and flex-direction change (activity bar, line 1053). The sidebar becomes `position: fixed` -- but when sidebar is NOT collapsed on desktop and the user rotates to portrait, the sidebar grid column (`var(--sidebar-width)`) is replaced by the mobile `1fr` template. The transition is handled purely by class toggling in JS (`sidebar-collapsed`), which the media query overrides on line 988-1005 by also targeting `.sidebar-collapsed`. This double-override works but is fragile -- the desktop `.sidebar-collapsed` rule (line 86-96) sets `display: none`, while the mobile override (line 1091-1093) sets `display: flex` with transform. If a third state appears, this cascade breaks.

### BUG 7: ResizeObserver fires before layout settles after orientation change

**File:** `IDEShell.js:763-768`

`_onEditorResize()` reads `getBoundingClientRect()` immediately when ResizeObserver fires. On mobile orientation changes, the browser may fire ResizeObserver before the grid has fully relaid out (especially with the `100dvh` transition). The result: the canvas gets the wrong dimensions for 1-2 frames.

**Fix:** Debounce `_onEditorResize` by ~100ms or use `requestAnimationFrame` to defer the read.

### BUG 8: `window.addEventListener('resize')` in ide.html:333 is redundant and harmful

**File:** `ide.html:333-335`
```js
window.addEventListener('resize', () => {
    ide._onEditorResize();
});
```

The ResizeObserver on `#editor-area` (IDEShell.js:764-767) already handles resize events. This extra `window.resize` listener causes double-firing on every resize. Worse, it fires even when the editor area hasn't changed size (e.g., soft keyboard appearing on mobile can fire window resize without changing the editor-area rect, or vice versa).

### BUG 9: Command palette width is absolute (ide.css:425)

**File:** `ide.css:425`
```css
width: 500px;
max-width: 80%;
```

On a 375px phone, this resolves to 300px (80% of 375). Not a breakage, but the palette has no mobile-specific styling -- no larger touch targets, no full-width mode. The `top: 0; left: 50%; transform: translateX(-50%)` positioning works but places it under the titlebar.

### BUG 10: Status bar overflows on narrow screens

**File:** `ide.css:559-577`

`.status-left` and `.status-right` are flex containers with `gap: 2px` and many child `.status-item` elements. No `overflow: hidden` or `flex-wrap: wrap`. On a 375px phone, the status bar items overflow horizontally. The items have `white-space: nowrap` (line 582), so they don't wrap.

**Fix:** Add `overflow: hidden` on `.status-right`, or hide low-priority items with a mobile media query.

---

## 3. Proposed Layout Architecture

### Principle: One grid, fluid columns, no magic numbers

Replace the fixed 4-column grid with a responsive pattern using `minmax()` and named grid lines. The sidebar should be an opt-in overlay at ALL widths below a threshold, not just below 768px.

### New CSS Grid

```css
:root {
    --activitybar-size: 48px;
    --sidebar-width: clamp(200px, 25vw, 400px);
    --statusbar-height: 22px;
    --titlebar-height: 30px;
    --panel-height: clamp(80px, 25vh, 300px);
}

#ide-shell {
    display: grid;
    width: 100vw;
    height: 100dvh;
    height: 100vh; /* fallback */
}

/* Landscape / wide: inline sidebar */
@media (min-width: 769px) and (orientation: landscape),
       (min-width: 1025px) {
    #ide-shell {
        grid-template-columns: var(--activitybar-size) var(--sidebar-width) 1fr;
        grid-template-rows: var(--titlebar-height) 1fr var(--statusbar-height);
        grid-template-areas:
            "titlebar  titlebar  titlebar"
            "activity  sidebar   editor"
            "statusbar statusbar statusbar";
    }
}

/* Portrait / narrow: sidebar is overlay, activity bar at bottom */
@media (max-width: 768px),
       ((min-width: 769px) and (max-width: 1024px) and (orientation: portrait)) {
    #ide-shell {
        grid-template-columns: 1fr;
        grid-template-rows: var(--titlebar-height) 1fr var(--statusbar-height) var(--activitybar-size);
        grid-template-areas:
            "titlebar"
            "editor"
            "statusbar"
            "activity";
    }
    #sidebar {
        position: fixed;
        inset-block: 0 calc(var(--activitybar-size) + var(--statusbar-height));
        inset-inline-start: 0;
        width: min(85vw, 360px);
        z-index: 310;
        transform: translateX(-100%);
        transition: transform 0.25s ease;
    }
}
```

### Key changes

1. **Drop the resize handle column.** The sidebar resize handle should be an absolutely-positioned element inside `#sidebar` (a `::after` pseudo-element or a child div), not a grid column. This simplifies the grid from 4 columns to 3.

2. **`clamp()` for sidebar width.** Instead of a fixed 280px with JS-clamped drag, use `clamp(200px, 25vw, 400px)` as the default. The drag handler still writes `--sidebar-width`, but the clamp provides safe bounds.

3. **`clamp()` for panel height.** `--panel-height: clamp(80px, 25vh, 300px)` prevents the panel from exceeding viewport on small screens without needing separate mobile logic.

4. **Portrait tablet breakpoint.** Explicitly handle 769-1024px portrait as overlay mode.

5. **`100dvh` first, `100vh` fallback.** Swap the order so modern browsers get dvh.

6. **Remove sidebar-collapsed grid override.** Instead of redefining grid-template-columns when sidebar is collapsed, set `--sidebar-width: 0px` and use `grid-template-columns: var(--activitybar-size) var(--sidebar-width) 1fr`. The sidebar shrinks to 0 with `overflow: hidden`. This eliminates the `display: none` / `display: flex` cascade conflict.

### Editor-area canvas sizing

Keep the ResizeObserver approach but:
- Remove the redundant `window.addEventListener('resize')` from `ide.html:333`
- Debounce `_onEditorResize` with `requestAnimationFrame`
- Cap DPR at 2 (already done at IDEShell.js:780)

---

## 4. Migration Path

### Step 1: Fix immediate bugs (no layout rewrite)

1. Add `height: 100dvh` fallback to `#ide-shell` root rule (ide.css:68). One line.
2. Fix bottom panel JS clamp: `Math.min(600, window.innerHeight * 0.5)` (IDEShell.js:395).
3. Fix sidebar resize max: `Math.min(600, window.innerWidth - 300)` (IDEShell.js:344).
4. Add `overflow: hidden` to `.status-right` (ide.css:573).
5. Remove redundant `window.addEventListener('resize')` from ide.html:333-335.
6. Replace `bottom: 48px` with `bottom: calc(var(--activitybar-size, 48px) + var(--statusbar-height, 22px))` in the mobile sidebar and backdrop rules (ide.css:1080, 1110).

### Step 2: Simplify the grid (one PR)

1. Remove the `resize-s` grid column. Move the resize handle inside `#sidebar` as a right-edge absolute-positioned element.
2. Change `sidebar-collapsed` from `grid-template-columns` override to `--sidebar-width: 0px`.
3. Collapse sidebar/expand sidebar methods just toggle the CSS variable.
4. Test: desktop landscape, desktop portrait, tablet landscape, tablet portrait, phone landscape, phone portrait.

### Step 3: Add portrait tablet breakpoint

1. Add the `(min-width: 769px) and (max-width: 1024px) and (orientation: portrait)` media query.
2. Reuse the overlay sidebar pattern from the phone layout.
3. Activity bar stays vertical (enough vertical space on tablets) -- only goes horizontal on phones.

### Step 4: Debounce and clean up

1. Wrap `_onEditorResize` in `requestAnimationFrame` guard.
2. Remove the `setInterval` polling for header label (IDEShell.js:217-223) -- use a single MutationObserver.
3. Consolidate mobile detection: replace `window.matchMedia('(max-width: 768px)')` in JS with reading the actual grid layout (`getComputedStyle` on grid-template-areas) so JS and CSS agree on the current mode.

---

## Summary of Files and Lines

| Issue | File | Lines |
|-------|------|-------|
| 100vh without dvh fallback | `app/ide.css` | 67-68 |
| Sidebar clamp too rigid | `app/IDEShell.js` | 344 |
| Panel clamp exceeds viewport | `app/IDEShell.js` | 395 |
| Hardcoded bottom offset | `app/ide.css` | 1080, 1110 |
| No portrait tablet layout | `app/ide.css` | 986 (only breakpoint) |
| display:none/flex cascade | `app/ide.css` | 86-96 vs 1091-1098 |
| Redundant resize listener | `app/ide.html` | 333-335 |
| Status bar overflow | `app/ide.css` | 572-577 |
| Command palette no mobile | `app/ide.css` | 422-433 |
| ResizeObserver no debounce | `app/IDEShell.js` | 763-768, 771-788 |
