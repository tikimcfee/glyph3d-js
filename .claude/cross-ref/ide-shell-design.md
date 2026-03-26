# IDE Shell Design: VS Codium-style Layout for GitHub 3D Viewer

## Research Summary

### How VS Code structures its workbench

VS Code's workbench is composed of five major layout zones, each a CSS-classed container managed by a grid system in `src/vs/workbench/browser/layout.ts`:

1. **Title Bar** (top, full width) -- app title, menus, window controls
2. **Activity Bar** (thin vertical strip, far left, ~48px) -- icon buttons for Explorer, Search, Source Control, Extensions, etc.
3. **Sidebar / Primary Side Bar** (left of editor, ~300px, resizable) -- the active viewlet (file tree, search results, git changes)
4. **Editor Area** (center, fills remaining space) -- tab bar at top, editor content below, split panes supported
5. **Panel** (below editor, collapsible) -- Terminal, Output, Problems, Debug Console
6. **Status Bar** (bottom, full width, ~22px) -- branch name, errors/warnings, encoding, line/col, language mode

The layout is essentially a nested flexbox/grid: a vertical stack (titlebar, middle row, statusbar), where the middle row is a horizontal arrangement (activitybar, sidebar, editor+panel column).

### Other references

- **Eclipse Theia** uses the same conceptual zones but implements them as draggable dock panels. The "application shell" provides title bar, activity bar, sidebar, editor area, bottom panel, and status bar.
- **CodeSandbox** follows the same pattern: activity bar on the left, file tree sidebar, tabbed editor area, embedded preview pane, and a bottom panel for console/terminal.
- The **Atom IDE CSS Grid layout** (codepen by adrifolio) demonstrates the simplest CSS grid approach: `grid-template-columns: 48px 250px 1fr` with `grid-template-rows: 30px 1fr 200px 22px`.

### Design principles extracted

1. The layout must be achievable with CSS Grid at the outer level and flexbox within zones.
2. All panels except the editor area must be collapsible/resizable.
3. The activity bar never collapses -- it is the constant anchor.
4. The 3D canvas must fill the editor area exactly, resizing with it.
5. The existing Drawer content (file tree, settings, stats, controls, repo, logs, diff) maps naturally to sidebar panels activated by activity bar icons.

---

## Zone Map: Existing Components to IDE Zones

| IDE Zone | Current Component | Transformation |
|---|---|---|
| Activity Bar | (none) | New: thin icon strip on far left |
| Sidebar | Drawer (bottom sheet / side panel) | Promote to permanent sidebar; each Drawer tab becomes a sidebar panel |
| Tab Bar | (none) | New: file tabs above the 3D canvas, driven by SelectionManager |
| Editor Area | `<canvas id="canvas">` (100vw x 100vh) | Constrained to grid cell; resize handler updated |
| Bottom Panel | (none; logs/diff in drawer) | New: collapsible panel below canvas for logs, console, search results |
| Status Bar | FPS badge (floating) + Stats panel in drawer | New: fixed bottom bar with FPS, glyph count, layout mode, camera pos |
| Command Palette | (planned in ShortcutManager) | Cmd+P overlay centered on editor area |
| Header | `#header` (fixed top bar) | Removed or absorbed into title bar zone |

---

## HTML Skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>glyph3d IDE</title>
    <link rel="stylesheet" href="ide-shell.css">
