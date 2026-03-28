# Phase 0: TUI Window Interaction Layer

**Agent**: interaction
**Scope**: click-to-focus, character hit testing, keystroke routing, cursor rendering, IDE docking

---

## Architecture Summary

The interaction layer sits between the existing input systems (SelectionManager, ShortcutManager, CameraController) and TUIWindow instances. It introduces a **focus model** where at most one TUIWindow is "active" and receives keystrokes, while all others remain display-only.

### Key Constraint

ShortcutManager captures keydown in the **capture phase** and calls `stopPropagation()`. CameraController listens in the **bubbling phase**. The TUI input handler must insert itself between these: it needs to intercept keys *after* ShortcutManager's global shortcuts but *before* CameraController consumes WASD. The solution is a ShortcutManager-registered "TUI mode" that conditionally swallows all non-shortcut keys when a window is focused.

---

## 1. TUIFocusManager (minimum viable)

Single class that owns focus state, raycasting, and keystroke routing.

```javascript
/**
 * TUIFocusManager -- click-to-focus and keystroke routing for TUI windows.
 *
 * Integrates with:
 * - TUIWindowManager (window registry)
 * - SelectionManager pattern (raycast against _background meshes)
 * - ShortcutManager (keyboard capture)
 * - WebSocketBridge (remote keystroke relay)
 * - CameraController (disabled when a TUI window is focused)
 */

import { CHAR_DIMENSIONS } from '../../src/core/constants.js';

const Z_FOCUS_POP = 2;           // Z lift for focused window
const CURSOR_BLINK_MS = 530;     // Standard terminal blink rate
const FOCUS_BORDER_COLOR = 0x569cd6;  // VS Code blue

export default class TUIFocusManager {
    /**
     * @param {Object} deps
     * @param {THREE} deps.THREE
     * @param {TUIWindowManager} deps.windowManager
     * @param {HTMLCanvasElement} deps.canvas
     * @param {THREE.Camera} deps.camera
     * @param {Object} [deps.cameraController] - disabled when TUI focused
     * @param {Object} [deps.wsBridge] - WebSocketBridge for remote relay
     */
    constructor({ THREE, windowManager, canvas, camera, cameraController, wsBridge }) {
        this._THREE = THREE;
        this._wm = windowManager;
        this._canvas = canvas;
        this._camera = camera;
        this._cameraCtrl = cameraController;
        this._wsBridge = wsBridge;

        this._raycaster = new THREE.Raycaster();

        // Focus state
        this._focusedId = null;       // window ID or null
        this._cursorRow = 0;
        this._cursorCol = 0;
        this._cursorVisible = false;
        this._blinkTimer = null;

        // Cursor mesh (thin vertical bar)
        this._cursorMesh = null;
        this._initCursorMesh();

        // Input buffer for local mode
        this._inputBuffer = '';

        // Visual: border highlight mesh for focused window
        this._focusBorder = null;

        // Listeners (stored for cleanup)
        this._onCanvasClick = this._handleCanvasClick.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._attached = false;
    }

    // ================================================================
    // Lifecycle
    // ================================================================

    attach() {
        if (this._attached) return;
        this._canvas.addEventListener('pointerdown', this._onCanvasClick);
        // Capture phase: after ShortcutManager (which also uses capture),
        // but we register with a LATER priority by appending after it.
        document.addEventListener('keydown', this._onKeyDown, { capture: true });
        this._attached = true;
    }

    detach() {
        if (!this._attached) return;
        this._canvas.removeEventListener('pointerdown', this._onCanvasClick);
        document.removeEventListener('keydown', this._onKeyDown, { capture: true });
        this._stopBlink();
        this._attached = false;
    }

    // ================================================================
    // Focus API
    // ================================================================

    /** @returns {string|null} ID of focused window */
    get focusedId() { return this._focusedId; }

    /**
     * Programmatically focus a window.
     * @param {string} windowId
     */
    focus(windowId) {
        if (this._focusedId === windowId) return;
        this.blur();

        const win = this._wm.get(windowId);
        if (!win) return;

        this._focusedId = windowId;

        // Visual: Z-pop
        win._originalZ = win.grid.position.z;
        win.grid.position.z += Z_FOCUS_POP;

        // Visual: tint background to indicate focus
        if (win.grid._background) {
            win.grid._background.material.color.set(FOCUS_BORDER_COLOR);
            win.grid._background.material.opacity = 0.95;
        }

        // Place cursor at end of content
        this._cursorRow = Math.max(0, win.buffer.findLastIndex(l => l.length > 0));
        this._cursorCol = win.buffer[this._cursorRow]?.length || 0;
        this._updateCursorPosition(win);
        this._startBlink();

        // Disable camera movement
        if (this._cameraCtrl && this._cameraCtrl.enabled !== undefined) {
            this._cameraCtrl._tuiPreviousEnabled = this._cameraCtrl.enabled;
            this._cameraCtrl.enabled = false;
        }

        this._notify('focus', windowId);
    }

    /**
     * Blur (unfocus) the current window.
     */
    blur() {
        if (!this._focusedId) return;
        const win = this._wm.get(this._focusedId);

        if (win) {
            // Restore Z
            if (win._originalZ !== undefined) {
                win.grid.position.z = win._originalZ;
                delete win._originalZ;
            }
            // Restore background
            if (win.grid._background) {
                win.grid._background.material.color.set(win.grid.config.backgroundColor);
                win.grid._background.material.opacity = win.grid.config.backgroundOpacity;
            }
        }

        this._stopBlink();
        if (this._cursorMesh) this._cursorMesh.visible = false;

        // Re-enable camera
        if (this._cameraCtrl && this._cameraCtrl._tuiPreviousEnabled !== undefined) {
            this._cameraCtrl.enabled = this._cameraCtrl._tuiPreviousEnabled;
            delete this._cameraCtrl._tuiPreviousEnabled;
        }

        const oldId = this._focusedId;
        this._focusedId = null;
        this._notify('blur', oldId);
    }

    // ================================================================
    // Click handling -- raycast against TUI window backgrounds
    // ================================================================

    /** @private */
    _handleCanvasClick(e) {
        const rect = this._canvas.getBoundingClientRect();
        const mouse = new this._THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );

        this._raycaster.setFromCamera(mouse, this._camera);

        // Collect all TUI window background meshes
        const backgrounds = [];
        const windowIds = [];
        for (const [id, win] of this._wm.windows) {
            if (win.grid._background && win.grid._background.visible) {
                backgrounds.push(win.grid._background);
                windowIds.push(id);
            }
        }

        const hits = this._raycaster.intersectObjects(backgrounds, false);

        if (hits.length === 0) {
            // Clicked empty space -- blur
            this.blur();
            return;
        }

        // Find which window was hit
        const hitMesh = hits[0].object;
        const hitIdx = backgrounds.indexOf(hitMesh);
        if (hitIdx < 0) return;

        const windowId = windowIds[hitIdx];
        const win = this._wm.get(windowId);
        if (!win) return;

        // Focus the window
        this.focus(windowId);

        // Character-level hit testing
        const hitPoint = hits[0].point;
        const cell = this._worldToCell(hitPoint, win);
        if (cell) {
            this._cursorRow = cell.row;
            this._cursorCol = cell.col;
            this._updateCursorPosition(win);
        }
    }

    // ================================================================
    // Character-level hit testing
    // ================================================================

    /**
     * Convert a world-space hit point to (row, col) in the TUI buffer.
     *
     * CodeGrid lays out text starting at its local origin:
     *   - X increases rightward: col * charWidth
     *   - Y decreases downward: -row * lineHeight
     *   - Filename header occupies row -1 (above content)
     *
     * We transform the world hit into the grid's local space,
     * then divide by character metrics.
     *
     * @param {THREE.Vector3} worldPoint
     * @param {TUIWindow} win
     * @returns {{row: number, col: number}|null}
     */
    _worldToCell(worldPoint, win) {
        // Transform world point into grid's local coordinate system
        const localPoint = win.grid.worldToLocal(worldPoint.clone());

        const cw = win.grid.metrics?.charWidth || CHAR_DIMENSIONS.width;
        const lh = win.grid.metrics?.lineHeight || CHAR_DIMENSIONS.height * 1.2;

        // Filename header offset: if showFilename, content starts 1 line down
        const headerOffset = win.grid.config.showFilename ? 1 : 0;

        // Y is negative-downward in grid space. The first content line
        // starts at y = -(headerOffset * lh). Each subsequent line is -lh.
        const contentY = -localPoint.y - (headerOffset * lh);
        const row = Math.floor(contentY / lh);
        const col = Math.floor(localPoint.x / cw);

        // Clamp to buffer bounds
        if (row < 0 || row >= win.rows || col < 0) return null;
        const clampedCol = Math.min(col, win.buffer[row]?.length || 0);

        return { row, col: clampedCol };
    }

    // ================================================================
    // Keystroke routing
    // ================================================================

    /** @private */
    _handleKeyDown(e) {
        if (!this._focusedId) return;  // No focused window -- let event propagate

        // Let global shortcuts through (Cmd+B, Cmd+J, Cmd+P, Escape)
        if (e.metaKey || e.ctrlKey) return;

        if (e.key === 'Escape') {
            this.blur();
            e.stopPropagation();
            e.preventDefault();
            return;
        }

        // Consume the event -- this window owns the keystroke
        e.stopPropagation();
        e.preventDefault();

        const win = this._wm.get(this._focusedId);
        if (!win) return;

        // Route: if WebSocket connected, send as window.input event
        if (this._wsBridge && this._wsBridge.connected) {
            this._sendKeystrokeRemote(e, win);
        } else {
            this._handleKeystrokeLocal(e, win);
        }
    }

    /**
     * Send keystroke to remote agent via WebSocket.
     * @private
     */
    _sendKeystrokeRemote(e, win) {
        const payload = {
            type: 'window.input',
            windowId: win.id,
            key: e.key,
            code: e.code,
            shift: e.shiftKey,
            alt: e.altKey,
            cursor: { row: this._cursorRow, col: this._cursorCol }
        };

        this._wsBridge.send(JSON.stringify(payload));
    }

    /**
     * Handle keystroke locally: update buffer + cursor.
     * Minimal line editor: printable chars, backspace, enter, arrows.
     * @private
     */
    _handleKeystrokeLocal(e, win) {
        const key = e.key;

        if (key === 'Backspace') {
            if (this._cursorCol > 0) {
                const line = win.buffer[this._cursorRow];
                win.buffer[this._cursorRow] =
                    line.slice(0, this._cursorCol - 1) + line.slice(this._cursorCol);
                this._cursorCol--;
            }
        } else if (key === 'Enter') {
            // Scroll buffer up, insert blank line
            win.buffer.push('');
            if (win.buffer.length > win.rows) {
                win.buffer.shift();
            } else {
                this._cursorRow++;
            }
            this._cursorCol = 0;
        } else if (key === 'ArrowLeft') {
            this._cursorCol = Math.max(0, this._cursorCol - 1);
        } else if (key === 'ArrowRight') {
            this._cursorCol = Math.min(
                win.buffer[this._cursorRow]?.length || 0,
                this._cursorCol + 1
            );
        } else if (key === 'ArrowUp') {
            this._cursorRow = Math.max(0, this._cursorRow - 1);
            this._cursorCol = Math.min(this._cursorCol, win.buffer[this._cursorRow]?.length || 0);
        } else if (key === 'ArrowDown') {
            this._cursorRow = Math.min(win.rows - 1, this._cursorRow + 1);
            this._cursorCol = Math.min(this._cursorCol, win.buffer[this._cursorRow]?.length || 0);
        } else if (key.length === 1) {
            // Printable character
            const line = win.buffer[this._cursorRow] || '';
            if (line.length < win.cols) {
                win.buffer[this._cursorRow] =
                    line.slice(0, this._cursorCol) + key + line.slice(this._cursorCol);
                this._cursorCol++;
            }
        } else {
            return; // Unhandled special key
        }

        // Re-render the TUI window content
        win._render();
        this._updateCursorPosition(win);
    }

    // ================================================================
    // Cursor rendering
    // ================================================================

    /** @private */
    _initCursorMesh() {
        const geo = new this._THREE.PlaneGeometry(0.15, 1.0);
        const mat = new this._THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            depthTest: false,
            side: this._THREE.DoubleSide
        });
        this._cursorMesh = new this._THREE.Mesh(geo, mat);
        this._cursorMesh.renderOrder = 100;  // Draw on top
        this._cursorMesh.visible = false;
    }

    /**
     * Position the cursor mesh at (row, col) in the given window's grid space.
     * @private
     */
    _updateCursorPosition(win) {
        if (!this._cursorMesh) return;

        const cw = win.grid.metrics?.charWidth || CHAR_DIMENSIONS.width;
        const lh = win.grid.metrics?.lineHeight || CHAR_DIMENSIONS.height * 1.2;
        const headerOffset = win.grid.config.showFilename ? 1 : 0;

        // Local-space position within the grid
        const x = this._cursorCol * cw;
        const y = -((this._cursorRow + headerOffset) * lh + lh / 2);
        const z = 1.0;  // In front of text

        // Scale cursor to match line height
        this._cursorMesh.scale.set(1, lh * 0.9, 1);

        // Attach cursor to grid so it transforms with the window
        if (this._cursorMesh.parent !== win.grid) {
            if (this._cursorMesh.parent) this._cursorMesh.parent.remove(this._cursorMesh);
            win.grid.add(this._cursorMesh);
        }

        this._cursorMesh.position.set(x, y, z);
        this._cursorMesh.visible = this._cursorVisible;
    }

    /** @private */
    _startBlink() {
        this._cursorVisible = true;
        if (this._cursorMesh) this._cursorMesh.visible = true;

        this._stopBlink();
        this._blinkTimer = setInterval(() => {
            this._cursorVisible = !this._cursorVisible;
            if (this._cursorMesh) this._cursorMesh.visible = this._cursorVisible;
        }, CURSOR_BLINK_MS);
    }

    /** @private */
    _stopBlink() {
        if (this._blinkTimer) {
            clearInterval(this._blinkTimer);
            this._blinkTimer = null;
        }
    }

    // ================================================================
    // Event system
    // ================================================================

    /** @private */
    _listeners = new Set();

    on(cb) { this._listeners.add(cb); }
    off(cb) { this._listeners.delete(cb); }

    /** @private */
    _notify(event, windowId) {
        const state = { focusedId: this._focusedId, row: this._cursorRow, col: this._cursorCol };
        for (const cb of this._listeners) {
            try { cb(event, windowId, state); } catch (e) { console.error('[TUIFocus]', e); }
        }
    }

    // ================================================================
    // Dispose
    // ================================================================

    dispose() {
        this.detach();
        this.blur();
        if (this._cursorMesh) {
            if (this._cursorMesh.parent) this._cursorMesh.parent.remove(this._cursorMesh);
            this._cursorMesh.geometry.dispose();
            this._cursorMesh.material.dispose();
            this._cursorMesh = null;
        }
        this._listeners.clear();
    }
}
```

