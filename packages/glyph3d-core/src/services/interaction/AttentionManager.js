/**
 * AttentionManager — single writer for the three-slot attention record.
 *
 * Editable-3d-ide L1-A: prior to this service, scene attention was spread
 * across at least three uncoordinated fields
 *   - ViewerCameraController.input.focus.attendedId (hover)  [removed]
 *   - ctx.mode.readerGridId                         (reader target) [removed]
 *   - commandBar.target (via app/ide.html:303-336 parallel raycaster)
 * each with its own writers and no shared vocabulary. L1 collapses them
 * into one record with one writer per slot:
 *
 *   attention = {
 *     hover:   { id, entity, ts } | null  — raycast-probe driven
 *     primary: { id, entity, ts } | null  — sticky focus (reader mode, etc.)
 *     key:     { id, entity, ts } | null  — keystroke target; new in L1
 *   }
 *   docks = Map<id, { anchor, offset, ts }>  — stubbed empty until L2 lands
 *                                              CameraDock / dock.* verbs
 *
 * Notes on shape:
 *   - Slot values are either null (cleared) or a record with id + entity
 *     + ts. `id` is always a registry id when set; `entity` is the registry
 *     entry ({id, grid, type, meta, ...}) at write time, or null if the
 *     writer didn't have the entry handy (e.g. the hover probe writes id
 *     only — callers that need the entry re-resolve via ctx.registry.get).
 *   - `ts` is performance.now() at write time. Handy for debugging
 *     ("when did reader mode last fire?") and for the billboard attention
 *     fade that wants a monotonically-advancing timestamp.
 *   - 'key' slot spelling matches Ivan's L1 spec. Internally the
 *     convergence docs called it 'keyFocus'; migration writes synonymize
 *     them when convenient but the external verb surface is `key`.
 *
 * No back-compat layer. Every writer and every reader was migrated to
 * ctx.attention.{hover,primary,key}?.id in a single sweep:
 *   - updateWindowBillboards (windowCommands.js) reads ctx.attention
 *   - VCC probe/wheel gates read attentionManager.get('primary')
 *   - mode.* commands read/write attention.primary
 *   - camera.attend is now a thin alias for attention.set primary
 *   - the parallel raycaster at app/ide.html:303-336 went away
 * If you see `focus.attendedId` or `ctx.mode.readerGridId` anywhere
 * it is a bug and a regression — they are removed.
 *
 * Event listeners:
 *   on('change', (slot, value, prev) => ...)  // any slot write
 *   on('change:hover', (v, prev) => ...)
 *   on('change:primary', (v, prev) => ...)
 *   on('change:key', (v, prev) => ...)
 *
 * Not an EventTarget subclass — deliberately minimal, no DOM dep.
 */

const SLOTS = ['hover', 'primary', 'key'];

export class AttentionManager {
    constructor() {
        /** @type {{ hover: object|null, primary: object|null, key: object|null }} */
        this.state = { hover: null, primary: null, key: null };

        /** Enumerable dock map. L2 will populate this via CameraDock.
         *  Kept here (not on CameraDock.docks) so L1 command handlers that
         *  snapshot scene state don't need a second service reference.
         *  @type {Map<string, { anchor: string, offset: object, ts: number }>} */
        this.docks = new Map();

        /** @private @type {Map<string, Array<Function>>} */
        this._listeners = new Map();
    }

    // ============ API ============

    /**
     * Write a slot. `id` may be null or 'none' to clear.
     * The entity ref is looked up via the optional registry arg; callers
     * that already have it can pass it directly via the 3rd arg.
     *
     * @param {'hover'|'primary'|'key'} slot
     * @param {string|null} id - registry id, or null/'none' to clear
     * @param {Object} [opts]
     * @param {Object} [opts.entity] - pre-resolved registry entry
     * @param {Object} [opts.registry] - registry to resolve id → entry
     * @returns {Object|null} the new slot value (null when cleared)
     */
    set(slot, id, opts = {}) {
        if (!SLOTS.includes(slot)) {
            throw new Error(`AttentionManager.set: unknown slot '${slot}' (expected one of ${SLOTS.join(', ')})`);
        }

        const cleared = id == null || id === 'none' || id === '';
        const prev = this.state[slot];

        if (cleared) {
            if (prev == null) return null; // no-op, no event
            this.state[slot] = null;
            this._emit(slot, null, prev);
            return null;
        }

        const entity = opts.entity
            || (opts.registry && typeof opts.registry.get === 'function'
                ? opts.registry.get(id) || null
                : null);

        // Every write emits change:<slot> — INCLUDING re-affirming the same id.
        // Re-selecting/re-clicking a grid is a deliberate signal that dependent
        // consumers (selection box, panels, camera) should re-arm. The old dedup
        // (same id+entity → bump ts, no event) was there to absorb per-frame hover
        // probes that wrote the same id every frame; those callers are gone (the
        // canvas hover loop now dedups upstream via its own last-id guard). The
        // dedup's only remaining effect was swallowing explicit re-selections —
        // "re-clicking the same grid does nothing until you touch another one".
        const value = { id, entity: entity || null, ts: performance.now() };
        this.state[slot] = value;
        this._emit(slot, value, prev);
        return value;
    }

    /**
     * @param {'hover'|'primary'|'key'} slot
     * @returns {Object|null}
     */
    get(slot) {
        return this.state[slot];
    }

    /**
     * Clear one slot (`clear(slot)`) or all slots (`clear()`).
     * @param {'hover'|'primary'|'key'} [slot]
     */
    clear(slot) {
        if (slot === undefined) {
            for (const s of SLOTS) this.set(s, null);
            return;
        }
        this.set(slot, null);
    }

    /**
     * Snapshot of all state. Safe to serialize; values are plain objects.
     * Docks are materialized to an array for JSON clients.
     * @returns {Object}
     */
    info() {
        return {
            hover:   this.state.hover   ? { id: this.state.hover.id,   ts: this.state.hover.ts }   : null,
            primary: this.state.primary ? { id: this.state.primary.id, ts: this.state.primary.ts } : null,
            key:     this.state.key     ? { id: this.state.key.id,     ts: this.state.key.ts }     : null,
            docks:   Array.from(this.docks.entries()).map(([id, d]) => ({ id, ...d })),
        };
    }

    // ============ Events ============

    /**
     * Subscribe. Events: 'change', 'change:hover', 'change:primary', 'change:key'.
     * Callback: (slot, value, prev) for 'change'; (value, prev) for the
     * per-slot variants.
     * @param {string} evt
     * @param {Function} fn
     * @returns {Function} unsubscribe
     */
    on(evt, fn) {
        if (!this._listeners.has(evt)) this._listeners.set(evt, []);
        this._listeners.get(evt).push(fn);
        return () => this.off(evt, fn);
    }

    /** @param {string} evt @param {Function} fn */
    off(evt, fn) {
        const arr = this._listeners.get(evt);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    }

    /** @private */
    _emit(slot, value, prev) {
        const specific = this._listeners.get(`change:${slot}`);
        if (specific) for (const fn of specific) safeCall(fn, value, prev);
        const any = this._listeners.get('change');
        if (any) for (const fn of any) safeCall(fn, slot, value, prev);
    }
}

function safeCall(fn, ...args) {
    try { fn(...args); }
    catch (err) { console.error('[AttentionManager] listener error:', err); }
}

export default AttentionManager;
