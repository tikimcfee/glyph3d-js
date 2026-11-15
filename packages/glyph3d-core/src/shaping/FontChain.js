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
 * FACES. A font may bring a bold, an italic and a bold-italic face
 * (`{ url, name, faces: { bold, italic, boldItalic } }`), each either its own file (`{ url }`) or
 * an INSTANCE of the font's own variable file (`{ variations: { wght: 700 } }` — the same bytes
 * and HarfBuzz face, other axis values). A face is loaded as one more font of the chain (its own
 * index, after every listed font, so a listed font's index is its place in the list) but takes no
 * part in routing — `lookupFace(cp, face)` answers that face's glyph for a codepoint its upright
 * font routes, and the upright glyph for everything else (a fallback font's glyph, a sprite, an
 * emoji: no face to draw it in, and none is synthesized).
 *
 * FAMILIES. A listed font that names a `family` is a family's primary: it is routed only for that
 * family, ahead of the fallbacks (the listed fonts that name none), and the family's cell — its
 * advance, its vertical em, its line metrics, the sprites drawn to it — is that font's. Every
 * family lives in the one chain, sharing its slots and the fallbacks' glyphs, so text in two
 * families draws from the same atlas side by side, and choosing another family for a field is a
 * rewrite of its slots, not a new atlas. Family 0 (the first listed font's) is the default: what
 * every method takes when no family is named. `view(id)` is one family as a shaper.
 *
 * CLUSTERS. A cell that holds a base and combining marks (`e` + U+0301) is `lookupCluster(text)`:
 * the precomposed glyph where a font has one (NFC), else the cluster shaped by HarfBuzz in the
 * base's font — the base plus its positioned marks — as one COMPOSITE slot, whose outline the
 * encode worker builds from its parts.
 */

import HarfBuzzShaper from './HarfBuzzShaper.js';
import { isSpriteCodepoint } from './cellSprites.js';
import { readFontLines } from './fontTables.js';
import { COMPOSITE_PART_STRIDE } from './slug-constants.js';

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

/** Per-family stride of the sprite keyspace (above every codepoint), and how many families fit below the bitmap keys. */
const SPRITE_FAMILY_STRIDE = 0x200000;
const MAX_FAMILIES = (BITMAP_KEY_BASE - SPRITE_KEY_BASE) / SPRITE_FAMILY_STRIDE;

/** Sentinel fontIdx for a composite slot in slotMeta (a shaped cluster: its `parts`). */
const COMPOSITE_FONT = -4;

/** A font spec's face keys, by face index (core/cellAttrs.js FACE_*: 1 bold, 2 italic, 3 both). */
const FACE_KEYS = [null, 'bold', 'italic', 'boldItalic'];
/** What a face adds to its font's name. */
const FACE_NAMES = ['', ' Bold', ' Italic', ' Bold Italic'];

/**
 * @typedef {Object} FaceSpec  a font's bold / italic / bold-italic face
 * @property {string} [url]                         its own file …
 * @property {ArrayBuffer|Uint8Array} [buffer]      … or its bytes
 * @property {Record<string, number>} [variations]  with no file: this instance of the font's own
 *   variable file; with one: the instance of that file
 */

/**
 * @typedef {Object} FontSpec
 * @property {string} [url]
 * @property {ArrayBuffer|Uint8Array} [buffer]
 * @property {string} [name]
 * @property {string} [family]   this font is the primary of the family so named (routed for it alone)
 * @property {Record<string, number>} [variations]  the instance of a variable file this font is
 * @property {boolean} [lineGap]  the font's (and its faces') cell takes in its line gap, half
 *   above and half below (HarfBuzzShaper.fontExtents): the line the font was designed for
 * @property {{ bold?: FaceSpec, italic?: FaceSpec, boldItalic?: FaceSpec }} [faces]
 */

/**
 * A chain's fonts in the order it loads them: every listed font (its index = its place), then
 * each listed font's faces — bold, italic, bold-italic — in list order.
 * @param {FontSpec[]} fontSpecs
 * @returns {Array<{ spec: FontSpec|FaceSpec, name: string, of: number, face: number, family: string|null, lineGap: boolean }>}
 *   of: the listed font a face belongs to (-1 for a listed font); lineGap: the listed font's
 */
export function expandFontSpecs(fontSpecs) {
    const nameOf = (spec, i) => spec.name || spec.url || `font${i}`;
    const out = fontSpecs.map((spec, i) => ({ spec, name: nameOf(spec, i), of: -1, face: 0, family: spec.family ?? null, lineGap: !!spec.lineGap }));
    fontSpecs.forEach((spec, i) => {
        for (let face = 1; face < FACE_KEYS.length; face++) {
            const f = spec.faces?.[FACE_KEYS[face]];
            if (f) out.push({ spec: f, name: nameOf(spec, i) + FACE_NAMES[face], of: i, face, family: null, lineGap: !!spec.lineGap });
        }
    });
    return out;
}

/**
 * A chain's identity for cache keys: each font it loads, in order, by name, variation instance
 * line-gap choice and family — what decides which glyph a (font index, glyph id) is and how it sits in its cell. Not urls: a bundler names
 * the same file differently in dev and in a build.
 * @param {FontSpec[]} [fontSpecs]
 * @returns {string[]}
 */
export function fontChainIdentity(fontSpecs) {
    return expandFontSpecs(fontSpecs || []).map(({ spec, name, family, lineGap }) => {
        const v = spec.variations ? `{${Object.keys(spec.variations).sort().map((k) => `${k}=${spec.variations[k]}`).join(',')}}` : '';
        return `${name}${v}${lineGap ? '+gap' : ''}${family ? `@${family}` : ''}`;
    });
}

/**
 * The space between a base's ink and a mark placed over or under it, in ems (HarfBuzz's fallback
 * mark positioning uses the same sixteenth).
 */
const MARK_GAP = 1 / 16;

/** Variation selectors and joiners: they pick a presentation or join emoji, and draw nothing themselves. */
const IGNORABLE = /[\u200C\u200D\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g;

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
        /**
         * @private every font the chain loaded: the listed fonts, then their faces.
         * faces: this font's own index, then its bold / italic / bold-italic face's (-1: none);
         * instanceOf: the font whose file this one is a variation instance of (-1: its own file).
         * @type {Array<{shaper: HarfBuzzShaper, coverage: Set<number>, name: string, bytes: ArrayBuffer,
         *   variations: Record<string, number>|null, lineGap: boolean, instanceOf: number, faces: number[], family: string|null}>}
         */
        this._fonts = [];
        /**
         * @private the families, the default first. route: the fonts a codepoint is tried in (the
         * primary, then the fallbacks); the rest is memoized per family.
         * @type {Array<{id: string|null, primary: number, route: number[], routeCache: Map<number, number>,
         *   advance: number|undefined, spriteMetrics: import('./cellSprites.js').SpriteMetrics|null, view: FontFamilyView|null}>}
         */
        this._families = [];
        /** @private slot → {fontIdx, gid}. Index 0 is the blank cell. */
        this._slotMeta = [{ fontIdx: -1, gid: 0 }];
        /** @private (fontIdx*STRIDE+gid) → slot */
        this._slotByKey = new Map();
        /** @private a composite's parts, joined → its slot */
        this._compositeByKey = new Map();
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

    /** @returns {number} number of fonts in the chain (the listed fonts, then their faces) */
    get fontCount() { return this._fonts.length; }

    /** @returns {Array<string|null>} the families' ids, the default first (null: a chain that names none) */
    get families() { return this._families.map((f) => f.id); }

    /**
     * A family's index. No id (null / undefined) is the default family, 0.
     * @param {string|null} [id]
     * @returns {number}
     */
    familyIndex(id) {
        if (id == null) return 0;
        const i = this._families.findIndex((f) => f.id === id);
        if (i < 0) throw new Error(`FontChain: no font family '${id}' (the chain has: ${this._families.map((f) => f.id ?? '(default)').join(', ')})`);
        return i;
    }

    /**
     * One family as a shaper: `shape` / `lookup` / `lookupFace` / `lookupCluster` routed for it,
     * and its cell's metrics. What a MonospaceShapeCache and deriveCharSize take.
     * @param {string|null} [id]  default: the default family
     * @returns {FontFamilyView}
     */
    view(id) {
        const fam = this._families[this.familyIndex(id)];
        return fam.view ?? (fam.view = new FontFamilyView(this, this._families.indexOf(fam)));
    }

    /** @returns {number} number of slots allocated (incl. the blank slot) */
    get slotCount() { return this._slotMeta.length; }

    /**
     * Fetch + initialize every font in the chain. The first font's WASM module
     * is reused for the rest (one HarfBuzz instance, many faces).
     *
     * @param {FontSpec[]} fontSpecs
     *   In priority order: a font naming a `family` is that family's primary, the rest are every
     *   family's fallbacks; `faces` names a font's bold, italic and bold-italic.
     * @param {Object} [options]
     * @param {string} [options.wasmUrl] - Override hb.wasm path.
     * @returns {Promise<void>}
     */
    async init(fontSpecs, options = {}) {
        let sharedHb = null;
        const specs = expandFontSpecs(fontSpecs);
        /** @type {number[]} fontSpecs index → _fonts index (-1: failed to load) */
        const loadedAt = fontSpecs.map(() => -1);
        for (let i = 0; i < specs.length; i++) {
            const { spec, name, of, face, family, lineGap } = specs[i];
            const upright = of >= 0 ? loadedAt[of] : -1;
            if (of >= 0 && upright < 0) {
                console.warn(`[FontChain] skipping "${name}": its upright font didn't load`);
                continue;
            }
            const raw = spec.buffer || spec.data || spec.arrayBuffer;
            const ownFile = !!(raw || spec.url);
            let shaper, buffer, instanceOf = -1;
            if (!ownFile && of >= 0 && spec.variations) {
                // An instance of its upright's own variable file: the same bytes, the same face.
                const base = this._fonts[upright];
                instanceOf = base.instanceOf >= 0 ? base.instanceOf : upright;
                shaper = this._fonts[instanceOf].shaper.instance(spec.variations, name);
                buffer = base.bytes;
            } else {
                try {
                    if (raw) {
                        buffer = (raw instanceof Uint8Array) ? raw.buffer : raw;
                    } else if (spec.url) {
                        const resp = await fetch(spec.url);
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        buffer = await resp.arrayBuffer();
                    } else {
                        throw new Error(of >= 0 ? 'a face must provide url, buffer, or variations' : 'spec must provide url, buffer, or data');
                    }
                } catch (err) {
                    console.warn(`[FontChain] skipping "${name}" (${spec.url || 'in-memory buffer'}): ${err.message}`);
                    continue;
                }
                shaper = new HarfBuzzShaper();
                await shaper.init(buffer, {
                    wasmUrl: options.wasmUrl,
                    wasmBinary: options.wasmBinary,
                    hb: sharedHb || options.hb,
                    name,
                    variations: spec.variations || null,
                    lineGap,
                });
                if (!sharedHb) sharedHb = shaper.hb;
            }

            const idx = this._fonts.length;
            // An instance shares its file's cmap; a font with its own file has its own.
            const coverage = instanceOf >= 0 ? this._fonts[instanceOf].coverage : new Set(shaper.collectUnicodes());
            this._fonts.push({ shaper, coverage, name, bytes: buffer, variations: spec.variations || null, lineGap, instanceOf, faces: [idx, -1, -1, -1], family });
            if (of >= 0) this._fonts[upright].faces[face] = idx;
            else loadedAt[i] = idx;
            console.log(`[FontChain] [${idx}] ${name}: ${coverage.size} codepoints${of >= 0 ? ` (a face of [${upright}])` : ''}${instanceOf >= 0 ? ` (an instance of [${instanceOf}]'s file)` : ''}${family ? ` (family '${family}')` : ''}`);
        }
        const listed = loadedAt.filter((idx) => idx >= 0);
        if (listed.length === 0) {
            throw new Error('FontChain.init: no fonts loaded');
        }
        // The families: the default (the first font's), then every other font that names one.
        // A family routes its primary, then the fallbacks — the listed fonts that name no family.
        const fallbacks = listed.filter((idx) => !this._fonts[idx].family);
        const family = (primary) => ({
            id: this._fonts[primary].family, primary,
            route: [primary, ...fallbacks.filter((idx) => idx !== primary)],
            routeCache: new Map(), advance: undefined, spriteMetrics: null, view: null,
        });
        this._families = [family(listed[0])];
        for (const idx of listed.slice(1)) {
            const id = this._fonts[idx].family;
            if (!id) continue;
            if (this._families.some((f) => f.id === id)) throw new Error(`FontChain.init: two fonts name the family '${id}' (a family has one primary)`);
            this._families.push(family(idx));
        }
        if (this._families.length > MAX_FAMILIES) throw new Error(`FontChain.init: ${this._families.length} families — the sprite keyspace holds ${MAX_FAMILIES}`);
        this._ready = true;
        console.log(`[FontChain] ready: ${this._fonts.length} fonts, ${this._families.length} famil${this._families.length === 1 ? 'y' : 'ies'} (${this._families.map((f) => f.id ?? this._fonts[f.primary].name).join(', ')}), upem(primary)=${this.upem}`);
    }

    // ── Routing + slot allocation ──────────────────────────────────────────

    /**
     * The index of the first font of a family's route whose cmap covers `codepoint`, or -1 if none.
     * @param {number} codepoint
     * @param {number} [fam=0]  the family's index
     * @returns {number}
     */
    routeCodepoint(codepoint, fam = 0) {
        const family = this._families[fam];
        const cached = family.routeCache.get(codepoint);
        if (cached !== undefined) return cached;
        let idx = -1;
        for (const i of family.route) {
            if (this._fonts[i].coverage.has(codepoint)) { idx = i; break; }
        }
        family.routeCache.set(codepoint, idx);
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
     * Each font in chain order — what the encode worker loads: its name, its file's bytes and
     * the variation instance it is; a font that is an instance of another's file names that font
     * (`instanceOf`) and carries no bytes of its own.
     * @returns {Array<{name:string, bytes:ArrayBuffer|null, variations:Record<string, number>|null, lineGap:boolean, instanceOf:number}>}
     */
    fontSources() {
        return this._fonts.map((f) => ({ name: f.name, bytes: f.instanceOf >= 0 ? null : f.bytes, variations: f.variations, lineGap: f.lineGap, instanceOf: f.instanceOf }));
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
     * Allocate (or reuse) a family's sprite slot for a codepoint the terminal draws itself (a
     * sprite is drawn to its family's cell, so each family has its own).
     * @private
     * @param {number} cp
     * @param {number} fam
     * @returns {number} slot
     */
    _spriteSlotFor(cp, fam) {
        const key = SPRITE_KEY_BASE + fam * SPRITE_FAMILY_STRIDE + cp;
        let slot = this._slotByKey.get(key);
        if (slot === undefined) {
            slot = this._slotMeta.length;
            this._slotMeta.push({ fontIdx: SPRITE_FONT, gid: cp, fam });
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

    /** @param {number} slot @returns {number} the family whose cell a sprite slot is drawn to (-1 if not a sprite slot) */
    spriteFamilyOf(slot) {
        const m = this._resolve(slot);
        return m.fontIdx === SPRITE_FONT ? m.fam : -1;
    }

    /**
     * The slot of a COMPOSITE glyph — a shaped cluster's parts drawn as one — allocated on first use.
     * @private
     * @param {number[]} parts  COMPOSITE_PART_STRIDE values per part
     * @returns {number} slot
     */
    _compositeSlotFor(parts) {
        const key = parts.join(',');
        let slot = this._compositeByKey.get(key);
        if (slot === undefined) {
            slot = this._slotMeta.length;
            this._slotMeta.push({ fontIdx: COMPOSITE_FONT, gid: 0, parts: Int32Array.from(parts) });
            this._compositeByKey.set(key, slot);
        }
        return slot;
    }

    /**
     * A composite slot's parts — what the encode worker draws it from: per part
     * (COMPOSITE_PART_STRIDE values) its font, its glyph, where its origin sits (x, y, in ITS
     * font's units, from the cell's origin on the baseline) and how many of those units span
     * one cell's width. Null for every other slot.
     * @param {number} slot
     * @returns {Int32Array|null}
     */
    compositeOf(slot) {
        const m = this._slotMeta[slot];
        return m && m.fontIdx === COMPOSITE_FONT ? m.parts : null;
    }

    /**
     * What a family's sprites are drawn to: the cell's aspect (its primary font's advance over
     * its vertical em — the cell every glyph is normalized to) and the font's own line weights,
     * as fractions of the cell's height. Light is the thickness of the primary font's ─ (else its
     * underline's); heavy its ━'s (else twice light).
     * @param {number} [fam=0]
     * @returns {import('./cellSprites.js').SpriteMetrics}
     */
    spriteMetrics(fam = 0) {
        const family = this._families[fam];
        if (!family.spriteMetrics) {
            const font = this._fonts[family.primary];
            const s = font.shaper, ext = s.fontExtents(), em = ext.ascender - ext.descender;
            const thickness = (ch) => {
                if (!font.coverage.has(ch.codePointAt(0))) return 0;
                const shaped = s.shape(ch);
                let lo = Infinity, hi = -Infinity;
                for (const seg of (shaped.length ? s.glyphOutline(shaped[0].g) : [])) {
                    for (let i = 1; i < seg.values.length; i += 2) { lo = Math.min(lo, seg.values[i]); hi = Math.max(hi, seg.values[i]); }
                }
                return hi > lo ? hi - lo : 0;
            };
            const light = thickness('─') || readFontLines(font.bytes).underlineThickness;
            if (!(light > 0) || !(em > 0)) throw new Error(`FontChain.spriteMetrics: the primary font "${font.name}" gives no line weight (─ ${thickness('─')}, em ${em})`);
            family.spriteMetrics = { aspect: this.cellAdvance(fam) / em, light: light / em, heavy: (thickness('━') || 2 * light) / em };
        }
        return family.spriteMetrics;
    }

    /**
     * Where a family's primary font draws its lines, in cell units (y up from the cell's bottom,
     * 1 = the cell's height — the range every glyph is normalized to): the centre of its underline
     * (post table), the centre of its strikethrough (OS/2; else half its x-height) and their
     * thickness (the underline's). A variable font's tables are its default instance's.
     * @param {number} [fam=0]
     * @returns {{ underlineY: number, strikeY: number, thickness: number }}
     */
    lineMetrics(fam = 0) {
        const f = this._fonts[this._families[fam].primary], ext = f.shaper.fontExtents(), em = ext.ascender - ext.descender;
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

    /**
     * A family's monospace advance, in its primary font's units: the cell's width, forced on
     * every glyph the family draws.
     * @param {number} [fam=0]
     * @returns {number}
     */
    cellAdvance(fam = 0) {
        const family = this._families[fam];
        if (family.advance === undefined) {
            const s = this._fonts[family.primary].shaper;
            const shaped = s.shape('M');
            family.advance = shaped.length ? shaped[0].ax : s.upem * 0.6;
        }
        return family.advance;
    }

    /** @private a codepoint's glyph id in one font (0: none) */
    _gidOf(fontIdx, cp) {
        const shaped = this._fonts[fontIdx].shaper.shape(String.fromCodePoint(cp));
        return shaped.length ? shaped[0].g : 0;
    }

    /**
     * @private The font that draws `fontIdx`'s glyphs in a face: that face's, else — for
     * bold-italic — its italic's, then its bold's; -1 when the font has none (the upright draws).
     */
    _faceFont(fontIdx, face) {
        const faces = this._fonts[fontIdx].faces;
        if (faces[face] >= 0) return faces[face];
        if (face === 3) return faces[2] >= 0 ? faces[2] : faces[1];
        return -1;
    }

    // ── Shaper-compatible surface (glyph IDs are global slots) ──────────────

    /**
     * Shape text into per-glyph records. Each codepoint is routed to its font,
     * shaped there to get a glyph id, and mapped to a global slot. The advance
     * is forced to the family's monospace width so columns stay aligned.
     *
     * @param {string} text
     * @param {number} [fam=0]  the family's index
     * @returns {Array<{g:number, cl:number, ax:number, ay:number, dx:number, dy:number, flags:number}>}
     */
    shape(text, fam = 0) {
        const out = [];
        const cellAx = this.cellAdvance(fam);
        for (let i = 0, len = text.length; i < len;) {
            const cp = text.codePointAt(i);
            const step = cp > 0xFFFF ? 2 : 1;
            let slot = BLANK_SLOT;
            // What a terminal draws itself comes from no font: a sprite, generated to the cell.
            if (isSpriteCodepoint(cp)) {
                out.push({ g: this._spriteSlotFor(cp, fam), cl: i, ax: cellAx, ay: 0, dx: 0, dy: 0, flags: 0 });
                i += step;
                continue;
            }
            const fontIdx = this.routeCodepoint(cp, fam);
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
                slot = this.slotFor(fontIdx, this._gidOf(fontIdx, cp));
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
     * @param {number} [fam=0]
     * @returns {{ g: number, ax: number }}
     */
    lookup(codepoint, fam = 0) {
        const shaped = this.shape(String.fromCodePoint(codepoint), fam);
        return (shaped && shaped.length > 0)
            ? { g: shaped[0].g, ax: shaped[0].ax }
            : { g: BLANK_SLOT, ax: this.cellAdvance(fam) };
    }

    /**
     * A codepoint's glyph in a FACE (core/cellAttrs.js FACE_*: bold, italic, bold-italic): its
     * font's face's, where that font has one and the face covers it; else the upright glyph
     * (`lookup`) — a fallback font's glyph, a sprite and an emoji have no faces, and none is
     * synthesized. A font with no bold-italic draws it in its italic, else its bold.
     * @param {number} codepoint
     * @param {number} face  0 regular · 1 bold · 2 italic · 3 bold-italic
     * @param {number} [fam=0]
     * @returns {{ g: number, ax: number }}
     */
    lookupFace(codepoint, face, fam = 0) {
        if (face && !isSpriteCodepoint(codepoint) && !(this._emojiAtlas && codepoint >= 0x1F000)) {
            const fontIdx = this.routeCodepoint(codepoint, fam);
            const f = fontIdx >= 0 ? this._faceFont(fontIdx, face) : -1;
            if (f >= 0 && this._fonts[f].coverage.has(codepoint)) {
                const gid = this._gidOf(f, codepoint);
                if (gid) return { g: this.slotFor(f, gid), ax: this.cellAdvance(fam) };
            }
        }
        return this.lookup(codepoint, fam);
    }

    /**
     * The glyph of a CLUSTER — one cell's base and its combining marks (`e` + U+0301):
     *   - the precomposed glyph, where the cluster composes to one codepoint (NFC) a font covers;
     *   - else the cluster shaped by HarfBuzz in the base's font (in `face`, where it has one): the
     *     base and each mark where the font's own positioning puts it, as one COMPOSITE slot. A
     *     mark the base's font lacks comes from the font that has it, hung at the cell's right
     *     edge as its own font draws it after a letter; one no font has is left out (the base
     *     still draws).
     * Variation selectors and joiners are not drawn: the cluster is its other codepoints (an
     * emoji sequence draws its first emoji).
     * @param {string} text  the cell's content, base first
     * @param {number} [face=0]
     * @param {number} [fam=0]
     * @returns {{ g: number, ax: number }}
     */
    lookupCluster(text, face = 0, fam = 0) {
        const ax = this.cellAdvance(fam);
        let str = text.replace(IGNORABLE, '').normalize('NFC');
        let base = str.codePointAt(0);
        if (base === undefined) return { g: BLANK_SLOT, ax };
        const single = (s, cp) => s.length === (cp > 0xFFFF ? 2 : 1);
        if (single(str, base)) {
            // One codepoint: precomposed, or a base whose selector went. If no font has the
            // precomposed form, its decomposition may still be drawn from parts.
            if (this.routeCodepoint(base, fam) >= 0) return this.lookupFace(base, face, fam);
            const nfd = str.normalize('NFD');
            if (nfd === str) return this.lookupFace(base, face, fam);
            str = nfd;
            base = str.codePointAt(0);
        }
        // A sprite or an emoji draws alone: nothing combines with a generated or a bitmap glyph.
        const upright = this.routeCodepoint(base, fam);
        if (isSpriteCodepoint(base) || (this._emojiAtlas && base >= 0x1F000) || upright < 0) return this.lookup(base, fam);

        const faced = face ? this._faceFont(upright, face) : -1;
        const fontIdx = faced >= 0 && this._fonts[faced].coverage.has(base) ? faced : upright;
        const font = this._fonts[fontIdx];
        const shaped = font.shaper.shape(str);
        // The base glyph's advance is what its font maps onto the cell's width (as a lone glyph's is).
        const baseGlyph = shaped.find((g) => g.g !== 0);
        const unitsPerCell = baseGlyph ? font.shaper.glyphAdvance(baseGlyph.g) || this.cellAdvance(fam) : 0;
        /** @type {Array<{fontIdx:number, gid:number, x:number, y:number, units:number, placed:boolean}>} */
        const glyphs = [];
        let pen = 0;
        for (const g of shaped) {
            if (g.g !== 0) {
                // The first glyph is the base, where a lone glyph sits; a mark HarfBuzz moved (the
                // font's GPOS anchors) stays where it put it; any other is placed below.
                glyphs.push({ fontIdx, gid: g.g, x: pen + g.dx, y: g.dy, units: unitsPerCell, placed: glyphs.length === 0 || g.dx !== 0 || g.dy !== 0 });
            } else if (baseGlyph) {
                // The base's font has no glyph for this codepoint: the font that has it draws it.
                const cp = str.codePointAt(g.cl);
                const other = this.routeCodepoint(cp, fam);
                const gid = other >= 0 && other !== upright ? this._gidOf(other, cp) : 0;
                if (gid) glyphs.push({ fontIdx: other, gid, x: 0, y: 0, units: Math.round(unitsPerCell * this._fonts[other].shaper.upem / font.shaper.upem), placed: false });
            }
            pen += g.ax;
        }
        if (glyphs.length === 0) return this.lookupFace(base, face, fam);
        this._placeMarks(glyphs);
        // One glyph where a lone glyph sits: HarfBuzz composed the cluster (or only the base drew).
        if (glyphs.length === 1 && glyphs[0].x === 0 && glyphs[0].y === 0) return { g: this.slotFor(glyphs[0].fontIdx, glyphs[0].gid), ax };
        const parts = [];
        for (const g of glyphs) parts.push(g.fontIdx, g.gid, g.x, g.y, g.units);
        return { g: this._compositeSlotFor(parts), ax };
    }

    /**
     * @private Place a cluster's marks that shaping left where their font drew them. Fonts differ
     * in where that is — over the previous letter (a negative bearing), inside their own cell, or
     * anywhere an anchor would have moved them from — so, lacking anchors, a mark is placed by its
     * INK, HarfBuzz's own fallback rule (which this build of it leaves out): centred over the
     * base's ink; a mark above sits `MARK_GAP` over what is under it (lowered only half the way
     * when it floats higher); a mark below hangs that far under (never raised); a mark across
     * the base keeps its height. Marks stack: each is placed against the base and the marks
     * before it. All in cell units (x across the cell, y up it), so parts from two fonts agree.
     * @param {Array<{fontIdx:number, gid:number, x:number, y:number, units:number, placed:boolean}>} glyphs  base first
     */
    _placeMarks(glyphs) {
        if (glyphs.length < 2) return;
        // A glyph's ink in cell units, at its (x, y); null when it has none.
        const ink = (g) => {
            const sh = this._fonts[g.fontIdx].shaper, e = sh.glyphExtents(g.gid);
            if (!e || !(e.width > 0) || !(e.height < 0)) return null;
            const ext = sh.fontExtents(), em = ext.ascender - ext.descender;
            return {
                x0: (g.x + e.xBearing) / g.units, x1: (g.x + e.xBearing + e.width) / g.units,
                y0: (g.y + e.yBearing + e.height - ext.descender) / em, y1: (g.y + e.yBearing - ext.descender) / em,
                em, baseline: -ext.descender / em, gap: MARK_GAP * sh.upem / em,
            };
        };
        const box = ink(glyphs[0]);
        const mid = box ? (box.y0 + box.y1) / 2 : 0;
        for (let i = 1; i < glyphs.length; i++) {
            const g = glyphs[i], m = ink(g);
            if (!m) continue;
            if (!g.placed) {
                // Centred over the base's ink (over the cell, under a base with none).
                const dx = (box ? (box.x0 + box.x1) / 2 : 0.5) - (m.x0 + m.x1) / 2;
                let dy = 0;
                if (box && m.y0 >= mid && m.y0 > m.baseline) {
                    dy = box.y1 + m.gap - m.y0;            // above: its foot a gap over what is under it
                    if (dy < 0) dy /= 2;                    // floating higher: come down half the way
                } else if (box && m.y1 <= m.baseline + m.gap / 4) {
                    const attached = m.y1 >= m.baseline - m.gap / 4;   // a cedilla, an ogonek: it touches
                    dy = Math.min(0, box.y0 - (attached ? 0 : m.gap) - m.y1);   // below: never raised
                }
                g.x += Math.round(dx * g.units);
                g.y += Math.round(dy * m.em);
                m.x0 += dx; m.x1 += dx; m.y0 += dy; m.y1 += dy;
            }
            if (box) { box.y0 = Math.min(box.y0, m.y0); box.y1 = Math.max(box.y1, m.y1); }
        }
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
        if (fontIdx < 0) return this.cellAdvance();
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
        if (m.fontIdx === COMPOSITE_FONT) {
            const names = [];
            for (let i = 0; i < m.parts.length; i += COMPOSITE_PART_STRIDE) names.push(`${this._fonts[m.parts[i]].name}:${this._fonts[m.parts[i]].shaper.glyphName(m.parts[i + 1])}`);
            return { font: '<cluster>', gid: 0, name: names.join(' + ') };
        }
        const f = this._fonts[m.fontIdx];
        if (!f) return { font: `#${m.fontIdx}`, gid: m.gid, name: '.blank' };
        return { font: f.name, gid: m.gid, name: f.shaper.glyphName(m.gid) };
    }

    /** Destroy every font's HarfBuzz objects (an instance before the font whose face it shares). */
    destroy() {
        for (const f of this._fonts) if (f.instanceOf >= 0) f.shaper.destroy();
        for (const f of this._fonts) if (f.instanceOf < 0) f.shaper.destroy();
        this._fonts = [];
        this._families = [];
        this._ready = false;
    }
}

/**
 * One family of a FontChain, as a shaper: text shaped, codepoints and clusters looked up, and
 * the cell measured, all for this family. Its glyph ids are the chain's slots.
 */
export class FontFamilyView {
    /**
     * @param {FontChain} chain
     * @param {number} fam  the family's index in the chain
     */
    constructor(chain, fam) {
        /** @type {FontChain} */ this.chain = chain;
        /** @type {number} */ this.index = fam;
    }

    /** @returns {string|null} the family's id */
    get id() { return this.chain._families[this.index].id; }

    /** @returns {number} the family's primary font's units per em */
    get upem() { return this.chain._fonts[this.chain._families[this.index].primary].shaper.upem; }

    /** @param {string} text */
    shape(text) { return this.chain.shape(text, this.index); }

    /** @param {number} codepoint */
    lookup(codepoint) { return this.chain.lookup(codepoint, this.index); }

    /** @param {number} codepoint @param {number} face */
    lookupFace(codepoint, face) { return this.chain.lookupFace(codepoint, face, this.index); }

    /** @param {string} text @param {number} [face] */
    lookupCluster(text, face = 0) { return this.chain.lookupCluster(text, face, this.index); }

    /** The primary font's horizontal extents (the cell's vertical em). */
    fontExtents() { return this.chain._fonts[this.chain._families[this.index].primary].shaper.fontExtents(); }

    /** Where the family's cell draws its lines (FontChain.lineMetrics). */
    lineMetrics() { return this.chain.lineMetrics(this.index); }

    /** What the family's sprites are drawn to (FontChain.spriteMetrics). */
    spriteMetrics() { return this.chain.spriteMetrics(this.index); }
}