</head>
<body>
    <!-- ====== IDE Shell (CSS Grid root) ====== -->
    <div id="ide-shell">

        <!-- Row 1: Title Bar -->
        <header id="titlebar">
            <span class="titlebar-title">glyph3d</span>
            <span id="titlebar-repo-label" class="titlebar-info"></span>
            <span class="titlebar-spacer"></span>
            <!-- Command palette trigger, theme toggle, etc. -->
        </header>

        <!-- Row 2: Main content area (activity bar + sidebar + editor column) -->
        <!-- These are placed as direct grid children, not wrapped in a row div -->

        <!-- Activity Bar: thin vertical icon strip -->
        <nav id="activity-bar">
            <button class="activity-btn active" data-panel="explorer" title="Explorer">
                <!-- Files icon (SVG or Unicode) -->
                <span class="activity-icon">&#128193;</span>
            </button>
            <button class="activity-btn" data-panel="search" title="Search">
                <span class="activity-icon">&#128269;</span>
            </button>
            <button class="activity-btn" data-panel="repo" title="Repository">
                <span class="activity-icon">&#9881;</span>
            </button>
            <button class="activity-btn" data-panel="diff" title="Diff / Source Control">
                <span class="activity-icon">&#8644;</span>
            </button>
            <button class="activity-btn" data-panel="settings" title="Settings">
                <span class="activity-icon">&#9776;</span>
            </button>
            <div class="activity-spacer"></div>
            <!-- Bottom-pinned items -->
            <button class="activity-btn" data-panel="controls" title="Keyboard Shortcuts">
                <span class="activity-icon">&#9000;</span>
            </button>
        </nav>

        <!-- Sidebar: shows the active panel -->
        <aside id="sidebar">
            <div class="sidebar-header">
                <span id="sidebar-title">EXPLORER</span>
                <button id="sidebar-collapse-btn" class="icon-btn" title="Collapse sidebar">&#10094;</button>
            </div>
            <div id="sidebar-content">
                <!-- Panels rendered here by JS; only the active one is display:block -->
                <div class="sidebar-panel active" id="sp-explorer">
                    <!-- File tree (from Drawer's filesPanelHTML) -->
                    <div id="tree-content">
                        <div class="tree-empty">Load a repository to see files</div>
                    </div>
                </div>
                <div class="sidebar-panel" id="sp-search">
                    <!-- Search input + results list -->
                    <div class="sidebar-search">
                        <input type="text" id="sidebar-search-input" class="sidebar-input"
                               placeholder="Search in files...">
                        <div id="sidebar-search-results" class="sidebar-results"></div>
                    </div>
                </div>
                <div class="sidebar-panel" id="sp-repo">
                    <!-- Repository URL, branch selection, load button (from Drawer's repoPanelHTML) -->
                </div>
                <div class="sidebar-panel" id="sp-diff">
                    <!-- Diff panel content (from DiffPanel) -->
                </div>
                <div class="sidebar-panel" id="sp-settings">
                    <!-- Settings sliders (from Drawer's settingsPanelHTML) -->
                </div>
                <div class="sidebar-panel" id="sp-controls">
                    <!-- Keyboard shortcuts help (from Drawer's controlsPanelHTML) -->
                </div>
            </div>
        </aside>

        <!-- Sidebar resize handle -->
        <div id="sidebar-resize" class="resize-handle-v"></div>

        <!-- Editor Column: tab bar + 3D canvas + bottom panel -->
        <div id="editor-column">

            <!-- Tab Bar: open files -->
            <div id="tab-bar">
                <!-- Tabs injected by JS from SelectionManager state -->
                <!-- Example tab structure: -->
                <!-- <div class="editor-tab active" data-path="src/index.js">
                    <span class="tab-icon">JS</span>
                    <span class="tab-name">index.js</span>
                    <button class="tab-close">&times;</button>
                </div> -->
                <div id="tab-bar-empty" class="tab-bar-hint">No files open</div>
            </div>

            <!-- Breadcrumb bar (optional, shows path to focused file) -->
            <div id="breadcrumb-bar">
                <span id="breadcrumb-path" class="breadcrumb-text"></span>
            </div>

            <!-- 3D Canvas: THE editor area -->
            <div id="editor-area">
                <canvas id="canvas"></canvas>
                <!-- Minimap overlay (positioned absolute within editor-area) -->
                <div id="minimap-container">
                    <canvas id="minimap-canvas"></canvas>
                </div>
                <!-- Command palette overlay (centered, absolute) -->
                <div id="command-palette" class="hidden">
                    <input type="text" id="palette-input" class="palette-input"
                           placeholder="Type a file name to open...">
                    <div id="palette-results" class="palette-results"></div>
                </div>
            </div>

            <!-- Bottom panel resize handle -->
            <div id="panel-resize" class="resize-handle-h"></div>

            <!-- Bottom Panel: logs, console, search results -->
            <div id="bottom-panel">
                <div id="panel-tab-bar">
                    <button class="panel-tab active" data-panel="output">Output</button>
                    <button class="panel-tab" data-panel="console">Console</button>
                    <button class="panel-tab" data-panel="search-results">Search Results</button>
                    <button class="panel-tab" data-panel="websocket">WebSocket</button>
                    <div class="panel-tab-spacer"></div>
                    <button id="panel-toggle-btn" class="icon-btn" title="Toggle panel">&#9660;</button>
                </div>
                <div id="panel-content">
                    <div class="panel-view active" id="pv-output">
                        <!-- Stats output (from Drawer's statsPanelHTML) -->
                    </div>
                    <div class="panel-view" id="pv-console">
                        <!-- Log capture (from Drawer's logCapturePanelHTML) -->
                    </div>
                    <div class="panel-view" id="pv-search-results">
                        <!-- Search matches across files -->
                    </div>
                    <div class="panel-view" id="pv-websocket">
                        <!-- WebSocket command I/O -->
                    </div>
                </div>
            </div>

        </div>

        <!-- Status Bar -->
        <footer id="status-bar">
            <div class="status-left">
                <span class="status-item" id="status-branch" title="Branch">
                    <span class="status-icon">&#9733;</span> main
                </span>
                <span class="status-item" id="status-layout" title="Layout mode">
                    hierarchical
                </span>
            </div>
            <div class="status-right">
                <span class="status-item" id="status-file-path" title="Focused file">
                    <!-- e.g. src/GlyphRenderer.js -->
                </span>
                <span class="status-item" id="status-glyph-count" title="Glyph count">
                    0 glyphs
                </span>
                <span class="status-item" id="status-grid-count" title="Grid count">
                    0 grids
                </span>
                <span class="status-item" id="status-camera" title="Camera position">
                    0, 0, 500
                </span>
                <span class="status-item status-fps" id="status-fps" title="FPS">
                    -- fps
                </span>
            </div>
        </footer>

    </div>

    <script type="importmap">
    {
        "imports": {
            "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"
        }
    }
    </script>
    <script type="module" src="./ide-main.js"></script>
</body>
</html>
```

---

## CSS Grid Layout Structure

The outer shell uses a single CSS Grid with named areas:

```
+---------------------------------------------------------------------+
| titlebar                                                            |  30px
+------+----------+---+----------------------------------------------+
|      |          | | |  tab-bar                                      |  32px
|      |          | | |-----------------------------------------------|
|  A   |          | | |  breadcrumb-bar                               |  22px
|  c   |  Side    |r| |-----------------------------------------------|
|  t   |  bar     |e| |                                               |
|  i   |          |s| |           3D Canvas (editor-area)             |  1fr
|  v   |          |i| |                                               |
|  i   |  240px   |z| |                                               |
|  t   |  ..      |e| |-----------------------------------------------|
|  y   |  ..      | | |  panel-resize                                 |  4px
|      |  400px   | | |-----------------------------------------------|
|  B   |          | | |  bottom-panel                                 |  200px
|  a   |          | | |                                               |  (collapsible)
|  r   |          | | |                                               |
+------+----------+---+----------------------------------------------+
| status-bar                                                          |  22px
+---------------------------------------------------------------------+
```

### CSS Implementation

```css
/* ============================================================
   IDE Shell — CSS Grid Layout
   ============================================================ */

/* ---- Reset ---- */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

:root {
    /* VS Code Dark+ inspired palette */
    --bg-titlebar:     #323233;
    --bg-activitybar:  #333333;
    --bg-sidebar:      #252526;
    --bg-editor:       #0a0a0a;
    --bg-panel:        #1e1e1e;
    --bg-statusbar:    #007acc;
    --bg-tab-active:   #1e1e1e;
    --bg-tab-inactive: #2d2d2d;
    --bg-input:        #3c3c3c;

    --border-color:    #3c3c3c;
    --text-primary:    #cccccc;
    --text-secondary:  #858585;
    --text-accent:     #00ff88;
    --text-white:      #e0e0e0;

    --activitybar-width:  48px;
    --sidebar-width:      280px;
    --statusbar-height:   22px;
    --titlebar-height:    30px;
    --tabbar-height:      35px;
    --breadcrumb-height:  22px;
    --panel-height:       200px;
    --resize-handle:      4px;

    /* Font */
    --font-mono: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    --font-size-sm: 11px;
    --font-size-base: 12px;
    --font-size-lg: 13px;
}

html, body {
    height: 100%;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--text-primary);
    background: var(--bg-editor);
    touch-action: none;
}

/* ============================================================
   Outer Grid: 4 rows, 4 columns
   ============================================================
   Columns: activitybar | sidebar | resize-handle | editor-column
   Rows:    titlebar | main-content | statusbar
   ============================================================ */

#ide-shell {
    display: grid;
    width: 100vw;
    height: 100vh;
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
}

/* Collapsed sidebar state */
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

/* ---- Title Bar ---- */
#titlebar {
    grid-area: titlebar;
    background: var(--bg-titlebar);
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 12px;
    border-bottom: 1px solid var(--border-color);
    -webkit-app-region: drag;  /* for Electron, harmless in browser */
    user-select: none;
}

.titlebar-title {
    font-weight: 600;
    font-size: var(--font-size-lg);
    color: var(--text-accent);
}

.titlebar-info {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.titlebar-spacer {
    flex: 1;
}

/* ---- Activity Bar ---- */
#activity-bar {
    grid-area: activity;
    background: var(--bg-activitybar);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 0;
    border-right: 1px solid var(--border-color);
}

.activity-btn {
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 18px;
    transition: color 0.15s;
}

.activity-btn:hover {
    color: var(--text-white);
}

.activity-btn.active {
    color: var(--text-white);
    border-left-color: var(--text-white);
}

.activity-spacer {
    flex: 1;
}

/* ---- Sidebar ---- */
#sidebar {
    grid-area: sidebar;
    background: var(--bg-sidebar);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border-color);
    min-width: 0;
}

.sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    height: 35px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color);
    user-select: none;
}

