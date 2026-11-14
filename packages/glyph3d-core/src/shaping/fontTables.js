/**
 * fontTables.js — the few font-wide metrics HarfBuzz's JS binding doesn't hand over, read straight
 * from a TrueType/OpenType file's tables: where the font puts its underline and strikethrough.
 *
 *   post   underlinePosition (the TOP of the underline, relative to the baseline), underlineThickness
 *   OS/2   yStrikeoutPosition (the top of the strikeout), yStrikeoutSize, sxHeight (version ≥ 2)
 *
 * Pure byte reading (big-endian sfnt): no DOM, no HarfBuzz. Font collections (.ttc) are not read.
 */

/**
 * @typedef {Object} FontLines  all in font units, y up from the baseline
 * @property {number} underlineTop        the top edge of the underline
 * @property {number} underlineThickness
 * @property {number|null} strikeoutTop   the top edge of the strikethrough (null: no OS/2 table)
 * @property {number|null} strikeoutSize
 * @property {number|null} xHeight        (null: OS/2 older than version 2)
 */

/**
 * Read a font file's line metrics.
 * @param {ArrayBuffer|Uint8Array} bytes  the .ttf / .otf file
 * @returns {FontLines}
 */
export function readFontLines(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (v.byteLength < 12) throw new Error('readFontLines: not a font file (shorter than an sfnt header)');
    const tag = v.getUint32(0);
    if (tag === 0x74746366) throw new Error('readFontLines: a font collection (.ttc) — give it one face');
    if (tag !== 0x00010000 && tag !== 0x4F54544F && tag !== 0x74727565) {
        throw new Error(`readFontLines: not an sfnt font (starts 0x${tag.toString(16)})`);
    }
    const tables = new Map();
    const n = v.getUint16(4);
    for (let i = 0; i < n; i++) {
        const o = 12 + i * 16;
        const name = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
        tables.set(name, { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
    }
    const post = tables.get('post');
    if (!post || post.length < 12) throw new Error('readFontLines: the font has no post table (underline metrics)');
    const out = {
        underlineTop: v.getInt16(post.offset + 8),
        underlineThickness: v.getInt16(post.offset + 10),
        strikeoutTop: null, strikeoutSize: null, xHeight: null,
    };
    const os2 = tables.get('OS/2');
    if (os2 && os2.length >= 30) {
        out.strikeoutSize = v.getInt16(os2.offset + 26);
        out.strikeoutTop = v.getInt16(os2.offset + 28);
        if (v.getUint16(os2.offset) >= 2 && os2.length >= 88) out.xHeight = v.getInt16(os2.offset + 86);
    }
    return out;
}
