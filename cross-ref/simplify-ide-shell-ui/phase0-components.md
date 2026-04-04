# Phase 0: Component Inventory & Shared System Proposal

## 1. Component Inventory

### Buttons (5 variants, 8 files)

| Pattern | CSS Class | Used In | Count |
|---------|-----------|---------|-------|
| Primary action (green bg) | `.repo-btn` | Drawer (repo), DiffPanel | 2 |
| Secondary action (dark bg) | `.setting-btn` | Drawer (settings), InstallerPanel, GroupsPanel | 6+ |
| Small inline button | `.repo-btn-sm` | Drawer (repo branch refresh) | 1 |
| Icon button (no bg) | `.icon-btn`, `.state-icon-btn`, `.state-row-btn`, `.group-wc-btn` | StatePanel, GroupsPanel, sidebar-header | 8+ |
| Log capture button | `.log-capture-btn` | LogCapturePanel | 3 |

All five are slight variations of the same concept: padding, border-radius, bg color, hover state.

### Text Inputs (3 variants, 4 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Full-width panel input | `.repo-input` | Drawer (repo), DiffPanel |
| Sidebar search input | `.sidebar-input` | Sidebar search |
| Command bar input | `.cmd-input` | CommandBar (injected styles) |

All share: `var(--bg-input)`, `1px solid var(--border-color)`, `border-radius: 2-4px`, focus outline = `var(--accent)`.

### Selects (1 variant, 1 file, used 4x)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Styled dropdown | `.setting-select` | Drawer (settings) x4, Drawer (repo) x1 |

Also reused as a text input wrapper (font-family input, port input) -- overloaded class.

### Toggles (1 variant, 1 file)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| On/off switch | `.setting-toggle` + `.setting-toggle-track` | Drawer (settings) x2 |

### Sliders (1 variant, 1 file)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Range slider | `.setting-slider` | Drawer (settings) x6 |

### Section Headers (1 variant, 3 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Uppercase divider | `.setting-section-header` | Drawer (settings) x5, InstallerPanel x5 |
| Namespace divider | `.state-ns-divider` | StatePanel |
| Controls section heading | `.controls-section h4` | Drawer (controls) |

Three separate implementations of the same concept: thin uppercase label with top border.

### Labels (3 variants, 4 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Setting label (flex row) | `.setting-label` | Drawer (settings) |
| Repo label (uppercase block) | `.repo-label` | Drawer (repo), DiffPanel |
| Stat label | `.stat-label` | Drawer (stats) |

### Hint Text (2 variants, 2 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Setting hint | `.setting-hint` | Drawer (settings) x4, InstallerPanel x4 |
| Branch status | `.branch-status` | Drawer (repo) |

### List Items (4 variants, 5 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Tree file item | `.tree-item` | File tree |
| Diff file item | `.diff-file-item` | DiffPanel |
| Branch item | `.branch-item` | Drawer (repo) |
| Group member | `.group-member` | GroupsPanel |

All are: flex row, padding 4-8px, 11-12px font, hover bg, bottom border.

### Badges (3 variants, 3 files)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Status badge (A/D/M/R) | `.badge`, `.badge-added`, etc. | DiffPanel |
| Count badge | `.groups-badge`, `.state-badge` | GroupsPanel, StatePanel |
| PR state badge | `.diff-pr-state` | DiffPanel |

### Cards (1 variant, 1 file)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Group card | `.group-card` | GroupsPanel |

### Code Block (1 variant, 1 file)

| Pattern | CSS Class | Used In |
|---------|-----------|---------|
| Copyable command | `.installer-cmd-wrap` | InstallerPanel x5 |

### Scrollable Container (implicit, 5 files)

Every panel that displays a list uses the same pattern: `max-height: 100-400px; overflow-y: auto; border: 1px solid #333; border-radius: 4px; background: #111`.

Found in: `.branch-list`, `.diff-file-list`, `.log-capture-preview`, `.group-members`, `.state-list`.

---

## 2. Duplication Map

### Near-Identical CSS Pairs

