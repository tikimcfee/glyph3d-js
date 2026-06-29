/**
 * FontChain — an ordered set of fonts presented as a single shaper.
 *
 * No single font covers everything a terminal throws at it: a clean code
 * monospace (Cousine) has ASCII/Latin/box-drawing but not the Claude Code
 * spinner stars, rounded box corners, powerline or Nerd-Font icons; a patched
 * Nerd Font (Meslo) has those but not braille; a broad Unicode face (DejaVu)
 * has braille but not the rare play-triangle — and so on down to "oh well, a
 * blank cell." Real terminals solve this with font fallback. So do we.
 *
 * The chain is presented to the rest of the pipeline as if it were a single
 * HarfBuzzShaper: same method surface (shape / glyphOutline / glyphAdvance /
 * fontExtents / glyphName / upem), but the "glyph IDs" it deals in are GLOBAL
 * SLOTS, not per-font HarfBuzz glyph indices. A slot is a dense integer that
 * uniquely identifies a (fontIndex, fontGlyphId) pair. Slot 0 is reserved for
 * the blank/.notdef cell (a codepoint no font covers). Because the chain mimics
 * the shaper interface with slots as IDs, MonospaceShapeCache, slugData,
 * SlugEncoder, LiveSlugAtlas and GlyphField all consume it unchanged — the only
 * difference is that `instanceGlyphId` now carries a slot, and the glyph-map
 * texture is keyed by slot. Slots stay dense, so the texture stays compact.
 *
 * Routing is per-codepoint (correct for a monospace grid where one cell = one
 * codepoint): the first font whose cmap covers the codepoint wins. Layout
 * advance is forced to the PRIMARY font's monospace advance for every glyph, so
 * columns stay aligned no matter which font actually drew the glyph; curve
 * normalization still uses each glyph's own font metrics (see slugData).
 */

import HarfBuzzShaper from './HarfBuzzShaper.js';

/** Slot 0 is the blank cell — a codepoint no font in the chain covers. */
export const BLANK_SLOT = 0;

/** Per-font glyph-id stride for the (fontIdx, gid) → key packing. */
const FONT_STRIDE = 0x100000; // 2^20 — well above any real font's glyph count

/** Slot-key base for bitmap (emoji) slots — disjoint from the font keyspace. */
const BITMAP_KEY_BASE = 0x7F000000;

/** Sentinel fontIdx for a bitmap slot in slotMeta (no outline font). */
const BITMAP_FONT = -2;

/**
 * Codepoints we let fall through to the color-emoji bitmap atlas when NO outline
 * font in the chain covers them. Outline fonts are always tried first (so a glyph
 * a real font has renders crisp via Slug); only the genuine pictographic gaps land
 * here. Broad ranges are safe precisely because of that outline-first precedence.
 * @param {number} cp
 * @returns {boolean}
 */
function isEmojiCodepoint(cp) {
    return (cp >= 0x1F000 && cp <= 0x1FAFF)   // emoticons, pictographs, transport, symbols-extended, …
        || (cp >= 0x2600  && cp <= 0x27BF)    // misc symbols + dingbats
        || (cp >= 0x2B00  && cp <= 0x2BFF)    // misc symbols & arrows
        || (cp >= 0x1FA00 && cp <= 0x1FAFF);  // symbols & pictographs extended-A
}

export default class FontChain {
    constructor() {
        /** @private @type {Array<{shaper: HarfBuzzShaper, coverage: Set<number>, name: string}>} */
        this._fonts = [];
        /** @private slot → {fontIdx, gid}. Index 0 is the blank cell. */
        this._slotMeta = [{ fontIdx: -1, gid: 0 }];
        /** @private (fontIdx*STRIDE+gid) → slot */
        this._slotByKey = new Map();
        /** @private codepoint → fontIdx (or -1 = uncovered), memoized */
        this._routeCache = new Map();
        /** @private primary monospace advance (font units), lazily resolved */
        this._primaryAdvance = undefined;
        /** @private color-emoji bitmap atlas (EmojiAtlas) for the fallback-of-last-resort */
        this._emojiAtlas = null;
        this._ready = false;
    }

    /**
     * Attach the color-emoji bitmap atlas. Codepoints no outline font covers but
     * that look like emoji get a "bitmap" slot whose glyph is a cell in this atlas
     * (rendered by the shader's bitmap branch, not Slug).
     * @param {import('../EmojiAtlas.js').default} emojiAtlas
     */
    setEmojiAtlas(emojiAtlas) { this._emojiAtlas = emojiAtlas; }

    /** @returns {boolean} */
    get ready() { return this._ready; }