#sidebar-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
}

#sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
}

.sidebar-panel {
    display: none;
    padding: 0;   /* individual panels set their own padding */
}

.sidebar-panel.active {
    display: block;
}

.sidebar-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-color);
    border-radius: 2px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    outline: none;
}

.sidebar-input:focus {
    border-color: #007acc;
}

/* ---- Sidebar Resize Handle ---- */
#sidebar-resize {
    grid-area: resize-s;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
}

#sidebar-resize:hover,
#sidebar-resize.dragging {
    background: #007acc;
}

/* ---- Editor Column ---- */
#editor-column {
    grid-area: editor;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

/* ---- Tab Bar ---- */
#tab-bar {
    display: flex;
    align-items: stretch;
    height: var(--tabbar-height);
    background: var(--bg-tab-inactive);
    border-bottom: 1px solid var(--border-color);
    overflow-x: auto;
    overflow-y: hidden;
    flex-shrink: 0;
    scrollbar-width: thin;
}

.editor-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    height: 100%;
    min-width: 80px;
    max-width: 200px;
    background: var(--bg-tab-inactive);
    border-right: 1px solid var(--border-color);
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
    font-size: var(--font-size-base);
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
}

.editor-tab:hover {
    background: #2a2d2e;
    color: var(--text-white);
}

