/**
 * InteractionContext — the composable, displayable answer to "what is the user
 * locked into right now?"
 *
 * A DERIVED read-model, not a new owner: AttentionManager keeps sole ownership
 * of its slots; this projects attention + edit state into an ordered list of
 * plain state NODES (innermost-last), each a composable entity:
 *
 *   { kind: 'focus', id, entityType, path }        ← attention.primary (path = full address)
 *   { kind: 'ast',   id, nodeKind, name, label }   ← enclosing scope (fn/class) at the cursor
 *   { kind: 'edit',  id, cursor: { line, col } }   ← key slot on a grid with a live cursor
 *   { kind: 'key',   id, entityType }              ← key slot held elsewhere (terminal capture)
 *
 * The 'ast' chain sits between focus and edit (file › class › method › line:col) —
 * the structural "where am I", from the keyed grid's lazily-built SemanticModel.
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
            const entry = reg?.get?.(primary.id) ?? null;
            // Full flattened address of the focused entity, for the breadcrumb's
            // address bar. Dirs carry it as meta.path (id is the prefixed `dir:<path>`);
            // file grids register under their path as the id, so getFilename — falling
            // back to the id itself — is the path.
            const path = entry?.meta?.path ?? entry?.grid?.getFilename?.() ?? primary.id;
            out.push({ kind: 'focus', id: primary.id, entityType: entry?.type ?? null, path });
        }
        const key = this._am.get('key');
        if (key) {
            const entry = reg?.get?.(key.id) ?? null;
            const cursor = entry?.type === 'grid' ? (entry.grid?.getCursor?.() ?? null) : null;
            if (cursor) {
                // Structural location between the file and the exact cursor
                // (innermost-last): the enclosing scope chain (class › method) from
                // the grid's CACHED model. Absent until ensureSemantics lands — the
                // pre-warm in _refresh kicks that off and re-emits when it does.
                const model = entry.grid.getSemantics?.();
                if (model) {
                    for (const n of model.scopeChainAt(cursor.line, cursor.col)) {
                        out.push({
                            kind: 'ast', id: key.id, nodeKind: n.kind, name: n.name,
                            label: n.name ? `${n.kind} ${n.name}` : n.kind,
                            start: n.start, end: n.end,
                        });
                    }
                }
                out.push({ kind: 'edit', id: key.id, cursor });
            } else {
                out.push({ kind: 'key', id: key.id, entityType: entry?.type ?? null });
            }
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
            // Pre-warm the structural model for the newly-keyed grid (lazy/cached) so
            // the breadcrumb's 'ast' chips can fill; re-emit when the build lands, if
            // the key hasn't moved on.
            if (gridId && entry.grid.ensureSemantics) {
                entry.grid.ensureSemantics()
                    .then(() => { if (this._cursorGridId === gridId) this._emit(); })
                    .catch(() => {});
            }
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
