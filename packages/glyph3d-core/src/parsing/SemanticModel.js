/**
 * SemanticModel.js — the arborist's output: a file's tree-sitter structure
 * re-projected into our coordinate system and our kind vocabulary.
 *
 * Coordinates are canonical {line, col} where `col` is a CODEPOINT index — the
 * same space a glyph's slot offset lives in (slot = lineSlotBase[line] + col),
 * so a node's range maps to glyph slots with no further conversion. Slots
 * themselves are NOT stored: they shift on every relayout/wrap, so the grid
 * derives them from the live layout on demand (highlightNode → highlightRange).
 *
 * `startIndex`/`endIndex` are absolute UTF-16 offsets (free from tree-sitter,
 * kept for 2D-editor parity and exact nesting comparison).
 *
 * @typedef {Object} SemanticNode
 * @property {string} kind            normalized: function|method|class|interface|type|enum|…
 * @property {string|null} name       identifier text, or null for anonymous nodes
 * @property {string} type            raw tree-sitter node type (escape hatch)
 * @property {{line:number, col:number}} start  codepoint col, inclusive
 * @property {{line:number, col:number}} end    codepoint col, exclusive
 * @property {number} startIndex      absolute UTF-16 offset, inclusive
 * @property {number} endIndex        absolute UTF-16 offset, exclusive
 * @property {SemanticNode|null} parent
 * @property {SemanticNode[]} children
 */

import { SCOPE_KINDS } from './semanticKinds.js';

export default class SemanticModel {
    /** @param {SemanticNode[]} roots top-level nodes; children already nested */
    constructor(roots) {
        /** @type {SemanticNode[]} top-level (file-scope) nodes */
        this.roots = roots || [];
        /** @type {SemanticNode[]} every node, depth-first, parent before child */
        this.flat = [];
        const link = (nodes, parent) => {
            for (const node of nodes) {
                node.parent = parent;
                this.flat.push(node);
                link(node.children, node);
            }
        };
        link(this.roots, null);
    }

    /**
     * Innermost node whose span contains (line, col), optionally constrained to
     * a kind. Tightness is by UTF-16 char span — the more deeply nested wins.
     * @param {number} line @param {number} col
     * @param {string|null} [kind]
     * @returns {SemanticNode|null}
     */
    nodeAt(line, col, kind = null) {
        let best = null;
        for (const node of this.flat) {
            if (kind && node.kind !== kind) continue;
            if (!this._contains(node, line, col)) continue;
            if (!best || this._span(node) < this._span(best)) best = node;
        }
        return best;
    }

    /** Nearest enclosing node of `kind` at (line,col) — "the function I'm in". */
    enclosing(line, col, kind) {
        return this.nodeAt(line, col, kind);
    }

    /**
     * Outermost-to-innermost chain of nodes containing (line, col) — the
     * breadcrumb for expand-selection / "where am I" inspection.
     * @returns {SemanticNode[]}
     */
    chainAt(line, col) {
        const out = [];
        for (let n = this.nodeAt(line, col); n; n = n.parent) out.unshift(n);
        return out;
    }

    /**
     * Outermost→innermost chain of SCOPE nodes (function/method/class/…) containing
     * (line, col) — the structural "where am I" a breadcrumb shows: file › class ›
     * method. Drops the non-scope nodes (statements, expressions, variables) the
     * full chainAt would include.
     * @returns {SemanticNode[]}
     */
    scopeChainAt(line, col) {
        return this.chainAt(line, col).filter((n) => SCOPE_KINDS.has(n.kind));
    }

    /**
     * The file outline. With no kind, the top-level nodes (their children nest);
     * with a kind, every node of that kind anywhere (e.g. all methods).
     * @param {string|null} [kind]
     * @returns {SemanticNode[]}
     */
    outline(kind = null) {
        return kind ? this.flat.filter((n) => n.kind === kind) : this.roots.slice();
    }

    /**
     * Nodes with an exact (case-sensitive) name, optional kind filter — the
     * lookup behind "highlight the function named X".
     * @param {string} name @param {string|null} [kind]
     * @returns {SemanticNode[]}
     */
    findByName(name, kind = null) {
        return this.flat.filter((n) => n.name === name && (!kind || n.kind === kind));
    }

    _contains(node, line, col) {
        const { start, end } = node;
        if (line < start.line || line > end.line) return false;
        if (line === start.line && col < start.col) return false;
        if (line === end.line && col >= end.col) return false;
        return true;
    }

    _span(node) {
        return node.endIndex - node.startIndex;
    }
}
