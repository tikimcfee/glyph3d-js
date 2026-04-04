# Phase 0: CodeGrid Pattern Analysis

Agent perspective: how CodeGrid works as a source-file primitive and what minimal wrapper turns it into an "agent window."

---

## 1. Minimal CodeGrid Lifecycle

The complete lifecycle for creating a grid, loading text, and adding it to the scene:

```js
// Prerequisites: scene (THREE.Scene), atlas (GlyphAtlas) already exist
const grid = new CodeGrid(scene, atlas, {
    name: 'my-grid',
    showFilename: true,
    textColor: { r: 0, g: 1, b: 0 },
});

// Load content (sync or async)
grid.loadFile('status.txt', 'Hello world\nLine two');
// or: await grid.loadFileAsync('status.txt', content);

// Position in 3D space
grid.position.set(x, y, z);

// Add to scene graph
scene.add(grid);
```

Teardown:

```js
scene.remove(grid);
grid.dispose();  // disposes GlyphCollection + background mesh
```

That's it. Five calls to create, one to destroy. CodeGrid extends `THREE.Object3D`, so `scene.add(grid)` works directly.

### How GitHubRepoViewer does it (the production pattern)

```js
// 1. Create grid
const grid = new CodeGrid(this.scene, this.atlas);

// 2. Wire picking BEFORE load (so flush auto-registers)
grid.getCollection().setPickingSystem(this.pickingSystem);

// 3. Load content (async worker path)
await grid.loadFileAsync(filename, content);

// 4. Store metadata
grid.userData.sourcePath = path;

// 5. Add to scene
this.scene.add(grid);

// 6. Register with scene registry
this.registry.register(sourcePath, grid, {
    type: 'grid',
    sourcePath: path,
});

// 7. Layout (positions the grid)
this.layoutManager.layoutGrids(grids);

// 8. Register with virtualizer (after layout, so bounds are valid)
this.gridVirtualizer.registerAll(grids);
```

Steps 2, 6, 7, 8 are optional depending on requirements.

---

## 2. How CodeGrid Handles Text Updates

**Full replace only.** There is no append API on CodeGrid.

`loadText(text)` and `loadTextAsync(text)` both:
1. Store `this.content = text`
2. Call `_clearContent()` -- removes all existing text entries from the GlyphCollection, flushes removals
3. Call `_layoutContent()` / `_layoutContentAsync()` -- adds all text as new entries, flushes to GPU
4. Call `_updateBackground()` -- resizes the background plane to match new content bounds

The `clear()` method wipes everything and resets state.

There is no incremental append. Every text change is a full replace cycle: clear old buffer entries, add new ones, flush to GPU. This is the same pattern TUIWindow uses internally -- `_render()` calls `grid.loadFile(title, content)` on every dirty frame.

**Cost of full replace:** For typical agent output (a few hundred lines), the cost is negligible. The worker path handles it in a single serialization. At 50K characters the async path takes ~5ms. The concern would be at 100K+ characters, but agent windows won't reach that.

---

## 3. What TUIWindow Adds Over CodeGrid

Feature-by-feature breakdown:

