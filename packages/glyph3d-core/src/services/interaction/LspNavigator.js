/**
 * LspNavigator — the presentation-agnostic model for "where does the symbol at
 * the caret resolve?"
 *
 * Owns the definition + references (each carrying a source-line preview from the
 * relay) for the focused symbol, a selection cursor, and the debounced query that
 * keeps them current. Several views render the SAME model by subscribing to
 * on(state): the breadcrumb summary, a 2D results panel, a 3D peek modal. The
 * view decides the skin; this owns the data and the selection.
 *
 * Layered on InteractionContext (the upstream caret model): it reacts to the
 * 'edit' node, so it tracks the caret without its own cursor plumbing. A result
 * whose caret has moved on drops itself (signature guard) — empty ≠ stale.
 *
 * State shape (state()):
 *   { status: 'idle'|'ready', origin: {gridId,uri,line,col}|null,
 *     def: Item|null, refs: Item[], refsTotal: number, selection: number }
 *   Item = { uri, sL, sC, eL, eC, label, preview }
 */

const DEBOUNCE_MS = 280; // let the caret settle before a round-trip to the server

function idleState() {
    return { status: 'idle', origin: null, def: null, refs: [], refsTotal: 0, selection: -1 };
}

/** lsp/* location { uri, range, preview } → a flat, view-ready item. */
function toItem(loc) {
    if (!loc?.uri || !loc.range?.start) return null;
    const { start, end } = loc.range;
    const base = String(loc.uri).split('/').pop() || loc.uri;
    return {
        uri: loc.uri,
        sL: start.line, sC: start.character,
        eL: end?.line ?? start.line, eC: end?.character ?? start.character,
        label: `${base}:${start.line + 1}`, // 1-based line for humans
        preview: loc.preview || '',
    };
}

export class LspNavigator {
    /**
     * @param {Object} deps
     * @param {import('./InteractionContext.js').InteractionContext} deps.interactionContext
     * @param {Object} deps.registry - SceneRegistry (get(id) → { id, grid, type, ... })
     * @param {Object} [deps.lsp] - RemoteLspProvider (definition/references)
     */
    constructor({ interactionContext, registry, lsp = null }) {
        this._registry = registry;
        this._lsp = lsp;
        this._listeners = new Set();
        this._timer = null;
        this._sig = null; // caret signature of the in-flight / current query
        this._state = idleState();
        this._off = interactionContext.on((nodes) => this._onContext(nodes));
        this._onContext(interactionContext.nodes());
    }

    /** Wire the LSP provider after construction, if it wasn't passed in. */
    setLsp(lsp) { this._lsp = lsp; }

    /** Current model snapshot — what views render. */
    state() { return this._state; }

    /** Flat selectable list: the definition (if any) then the references. */
    items() {
        const s = this._state;
        return s.def ? [s.def, ...s.refs] : s.refs.slice();
    }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    dispose() {
        this._off?.();
        clearTimeout(this._timer);
        this._listeners.clear();
    }

    // ---- selection (for the panel / peek views; the breadcrumb ignores it) ----

    select(i) {
        const items = this.items();
        if (!items.length) return;
        const sel = Math.max(0, Math.min(items.length - 1, i | 0));
        if (sel !== this._state.selection) { this._state = { ...this._state, selection: sel }; this._emit(); }
    }
    next() { this.select((this._state.selection < 0 ? -1 : this._state.selection) + 1); }
    prev() { this.select((this._state.selection < 0 ? this.items().length : this._state.selection) - 1); }
    current() { return this.items()[this._state.selection] ?? null; }

    // ---- query driven by the caret (InteractionContext 'edit' node) ----

    /** @private */
    _onContext(nodes) {
        const edit = nodes.find((n) => n.kind === 'edit');
        const entry = edit ? this._registry?.get?.(edit.id) : null;
        const grid = entry?.type === 'grid' ? entry.grid : null;
        const uri = grid?.getSourcePath?.();
        if (!this._lsp || !edit || !grid || !uri) { this._toIdle(); return; }
        const cur = edit.cursor;
        const sig = `${edit.id}:${cur.line}:${cur.col}`;
        if (sig === this._sig) return; // already querying / already have this spot
        this._sig = sig;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._run(sig, grid, cur, uri, edit.id), DEBOUNCE_MS);
    }

    /** @private */
    _toIdle() {
        this._sig = null;
        clearTimeout(this._timer);
        if (this._state.status !== 'idle') { this._state = idleState(); this._emit(); }
    }

    /** @private — run definition+references for (grid, cursor); publish if still current. */
    async _run(sig, grid, cur, uri, gridId) {
        if (this._sig !== sig) return;
        const lineText = grid.lines?.[cur.line] ?? '';
        const character = [...lineText].slice(0, cur.col).join('').length; // codepoint → UTF-16
        const text = grid.getContent?.();
        let def = null, refs = [];
        try {
            const [d, r] = await Promise.all([
                this._lsp.definition(uri, cur.line, character, text).catch(() => null),
                this._lsp.references(uri, cur.line, character, text).catch(() => null),
            ]);
            if (this._sig !== sig) return; // caret moved while in-flight → drop
            def = (d?.locations || []).map(toItem).filter(Boolean)[0] ?? null;
            refs = (r?.locations || []).map(toItem).filter(Boolean);
        } catch {
            return;
        }
        if (this._sig !== sig) return;
        this._state = {
            status: 'ready',
            origin: { gridId, uri, line: cur.line, col: cur.col },
            def, refs, refsTotal: refs.length, selection: -1,
        };
        this._emit();
    }

    /** @private */
    _emit() {
        const st = this._state;
        for (const fn of this._listeners) {
            try { fn(st); }
            catch (err) { console.error('[LspNavigator] listener error:', err); }
        }
    }
}

export default LspNavigator;