.editor-tab.active {
    background: var(--bg-editor);
    color: var(--text-white);
    border-bottom: 1px solid var(--bg-editor); /* overlaps container border */
    margin-bottom: -1px;
}

.tab-icon {
    font-size: 10px;
    color: var(--text-accent);
    opacity: 0.6;
}

.tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-close {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 14px;
    cursor: pointer;
    padding: 0 2px;
    border-radius: 3px;
    line-height: 1;
    visibility: hidden;
}

.editor-tab:hover .tab-close,
.editor-tab.active .tab-close {
    visibility: visible;
}

.tab-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-white);
}

.tab-bar-hint {
    color: var(--text-secondary);
    padding: 0 12px;
    font-size: var(--font-size-sm);
    display: flex;
    align-items: center;
}

/* ---- Breadcrumb Bar ---- */
#breadcrumb-bar {
    height: var(--breadcrumb-height);
    padding: 0 12px;
    display: flex;
    align-items: center;
    background: var(--bg-editor);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

.breadcrumb-text {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* ---- Editor Area (3D Canvas) ---- */
#editor-area {
    flex: 1;
    position: relative;     /* for absolute children: minimap, command palette */
    min-height: 0;
    overflow: hidden;
    background: var(--bg-editor);
}

#canvas {
    display: block;
    width: 100%;
    height: 100%;
}

