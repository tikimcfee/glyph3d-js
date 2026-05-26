// src/services/tour/TourResolver.js

/**
 * @typedef {Object} ResolvedReference
 * @property {import('../../parsing/parseFileRef.js').FileRef} ref  - original FileRef (1-based coords preserved)
 * @property {Object|null} grid             - CodeGrid instance or null
 * @property {string|null} registryId       - registry ID of matched grid
 * @property {number} confidence            - 0.0-1.0
 * @property {'exact'|'suffix'|'fuzzy'|'none'} matchType
 * @property {number|null} line0            - 0-based line (null if no line in ref)
 * @property {number|null} col0             - 0-based col (null if no col in ref)
 * @property {number|null} endLine0         - 0-based end line (null if no endLine in ref)
 * @property {number|null} endCol0          - 0-based end col (null if no endCol in ref)
 */

export default class TourResolver {
    /**
     * @param {import('../SceneRegistry.js').default} registry
     */
    constructor(registry) {
        this._registry = registry;
    }

    /**
     * Resolve a single FileRef to a grid in the workspace.
     * Converts 1-based line/col to 0-based in the returned ResolvedReference
     * (line0, col0, endLine0, endCol0). This is the single coordinate-conversion point.
     * Guards against null filePath (emitted by parseLogLine for timestamp-only lines).
     *
     * @param {import('../../parsing/parseFileRef.js').FileRef} ref
     * @returns {ResolvedReference}
     */
    resolve(ref) {
        if (!ref.filePath) {
            return { ref, grid: null, registryId: null, confidence: 0, matchType: 'none',
                line0: null, col0: null, endLine0: null, endCol0: null };
        }

        // 1. Exact registry ID match
        const exact = this._registry.get(ref.filePath);
        if (exact) {
            return this._makeResolved(ref, exact.grid, exact.id, 1.0, 'exact');
        }

        // 2. sourcePath/filename suffix match
        const suffixMatch = this._findBySuffix(ref.filePath);
        if (suffixMatch) {
            return this._makeResolved(ref, suffixMatch.grid, suffixMatch.id, suffixMatch.confidence, 'suffix');
        }

        // 3. Fuzzy: basename-only match (lowest confidence)
        const fuzzyMatch = this._findByBasename(ref.filePath);
        if (fuzzyMatch) {
            return this._makeResolved(ref, fuzzyMatch.grid, fuzzyMatch.id, fuzzyMatch.confidence, 'fuzzy');
        }

        // 4. No match
        return { ref, grid: null, registryId: null, confidence: 0, matchType: 'none',
            line0: null, col0: null, endLine0: null, endCol0: null };
    }

    /**
     * Resolve all FileRefs from an array of ParsedRefs.
     * Extracts the .ref (FileRef) from each ParsedRef and resolves it.
     * @param {import('../../parsing/parseFileRef.js').ParsedRef[]} parsedRefs
     * @returns {ResolvedReference[]}
     */
    resolveAll(parsedRefs) {
        return parsedRefs.map(pr => {
            const resolved = this.resolve(pr.ref);
            return { ...resolved, parsedRef: pr };
        });
    }

    /**
     * Suffix match: find grids whose sourcePath ends with the file string.
     * Longer suffix overlap = higher confidence.
     * @param {string} file
     * @returns {{ grid, id, confidence }|null}
     * @private
     */
    _findBySuffix(file) {
        if (!file) return null;
        const entries = this._registry.findByType('grid');
        let best = null;
        let bestOverlap = 0;

        for (const entry of entries) {
            const sp = entry.meta.sourcePath || entry.meta.filename || entry.id;
            // Bidirectional suffix match: handle both shorter query matching
            // longer registry path AND longer query (absolute path from stack trace)
            // matching shorter registry path.
            const isSuffix = sp.endsWith(file) || file.endsWith(sp);
            if (!sp || !isSuffix) continue;

            // Confidence: ratio of shorter to longer path length
            const shorter = Math.min(file.length, sp.length);
            const longer = Math.max(file.length, sp.length);
            const overlap = shorter / longer;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                best = entry;
            }
        }

        if (!best) return null;
        // Suffix match confidence: 0.5 base + 0.4 scaled by overlap ratio
        const confidence = 0.5 + 0.4 * bestOverlap;
        return { grid: best.grid, id: best.id, confidence };
    }

    /**
     * Basename-only match: extract filename from ref, compare against grid filenames.
     * @param {string} file
     * @returns {{ grid, id, confidence }|null}
     * @private
     */
    _findByBasename(file) {
        if (!file) return null;
        const queryBase = file.split('/').pop();
        if (!queryBase) return null;

        const entries = this._registry.findByType('grid');
        const matches = [];

        for (const entry of entries) {
            const sp = entry.meta.sourcePath || entry.meta.filename || entry.id;
            const entryBase = sp ? sp.split('/').pop() : '';
            if (entryBase === queryBase) {
                matches.push(entry);
            }
        }

        if (matches.length === 0) return null;
        if (matches.length === 1) {
            return { grid: matches[0].grid, id: matches[0].id, confidence: 0.4 };
        }

        // Multiple basename matches: ambiguous, return first but low confidence
        return { grid: matches[0].grid, id: matches[0].id, confidence: 0.2 };
    }

    /**
     * Build a ResolvedReference with 0-based coordinate conversion.
     * @private
     */
    _makeResolved(ref, grid, registryId, confidence, matchType) {
        return {
            ref,
            grid,
            registryId,
            confidence,
            matchType,
            line0:    ref.line    != null ? ref.line    - 1 : null,
            col0:     ref.col     != null ? ref.col     - 1 : null,
            endLine0: ref.endLine != null ? ref.endLine - 1 : null,
            endCol0:  ref.endCol  != null ? ref.endCol  - 1 : null,
        };
    }
}
