/**
 * SemanticInfoMap - Pure data structure mapping glyph buffer slots to token info.
 *
 * No DOM or Three.js imports — safe to use in worker context.
 *
 * Buffer slot indices shift after every _rebuildAllInstances() or
 * applyPrebuiltBuffers(). Call invalidate() then populate() again after each
 * flush that rebuilds geometry. GlyphCollection's onFlush callback is the
 * recommended wiring point.
 *
 * Example:
 *   const map = new SemanticInfoMap();
 *   collection.setPickingSystem(ps);
 *   // After flush completes and tokens are available:
 *   map.invalidate();
 *   map.populate(tokens, glyphOffsets);
 *   // Later in hover handler:
 *   const info = map.lookup(hit.slotIndex);
 */

/**
 * Represents one semantic token (function, class, keyword, etc.)
 */
export class SemanticInfo {
    /**
     * @param {Object} opts
     * @param {string} opts.tokenType - e.g. 'function', 'class', 'keyword', 'string', 'comment', 'variable'
     * @param {string} opts.text - The source text of the token
     * @param {number} opts.glyphStart - First glyph buffer slot covered by this token
     * @param {number} opts.glyphEnd - One past the last glyph buffer slot
     * @param {number} [opts.line] - Source line (0-based)
     * @param {number} [opts.col] - Source column (0-based)
     */
    constructor({ tokenType, text, glyphStart, glyphEnd, line = 0, col = 0 }) {
        this.tokenType = tokenType;
        this.text = text;
        this.glyphStart = glyphStart;
        this.glyphEnd = glyphEnd;
        this.line = line;
        this.col = col;
    }
}

/**
 * Bidirectional index: glyph buffer slot → SemanticInfo, plus category buckets.
 *
 * The _glyphIndex is a plain Array (not Map) for O(1) integer-keyed lookup.
 * Category buckets (functions, classes, etc.) allow O(1) iteration over tokens
 * of a specific type without scanning the full index.
 */
export class SemanticInfoMap {
    constructor() {
        /** @type {SemanticInfo[]} - Sparse array indexed by glyph buffer slot */
        this._glyphIndex = [];

        // Category buckets
        /** @type {SemanticInfo[]} */ this.functions  = [];
        /** @type {SemanticInfo[]} */ this.classes     = [];
        /** @type {SemanticInfo[]} */ this.variables   = [];
        /** @type {SemanticInfo[]} */ this.keywords    = [];
        /** @type {SemanticInfo[]} */ this.strings     = [];
        /** @type {SemanticInfo[]} */ this.comments    = [];
    }

    /**
     * Build the glyph index from an array of tokens.
     * Must be called after every flush that rebuilds buffers (not once at load).
     *
     * @param {Array<{tokenType: string, text: string, glyphStart: number, glyphEnd: number, line?: number, col?: number}>} tokens
     * @param {Array<number>} [glyphOffsets] - Optional per-token glyph offsets (unused by default;
     *   reserved for callers that compute offsets externally)
     */
    populate(tokens, glyphOffsets) {
        this.invalidate();
        for (let t = 0; t < tokens.length; t++) {
            const tok = tokens[t];
            const info = new SemanticInfo(tok);
            for (let i = tok.glyphStart; i < tok.glyphEnd; i++) {
                this._glyphIndex[i] = info;
            }
            // Fill category bucket — pluralise the token type
            const bucket = this[tok.tokenType + 's'];
            if (Array.isArray(bucket)) bucket.push(info);
        }
    }

    /**
     * Clear all state. Call before a flush that will rebuild buffers, or before
     * calling populate() again.
     */
    invalidate() {
        this._glyphIndex = [];
        this.functions  = [];
        this.classes     = [];
        this.variables   = [];
        this.keywords    = [];
        this.strings     = [];
        this.comments    = [];
    }

    /**
     * O(1) lookup of the semantic token that covers a given glyph buffer slot.
     * @param {number} glyphBufferIndex - Absolute buffer slot index
     * @returns {SemanticInfo|null}
     */
    lookup(glyphBufferIndex) {
        return this._glyphIndex[glyphBufferIndex] ?? null;
    }

    /**
     * Return the glyph range of the token that covers a given slot.
     * @param {number} glyphBufferIndex
     * @returns {{ start: number, end: number } | null}
     */
    getTokenRange(glyphBufferIndex) {
        const info = this.lookup(glyphBufferIndex);
        if (!info) return null;
        return { start: info.glyphStart, end: info.glyphEnd };
    }
}
