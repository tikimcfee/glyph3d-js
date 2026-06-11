/**
 * InteractionContext — the composable, displayable answer to "what is the user
 * locked into right now?"
 *
 * A DERIVED read-model, not a new owner: AttentionManager keeps sole ownership
 * of its slots; this projects attention + edit state into an ordered list of
 * plain state NODES (innermost-last), each a composable entity:
 *
 *   { kind: 'focus', id, entityType }              ← attention.primary
 *   { kind: 'edit',  id, cursor: { line, col } }   ← key slot on a grid with a live cursor
 *   { kind: 'key',   id, entityType }              ← key slot held elsewhere (terminal capture)
 *
 * Future kinds ride the same shape: 'visual' (a selection), 'capture' (greedy
 * terminal passthrough). One source, several consumers: the breadcrumb HUD
 * renders chips 1:1 from nodes, `context.info` exposes them on the bus, gesture
 * resolution reads the innermost node to decide what a click/key means, and
 * binding tables predicate on node kinds (a vim layer's mode system, derived).
 *
 * Events: `on(fn)` → fn(nodes) on every attention change and on the key grid's
 * cursor movement (via CodeGrid.onCursorChange — no polling).
 */
export class InteractionContext {
    /**
     * @param {Object} deps
     * @param {import('./AttentionManager.js').AttentionManager} deps.attentionManager
     * @param {Object} deps.registry - SceneRegistry (get(id) → { id, grid, type, ... })
     */
    constructor({ attentionManager, registry }) {
        this._am = attentionManager;
        this._registry = registry;
        /** @private @type {Set<Function>} */
        this._listeners = new Set();
        this._offCursor = null;
        this._cursorGridId = null;

        const refresh = () => this._refresh();
        this._offs = [
            attentionManager.on('change:primary', refresh),
            attentionManager.on('change:key', refresh),
        ];
        this._refresh();
    }

    /**
     * The current node list, innermost-last. Always a fresh array of plain
     * serializable objects — safe to hand to the bus / JSON clients.
     * @returns {Array<object>}
     */
    nodes() {
        const out = [];
        const reg = this._registry;
        const primary = this._am.get('primary');
        if (primary) {
            out.push({ kind: 'focus', id: primary.id, entityType: reg?.get?.(primary.id)?.type ?? null });
        }
        const key = this._am.get('key');
        if (key) {
            const entry = reg?.get?.(key.id) ?? null;
            const cursor = entry?.type === 'grid' ? (entry.grid?.getCursor?.() ?? null) : null;
            if (cursor) out.push({ kind: 'edit', id: key.id, cursor });
            else out.push({ kind: 'key', id: key.id, entityType: entry?.type ?? null });
        }
        return out;
    }

    /**
     * Subscribe to node-list changes.
     * @param {(nodes: Array<object>) => void} fn
     * @returns {() => void} unsubscribe
     */
    on(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    dispose() {
        for (const off of this._offs) off?.();
        this._offs = [];
        this._offCursor?.();
        this._offCursor = null;
        this._listeners.clear();
    }

    /** @private — retarget the cursor subscription to the key grid, then notify. */
    _refresh() {
        const key = this._am.get('key');
        const entry = key ? this._registry?.get?.(key.id) : null;
        const gridId = (entry?.type === 'grid' && entry.grid?.onCursorChange) ? key.id : null;
        if (gridId !== this._cursorGridId) {
            this._offCursor?.();
            this._offCursor = gridId ? entry.grid.onCursorChange(() => this._emit()) : null;
            this._cursorGridId = gridId;
        }
        this._emit();
    }

    /** @private */
    _emit() {
        if (!this._listeners.size) return;
        const nodes = this.nodes();
        for (const fn of this._listeners) {
            try { fn(nodes); }
            catch (err) { console.error('[InteractionContext] listener error:', err); }
        }
    }
}

export default InteractionContext;