| Class A | Class B | Delta |
|---------|---------|-------|
| `.setting-btn` | `.log-capture-btn` | padding (12px vs 8px 14px), border-radius (6px vs 4px) |
| `.repo-input` | `.sidebar-input` | border-radius (4px vs 2px), margin |
| `.repo-input` | `.setting-select` | identical bg/border/color; select adds caret SVG |
| `.setting-section-header` | `.state-ns-divider` | identical concept, different font-size (10px vs 9px) |
| `.repo-label` | `.stat-label` | both uppercase secondary text, different implementations |
| `.setting-hint` | `.branch-status` | font-size 11px, color #555/#666, margin-top 4px |
| `.tree-item` | `.diff-file-item` | flex row, gap 6px, padding 6-8px, border-bottom, cursor pointer |
| `.groups-badge` | `.state-badge` | identical pattern, different font-sizes (10px/9px) |
| `.group-wc-btn` | `.state-icon-btn` | small icon button, nearly identical |

### Inline Style Duplication

InstallerPanel uses `style="margin-top:6px"`, `style="margin-top:8px"`, `style="margin-bottom:8px"` on `.setting-hint` elements -- these should be structural spacing from the component, not inline overrides.

CommandBar injects 70 lines of `<style>` that duplicates `var(--bg-panel)`, `var(--border-color)`, `var(--accent)`, `var(--font-mono)` patterns already in ide.css.

### Hardcoded Color Values (should be tokens)

- `#333` appears 14 times (backgrounds, borders) -- should be `var(--surface-2)`
- `#222` appears 6 times -- should be `var(--surface-1)`
- `#111` appears 4 times -- should be `var(--surface-0)`
- `#888` / `#aaa` / `#ccc` / `#666` used interchangeably for text -- should be `var(--text-*)` tokens
- `#ffaa00` used for slider thumb + setting-value -- accent-secondary, not tokenized

---

## 3. Proposed Token System

```css
:root {
    /* ---- Surfaces (darkest to lightest) ---- */
    --surface-0:       #0a0a0a;   /* canvas / deepest bg */
    --surface-1:       #111122;   /* activity bar, list bg */
    --surface-2:       #141420;   /* sidebar, panels */
    --surface-3:       #1a1a2e;   /* titlebar, hover states */
    --surface-4:       #1e1e2e;   /* input fields */
    --surface-5:       #2a2a3a;   /* borders, dividers */

    /* ---- Text ---- */
    --text-0:          #e0e0e0;   /* primary / white */
    --text-1:          #cccccc;   /* default body */
    --text-2:          #888899;   /* secondary / labels */
    --text-3:          #555566;   /* tertiary / hints */
    --text-4:          #333344;   /* disabled */

    /* ---- Accents ---- */
    --accent:          #00ff88;   /* primary action */
    --accent-dim:      #00cc66;   /* primary hover */
    --accent-warm:     #ffaa00;   /* values, sliders */
    --accent-info:     #569cd6;   /* terminal mode, info */
    --accent-danger:   #ff4444;   /* destructive actions */
    --accent-success:  #4ade80;   /* connected, ok */

    /* ---- Spacing ---- */
    --sp-1:  2px;
    --sp-2:  4px;
    --sp-3:  6px;
    --sp-4:  8px;
    --sp-5:  12px;
    --sp-6:  16px;
    --sp-7:  24px;

    /* ---- Radii ---- */
    --radius-sm:  2px;
    --radius-md:  4px;
    --radius-lg:  6px;
    --radius-pill: 9999px;

    /* ---- Typography ---- */
    --font-mono: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    --fs-xs:  9px;
    --fs-sm:  10px;
    --fs-md:  11px;
    --fs-base: 12px;
    --fs-lg:  13px;
    --fs-xl:  14px;
}
```

---

## 4. Proposed Component Library

### 4a. `.g-btn` -- Universal Button

```css
/* Base */
.g-btn {
    padding: var(--sp-4) var(--sp-5);
    background: var(--surface-3);
    color: var(--text-0);
    border: 1px solid var(--surface-5);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    transition: background 0.15s, border-color 0.15s;
}
.g-btn:hover { background: var(--surface-4); border-color: var(--text-2); }
.g-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Variants */
.g-btn--primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
.g-btn--primary:hover { background: var(--accent-dim); }
.g-btn--danger { color: var(--accent-danger); border-color: #442222; }
.g-btn--danger:hover { background: #2a1a1a; border-color: var(--accent-danger); }
.g-btn--icon { padding: var(--sp-2) var(--sp-3); background: none; border: none; color: var(--text-2); font-size: var(--fs-lg); }
.g-btn--icon:hover { color: var(--text-0); background: rgba(255,255,255,0.08); }
.g-btn--full { width: 100%; }
```