---

## 2. Integration Points

### 2a. Wiring into GitHubRepoViewer

After `TUIWindowManager` is created, create the focus manager:

```javascript
this._tuiFocus = new TUIFocusManager({
    THREE,
    windowManager: this._tuiWindowManager,
    canvas: this.renderer.domElement,
    camera: this.camera,
    cameraController: this.cameraController,
    wsBridge: this._wsBridge
});
this._tuiFocus.attach();
```

### 2b. SelectionManager coordination

When a TUI window is focused, the SelectionManager should not also try to select file grids. Add a guard in `SelectionManager.handleClick()`:

```javascript
// At top of handleClick():
if (this._tuiFocusManager?.focusedId) return;  // TUI has focus
```

Or: TUIFocusManager calls `e.stopImmediatePropagation()` on the pointerdown when it hits a TUI background, preventing SelectionManager from seeing it at all.

### 2c. ShortcutManager coexistence

The key ordering matters. ShortcutManager and TUIFocusManager both listen in capture phase. Registration order determines who fires first. ShortcutManager should register first (global shortcuts like Escape, Cmd+B), then TUIFocusManager registers second. TUIFocusManager skips events that have modifier keys (Cmd/Ctrl), letting them reach ShortcutManager's registered handlers. For bare-key events (letters, arrows, Enter, Backspace), TUIFocusManager calls `stopPropagation()` so CameraController never sees them.