/* ---- Minimap (inside editor-area) ---- */
#minimap-container {
    position: absolute;
    bottom: 8px;
    right: 16px;
    border-radius: 4px;
    overflow: hidden;
    cursor: crosshair;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    z-index: 10;
}

/* ---- Command Palette (inside editor-area) ---- */
#command-palette {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 500px;
    max-width: 80%;
    background: var(--bg-sidebar);
    border: 1px solid var(--border-color);
    border-top: none;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
}

#command-palette.hidden {
    display: none;
}

.palette-input {
    width: 100%;
    padding: 10px 14px;
    background: var(--bg-input);
    border: none;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-white);
    font-family: var(--font-mono);
    font-size: var(--font-size-lg);
    outline: none;
}

.palette-results {
    max-height: 300px;
    overflow-y: auto;
}

.palette-item {
    padding: 6px 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-base);
}

.palette-item:hover,
.palette-item.active {
    background: #062f4a;
}

.palette-item-path {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
}

/* ---- Panel Resize Handle ---- */
#panel-resize {
    height: var(--resize-handle);
    cursor: row-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
}

#panel-resize:hover,
#panel-resize.dragging {
    background: #007acc;
}

/* ---- Bottom Panel ---- */
#bottom-panel {
    height: var(--panel-height);
    background: var(--bg-panel);
    border-top: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
}

#bottom-panel.collapsed {
    height: 0;
    border-top: none;
    overflow: hidden;
}

#panel-tab-bar {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    gap: 2px;
}

.panel-tab {
    padding: 4px 12px;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    border-bottom: 1px solid transparent;
    transition: color 0.1s;
}

.panel-tab:hover {
    color: var(--text-white);
}

.panel-tab.active {
    color: var(--text-white);
    border-bottom-color: var(--text-accent);
}

.panel-tab-spacer {
    flex: 1;
}

#panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 8px 12px;
}

.panel-view {
    display: none;
    font-size: var(--font-size-base);
    line-height: 1.6;
}

.panel-view.active {
    display: block;
}

/* ---- Status Bar ---- */
#status-bar {
    grid-area: statusbar;
    background: var(--bg-statusbar);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-size: var(--font-size-sm);
    color: #fff;
    user-select: none;
}

.status-left,
.status-right {
    display: flex;
    align-items: center;
    gap: 2px;
}

.status-item {
    padding: 0 8px;
    white-space: nowrap;
    cursor: default;
    height: var(--statusbar-height);
    display: flex;
    align-items: center;
}

.status-item:hover {
    background: rgba(255, 255, 255, 0.12);
}

.status-icon {
    margin-right: 4px;
    font-size: 12px;
}

.status-fps {
    font-weight: 600;
}

/* ---- Utility ---- */
.hidden {
    display: none !important;
}

.icon-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    border-radius: 3px;
}

.icon-btn:hover {
    color: var(--text-white);
    background: rgba(255, 255, 255, 0.1);
}

/* ---- Loading Overlay ---- */
#loading {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.95);
    border: 2px solid var(--text-accent);
    border-radius: 8px;
    padding: 24px 32px;
    text-align: center;
    z-index: 2000;
}

#loading.hidden { display: none; }

/* ============================================================
   Responsive: collapse sidebar on narrow screens
   ============================================================ */
@media (max-width: 768px) {
    #ide-shell {
        grid-template-columns: var(--activitybar-width) 0px 0px 1fr;
    }
    #sidebar,
    #sidebar-resize {
        display: none;
    }
    /* Activity bar becomes a toggle for a full-screen overlay sidebar */
}
```

---

## Component Mapping: How Each Zone is Built

### 1. Activity Bar (`#activity-bar`)

**New component: `ActivityBar.js`**

