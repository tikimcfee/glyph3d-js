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
 * SlugTextures, LiveSlugAtlas and GlyphField all consume it unchanged — the only
 * difference is that `instanceGlyphId` now carries a slot, and the glyph-map
 * texture is keyed by slot. Slots stay dense, so the texture stays compact.
 *
 * Routing is per-codepoint (correct for a monospace grid where one cell = one
 * codepoint): the first font whose cmap covers the codepoint wins. Layout
 * advance is forced to the PRIMARY font's monospace advance for every glyph, so
 * columns stay aligned no matter which font actually drew the glyph; curve
 * normalization still uses each glyph's own font metrics (see slugData).
 *
 * Two glyph sources come before any font's cmap:
 *   - SPRITES: the codepoints a terminal draws itself (box drawing, blocks, braille, legacy
 *     computing, powerline — cellSprites.isSpriteCodepoint) get a sprite slot, whose outline is
 *     generated to the cell (LiveSlugAtlas lands it), whatever the fonts hold for them.
 *   - color emoji (below).
 *
 * A font may bring an ITALIC face (`{ url, name, italic: { url } }`): it is loaded as one more
 * font of the chain (its own index, after every upright font, so the upright indices never
 * move) but takes no part in routing — `lookupItalic(cp)` answers the italic face's glyph for a
 * codepoint its upright font routes, and the upright glyph for everything else (a fallback
 * font's glyph, a sprite, an emoji: no face to slant with, and none is synthesized).
 */

import HarfBuzzShaper from './HarfBuzzShaper.js';
import { isSpriteCodepoint } from './cellSprites.js';
import { readFontLines } from './fontTables.js';

/** Slot 0 is the blank cell — a codepoint no font in the chain covers. */
export const BLANK_SLOT = 0;

/** Per-font glyph-id stride for the (fontIdx, gid) → key packing. */
const FONT_STRIDE = 0x100000; // 2^20 — well above any real font's glyph count

/** Slot-key base for bitmap (emoji) slots — disjoint from the font keyspace. */
const BITMAP_KEY_BASE = 0x7F000000;

/** Sentinel fontIdx for a bitmap slot in slotMeta (no outline font). */
const BITMAP_FONT = -2;

/** Slot-key base for sprite slots — disjoint from the font and bitmap keyspaces. */
const SPRITE_KEY_BASE = 0x7D000000;

/** Sentinel fontIdx for a sprite slot in slotMeta (its gid is the codepoint). */
const SPRITE_FONT = -3;

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
        /** @private @type {Array<{shaper: HarfBuzzShaper, coverage: Set<number>, name: string, bytes: ArrayBuffer, italicIdx?: number}>} */
        this._fonts = [];
        /** @private how many of _fonts are upright (routed); the italic faces follow them */
        this._routed = 0;
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

    /** @returns {import('./HarfBuzzShaper.js').default|null} primary font shaper */
    get primaryShaper() { return this._fonts[0]?.shaper || null; }

    /** @returns {number} primary font units-per-em (the layout reference) */
    get upem() { return this._fonts[0]?.shaper.upem || 2048; }

    /** @returns {number} number of fonts in the chain (upright fonts, then their italic faces) */
    get fontCount() { return this._fonts.length; }

    /** @returns {number} number of slots allocated (incl. the blank slot) */
    get slotCount() { return this._slotMeta.length; }

    /**
     * Fetch + initialize every font in the chain. The first font's WASM module
     * is reused for the rest (one HarfBuzz instance, many faces).
     *
     * @param {Array<{url?: string, buffer?: ArrayBuffer|Uint8Array, name?: string, italic?: {url?: string, buffer?: ArrayBuffer|Uint8Array}}>} fontSpecs
     *   In priority order; `italic` names that font's italic face.
     * @param {Object} [options]
     * @param {string} [options.wasmUrl] - Override hb.wasm path.
     * @returns {Promise<void>}
     */
    async init(fontSpecs, options = {}) {
        let sharedHb = null;
        // Every upright font first, then the italic faces: an upright font's index is its place
        // in the list whether or not any font has an italic.
        const specs = fontSpecs.map((spec, i) => ({ spec, name: spec.name || `font${i}`, italicOf: -1 }));
        for (const [i, spec] of fontSpecs.entries()) {
            if (spec.italic) specs.push({ spec: spec.italic, name: `${spec.name || `font${i}`} Italic`, italicOf: i });
        }
        /** @type {number[]} fontSpecs index → _fonts index (-1: failed to load) */
        const loadedAt = fontSpecs.map(() => -1);
        for (let i = 0; i < specs.length; i++) {
            const { spec, name, italicOf } = specs[i];
            let buffer;
            try {
                if (spec.buffer || spec.data || spec.arrayBuffer) {
                    const raw = spec.buffer || spec.data || spec.arrayBuffer;
                    buffer = (raw instanceof Uint8Array) ? raw.buffer : raw;
                } else if (spec.url) {
                    const resp = await fetch(spec.url);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    buffer = await resp.arrayBuffer();
                } else {
                    throw new Error('spec must provide url, buffer, or data');
                }
            } catch (err) {
                console.warn(`[FontChain] skipping "${name}" (${spec.url || 'in-memory buffer'}): ${err.message}`);
                continue;
            }
            const shaper = new HarfBuzzShaper();
            await shaper.init(buffer, {
                wasmUrl: options.wasmUrl,
                wasmBinary: options.wasmBinary,
                hb: sharedHb || options.hb,
                name
            });
            if (!sharedHb) sharedHb = shaper.hb;

            const coverage = new Set(shaper.collectUnicodes());
            const idx = this._fonts.length;
            if (italicOf >= 0) {
                const upright = loadedAt[italicOf];
                if (upright < 0) {
                    console.warn(`[FontChain] skipping "${name}": its upright font didn't load`);
                    shaper.destroy();
                    continue;
                }
                this._fonts[upright].italicIdx = idx;
            } else {
                loadedAt[i] = idx;
                this._routed = idx + 1;
            }
            this._fonts.push({ shaper, coverage, name, bytes: buffer });
            console.log(`[FontChain] [${idx}] ${name}: ${coverage.size} codepoints${italicOf >= 0 ? ` (the italic of [${loadedAt[italicOf]}])` : ''}`);
        }
        if (this._routed === 0) {
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
        for (let i = 0; i < this._routed; i++) {
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
     * The font glyph behind an OUTLINE slot — what the encode worker extracts, and what a
     * persisted glyph is keyed by (slots are allocation order, so they differ between boots;
     * (fontIdx, gid) does not). Null for the blank slot and for bitmap slots.
     * @param {number} slot
     * @returns {{fontIdx:number, gid:number}|null}
     */
    slotSource(slot) {
        const m = this._slotMeta[slot];
        return (m && m.fontIdx >= 0) ? { fontIdx: m.fontIdx, gid: m.gid } : null;
    }

    /**
     * Each font's name and file bytes, in chain order — what the encode worker loads.
     * @returns {Array<{name:string, bytes:ArrayBuffer}>}
     */
    fontSources() {
        return this._fonts.map((f) => ({ name: f.name, bytes: f.bytes }));
    }

    /**
     * The bitmap slot already allocated for an emoji codepoint, or -1 (a lookup — it never
     * allocates or draws).
     * @param {number} cp
     * @returns {number}
     */
    bitmapSlotOf(cp) {
        return this._slotByKey.get(BITMAP_KEY_BASE + cp) ?? -1;
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

    /**
     * Allocate (or reuse) the sprite slot for a codepoint the terminal draws itself.
     * @private
     * @param {number} cp
     * @returns {number} slot
     */
    _spriteSlotFor(cp) {
        const key = SPRITE_KEY_BASE + cp;
        let slot = this._slotByKey.get(key);
        if (slot === undefined) {
            slot = this._slotMeta.length;
            this._slotMeta.push({ fontIdx: SPRITE_FONT, gid: cp });
            this._slotByKey.set(key, slot);
        }
        return slot;
    }

    /** @param {number} slot @returns {boolean} true if this slot's outline is generated to the cell (cellSprites) */
    isSpriteSlot(slot) {
        return this._resolve(slot).fontIdx === SPRITE_FONT;
    }

    /** @param {number} slot @returns {number} the codepoint a sprite slot draws (-1 if not a sprite slot) */
    spriteCodepointOf(slot) {
        const m = this._resolve(slot);
        return m.fontIdx === SPRITE_FONT ? m.gid : -1;
    }

    /**
     * What a sprite is drawn to: the cell's aspect (the primary font's advance over its vertical
     * em — the cell every glyph is normalized to) and the font's own line weights, as fractions of
     * the cell's height. Light is the thickness of the primary font's ─ (else its underline's);
     * heavy its ━'s (else twice light).
     * @returns {import('./cellSprites.js').SpriteMetrics}
     */
    spriteMetrics() {
        if (!this._spriteMetrics) {
            const s = this._fonts[0].shaper, ext = s.fontExtents(), em = ext.ascender - ext.descender;
            const thickness = (ch) => {
                if (!this._fonts[0].coverage.has(ch.codePointAt(0))) return 0;
                const shaped = s.shape(ch);
                let lo = Infinity, hi = -Infinity;
                for (const seg of (shaped.length ? s.glyphOutline(shaped[0].g) : [])) {
                    for (let i = 1; i < seg.values.length; i += 2) { lo = Math.min(lo, seg.values[i]); hi = Math.max(hi, seg.values[i]); }
                }
                return hi > lo ? hi - lo : 0;
            };
            const light = thickness('─') || readFontLines(this._fonts[0].bytes).underlineThickness;
            if (!(light > 0) || !(em > 0)) throw new Error(`FontChain.spriteMetrics: the primary font "${this._fonts[0].name}" gives no line weight (─ ${thickness('─')}, em ${em})`);
            this._spriteMetrics = { aspect: this._primaryAx() / em, light: light / em, heavy: (thickness('━') || 2 * light) / em };
        }
        return this._spriteMetrics;
    }

    /**
     * Where the primary font draws its lines, in cell units (y up from the cell's bottom, 1 = the
     * cell's height — the range every glyph is normalized to): the centre of its underline (post
     * table), the centre of its strikethrough (OS/2; else half its x-height) and their thickness
     * (the underline's).
     * @returns {{ underlineY: number, strikeY: number, thickness: number }}
     */
    lineMetrics() {
        const f = this._fonts[0], ext = f.shaper.fontExtents(), em = ext.ascender - ext.descender;
        const L = readFontLines(f.bytes);
        const y = (units) => (units - ext.descender) / em;
        const strike = L.strikeoutTop != null && L.strikeoutSize > 0 ? L.strikeoutTop - L.strikeoutSize / 2
            : L.xHeight != null ? L.xHeight / 2 : ext.ascender * 0.3;
        if (!(L.underlineThickness > 0)) throw new Error(`FontChain.lineMetrics: the primary font "${f.name}" names no underline thickness (post table: ${L.underlineThickness})`);
        return {
            underlineY: Math.min(1, Math.max(0, y(L.underlineTop - L.underlineThickness / 2))),
            strikeY: Math.min(1, Math.max(0, y(strike))),
            thickness: L.underlineThickness / em,
        };
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
            let slot = BLANK_SLOT;
            // What a terminal draws itself comes from no font: a sprite, generated to the cell.
            if (isSpriteCodepoint(cp)) {
                out.push({ g: this._spriteSlotFor(cp), cl: i, ax: cellAx, ay: 0, dx: 0, dy: 0, flags: 0 });
                i += step;
                continue;
            }
            const fontIdx = this.routeCodepoint(cp);
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
     * Single-codepoint lookup matching MonospaceShapeCache interface.
     * @param {number} codepoint
     * @returns {{ g: number, ax: number }}
     */
    lookup(codepoint) {
        const shaped = this.shape(String.fromCodePoint(codepoint));
        return (shaped && shaped.length > 0)
            ? { g: shaped[0].g, ax: shaped[0].ax }
            : { g: BLANK_SLOT, ax: this._primaryAx() };
    }

    /**
     * The ITALIC glyph for a codepoint: its font's italic face's, where that font has one and the
     * face covers it; else the upright glyph (`lookup`) — a fallback font's glyph, a sprite and an
     * emoji have no italic, and none is synthesized.
     * @param {number} codepoint
     * @returns {{ g: number, ax: number }}
     */
    lookupItalic(codepoint) {
        if (!isSpriteCodepoint(codepoint) && !(this._emojiAtlas && codepoint >= 0x1F000)) {
            const fontIdx = this.routeCodepoint(codepoint);
            const it = fontIdx >= 0 ? this._fonts[fontIdx].italicIdx : undefined;
            if (it !== undefined && this._fonts[it].coverage.has(codepoint)) {
                const shaped = this._fonts[it].shaper.shape(String.fromCodePoint(codepoint));
                if (shaped.length && shaped[0].g) return { g: this.slotFor(it, shaped[0].g), ax: this._primaryAx() };
            }
        }
        return this.lookup(codepoint);
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

    /**
     * A slot's debug identity for logs: which FONT it came from, the per-font glyph
     * id, and that glyph's name — bitmap (emoji) slots name their atlas cell instead.
     * A glyph literally named '.blank' is a font's empty placeholder (zero-width/format
     * codepoints map there); seeing one appended means "renders as nothing".
     * @param {number} slot
     * @returns {{ font: string, gid: number, name: string }}
     */
    describeSlot(slot) {
        const m = this._resolve(slot);
        if (m.fontIdx === BITMAP_FONT) return { font: '<emoji-atlas>', gid: m.gid, name: `cell ${m.cell}` };
        if (m.fontIdx === SPRITE_FONT) return { font: '<cell-sprite>', gid: m.gid, name: `U+${m.gid.toString(16).toUpperCase()}` };
        const f = this._fonts[m.fontIdx];
        if (!f) return { font: `#${m.fontIdx}`, gid: m.gid, name: '.blank' };
        return { font: f.name, gid: m.gid, name: f.shaper.glyphName(m.gid) };
    }

    /** Destroy every font's HarfBuzz objects. */
    destroy() {
        for (const f of this._fonts) f.shaper.destroy();
        this._fonts = [];
        this._ready = false;
    }
}
