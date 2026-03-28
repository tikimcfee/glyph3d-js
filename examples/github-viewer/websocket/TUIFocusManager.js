/**
 * TUIFocusManager -- click-to-focus and keystroke routing for TUI windows.
 *
 * Integrates with:
 * - TUIWindowManager (window registry)
 * - SelectionManager pattern (raycast against _background meshes)
 * - CameraController (disabled when a TUI window is focused)
 * - WebSocketBridge (remote keystroke relay)
 *
 * All cursor state lives on TUIWindow (single source of truth).
 * This class reads/writes via win.setCursor() and win.getCursor().
 * All buffer edits go through TUIWindow's public editing API:
 *   win.insertChar(), win.deleteChar(), win.splitLine(), win.getLine(), win.setLine()
 */

import { CHAR_DIMENSIONS } from '../../../src/core/constants.js';

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
        this._mouseVec = new THREE.Vector2();  // reused per click

        // Focus state
        this._focusedId = null;       // window ID or null
        this._cursorVisible = false;
        this._blinkTimer = null;

        // Cursor mesh (thin vertical bar)
        this._cursorMesh = null;
        this._initCursorMesh();

        // Listeners (stored for cleanup)
        this._onCanvasClick = this._handleCanvasClick.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._attached = false;

        // Event listeners
        this._listeners = new Set();
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
        this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this._attached = true;
    }

    detach() {
        if (!this._attached) return;
        this._canvas.removeEventListener('pointerdown', this._onCanvasClick);
        document.removeEventListener('keydown', this._onKeyDown, { capture: true });
        this._canvas.removeEventListener('wheel', this._onWheel);
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
            // Save original background state for restore on blur
            win._originalBgColor = win.grid._background.material.color.getHex();
            win._originalBgOpacity = win.grid._background.material.opacity;
            win.grid._background.material.color.set(FOCUS_BORDER_COLOR);
            win.grid._background.material.opacity = 0.95;
        }

        // Place cursor at end of content via TUIWindow's public API
        const lines = win.getVisibleLines();
        let lastRow = lines.length - 1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].length > 0) { lastRow = i; break; }
        }
        const row = Math.max(0, lastRow);
        win.setCursor(row, lines[row]?.length ?? 0);

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
                if (win._originalBgColor !== undefined) {
                    win.grid._background.material.color.set(win._originalBgColor);
                    delete win._originalBgColor;
                }
                if (win._originalBgOpacity !== undefined) {
                    win.grid._background.material.opacity = win._originalBgOpacity;
                    delete win._originalBgOpacity;
                }
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
        this._mouseVec.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );

        this._raycaster.setFromCamera(this._mouseVec, this._camera);

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
            win.setCursor(cell.row, cell.col);
            this._updateCursorPosition(win);
        }

        // Prevent SelectionManager from also handling this click
        e.stopImmediatePropagation();
    }

    // ================================================================
    // Character-level hit testing
    // ================================================================

    /**
     * Convert a world-space hit point to (row, col) in the TUI visible window.
     *
     * CodeGrid lays out text starting at its local origin:
     *   - X increases rightward: col * charWidth
     *   - Y decreases downward: -row * lineHeight
     *   - Filename header occupies row -1 (above content)
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
        const lineLen = win.getLine(row)?.length || 0;
        const clampedCol = Math.min(col, lineLen);

        return { row, col: clampedCol };
    }

    // ================================================================
    // Keystroke routing
    // ================================================================

    /** @private */
    _handleKeyDown(e) {
        if (!this._focusedId) return;  // No focused window -- let event propagate

        // Let modifier combos through (Cmd+B, Cmd+J, Ctrl+C, etc.)
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

        // Handle scroll keys
        if (e.key === 'PageUp') {
            win.scrollUp(win.rows);
            win.markDirty();
            this._updateCursorPosition(win);
            return;
        }
        if (e.key === 'PageDown') {
            win.scrollDown(win.rows);
            win.markDirty();
            this._updateCursorPosition(win);
            return;
        }

        // Route: if WebSocket connected, send as window.input event
        if (this._wsBridge && this._wsBridge.connected) {
            this._sendKeystrokeRemote(e, win);
        } else {
            this._handleKeystrokeLocal(e, win);
        }
    }

    /**
     * Handle mouse wheel on focused window: scroll content.
     * @private
     */
    _handleWheel(e) {
        if (!this._focusedId) return;
        const win = this._wm.get(this._focusedId);
        if (!win) return;

        e.preventDefault();
        const lines = Math.round(Math.abs(e.deltaY) / 30) || 1;
        if (e.deltaY < 0) {
            win.scrollUp(lines);
        } else {
            win.scrollDown(lines);
        }
        win.markDirty();
        this._updateCursorPosition(win);
    }

    /**
     * Send keystroke to remote agent via WebSocket.
     * @private
     */
    _sendKeystrokeRemote(e, win) {
        const cursor = win.getCursor();
        const payload = {
            type: 'window.input',
            windowId: win.id,
            key: e.key,
            code: e.code,
            shift: e.shiftKey,
            alt: e.altKey,
            cursor: { row: cursor.row, col: cursor.col }
        };

        this._wsBridge.send(JSON.stringify(payload));
    }

    /**
     * Handle keystroke locally: update buffer + cursor via TUIWindow public API.
     * Minimal line editor: printable chars, backspace, enter, arrows.
     * @private
     */
    _handleKeystrokeLocal(e, win) {
        const key = e.key;
        const cursor = win.getCursor();
        const row = cursor.row;
        const col = cursor.col;

        if (key === 'Backspace') {
            win.deleteChar(row, col);
        } else if (key === 'Delete') {
            // Delete character at cursor (forward delete)
            const line = win.getLine(row);
            if (col < line.length) {
                win.setLine(row, line.slice(0, col) + line.slice(col + 1));
                // Cursor stays in place
            }
        } else if (key === 'Enter') {
            win.splitLine(row, col);
        } else if (key === 'ArrowLeft') {
            win.setCursor(row, Math.max(0, col - 1));
        } else if (key === 'ArrowRight') {
            const lineLen = win.getLine(row)?.length || 0;
            win.setCursor(row, Math.min(lineLen, col + 1));
        } else if (key === 'ArrowUp') {
            const newRow = Math.max(0, row - 1);
            const lineLen = win.getLine(newRow)?.length || 0;
            win.setCursor(newRow, Math.min(col, lineLen));
        } else if (key === 'ArrowDown') {
            const newRow = Math.min(win.rows - 1, row + 1);
            const lineLen = win.getLine(newRow)?.length || 0;
            win.setCursor(newRow, Math.min(col, lineLen));
        } else if (key === 'Home') {
            win.setCursor(row, 0);
        } else if (key === 'End') {
            const lineLen = win.getLine(row)?.length || 0;
            win.setCursor(row, lineLen);
        } else if (key.length === 1) {
            // Printable character
            win.insertChar(row, col, key);
        } else {
            return; // Unhandled special key
        }

        // Trigger coalesced render
        win.markDirty();
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
     * Position the cursor mesh at the current cursor pos in the given window's grid space.
     * Reads cursor from win.getCursor() (TUIWindow is source of truth).
     * @private
     */
    _updateCursorPosition(win) {
        if (!this._cursorMesh) return;

        const cursor = win.getCursor();
        const cw = win.grid.metrics?.charWidth || CHAR_DIMENSIONS.width;
        const lh = win.grid.metrics?.lineHeight || CHAR_DIMENSIONS.height * 1.2;
        const headerOffset = win.grid.config.showFilename ? 1 : 0;

        // Local-space position within the grid
        const x = cursor.col * cw;
        const y = -((cursor.row + headerOffset) * lh + lh / 2);
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

    /**
     * Subscribe to focus/blur events.
     * @param {Function} cb - (event, windowId, state) => void
     */
    on(cb) { this._listeners.add(cb); }

    /**
     * Unsubscribe from focus/blur events.
     * @param {Function} cb
     */
    off(cb) { this._listeners.delete(cb); }

    /** @private */
    _notify(event, windowId) {
        const win = this._wm.get(this._focusedId || windowId);
        const cursor = win ? win.getCursor() : { row: 0, col: 0 };
        const state = { focusedId: this._focusedId, row: cursor.row, col: cursor.col };
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
