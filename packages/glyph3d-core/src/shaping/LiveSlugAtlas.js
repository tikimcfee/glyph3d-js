/**
 * LiveSlugAtlas — the live, growable Slug curve atlas.
 *
 * The renderer draws glyphs from two textures: a curve texture (quadratic beziers) and a
 * glyph-map texture (slot → curve range, or → emoji cell). This class owns them (through
 * SlugTextures), the set of live fields that draw from them, and their GROWTH: when a grid
 * meets a glyph that isn't encoded yet it calls ensureGlyphsEncoded()/ensureCodepoints(), and
 * the glyph is encoded OFF the main thread and lands a little later.
 *
 * The growth contract (what a caller can rely on):
 *
 *   1. Slots are synchronous. A codepoint's slot comes from the shaper (FontChain /
 *      MonospaceShapeCache) the moment it is looked up, and never changes; a cell writes that
 *      slot into its instance buffer straight away.
 *   2. ensure*() never blocks. It reserves the slot's glyph-map texel (an all-zero entry) and
 *      queues the glyph; the queue goes to the encode worker (SlugEncodeWorker, its own
 *      HarfBuzz) as one batch per task.
 *   3. In flight, a cell draws BLANK: its glyph-map texel is all zero (mode 0, no curves), the
 *      shader's empty-glyph case — the cell's background/fill still paints, no ink. A new emoji
 *      is the same: its map entry is written at once, but its atlas cell is transparent until
 *      EmojiAtlas's raster lands.
 *   4. On landing the curves are copied into the textures' spare capacity and ONLY the touched
 *      texels upload (rectangles on the texture objects every field already holds, queued on
 *      the TextureUploads the renderer seam flushes before the next frame). The cell needs no
 *      rewrite: the slot it holds now resolves to ink on the next frame.
 *   5. `onGlyphsReady(cb)` fires once per landed batch (outlines encoded, or emoji pixels
 *      rasterized) with { slots, codepoints, version } — for callers that cache anything per
 *      glyph or render on demand. Nothing needs it to draw correctly.
 *   6. A SPRITE slot (a codepoint the terminal draws itself: FontChain.isSpriteSlot) is never in
 *      flight: its outline is generated to its family's cell right here (cellSprites — a few
 *      rectangles) and lands in the same textures before ensure*() returns. It is not persisted
 *      as growth (it is regenerated; the core cache holds the core's).
 *   7. A COMPOSITE slot (a shaped cluster — a base and its combining marks: FontChain.compositeOf)
 *      is encoded by the worker from its parts like any outline, and is not persisted either (a
 *      slot is its cluster's shaping, redone when the cluster is next seen).
 *
 * A texture is REBORN only when its array doubles (it fills its capacity): then every
 * registered field gets setSlugData() with the new pair — rare and amortized, never per glyph —
 * and the old texture's rows are copied into the new one on the GPU, not re-sent.
 *
 * Runtime growth PERSISTS: the glyphs learned after boot (not the core) are handed to
 * `persist.save` (debounced) as records keyed by font glyph, and boot hydrates them back
 * (hydrateGrowth) right after the core — see slugCoreCache. Every growth logs its source
 * (codepoint → font:glyph), so a missing core glyph is bakeable, not a mystery.
 */

import SlugTextures from './SlugTextures.js';
import { CURVE_U32_PER_CURVE, COMPOSITE_PART_STRIDE } from './slug-constants.js';
import { encodeSprites } from './cellSprites.js';
import { loadStats } from '../core/loadStats.js';
import { cellText } from '../core/cellClusters.js';

/** The glyph-map mode a cell sprite draws in (core/glyphMaterial.js GLYPH_MODE.SPRITE; shaping imports no three). */
const SPRITE_MODE = 3;

/** Growth tuning, born configurable (LiveSlugAtlas options override). */
export const ATLAS_GROWTH = Object.freeze({
    /** quiet time after the last growth before the grown glyphs are persisted */
    persistDebounceMs: 1500,
});

/**
 * @typedef {Object} GlyphsReady
 * @property {number[]} slots       slots that just became drawable
 * @property {number[]} codepoints  the codepoints that asked for them (where known; the core's
 *   boot encode and hydrated growth have none)
 * @property {number} version       the atlas version after the landing
 */