### 2d. WebSocket protocol

New message type for the relay:

```json
{
    "type": "window.input",
    "windowId": "term-1",
    "key": "a",
    "code": "KeyA",
    "shift": false,
    "alt": false,
    "cursor": { "row": 5, "col": 12 }
}
```

Remote agents can respond with `window.write` commands through the existing CommandRouter.

---

## 3. IDE Shell Docking (future phase)

A TUI window can be "docked" into the bottom panel as a new tab. This means:

1. Remove the grid from the 3D scene
2. Create a `<canvas>` element inside the panel view
3. Render the TUI window's content as a 2D terminal (either via a second Three.js renderer targeting that canvas, or by falling back to a DOM-based terminal like xterm.js)

This is explicitly **not** in Phase 0. The 3D-to-2D bridge is a separate concern. For now, TUI windows live only in 3D space. The bottom panel's "TERMINAL" tab could show a text-mode mirror of the focused TUI window's buffer using a simple `<pre>` element, which is cheap to implement:

```javascript
// In IDEShell, on TUIFocusManager 'focus' event:
const termView = document.getElementById('pv-terminal');
if (termView) {
    termView.innerHTML = `<pre class="tui-mirror">${win.buffer.join('\n')}</pre>`;
}
```

---

## 4. What this does NOT cover (deferred)

| Feature | Why deferred |
|---|---|
| Text selection (click-drag highlight) | Needs glyph-level color override API on GlyphRenderer |
| Copy/paste | Needs selection first; also clipboard API permissions |
| Scroll within TUI buffer | TUIWindow.buffer is already row-windowed; scroll = shift view offset |
| Multiple cursor support | Complexity; single cursor is sufficient for terminal input |
| xterm.js integration | Requires bridging ANSI escape sequences; separate project |
| Touch/gesture input | Hand tracking adapter exists but needs TUI focus integration |

---

## 5. Critical dimensions for hit testing

From `CodeGrid.js` and `constants.js`:

- **CHAR_DIMENSIONS**: `width=0.6, height=1.0` (fallback; real values come from atlas metrics via `grid.metrics`)
- **lineHeight**: `charHeight * 1.2` (standard)
- **Background mesh**: `PlaneGeometry(1,1)` scaled to content bounds + padding. Position is at content center.
- **Grid local space**: text starts at origin, X right, Y down (negative). Filename header if present shifts content down by one lineHeight.
- **worldToLocal()**: Three.js `Object3D.worldToLocal()` handles all parent transforms (position, rotation, scale) correctly.