| TUIWindow Feature | CodeGrid Has It? | Agent Grid Needs It? |
|---|---|---|
| **Identity (id, title)** | `name` property only | Yes -- need stable ID for command routing |
| **write(text)** (full replace) | `loadText()` / `loadFile()` | Yes -- direct mapping |
| **appendLine(text)** | No | Yes -- primary I/O mode for streaming agent output |
| **clear()** | `clear()` | Yes -- direct mapping |
| **History buffer** (`_history[]`) | No -- stores `content` string | Maybe -- useful for scroll-back, but adds complexity |
| **Scrolling** (scrollUp/Down/ToBottom) | No | Not initially -- can add later if needed |
| **Fixed dimensions** (cols x rows) | No -- content determines size | No -- let grids grow freely (per project memory: "TUI windows should grow freely in 3D") |
| **Line wrapping** (`_pushWrapped`) | No -- text wraps in Z-depth via builder | No -- Z-wrap is the 3D-native approach |
| **Cursor tracking** (row/col) | No | No -- agent windows are output-only, not editable |
| **Character-level editing** (insertChar, deleteChar, splitLine) | No | No -- agents write complete text, not keystrokes |
| **ANSI stripping** | No | Yes -- agents may emit ANSI escape codes |
| **Dirty-flag rendering** (`_dirty`, `_lastRenderedContent`) | No | Yes -- avoids redundant GPU uploads on identical content |
| **Scene addition** (constructor does `scene.add`) | No -- caller does it | Wrapper should do it for convenience |
| **Background styling** | Yes (built-in) | Yes -- already there |
| **Scale control** | Yes (`gridScale` config) | Yes -- already there |
| **Dispose** | Yes | Yes -- plus scene removal |

**Summary:** TUIWindow's terminal emulation features (fixed dimensions, cursor, char editing, line wrapping, scroll viewport) are unnecessary. The valuable parts are: identity, append, dirty tracking, ANSI stripping, and auto scene management.

---

## 4. AgentGrid Wrapper Sketch

```js
import CodeGrid from '../collections/CodeGrid.js';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export default class AgentGrid {
    /**
     * @param {string} id - Stable identifier (used for registry + commands)
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} [options]
     * @param {string} [options.title]
     * @param {Object} [options.color]   - {r,g,b} text color
     * @param {number} [options.scale]   - grid scale (default 1.0)
     * @param {Object} [options.position] - {x,y,z}
     */
    constructor(id, scene, atlas, options = {}) {
        this.id = id;
        this.scene = scene;
        this.title = options.title || id;

        // Content buffer -- just an array of strings
        this._lines = [];
        this._dirty = false;
        this._lastRenderedContent = '';

        // The underlying CodeGrid (does all the real work)
        this.grid = new CodeGrid(scene, atlas, {
            name: `agent-${id}`,
            showFilename: true,
            filenameColor: { r: 0.8, g: 0.8, b: 0.2 },
            textColor: options.color || { r: 0, g: 1, b: 0 },
            gridScale: options.scale || 1.0,
        });

        if (options.position) {
            this.grid.position.set(
                options.position.x || 0,
                options.position.y || 0,
                options.position.z || 0,
            );
        }

        scene.add(this.grid);
    }

    // -- Content API --

    /** Replace all content. */
    setText(text) {
        this._lines = text.replace(ANSI_RE, '').split('\n');
        this._markDirty();
    }

    /** Append one or more lines (streaming output). */
    appendText(text) {
        const cleaned = text.replace(ANSI_RE, '');
        this._lines.push(...cleaned.split('\n'));
        this._markDirty();
    }

    /** Clear all content. */
    clear() {
        this._lines = [];
        this._markDirty();
    }

    /** Set title (shown as filename label). */
    setTitle(title) {
        this.title = title;
        this._markDirty();
    }

    // -- Spatial --

    setPosition(x, y, z) { this.grid.position.set(x, y, z); }
    getPosition() {
        const p = this.grid.position;
        return { x: p.x, y: p.y, z: p.z };
    }
    setScale(s) { this.grid.scale.setScalar(s); }

    // -- Lifecycle --

    dispose() {
        this.scene.remove(this.grid);
        this.grid.dispose();
        this.grid = null;
    }

    // -- Internal --

    _markDirty() {
        if (this._dirty) return;
        this._dirty = true;
        requestAnimationFrame(() => this._render());
    }

    _render() {
        this._dirty = false;
        const content = this._lines.join('\n');
        if (content === this._lastRenderedContent) return;
        this.grid.loadFile(`[${this.title}]`, content);
        this._lastRenderedContent = content;
    }
}
```

**State beyond CodeGrid:** `id`, `title`, `_lines[]`, `_dirty`, `_lastRenderedContent`. That's five fields. The class is ~80 lines. It's a thin identity + I/O envelope around CodeGrid, not a separate rendering layer.