export default class LiveSlugAtlas {
    /**
     * @param {Object}   opts
     * @param {Object}   opts.atlas        - GlyphAtlas the fields read `_slugData` off of.
     * @param {Object}   opts.shaper       - FontChain: slot routing (slotSource / slotFor /
     *           isBitmapSlot / emojiCellOf / bitmapSlotOf / isSpriteSlot / spriteFamilyOf /
     *           compositeOf / describeSlot).
     * @param {{encode:(items:Uint32Array, composites?:Int32Array|null)=>Promise<{batch:Object, ms:number}>, dispose?:()=>void}} opts.encoder
     *           - the off-thread encoder (SlugEncodeClient)
     * @param {import('../core/TextureUploads.js').default} opts.uploads - the texture-upload queue
     *           the renderer seam flushes (shared with the emoji atlas)
     * @param {Object}   [opts.initialDescriptor] - a slug-core descriptor (the cache) to hydrate;
     *           without one the atlas starts empty and boot calls encodeCore().
     * @param {import('../EmojiAtlas.js').default|null} [opts.emojiAtlas] - whose landed pixels
     *           and rebirths this atlas relays to its fields and listeners
     * @param {{save:(growth:Object)=>Promise<number>}|null} [opts.persist] - where grown glyphs go
     * @param {number}   [opts.persistDebounceMs]
     */
    constructor({ atlas, shaper, encoder, uploads, initialDescriptor = null, emojiAtlas = null, persist = null,
                  persistDebounceMs = ATLAS_GROWTH.persistDebounceMs }) {
        if (!uploads) throw new Error('[LiveSlugAtlas] needs a TextureUploads (the queue the renderer seam flushes)');
        /** @private */ this._atlas    = atlas;
        /** @private */ this._shaper   = shaper;
        /** @private */ this._encoder  = encoder;
        /** @private */ this._uploads = uploads;
        /** @private */ this._textures = initialDescriptor ? SlugTextures.hydrate(uploads, initialDescriptor) : new SlugTextures(uploads);
        /** @private the pair fields bind; replaced only when a texture is reborn */
        this._slugData = this._textures.pair;
        if (atlas) atlas._slugData = this._slugData;
        /** @private bumped on every landing; lets callers detect staleness */
        this._version = 0;
        /** @private @type {Set<Object>} live fields */ this._fields = new Set();
        /** @private slots queued or at the worker */ this._inFlight = new Set();
        /** @private slots waiting for this task's batch, and who asked */
        this._queue = [];
        this._queueProv = new Map();
        /** @private */ this._flushScheduled = false;
        /** @private encode batches at the worker */ this._batches = 0;
        /** @private resolvers waiting for quiet */ this._idleWaiters = [];
        /** @private outline slots learned after boot — the persisted growth, in learning order */
        this._grown = new Set();
        /** @private */ this._persist = persist;
        /** @private */ this._persistDebounceMs = persistDebounceMs;
        /** @private */ this._persistTimer = null;
        /** @private grown glyphs at the last save */ this._persistedCount = 0;
        /** @private @type {Set<(e:GlyphsReady)=>void>} */ this._listeners = new Set();
        /** @private */ this._emojiAtlas = emojiAtlas;
        /** @private */ this._offEmoji = emojiAtlas ? emojiAtlas.onChange((e) => this._onEmoji(e)) : null;
    }

    /** Snapshot the encoded atlas as a serializable descriptor (for the slug-core cache). */
    serialize() {
        return this._textures.buffer.serialize();
    }

    /** @returns {{curveTexture:Object, glyphMapTexture:Object}} the pair fields bind */
    get slugData() { return this._slugData; }

    /** @returns {number} number of distinct slots encoded (outline + emoji) */
    get size() { return this._textures.buffer.size; }

    /** @returns {number} monotonically increasing landing counter */
    get version() { return this._version; }

    /** @returns {number} glyphs requested and not yet landed (outlines + emoji pixels) */
    get pending() { return this._inFlight.size + (this._emojiAtlas?.pending ?? 0); }