A simple icon strip. Each button has a `data-panel` attribute matching a sidebar panel id. Clicking an activity button:
- If the associated panel is already active and sidebar is visible: collapse the sidebar
- If a different panel is active: switch to the clicked panel
- If sidebar is collapsed: open sidebar to the clicked panel

```javascript
// ActivityBar.js (sketch)
export class ActivityBar {
    constructor(container, sidebar) {
        this._buttons = container.querySelectorAll('.activity-btn');
        this._sidebar = sidebar;
        this._activePanel = 'explorer';

        this._buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const panel = btn.dataset.panel;
                if (panel === this._activePanel && this._sidebar.isVisible()) {
                    this._sidebar.collapse();
                } else {
                    this._sidebar.showPanel(panel);
                    this._setActive(panel);
                }
            });
        });
    }
}
```

Maps to existing Drawer tab buttons. The Drawer's tab-switching logic in `DrawerController.switchTab()` translates directly.

### 2. Sidebar (`#sidebar`)

**Evolution of: `DrawerController`**

The existing `DrawerController` manages tab switching and open/close state. The IDE sidebar differs in that:
- It is always visible (not a slide-out panel)
- It occupies a grid cell, not a `position: fixed` overlay
- There is no scrim or toggle button -- the activity bar controls it
- The collapse behavior simply sets `display: none` and adjusts the grid column to 0px

The sidebar panels map 1:1 to existing Drawer panels:

| Sidebar Panel ID | Source | Existing Drawer Tab |
|---|---|---|
| `sp-explorer` | `filesPanelHTML()` | "Files" tab |
| `sp-search` | New (SearchOverlay moved to sidebar) | -- |
| `sp-repo` | `repoPanelHTML()` | "Repo" tab |
| `sp-diff` | `diffPanelHTML()` | "Diff" tab |
| `sp-settings` | `settingsPanelHTML()` | "Settings" tab |
| `sp-controls` | `controlsPanelHTML()` | "Controls" tab |

**Sidebar resize:** The `#sidebar-resize` handle uses a mousedown/mousemove/mouseup cycle to adjust `--sidebar-width` on `#ide-shell`. Min 180px, max 500px. The handle must call `stopPropagation` to prevent the CameraController from interpreting the drag.

### 3. Tab Bar (`#tab-bar`)

**New component: `EditorTabBar.js`**

Driven by selection state. The tab bar reflects "open files" -- a concept that does not exist today. The SelectionManager tracks selected files but not "open" files. A new lightweight `OpenFilesManager` (or an extension of SelectionManager) maintains an ordered list of opened file paths.

Behavior:
- Clicking a file in the tree "opens" it (adds a tab) and focuses it in 3D
- Selecting a file via canvas click also opens it
- Clicking a tab focuses the camera on that file (calls `cameraController.focusOnGrid`)
- Closing a tab (X button) removes it from the open list; does NOT deselect from 3D
- The active tab matches the primary selection in SelectionManager

```javascript
// EditorTabBar.js (sketch)
export class EditorTabBar {
    constructor(container, selectionManager, cameraController, getGrids) {
        this._container = container;
        this._openFiles = [];  // { path, name }
        this._activePath = null;

        // Sync with selection changes
        selectionManager.onChange((primary, selected) => {
            if (primary && !this._openFiles.find(f => f.path === primary)) {
                this._openFile(primary);
            }
            this._activePath = primary;
            this._render();
        });
    }

    _openFile(path) {
        const name = path.split('/').pop();
        this._openFiles.push({ path, name });
    }

    _closeFile(path) {
        this._openFiles = this._openFiles.filter(f => f.path !== path);
        this._render();
    }
}
```

### 4. Editor Area (`#editor-area` + `<canvas>`)

**Modified: canvas sizing**

Currently the canvas is `100vw x 100vh`. In the IDE layout, it fills the `#editor-area` div. The critical change is in the resize handler:

```javascript
// Before (current):
this.renderer.setSize(window.innerWidth, window.innerHeight);

// After (IDE shell):
const rect = this.editorArea.getBoundingClientRect();
this.renderer.setSize(rect.width, rect.height);
this.camera.aspect = rect.width / rect.height;
this.camera.updateProjectionMatrix();
```

