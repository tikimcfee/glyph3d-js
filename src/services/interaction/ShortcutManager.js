/**
 * ShortcutManager — keyboard shortcut registry
 *
 * Registers shortcuts in the capture phase (before CameraController's
 * bubbling-phase keydown). When a shortcut matches, stopPropagation()
 * prevents CameraController from seeing the key.
 *
 * Guards against misfires:
 * - Never fires when an input/select/textarea is focused
 * - Never fires during IME composition
 * - Shortcuts using bare letter keys (Tab, Enter, Escape, F, M, 1/2/3)
 *   are safe: they don't conflict with WASD camera movement because WASD
 *   uses KeyW/KeyA/KeyS/KeyD codes, not letter values.
 *
 * Usage:
 *   const sm = new ShortcutManager();
 *   sm.register('Escape', () => selectionManager.clear(grids));
 *   sm.register('Tab', () => selectNextFile(), { shift: () => selectPrevFile() });
 *   sm.attach();  // called once after construction
 *   sm.detach();  // on cleanup
 */

import { isMac } from '../utils/platform.js';

export class ShortcutManager {
    constructor() {
        /**
         * Map from normalized key string → handler object
         * Key format: optional modifiers + key name, e.g. "ctrl+p", "shift+tab", "f"
         * @type {Map<string, { action: Function, description: string }>}
         */
        this._handlers = new Map();

        this._onKeyDown = this._handleKeyDown.bind(this);
        this._attached = false;
    }

    // ============ Registration API ============

    /**
     * Register a keyboard shortcut.
     * @param {string} key - Key value (e.g. 'Escape', 'Tab', 'Enter', 'f', '1', '2', '3')
     *   Prefix with 'ctrl+', 'shift+', 'meta+', 'alt+' for modifiers.
     * @param {Function} action - Called when the shortcut fires. Receives the KeyboardEvent.
     * @param {Object} [opts]
     * @param {string} [opts.description] - Human-readable description for help display
     */
    register(key, action, { description = '' } = {}) {
        const normalized = this._normalize(key);
        this._handlers.set(normalized, { action, description });
    }

    /**
     * Unregister a shortcut.
     * @param {string} key
     */
    unregister(key) {
        this._handlers.delete(this._normalize(key));
    }

    /**
     * Attach the keydown listener to document (capture phase).
     * Call once after construction and all register() calls.
     */
    attach() {
        if (this._attached) return;
        document.addEventListener('keydown', this._onKeyDown, { capture: true });
        this._attached = true;
    }

    /**
     * Detach all listeners. Call on cleanup.
     */
    detach() {
        if (!this._attached) return;
        document.removeEventListener('keydown', this._onKeyDown, { capture: true });
        this._attached = false;
    }

    /**
     * Return all registered shortcuts as an array for help display.
     * @returns {Array<{ key: string, description: string }>}
     */
    getShortcuts() {
        return Array.from(this._handlers.entries()).map(([key, h]) => ({
            key,
            description: h.description
        }));
    }

    // ============ Private ============

    /**
     * Core keydown handler. Runs in capture phase before CameraController.
     * @private
     */
    _handleKeyDown(e) {
        // Never fire when input elements are focused
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        // Never fire during IME composition
        if (e.isComposing) return;

        const key = this._eventKey(e);
        const handler = this._handlers.get(key);
        if (!handler) return;

        // Consume the event so CameraController doesn't see it
        e.stopPropagation();
        e.preventDefault();

        try {
            handler.action(e);
        } catch (err) {
            console.error('[ShortcutManager] Action error for key:', key, err);
        }
    }

    /**
     * Build a normalized key string from a KeyboardEvent.
     * @private
     * @param {KeyboardEvent} e
     * @returns {string}
     */
    _eventKey(e) {
        const parts = [];
        // Normalize platform modifiers: on Mac, meta is primary; elsewhere ctrl is.
        // Map both to 'mod' so registered shortcuts work cross-platform.
        if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
        if (e.altKey)   parts.push('alt');
        if (e.shiftKey && e.key !== 'Shift') parts.push('shift');
        // Use e.key for letter/symbol keys, lower-cased for consistency
        parts.push(e.key.toLowerCase());
        return parts.join('+');
    }

    /**
     * Normalize a human-written key string to canonical form.
     * E.g. "Ctrl+P" → "ctrl+p", "Shift+Tab" → "shift+tab"
     * @private
     * @param {string} key
     * @returns {string}
     */
    _normalize(key) {
        // Collapse whitespace first, then map ctrl/meta → mod so registrations
        // like "ctrl+p" or "meta+p" resolve to the same canonical "mod+p".
        return key.toLowerCase().replace(/\s+/g, '')
            .replace(/\b(ctrl|meta)\b/, 'mod');
    }
}

export default ShortcutManager;