    /** @returns {number} primary font units-per-em (the layout reference) */
    get upem() { return this._fonts[0]?.shaper.upem || 2048; }

    /** @returns {number} number of fonts in the chain */
    get fontCount() { return this._fonts.length; }

    /** @returns {number} number of slots allocated (incl. the blank slot) */
    get slotCount() { return this._slotMeta.length; }

    /**
     * Fetch + initialize every font in the chain. The first font's WASM module
     * is reused for the rest (one HarfBuzz instance, many faces).
     *
     * @param {Array<{url: string, name?: string}>} fontSpecs - In priority order.
     * @param {Object} [options]
     * @param {string} [options.wasmUrl] - Override hb.wasm path.
     * @returns {Promise<void>}
     */
    async init(fontSpecs, options = {}) {
        let sharedHb = null;
        for (let i = 0; i < fontSpecs.length; i++) {
            const spec = fontSpecs[i];
            const name = spec.name || `font${i}`;
            let buffer;
            try {
                const resp = await fetch(spec.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                buffer = await resp.arrayBuffer();
            } catch (err) {
                console.warn(`[FontChain] skipping "${name}" (${spec.url}): ${err.message}`);
                continue;
            }
            const shaper = new HarfBuzzShaper();
            await shaper.init(buffer, { wasmUrl: options.wasmUrl, hb: sharedHb, name });
            if (!sharedHb) sharedHb = shaper.hb;

            const coverage = new Set(shaper.collectUnicodes());
            this._fonts.push({ shaper, coverage, name });
            console.log(`[FontChain] [${this._fonts.length - 1}] ${name}: ${coverage.size} codepoints`);
        }
        if (this._fonts.length === 0) {
            throw new Error('FontChain.init: no fonts loaded');
        }
        this._ready = true;
        console.log(`[FontChain] ready: ${this._fonts.length} fonts, upem(primary)=${this.upem}`);
    }

    // ── Routing + slot allocation ──────────────────────────────────────────

    /**
     * The index of the first font whose cmap covers `codepoint`, or -1 if none.
     * @param {number} codepoint
     * @returns {number}
     */
    routeCodepoint(codepoint) {
        const cached = this._routeCache.get(codepoint);
        if (cached !== undefined) return cached;
        let idx = -1;
        for (let i = 0; i < this._fonts.length; i++) {
            if (this._fonts[i].coverage.has(codepoint)) { idx = i; break; }
        }
        this._routeCache.set(codepoint, idx);
        return idx;
    }

    /**
     * The dense global slot for a (fontIdx, gid) pair, allocating on first use.
     * gid 0 (.notdef) or an uncovered font maps to the blank slot.
     * @param {number} fontIdx
     * @param {number} gid
     * @returns {number} slot
     */
    slotFor(fontIdx, gid) {
        if (fontIdx < 0 || gid === 0) return BLANK_SLOT;
        const key = fontIdx * FONT_STRIDE + gid;
        let slot = this._slotByKey.get(key);
        if (slot === undefined) {
            slot = this._slotMeta.length;
            this._slotMeta.push({ fontIdx, gid });
            this._slotByKey.set(key, slot);
        }
        return slot;
    }

    /** @private @returns {{fontIdx:number, gid:number, cell?:number}} */
    _resolve(slot) {
        return this._slotMeta[slot] || this._slotMeta[BLANK_SLOT];
    }

    /**
     * Allocate (or reuse) a bitmap slot for an emoji codepoint, drawing it into
     * the emoji atlas on first sight. Returns the blank slot if the atlas is full.
     * @private
     * @param {number} cp
     * @returns {number} slot
     */
    _bitmapSlotFor(cp) {
        const key = BITMAP_KEY_BASE + cp;
        let slot = this._slotByKey.get(key);
        if (slot !== undefined) return slot;
        const cell = this._emojiAtlas.ensure(cp);
        if (cell < 0) return BLANK_SLOT; // atlas full → blank cell
        slot = this._slotMeta.length;
        this._slotMeta.push({ fontIdx: BITMAP_FONT, gid: 0, cell });
        this._slotByKey.set(key, slot);
        return slot;
    }

    /** @param {number} slot @returns {boolean} true if this slot is a color-emoji bitmap */
    isBitmapSlot(slot) {
        return this._resolve(slot).fontIdx === BITMAP_FONT;
    }

    /** @param {number} slot @returns {number} emoji-atlas cell index (-1 if not a bitmap slot) */
    emojiCellOf(slot) {
        const m = this._resolve(slot);
        return m.fontIdx === BITMAP_FONT ? m.cell : -1;
    }

    /** @private monospace advance of the primary font (forced on every cell) */
    _primaryAx() {
        if (this._primaryAdvance === undefined) {
            const s = this._fonts[0]?.shaper;
            const shaped = s ? s.shape('M') : null;
            this._primaryAdvance = (shaped && shaped.length) ? shaped[0].ax : (this.upem * 0.6);
        }
        return this._primaryAdvance;
    }

    // ── Shaper-compatible surface (glyph IDs are global slots) ──────────────

    /**
     * Shape text into per-glyph records. Each codepoint is routed to its font,
     * shaped there to get a glyph id, and mapped to a global slot. The advance
     * is forced to the primary monospace width so columns stay aligned.
     *
     * @param {string} text
     * @returns {Array<{g:number, cl:number, ax:number, ay:number, dx:number, dy:number, flags:number}>}
     */
    shape(text) {
        const out = [];
        const cellAx = this._primaryAx();
        for (let i = 0, len = text.length; i < len;) {
            const cp = text.codePointAt(i);
            const step = cp > 0xFFFF ? 2 : 1;
            const fontIdx = this.routeCodepoint(cp);
            let slot = BLANK_SLOT;
            // Codepoints in the emoji planes (U+1F000+) are Emoji_Presentation=Yes —
            // pictographic emoji that should be COLOR even when a fallback font happens
            // to carry a monochrome outline (DejaVu has a mono ☺, but 😀 should be the
            // color one). So prefer the color bitmap for those; outline is the backstop
            // if the emoji atlas is full. Text-default symbols (❤ ✓ ★, U+2600–2BFF)
            // stay outline-first so they render as crisp monochrome glyphs.
            const preferColor = this._emojiAtlas && cp >= 0x1F000;
            if (preferColor) {
                slot = this._bitmapSlotFor(cp);
            }
            if (slot === BLANK_SLOT && fontIdx >= 0) {
                const shaped = this._fonts[fontIdx].shaper.shape(String.fromCodePoint(cp));
                if (shaped.length) slot = this.slotFor(fontIdx, shaped[0].g);
            }
            if (slot === BLANK_SLOT && !preferColor && this._emojiAtlas && isEmojiCodepoint(cp)) {
                // No outline font has it, but it's emoji → color bitmap fallback.
                slot = this._bitmapSlotFor(cp);
            }
            // Emoji render as a SQUARE bitmap ~2× the mono advance, so they take a DOUBLE-WIDTH
            // advance (2 cells) — the terminal-standard east-asian "wide" width. The square then
            // lands cleanly in its 2-cell span (the builder centers it on iSize.x·0.5) instead of
            // spilling into the next glyph. Outline glyphs (incl. the blank slot) stay 1 cell.
            const ax = this.isBitmapSlot(slot) ? cellAx * 2 : cellAx;
            out.push({ g: slot, cl: i, ax, ay: 0, dx: 0, dy: 0, flags: 0 });
            i += step;
        }
        return out;
    }

    /**
     * Outline segments for a slot, pulled from the slot's own font. The blank
     * slot has no outline (renders as an empty cell).
     * @param {number} slot
     * @returns {Array<{type:string, values:number[]}>}
     */
    glyphOutline(slot) {
        const { fontIdx, gid } = this._resolve(slot);
        if (fontIdx < 0) return [];
        return this._fonts[fontIdx].shaper.glyphOutline(gid);
    }

    /**
     * The slot's glyph advance in ITS OWN font units (for curve normalization,
     * not layout — layout uses the forced monospace advance from shape()).
     * @param {number} slot
     * @returns {number}
     */
    glyphAdvance(slot) {
        const { fontIdx, gid } = this._resolve(slot);
        if (fontIdx < 0) return this._primaryAx();
        return this._fonts[fontIdx].shaper.glyphAdvance(gid);
    }

    /**
     * Font horizontal extents for a slot's font. With no slot (legacy single-
     * font callers), returns the primary font's extents.
     * @param {number} [slot]
     * @returns {{ascender:number, descender:number, lineGap:number}}
     */
    fontExtents(slot) {
        const fontIdx = slot === undefined ? 0 : Math.max(0, this._resolve(slot).fontIdx);
        return this._fonts[fontIdx].shaper.fontExtents();
    }

    /**
     * Glyph name for a slot (logging/debug).
     * @param {number} slot
     * @returns {string}
     */
    glyphName(slot) {
        const { fontIdx, gid } = this._resolve(slot);
        if (fontIdx < 0) return '.blank';
        const n = this._fonts[fontIdx].shaper.glyphName(gid);
        return `${this._fonts[fontIdx].name}:${n}`;
    }

    /** Destroy every font's HarfBuzz objects. */
    destroy() {
        for (const f of this._fonts) f.shaper.destroy();
        this._fonts = [];
        this._ready = false;
    }
}