A `ResizeObserver` on `#editor-area` replaces the `window.resize` listener, because sidebar collapse/expand, panel resize, and window resize all change the editor area dimensions.

```javascript
const editorArea = document.getElementById('editor-area');
const resizeObserver = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (width > 0 && height > 0) {
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }
});
resizeObserver.observe(editorArea);
```

### 5. Bottom Panel (`#bottom-panel`)

**Evolution of: Stats panel + LogCapturePanel in Drawer**

The bottom panel has its own tab bar (Output, Console, Search Results, WebSocket). Content:

| Panel View | Source | Existing Component |
|---|---|---|
| `pv-output` | `statsPanelHTML()` content | Stats tab in Drawer |
| `pv-console` | `logCapturePanelHTML()` content | Logs tab in Drawer |
| `pv-search-results` | New: list of search matches with file + line | -- |
| `pv-websocket` | WebSocket command I/O from ws branch | TUIFormatter output |

Toggle: clicking the panel toggle button or pressing `Ctrl+backtick` collapses/expands the panel by adding/removing the `.collapsed` class. The collapsed state sets `height: 0` and the editor area's flex grows to fill the space.

Panel resize: the `#panel-resize` handle adjusts `--panel-height` via mousedown/mousemove/mouseup. Min 100px, max 60% of editor column height.

### 6. Status Bar (`#status-bar`)

**Evolution of: `#fps-badge` + Stats panel values**

The status bar replaces the floating FPS badge and the Stats panel in the drawer. It reads from the same data sources:

| Status Item | Data Source | Update Frequency |
|---|---|---|
| `status-branch` | `this.branchInput.value` or loaded branch | On repo load |
| `status-layout` | `this._activeLayout` | On layout switch |
| `status-file-path` | SelectionManager primary selection path | On selection change |
| `status-glyph-count` | `this.grids` glyph sum | On repo load |
| `status-grid-count` | `this.grids.length` | On repo load |
| `status-camera` | `this.camera.position` | Every frame (throttled to 4Hz) |
| `status-fps` | FPS counter (existing) | Every second |

The `updateStats()` method in GitHubRepoViewer already computes these values; it just needs to write to `#status-*` elements instead of (or in addition to) the drawer's `#stat-*` elements.

### 7. Command Palette

**New component: `CommandPalette.js`** (already designed in UX round 1)

Positioned absolute within `#editor-area`, centered at the top. Triggered by `Cmd+P` / `Ctrl+P` via ShortcutManager. Fuzzy matches against `grid.userData.sourcePath`. Selecting a result:
1. Opens the file as a tab
2. Focuses the camera on the grid
3. Sets it as primary selection

---

## Integration Plan: GitHubRepoViewer Changes

### Phase 1: HTML/CSS scaffold

1. Create `ide-shell.css` with the grid layout above
2. Create `ide-shell.html` replacing `index.html`
3. Create `ide-main.js` as the new entry point (or modify existing inline script)
4. The canvas element moves from being a direct child of `<body>` to being inside `#editor-area`

### Phase 2: Sidebar migration

1. Create `SidebarController.js` -- simplified version of `DrawerController` that manages panel switching without open/close animation (sidebar is always visible)
2. Create `ActivityBar.js` -- wires activity buttons to sidebar panels
3. Move Drawer panel HTML generators (`repoPanelHTML`, `filesPanelHTML`, etc.) to render into sidebar panels instead of drawer panels
4. Remove the floating drawer toggle button, scrim, and drawer handle

### Phase 3: Tab bar + status bar

1. Create `EditorTabBar.js` -- syncs with SelectionManager
2. Update `updateStats()` to write to `#status-*` elements
3. Remove `#fps-badge` (replaced by status bar)
4. Remove Stats panel from sidebar (moved to bottom panel)

### Phase 4: Bottom panel

1. Create `BottomPanel.js` -- tab switching + collapse toggle
2. Move LogCapturePanel content into `pv-console`
3. Move Stats content into `pv-output`
4. Wire Ctrl+backtick to toggle

### Phase 5: Resize handlers

1. Implement sidebar resize via `#sidebar-resize`
2. Implement panel resize via `#panel-resize`
3. Replace `window.resize` with `ResizeObserver` on `#editor-area`

