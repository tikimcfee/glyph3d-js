/**
 * GlyphEvents - Event types and lightweight event bus for glyph interaction.
 *
 * No DOM or Three.js imports — safe to use anywhere.
 *
 * Event shape (all types):
 *   { type, bufferSlotIndex, renderer, slotIndex, semanticInfo }
 *
 * Example:
 *   const bus = new GlyphEventBus();
 *   bus.on(GlyphEventType.HOVER_ENTER, e => {
 *     renderer.setGlyphHighlight(e.slotIndex, { r: 0.3, g: 0.3, b: 0 });
 *   });
 *   bus.on(GlyphEventType.HOVER_EXIT, e => {
 *     renderer.setGlyphHighlight(e.slotIndex, null);
 *   });
 */

/**
 * Canonical event type strings for glyph interaction.
 * @enum {string}
 */
export const GlyphEventType = Object.freeze({
    HOVER_ENTER: 'glyph:hover:enter',
    HOVER_EXIT:  'glyph:hover:exit',
    CLICK:       'glyph:click',
});

/**
 * Minimal event bus backed by Map<type, Set<fn>>.
 * Supports multiple listeners per event type.
 */
export class GlyphEventBus {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Subscribe to an event type.
     * @param {string} type - One of GlyphEventType values
     * @param {Function} fn - Listener function
     */
    on(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }

    /**
     * Unsubscribe a listener.
     * @param {string} type
     * @param {Function} fn
     */
    off(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }

    /**
     * Emit an event to all listeners of the given type.
     * @param {string} type
     * @param {Object} event - Event payload
     */
    emit(type, event) {
        this._listeners.get(type)?.forEach(fn => fn(event));
    }
}
