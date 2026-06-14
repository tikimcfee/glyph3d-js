/**
 * Semantic-structure commands: query and act on a grid's SemanticModel (the
 * arborist) — the file's functions / classes / methods / types mapped to buffer
 * ranges by the same tree-sitter parse that colors it.
 *
 *   semantic.outline  <grid> [kind]            — dump the structure tree
 *   semantic.at       <grid> <line> <col>      — the node chain at a position
 *   semantic.highlight <grid> <name> [color]   — highlight named function/class/…
 *
 * Lines/cols are 0-based on the wire (display is 1-based for humans). Colors are
 * additive, same as the highlight.* verbs. Grids resolve by index or path suffix.
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

const COLOR_PRESETS = {
    blue:   { r: 0.3, g: 0.8, b: 1.0 },
    green:  { r: 0.2, g: 1.0, b: 0.4 },
    red:    { r: 1.0, g: 0.3, b: 0.3 },
    yellow: { r: 1.0, g: 0.9, b: 0.2 },
    orange: { r: 1.0, g: 0.6, b: 0.1 },
    purple: { r: 0.7, g: 0.3, b: 1.0 },
    cyan:   { r: 0.2, g: 1.0, b: 1.0 },
};
const DEFAULT_COLOR = COLOR_PRESETS.purple;

/** Named preset or `r g b` floats starting at args[i]; falls back to default. */
function parseColor(args, i) {
    if (i >= args.length) return DEFAULT_COLOR;
    const name = args[i].toLowerCase();
    if (COLOR_PRESETS[name]) return COLOR_PRESETS[name];
    const [r, g, b] = [args[i], args[i + 1], args[i + 2]].map(parseFloat);
    if ([r, g, b].every((n) => !isNaN(n))) return { r, g, b };
    return DEFAULT_COLOR;
}

/** One-line label for a node: `kind name  [startLine-endLine]` (1-based lines). */
function label(node) {
    const name = node.name ? ` ${node.name}` : '';
    return `${node.kind}${name}  [${node.start.line + 1}-${node.end.line + 1}]`;
}

/** Serializable node, nested (drops the parent back-ref to avoid cycles). */
function plain(node) {
    return {
        kind: node.kind,
        name: node.name,
        type: node.type,
        startLine: node.start.line,
        startCol: node.start.col,
        endLine: node.end.line,
        endCol: node.end.col,
        children: node.children.map(plain),
    };
}

/** Serializable node, flat (no children) — for headline / kind listings. */
function plainFlat(node) {
    return {
        kind: node.kind,
        name: node.name,
        type: node.type,
        startLine: node.start.line,
        startCol: node.start.col,
        endLine: node.end.line,
        endCol: node.end.col,
    };
}

/** Kinds shown in the default outline — the readable structural skeleton. */
const HEADLINE_KINDS = new Set([
    'function', 'method', 'class', 'interface', 'type', 'enum',
    'variable', 'field', 'import', 'export',
]);

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSemanticCommands(router) {

    // ── semantic.outline <grid> [kind|all] ──────────────────────────────────
    // No kind: the readable skeleton (headline kinds, nested). A specific kind:
    // a flat list of those (e.g. `function`, `call_expression`). `all`: the full
    // named-node tree — verbose, the faithful AST.
    router.register('semantic.outline', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: semantic.outline <grid> [kind|all]', data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };
        const { grid } = resolved;

        const model = await grid.ensureSemantics?.();
        if (!model) {
            return { text: 'ERR: no semantic model (unsupported file type, or empty)', data: null };
        }
        const path = grid.userData?.sourcePath || resolved.idx;
        const total = model.flat.length;
        const kind = args[1] || null;

        // Specific kind → flat list.
        if (kind && kind !== 'all') {
            const matches = model.outline(kind);
            return {
                text: matches.length
                    ? `${path} — ${matches.length} ${kind}:\n${matches.map((n) => label(n)).join('\n')}`
                    : `${path} — no ${kind} nodes (${total} total)`,
                data: { total, kind, nodes: matches.map(plainFlat) },
            };
        }

        // Nested render — full tree for `all`, else pruned to headline kinds
        // (descend THROUGH the rest so nested headlines still surface).
        const full = kind === 'all';
        const lines = [];
        const shownNodes = [];
        const render = (nodes, depth) => {
            for (const n of nodes) {
                if (full || HEADLINE_KINDS.has(n.kind)) {
                    lines.push(`${'  '.repeat(depth)}${label(n)}`);
                    shownNodes.push(n);
                    render(n.children, depth + 1);
                } else {
                    render(n.children, depth);   // transparent
                }
            }
        };
        render(model.roots, 0);

        return {
            text: lines.length
                ? `${path} — ${shownNodes.length}/${total} node(s):\n${lines.join('\n')}`
                : `${path} — no structural nodes (${total} total)`,
            data: {
                total,
                shown: shownNodes.length,
                nodes: full ? model.roots.map(plain) : shownNodes.map(plainFlat),
            },
        };
    }, {
        description: 'Outline a grid\'s structure — headline kinds, a specific kind, or `all`',
        usage: '<grid> [kind|all]',
    });

    // ── semantic.at <grid> <line> <col> ─────────────────────────────────────
    router.register('semantic.at', async (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: semantic.at <grid> <line> <col>', data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };
        const { grid } = resolved;

        const line = parseInt(args[1]);
        const col = parseInt(args[2]);
        if (isNaN(line) || isNaN(col)) {
            return { text: 'ERR: line and col must be numbers', data: null };
        }

        const model = await grid.ensureSemantics?.();
        if (!model) return { text: 'ERR: no semantic model for this grid', data: null };

        const chain = model.chainAt(line, col);
        if (!chain.length) {
            return { text: `(${line}, ${col}) — no enclosing structural node`, data: { chain: [] } };
        }
        return {
            text: chain.map((n, i) => `${'  '.repeat(i)}${label(n)}`).join('\n'),
            data: { chain: chain.map(plain) },
        };
    }, {
        description: 'Show the semantic node chain (outermost→innermost) at a position',
        usage: '<grid> <line> <col>',
    });

    // ── semantic.highlight <grid> <name> [color] ────────────────────────────
    router.register('semantic.highlight', async (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: semantic.highlight <grid> <name> [color]', data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, args[0], 'grid', { byName: true });
        if (resolved.error) return { text: resolved.error, data: null };
        const { grid } = resolved;

        const model = await grid.ensureSemantics?.();
        if (!model) return { text: 'ERR: no semantic model for this grid', data: null };

        const name = args[1];
        const color = parseColor(args, 2);
        const nodes = model.findByName(name);
        if (!nodes.length) {
            return { text: `ERR: no node named "${name}"`, data: { name, matches: 0 } };
        }
        for (const n of nodes) grid.highlightNode(n, color);

        const path = grid.userData?.sourcePath || resolved.idx;
        return {
            text: `OK: highlighted ${nodes.length}×"${name}" (${nodes.map((n) => n.kind).join(', ')}) in ${path}`,
            data: { name, color, matches: nodes.map(plain) },
        };
    }, {
        description: 'Highlight every semantic node with a given name',
        usage: '<grid> <name> [color]',
    });
}