### Phase 6: Command palette

1. Create `CommandPalette.js` inside `#editor-area`
2. Wire `Cmd+P` shortcut

---

## Key Architectural Decisions

### Why CSS Grid (not flexbox) at the outer level

The IDE shell is inherently a 2D layout problem: zones are arranged in both rows and columns. CSS Grid's `grid-template-areas` gives us named zones that map directly to the IDE concept. Flexbox would require nested wrappers (a row for the middle, columns within it) which adds DOM complexity.

### Why the canvas is inside a div, not the grid directly

The `<canvas>` element cannot directly participate in CSS Grid sizing in a useful way -- Three.js needs explicit pixel dimensions from `setSize()`. Wrapping it in `#editor-area` gives us a `position: relative` container for absolute children (minimap, command palette) and a `ResizeObserver` target.

### Why the sidebar replaces the Drawer

The Drawer is a modal overlay that requires the user to explicitly open/close it. An IDE sidebar is always-visible context. The file tree, search, and settings should be glanceable without interaction. The activity bar provides instant switching between contexts. This is the single biggest UX improvement.

### Why the status bar replaces the FPS badge

Floating badges compete for space with the 3D content and have no semantic structure. A status bar is a standard IDE pattern that users know how to scan. Moving FPS, glyph count, camera position, and file path into a single horizontal strip frees up canvas space and creates a predictable information architecture.

### Why the bottom panel hosts logs instead of the sidebar

Logs and search results are temporally-oriented (newest at bottom, scrolling). They belong in a wide horizontal panel where long lines are readable. The sidebar is for tree-structured or form-structured content (file tree, settings). This mirrors VS Code's split: sidebar for navigation, panel for output.

---

## File Inventory (new/modified)

### New Files
```
examples/github-viewer/
    ide-shell.html                     New HTML skeleton
    ide-shell.css                      Full CSS for the IDE layout
    ide-main.js                        New entry point script
    components/
        ActivityBar.js                 Activity bar icon strip controller
        SidebarController.js           Sidebar panel manager (replaces DrawerController for IDE mode)
        EditorTabBar.js                Open file tabs above canvas
        BottomPanel.js                 Collapsible output/console/search panel
        StatusBar.js                   Status bar updater
        ResizeManager.js               Sidebar + panel resize handle logic
```

### Modified Files
```
examples/github-viewer/
    GitHubRepoViewer.js                Canvas sizing via ResizeObserver; status bar wiring;
                                       remove floating FPS badge creation; instantiate new components
    components/Drawer.js               Panel HTML generators reused; DrawerController still available
                                       for mobile/fallback but not used in IDE mode
    components/AppShell.js             createHeader/createFPSBadge may be deprecated in IDE mode
    styles.css                         Retained for non-IDE mode; IDE mode uses ide-shell.css
```

### Preserved Files (no changes)
```
    SelectionManager.js                Works as-is; tab bar listens to its events
    ShortcutManager.js                 Works as-is; new shortcuts registered for panel toggle
    MinimapOverlay.js                  Works as-is; positioned inside #editor-area
    TreemapLabelManager.js             Works as-is
    CameraController.js                Works as-is
    FileStateManager.js                Works as-is
    CodeColorManager.js                Works as-is
```

---

## Sources

Research references consulted for this design:

- [VS Code User Interface documentation](https://code.visualstudio.com/docs/getstarted/userinterface)
- [VS Code Custom Layout documentation](https://code.visualstudio.com/docs/configure/custom-layout)
- [VS Code Workbench layout.ts source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/layout.ts)
- [VS Code Extending Workbench API](https://code.visualstudio.com/api/extension-capabilities/extending-workbench)
- [Atom IDE CSS Grid layout CodePen](https://codepen.io/adrifolio/pen/GvXVgP)
- [MDN Common Grid Layouts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Common_grid_layouts)
- [Eclipse Theia IDE architecture](https://eclipsesource.com/blogs/2018/06/20/welcome-at-eclipse-theia/)
- [VS Code Workbench Grid Layout PR](https://github.com/microsoft/vscode/pull/63066/files/98b6f5a08fb1c9e4b346277ea540a4828df7d621)