Replaces: `.setting-btn`, `.repo-btn`, `.repo-btn-sm`, `.log-capture-btn`, `.icon-btn`, `.state-icon-btn`, `.state-row-btn`, `.group-wc-btn`, `.installer-copy-btn`.

### 4b. `.g-input` -- Universal Text Input

```css
.g-input {
    width: 100%;
    padding: var(--sp-4) var(--sp-5);
    background: var(--surface-4);
    border: 1px solid var(--surface-5);
    border-radius: var(--radius-md);
    color: var(--text-0);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    outline: none;
}
.g-input:focus { border-color: var(--accent); }
.g-input::placeholder { color: var(--text-3); }

/* Variants */
.g-input--select {
    cursor: pointer;
    -webkit-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,...chevron...");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
}
.g-input--textarea { resize: vertical; line-height: 1.5; }
```

Replaces: `.repo-input`, `.sidebar-input`, `.setting-select`, `.setting-textarea`.

### 4c. `.g-section` -- Section Header

```css
.g-section {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-3);
    padding-top: var(--sp-5);
    margin-top: var(--sp-2);
    margin-bottom: var(--sp-6);
    border-top: 1px solid var(--surface-5);
}
.g-section:first-child { border-top: none; margin-top: 0; padding-top: 0; }
```

Replaces: `.setting-section-header`, `.state-ns-divider`, `.controls-section h4`.

### 4d. `.g-label` + `.g-hint`

```css
.g-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--sp-3);
    color: var(--text-2);
    font-size: var(--fs-base);
}
.g-label--block {
    display: block;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: var(--fs-md);
}
.g-hint {
    font-size: var(--fs-md);
    color: var(--text-3);
    margin-top: var(--sp-2);
    line-height: 1.4;
}
.g-value { color: var(--accent-warm); font-weight: 600; }
```

Replaces: `.setting-label`, `.repo-label`, `.stat-label`, `.setting-hint`, `.branch-status`, `.setting-value`.

### 4e. `.g-list-item` -- Universal List Row

```css
.g-list-item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    font-size: var(--fs-md);
    cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    transition: background 0.1s;
}
.g-list-item:hover { background: var(--surface-3); }
.g-list-item.selected { background: #1a3a1a; border-left: 3px solid var(--accent); }
.g-list-item__name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-list-item__meta { font-size: var(--fs-sm); color: var(--text-3); flex-shrink: 0; }
```

Replaces: `.tree-item`, `.diff-file-item`, `.branch-item`, `.group-member`, `.sidebar-result-item`.

### 4f. `.g-badge` -- Universal Badge

```css
.g-badge {
    display: inline-block;
    font-size: var(--fs-xs);
    padding: 1px 5px;
    border-radius: var(--radius-lg);
    background: var(--surface-5);
    color: var(--text-2);
    min-width: 16px;
    text-align: center;
    font-weight: 600;
}
.g-badge--success { background: #238636; color: #fff; }
.g-badge--danger  { background: #da3633; color: #fff; }
.g-badge--warn    { background: #d29922; color: #fff; }
.g-badge--info    { background: #8957e5; color: #fff; }
.g-badge--accent  { background: rgba(0,255,136,0.1); color: var(--accent); }
```

Replaces: `.badge`, `.badge-added/removed/modified/renamed`, `.groups-badge`, `.state-badge`, `.diff-pr-state`, `.installer-dl-badge`.

### 4g. `.g-group` -- Spacing Container

```css
.g-group { margin-bottom: var(--sp-6); }
.g-group--row { display: flex; gap: var(--sp-4); }
.g-group--col { display: flex; flex-direction: column; gap: var(--sp-3); }
```

Replaces: `.setting-group`, `.repo-section`, `.log-capture-controls`.

### 4h. `.g-scroll` -- Scrollable Container

```css
.g-scroll {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--surface-5);
    border-radius: var(--radius-md);
    background: var(--surface-1);
}
```

Replaces: `.branch-list`, `.diff-file-list`, `.log-capture-preview`, `.group-members`, `.state-list`, `.sidebar-results`.

