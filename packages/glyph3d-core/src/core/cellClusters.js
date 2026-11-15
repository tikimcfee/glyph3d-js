/**
 * cellClusters.js — a cell that holds more than one codepoint (a base letter and its combining
 * marks: `e` + U+0301, a Vietnamese stack; a symbol and its variation selector) as ONE number.
 *
 * A terminal cell's content travels as a u32 per cell (TerminalScreen.cp, TerminalGrid's canonical
 * cells, the shape cache's key). A lone codepoint is itself; a cluster is interned here and
 * travels as its CLUSTER ID — a number above every codepoint (≥ CLUSTER_BASE), stable for the
 * page's life. Everything that only compares or copies cell contents is untouched; what DRAWS a
 * cell asks the shape cache, which hands a cluster's text to the font chain
 * (FontChain.lookupCluster: the precomposed glyph where a font has one, else the cluster shaped
 * by HarfBuzz into one composite glyph).
 *
 * Interning allocates only the first time a cluster's text is seen: afterwards `clusterId` is one
 * Map read on a string the caller already holds.
 *
 * Pure: no DOM, no three — worker-safe.
 */

/** The first cluster id: above every Unicode codepoint (U+10FFFF), with room in a u32. */
export const CLUSTER_BASE = 0x200000;

/**
 * How many distinct clusters are interned before the table stops growing (born configurable:
 * `setClusterLimit`). A program that prints ever-new clusters (random combining marks) would
 * otherwise grow it without bound; past the limit a new cluster reads as its first codepoint,
 * said once.
 */
export const CLUSTER_LIMIT_DEFAULT = 1 << 16;

let _limit = CLUSTER_LIMIT_DEFAULT;
let _fullNoted = false;
/** @type {Map<string, number>} cluster text → its id */
const _ids = new Map();
/** @type {string[]} id − CLUSTER_BASE → cluster text */
const _texts = [];

/**
 * The id of a cluster's text, interning it on first sight. A text of ONE codepoint is that
 * codepoint (not a cluster). Past the limit, a new cluster's first codepoint.
 * @param {string} text  the cell's whole content (base first, then its marks)
 * @returns {number} a codepoint, or a cluster id (≥ CLUSTER_BASE)
 */
export function clusterId(text) {
    const known = _ids.get(text);
    if (known !== undefined) return known;
    const first = text.codePointAt(0);
    if (first === undefined) return 32;
    if (text.length === (first > 0xFFFF ? 2 : 1)) return first;
    if (_texts.length >= _limit) {
        if (!_fullNoted) {
            _fullNoted = true;
            console.warn(`[cellClusters] ${_limit} distinct clusters interned — the table is full; a new cluster now draws its first codepoint alone (raise it: setClusterLimit)`);
        }
        return first;
    }
    const id = CLUSTER_BASE + _texts.length;
    _texts.push(text);
    _ids.set(text, id);
    return id;
}

/** @param {number} cell  a cell's content @returns {boolean} whether it is a cluster id */
export function isCluster(cell) {
    return cell >= CLUSTER_BASE;
}

/**
 * A cluster id's text.
 * @param {number} id
 * @returns {string}
 */
export function clusterText(id) {
    const text = _texts[id - CLUSTER_BASE];
    if (text === undefined) throw new Error(`clusterText: ${id} is not an interned cluster (${_texts.length} interned, ids from ${CLUSTER_BASE})`);
    return text;
}

/**
 * A cell's content as text: a cluster's whole text, a codepoint's character.
 * @param {number} cell  a codepoint or a cluster id
 * @returns {string}
 */
export function cellText(cell) {
    return cell >= CLUSTER_BASE ? clusterText(cell) : String.fromCodePoint(cell);
}

/** @returns {number} clusters interned so far */
export function clusterCount() {
    return _texts.length;
}

/**
 * Set how many distinct clusters may be interned (those already interned stay).
 * @param {number} limit  a whole number ≥ 0
 */
export function setClusterLimit(limit) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`setClusterLimit: want a whole number ≥ 0, got ${limit}`);
    _limit = limit;
    _fullNoted = false;
}