**Key design choice:** No fixed dimensions. No scroll viewport. Content grows freely. The 3D camera IS the scroll mechanism. This aligns with the project memory note: "TUI windows should grow freely in 3D."

---

## 5. Positioning Strategy

**Agent grids should NOT join HierarchicalLayoutManager.** That layout is for source files organized by directory structure. Agent windows are ephemeral output panes with different spatial semantics.

Options, in order of simplicity:

1. **Fixed offset from source grids.** Place agent windows in a dedicated region (e.g., negative X from the source tree). A simple auto-stacker like TUIWindowManager's `_nextY` / `_nextX` logic is sufficient.

2. **Attached to a source grid.** An agent analyzing `foo.js` could position itself adjacent to that grid. Use `sourceGrid.getBounds()` to compute an offset.

3. **Separate "layer" concept.** Not a rendering layer -- just a spatial convention. Agent grids live at Z=+50 or X=-200, clearly separated from source content.

Recommendation: option 1 for the initial implementation, with option 2 as an enhancement when agents reference specific files.

The auto-stacker from TUIWindowManager is 6 lines of state and works fine:

```js
_nextY = 50;
_nextX = -100;
_stackSpacing = 30;
// On each create: assign position, advance _nextY, wrap to next column
```

---

## 6. Registration Requirements

| System | Source Grids | Agent Grids | Why |
|---|---|---|---|
| **SceneRegistry** | Yes (type: 'grid') | Yes (type: 'agent') | Command routing needs to find them by ID. Registry already supports the 'agent' type. |
| **PickingSystem** | Yes | Optional | If you want click-to-select on agent output, wire it. Otherwise skip -- agent windows are passive display. |
| **GridVirtualizer** | Yes | No (initially) | Agent windows are few (3-10). Frustum culling saves nothing. Add them to the scene directly and leave them there. If agent count grows to 50+, reconsider. |
| **LayoutManager** | Yes | No | Agent grids use their own positioning (see section 5). |

Registration in the command handler:

```js
registry.register(id, agentGrid.grid, {
    type: 'agent',
    agentId: id,
    title: agentGrid.title,
});
```

Teardown:

```js
registry.unregister(id);
agentGrid.dispose();
```

---

## 7. Atlas Sharing

CodeGrid receives the atlas as a constructor argument: `new CodeGrid(scene, atlas, ...)`. The atlas is created once by the application (GitHubRepoViewer or IDEShell) and passed to every grid. Agent grids use the exact same atlas instance -- no special handling needed.

The atlas auto-grows when new codepoints are encountered. If an agent emits Unicode that source files didn't contain, the atlas's `ensureCodepoints()` handles it transparently during the next flush.

```js
// Same atlas used everywhere
const atlas = new GlyphAtlas();
await atlas.generate();

// Source grids
const sourceGrid = new CodeGrid(scene, atlas);

// Agent grids -- same atlas
const agentGrid = new AgentGrid('agent-1', scene, atlas);
```

No sharing concern. The atlas is already a shared singleton in practice.

---

## Summary

CodeGrid is 95% of what an agent window needs. The missing 5% is:

1. **Identity** (id, title) -- 2 fields
2. **Append** (accumulate lines, flush on next frame) -- 1 method + 1 array
3. **Dirty coalescing** (skip identical re-renders) -- 1 flag + 1 string
4. **ANSI stripping** -- 1 regex
5. **Auto scene management** (add on create, remove on dispose) -- 2 calls

Total wrapper: ~80 lines, zero new rendering concepts. The command system (windowCommands.js) is ~230 lines and maps 1:1 onto the new API with trivial changes (replace `TUIWindowManager` with an `AgentGridManager` that has the same shape).

The TUI layer's terminal emulation (cursor, char editing, fixed viewport, line wrapping, scroll offset) is dead weight for agent output. Drop it entirely.