    /** @returns {import('../core/TextureUploads.js').default} the queue the renderer seam flushes */
    get uploads() { return this._uploads; }

    /** Upload accounting: { slug: SlugTextures stats, emoji: EmojiAtlas stats, queue: TextureUploads stats }. */
    get uploadStats() {
        return { slug: { ...this._textures.stats }, emoji: this._emojiAtlas ? { ...this._emojiAtlas.stats } : null, queue: { ...this._uploads.stats } };
    }

    /** @returns {number} glyphs learned since boot (the persisted growth) */
    get grownCount() { return this._grown.size; }

    /**
     * Register a live field so it gets the new pair when a texture is reborn (and the emoji
     * texture when that one is). Idempotent. A field constructed now binds the atlas's current
     * `_slugData`, which is always the latest — no catch-up needed.
     * @param {Object} field - an InstancedField (setSlugData / setEmojiTexture)
     */
    registerField(field) {
        if (field) this._fields.add(field);
    }

    /** @param {Object} field */
    unregisterField(field) {
        this._fields.delete(field);
    }

    /**
     * Listen for glyphs becoming drawable (see the growth contract, point 5).
     * @param {(e:GlyphsReady) => void} cb
     * @returns {() => void} unsubscribe
     */
    onGlyphsReady(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    /**
     * Resolves once nothing is in flight — every requested outline encoded, every emoji cell
     * rasterized (for tools and tests; rendering never waits on it).
     * @returns {Promise<void>}
     */
    async whenIdle() {
        for (;;) {
            if (this._inFlight.size > 0 || this._batches > 0) {
                await new Promise((res) => this._idleWaiters.push(res));
                continue;
            }
            if (this._emojiAtlas && this._emojiAtlas.pending > 0) {
                await this._emojiAtlas.whenIdle();
                continue;
            }
            return;
        }
    }

    /**
     * Ask for glyphs to be drawable. Never blocks: outline slots not yet encoded are queued for
     * the encode worker (their map texels reserved, drawing blank until they land); bitmap
     * (emoji) slots get their map entries now and draw once their cells are rasterized.
     * Glyph 0 (.notdef / blank) and slots already encoded or in flight are skipped.
     *
     * @param {Iterable<number>} glyphIds
     * @param {Map<number, number>} [provenance] - slot → codepoint that sighted it (log + event detail)
     * @returns {{ queued: number, pending: number, total: number }}
     */
    ensureGlyphsEncoded(glyphIds, provenance) {
        const buf = this._textures.buffer;
        let emoji = null, sprites = null, queued = 0;
        for (const id of glyphIds) {
            if (id <= 0 || buf.has(id) || this._inFlight.has(id)) continue;
            if (this._shaper.isBitmapSlot(id)) { (emoji ?? (emoji = [])).push(id); continue; }
            if (this._shaper.isSpriteSlot?.(id)) { (sprites ?? (sprites = [])).push(id); continue; }
            this._inFlight.add(id);
            this._queue.push(id);
            const cp = provenance?.get(id);
            if (cp !== undefined) this._queueProv.set(id, cp);
            buf.reserveSlot(id);
            queued++;
        }
        if (emoji) {
            // Map entries [0, 0, mode 1, cell] — without one the texel is all-zero and the slug
            // branch discards the emoji as an empty glyph. Pixels arrive via the emoji atlas.
            const res = buf.addBitmapSlots(this._shaper, emoji);
            queued += res.added;
            if (res.added) this._debugEmoji(res.addedIds, provenance);
        }
        if (sprites) queued += this._landSprites(sprites);
        if (queued) this._sync();
        if (this._queue.length && !this._flushScheduled) {
            this._flushScheduled = true;
            queueMicrotask(() => this._flush());
        }
        return { queued, pending: this._inFlight.size, total: buf.size };
    }

    /**
     * Convenience: ensure a list of Unicode codepoints, resolving each to its slot through the
     * shape cache (HarfBuzz on a miss). Passes codepoint → slot provenance through.
     * @param {Iterable<number>} codepoints
     * @param {{lookup:(cp:number)=>{g:number}}} shapeCache
     * @returns {{ queued: number, pending: number, total: number }}
     */
    ensureCodepoints(codepoints, shapeCache) {
        const gids = [];
        const provenance = new Map();
        for (const cp of codepoints) {
            const entry = shapeCache.lookup(cp);
            if (entry && entry.g > 0) {
                gids.push(entry.g);
                if (!provenance.has(entry.g)) provenance.set(entry.g, cp);
            }
        }
        return this.ensureGlyphsEncoded(gids, provenance);
    }

    /**
     * Encode the boot core (a cache miss) through the worker and land it. Unlike growth it is
     * awaited by boot and is not persisted as growth (the core has its own cache entry).
     * @param {Iterable<number>} glyphIds
     * @returns {Promise<void>}
     */
    async encodeCore(glyphIds) {
        const t0 = performance.now();
        const buf = this._textures.buffer;
        const emoji = [];
        const sprites = [];
        const items = [];
        for (const id of glyphIds) {
            if (id <= 0 || buf.has(id)) continue;
            if (this._shaper.isBitmapSlot(id)) { emoji.push(id); continue; }
            if (this._shaper.isSpriteSlot?.(id)) { sprites.push(id); continue; }
            const src = this._shaper.slotSource(id);
            if (src) items.push(id, src.fontIdx, src.gid);
        }
        buf.addBitmapSlots(this._shaper, emoji);
        this._landSprites(sprites);
        const { batch, ms } = await this._encoder.encode(Uint32Array.from(items));
        buf.appendEncoded(batch);
        this._sync();
        this._logOverhang(batch);
        const s = this._textures.describe();
        console.log(
            `[LiveSlugAtlas] encoded core: ${s.glyphCount} glyphs, ${s.totalCurves} curves ` +
            `(${s.curveTextureSizeKB}KB) — ${ms.toFixed(1)}ms in the worker, ${(performance.now() - t0).toFixed(1)}ms to land`
        );
    }

    /**
     * Land persisted growth (slugCoreCache.loadSlugGrowth) — called at boot right after the
     * core hydrates, before any field exists. Each record's slot is allocated through the
     * chain (slotFor(fontIdx, gid)); one the core already holds is skipped.
     * @param {import('./slugCoreCache.js').SlugGrowth} growth
     * @returns {number} glyphs added
     */
    hydrateGrowth(growth) {
        const n = growth.gid.length;
        const slots = new Uint32Array(n);
        for (let i = 0; i < n; i++) slots[i] = this._shaper.slotFor(growth.fontIdx[i], growth.gid[i]);
        const { addedIds } = this._textures.buffer.appendEncoded({ slots, counts: growth.counts, texels: growth.texels });
        for (const id of addedIds) this._grown.add(id);
        this._persistedCount = this._grown.size;
        this._sync();
        return addedIds.length;
    }

    /**
     * Save the grown glyphs now (the debounce calls this). Resolves to the stored size (0 when
     * there was nothing new or no persist sink).
     * @returns {Promise<number>}
     */
    async persistNow() {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
        if (!this._persist || this._grown.size === this._persistedCount) return 0;
        const buf = this._textures.buffer;
        const slots = [...this._grown];
        const n = slots.length;
        const fontIdx = new Uint32Array(n), gid = new Uint32Array(n), counts = new Uint32Array(n);
        let total = 0;
        for (let i = 0; i < n; i++) {
            const src = this._shaper.slotSource(slots[i]);
            fontIdx[i] = src.fontIdx; gid[i] = src.gid;
            counts[i] = buf.slotTexels(slots[i]).length / CURVE_U32_PER_CURVE;
            total += counts[i];
        }
        const texels = new Uint32Array(total * CURVE_U32_PER_CURVE);
        for (let i = 0, o = 0; i < n; i++) {
            const t = buf.slotTexels(slots[i]);
            texels.set(t, o);
            o += t.length;
        }
        this._persistedCount = n;
        return this._persist.save({ fontIdx, gid, counts, texels });
    }

    /** Stop the worker, the persistence timer and the emoji relay; release the textures. */
    dispose() {
        clearTimeout(this._persistTimer);
        this._offEmoji?.();
        this._encoder.dispose?.();
        this._textures.dispose();
        this._fields.clear();
        this._listeners.clear();
    }

    // ── internals ───────────────────────────────────────────────────────────────────────

    /**
     * @private Generate sprite slots' outlines to the cell and append them (the caller syncs the
     * textures). Synchronous: a sprite is a few rectangles.
     * @param {number[]} slots  sprite slots not yet encoded
     * @returns {number} sprites added
     */
    _landSprites(slots) {
        if (!slots.length) return 0;
        // A sprite is drawn to its family's cell (its aspect, its line weights): one batch per family.
        const byFamily = new Map();
        for (const slot of slots) {
            const fam = this._shaper.spriteFamilyOf(slot);
            let items = byFamily.get(fam);
            if (!items) byFamily.set(fam, items = []);
            items.push({ slot, cp: this._shaper.spriteCodepointOf(slot) });
        }
        let added = 0;
        for (const [fam, items] of byFamily) {
            added += this._textures.buffer.appendEncoded(encodeSprites(items, this._shaper.spriteMetrics(fam), SPRITE_MODE)).added;
        }
        return added;
    }

    /** @private send this task's queue to the worker as one batch */
    _flush() {
        this._flushScheduled = false;
        const ids = this._queue.splice(0);
        const prov = this._queueProv;
        this._queueProv = new Map();
        if (!ids.length) return;
        const items = new Uint32Array(ids.length * 3);
        /** @type {number[]|null} composite glyphs: [slot, n, …parts] each */
        let composites = null;
        let n = 0, sent = 0;
        for (const id of ids) {
            const src = this._shaper.slotSource(id);
            if (src) {
                items[n++] = id; items[n++] = src.fontIdx; items[n++] = src.gid;
                sent++;
                continue;
            }
            const parts = this._shaper.compositeOf?.(id);
            if (parts) {
                (composites ?? (composites = [])).push(id, parts.length / COMPOSITE_PART_STRIDE, ...parts);
                sent++;
                continue;
            }
            console.error(`[LiveSlugAtlas] slot ${id} has no font glyph (not outline, not composite, not bitmap) — it stays blank`);
            this._inFlight.delete(id);
        }
        if (!sent) return this._settle();
        this._batches++;
        this._encoder.encode(items.subarray(0, n).slice(), composites ? Int32Array.from(composites) : null)
            .then(({ batch, ms }) => this._land(batch, ms, prov))
            .catch((err) => {
                console.error(`[LiveSlugAtlas] growth of ${sent} glyph(s) failed (${err.message}) — ` +
                    `they stay blank: [${ids.slice(0, 12).map((id) => this._describe(id, prov)).join(', ')}${ids.length > 12 ? ' …' : ''}]`);
                for (const id of ids) this._inFlight.delete(id);
            })
            .finally(() => { this._batches--; this._settle(); });
    }

    /** @private copy a landed batch into the textures, tell the fields + listeners */
    _land(batch, workerMs, prov) {
        const t0 = performance.now();
        const { added, addedIds } = this._textures.buffer.appendEncoded(batch);
        for (const slot of batch.slots) this._inFlight.delete(slot);
        // What persists is keyed by font glyph: a composite (a cluster's shaping) is not.
        for (const id of addedIds) if (this._shaper.slotSource(id)) this._grown.add(id);
        const { bytes, reborn, rebound } = this._sync();
        this._version++;
        this._logOverhang(batch);

        const ids = addedIds;
        const blanks = ids.filter((id) => this._shaper.describeSlot?.(id)?.name === '.blank').length;
        const ms = performance.now() - t0;
        // The load path's atlas cost, counted for the load trace (core/loadStats.js): the
        // MAIN-THREAD part of a growth (the worker's time is off it).
        loadStats.atlasGrows++;
        loadStats.atlasMs += ms;
        loadStats.atlasFieldsSwapped += rebound;
        loadStats.atlasBlanks += blanks;
        loadStats.atlasGlyphsAdded += added;
        const names = ids.slice(0, 24).map((id) => this._describe(id, prov)).join(', ');
        console.log(
            `[LiveSlugAtlas] grew v${this._version}: +${added} → ${this.size} glyphs ` +
            `[${names}${ids.length > 24 ? ` …+${ids.length - 24}` : ''}]${blanks ? ` (${blanks} blank)` : ''}, ` +
            `encoded in ${workerMs.toFixed(1)}ms off-thread, landed in ${ms.toFixed(1)}ms, ` +
            `${bytes} B to upload${reborn ? `, textures reborn (old rows copied on the GPU) → ${rebound}/${this._fields.size} fields rebound` : ''}`
        );
        if (added) {
            this._emit({ slots: ids, codepoints: ids.map((id) => prov.get(id)).filter((cp) => cp !== undefined), version: this._version });
            this._schedulePersist();
        }
    }

    /**
     * @private bring the textures up to the buffer; a reborn texture goes to every field (the old
     * one is disposed by the uploads queue once its rows are copied — each growth used to leak a
     * pair until page unload: VRAM pressure on the bulk-load path preceded the 2026-08-04 device OOM)
     */
    _sync() {
        const { reborn, bytes } = this._textures.sync();
        let rebound = 0;
        if (reborn) {
            this._slugData = this._textures.pair;
            if (this._atlas) this._atlas._slugData = this._slugData;
            for (const field of this._fields) {
                if (typeof field?.setSlugData === 'function') { field.setSlugData(this._slugData, this._shaper); rebound++; }
            }
        }
        return { reborn, bytes, rebound };
    }

    /** @private relay the emoji atlas: a reborn texture to every field, landed pixels to listeners */
    _onEmoji(e) {
        if (e.kind === 'replaced') {
            for (const field of this._fields) field?.setEmojiTexture?.();
            return;
        }
        if (e.kind === 'rasterized') {
            const slots = [];
            for (const cp of e.codepoints) {
                const slot = this._shaper.bitmapSlotOf(cp);
                if (slot > 0) slots.push(slot);
            }
            this._version++;
            this._emit({ slots, codepoints: e.codepoints, version: this._version });
        }
    }

    /** @private */
    _emit(e) {
        for (const cb of this._listeners) {
            try { cb(e); } catch (err) { console.error('[LiveSlugAtlas] onGlyphsReady listener failed:', err); }
        }
    }

    /** @private wake whenIdle() waiters once nothing is in flight */
    _settle() {
        if (this._inFlight.size === 0 && this._batches === 0) {
            for (const res of this._idleWaiters.splice(0)) res();
        }
    }

    /** @private */
    _schedulePersist() {
        if (!this._persist) return;
        clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => { this.persistNow(); }, this._persistDebounceMs);
    }