---

## 5. Panel Rewiring Plan

### Drawer.js -- settingsPanelHTML()
- `.setting-group` -> `.g-group`
- `.setting-label` -> `.g-label`, `.setting-value` -> `.g-value`
- `.setting-slider` -> keep (unique component, just tokenize colors)
- `.setting-select` -> `.g-input--select`
- `.setting-btn` -> `.g-btn` / `.g-btn--full`
- `.setting-toggle` -> keep (unique component, just tokenize colors)
- `.setting-section-header` -> `.g-section`
- `.setting-hint` -> `.g-hint`
- `.setting-textarea` -> `.g-input--textarea`

### Drawer.js -- repoPanelHTML()
- `.repo-section` -> `.g-group`
- `.repo-label` -> `.g-label--block`
- `.repo-input` -> `.g-input`
- `.repo-btn` -> `.g-btn--primary g-btn--full`
- `.repo-btn-sm` -> `.g-btn--icon`
- `.branch-item` -> `.g-list-item`
- `.branch-list` -> `.g-scroll`
- `.branch-status` -> `.g-hint`

### Drawer.js -- statsPanelHTML()
- `.stat-row` -> `.g-label` (already a flex row with label + value)
- `.stat-label` -> implicit (first child)
- `.stat-value` -> `.g-value`

### Drawer.js -- controlsPanelHTML()
- `.controls-section h4` -> `.g-section`
- `.control-row` -> `.g-list-item` (non-clickable variant)
- `.key` -> `.g-badge` (keyboard key style)

### DiffPanel.js
- `.repo-section` -> `.g-group`
- `.repo-label` -> `.g-label--block`
- `.repo-input` -> `.g-input`
- `.repo-btn` -> `.g-btn--primary g-btn--full`
- `.diff-file-item` -> `.g-list-item`
- `.badge-*` -> `.g-badge--*`
- `.diff-status` -> `.g-hint`
- `.diff-file-list` -> `.g-scroll`

### LogCapturePanel.js
- `.log-capture-controls` -> `.g-group--row`
- `.log-capture-btn` -> `.g-btn`
- `.log-capture-btn.download` -> `.g-btn--primary`
- `.log-capture-status` -> `.g-hint`
- `.log-capture-preview` -> `.g-scroll`

### InstallerPanel.js
- `.setting-group` -> `.g-group`
- `.setting-section-header` -> `.g-section`
- `.setting-hint` -> `.g-hint`
- `.installer-cmd-wrap` -> `.g-code-block` (new, keep as-is -- unique component)
- Remove all inline `style="margin-top:..."` -- spacing handled by `.g-group` gap

### GroupsPanel.js
- `.groups-badge` -> `.g-badge`
- `.groups-hint` -> `.g-hint`
- `.groups-empty` -> `.g-list-item` empty state (`.g-scroll--empty`)
- `.group-wc-btn` -> `.g-btn--icon`
- `.group-mode-btn` -> `.g-btn` with `.active` state
- `.groups-btn-danger` -> `.g-btn--danger`
- `.group-member` -> `.g-list-item`

### StatePanel.js
- `.state-badge` -> `.g-badge`
- `.state-icon-btn` -> `.g-btn--icon`
- `.state-row-btn` -> `.g-btn--icon`
- `.state-ns-divider` -> `.g-section`
- `.state-row` -> `.g-list-item` (with key-value layout variant)
- `.state-empty` -> empty state pattern

### CommandBar.js
- Move injected `<style>` into ide.css under `#command-bar` section
- Replace hardcoded fallback values with tokens (already uses `var()` with fallbacks -- drop fallbacks once tokens are guaranteed)

---

## Summary

- **13 component patterns** found across 8 files
- **9 near-duplicate CSS class pairs** identified
- **~50 hardcoded color values** should become token references
- Proposed system: **8 shared components** (`g-btn`, `g-input`, `g-section`, `g-label`, `g-hint`, `g-list-item`, `g-badge`, `g-group`, `g-scroll`) + token variables
- CommandBar's injected styles should move into ide.css
- InstallerPanel's inline style overrides should be eliminated by structural spacing

Net effect: ide.css drops from ~1285 lines to ~600, panels share one visual language, new panels need zero custom CSS for standard layouts.