    /** @private one aggregated overhang note per batch (ink clipped at the cell edge — benign) */
    _logOverhang(batch) {
        const o = batch.overhang;
        if (!o || !o.count) return;
        console.log(
            `[LiveSlugAtlas] ${o.count}/${batch.slots.length} glyph(s) overhang the advance cell ` +
            `(ink clipped at the edge; benign for monospace) — worst: ${o.worstSlot} ("${o.worstName}") +${(o.worstFrac * 100).toFixed(1)}%`
        );
    }

    /** @private U+XXXX 'c' → Font:gid 'name' — a growth is readable (and bakeable) */
    _describe(id, prov) {
        const d = this._shaper.describeSlot?.(id);
        const cp = prov?.get(id);
        // A cell's content: a codepoint, or a cluster (core/cellClusters.js) — named by its codepoints.
        const src = cp != null
            ? `${Array.from(cellText(cp), (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('+')} ${JSON.stringify(cellText(cp))}`
            : `slot ${id}`;
        return d ? `${src}→${d.font}:${d.gid} "${d.name}"` : `${src}→${id}`;
    }

    /** @private emoji sightings are expected and cheap: debug, not an atlas event */
    _debugEmoji(slots, provenance) {
        console.debug(
            `[LiveSlugAtlas] emoji: +${slots.length} cell(s) [${slots.slice(0, 12).map((id) => this._describe(id, provenance)).join(', ')}` +
            `${slots.length > 12 ? ` …+${slots.length - 12}` : ''}]`
        );
    }
}
