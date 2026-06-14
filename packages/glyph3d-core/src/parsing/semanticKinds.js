/**
 * semanticKinds.js — labels for the full named-node tree, per language.
 *
 * The arborist records EVERY named node the grammar produced (the faithful AST
 * minus anonymous tokens) — we don't pre-prune to a handful of types. This file
 * is the LABELER over that tree, not a filter: `kindOf(type)` returns a friendly
 * kind for the node types worth naming (function / class / method / …) and falls
 * back to the raw tree-sitter type for everything else, so the model stays
 * faithful (filter by `call_expression` if you want; `function` reads nicer).
 * The twin of syntaxTheme's scope→color map.
 *
 * A spec is two pure functions over a live tree-sitter node:
 *   kindOf(type) → string         friendly kind, or the raw node type
 *   nameOf(node) → string | null  display name, if the node has/borrows one
 *
 * Depth is bounded by the grammar + parse — when the parse is shallow, the tree
 * is shallow. No invented structure.
 */

// ── friendly labels (everything else falls back to the raw node type) ───────

const JS_KINDS = {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    function_expression: 'function',
    generator_function_expression: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    class: 'class',
    variable_declarator: 'variable',
    field_definition: 'field',
    public_field_definition: 'field',
    import_statement: 'import',
    export_statement: 'export',
    jsx_element: 'element',
    jsx_self_closing_element: 'element',
};

const TS_KINDS = {
    ...JS_KINDS,
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    abstract_class_declaration: 'class',
};

const PY_KINDS = {
    function_definition: 'function',
    class_definition: 'class',
    decorated_definition: 'decorated',
    import_statement: 'import',
    import_from_statement: 'import',
};

const GO_KINDS = {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
    type_declaration: 'type',
    import_declaration: 'import',
};

const JSON_KINDS = {
    object: 'object',
    array: 'array',
    pair: 'property',
};

/** @type {Record<string, Record<string,string>>} keyed by descriptor.key */
const KIND_MAPS = {
    javascript: JS_KINDS,
    typescript: TS_KINDS,
    tsx: TS_KINDS,
    python: PY_KINDS,
    go: GO_KINDS,
    json: JSON_KINDS,
};

// ── name resolution ───────────────────────────────────────────────────────

/**
 * The node's display name, or null. Declarations carry a `name` field directly;
 * object members carry `key`. Anonymous functions (arrows, function expressions)
 * borrow the name of whatever binds them — `const foo = () => …`, `{ foo() {} }`,
 * `foo = function () {}` — so they read as `foo` rather than nameless. Reads
 * `.text` only on the small name node, never the whole subtree.
 * @param {any} node live tree-sitter node
 * @returns {string|null}
 */
function nameOf(node) {
    const direct = node.childForFieldName?.('name');
    if (direct) return direct.text;
    if (node.type === 'pair') return node.childForFieldName?.('key')?.text ?? null;

    const p = node.parent;
    if (!p) return null;
    switch (p.type) {
        case 'variable_declarator':
        case 'public_field_definition':
        case 'field_definition':
            return p.childForFieldName?.('name')?.text ?? null;
        case 'pair':
            return p.childForFieldName?.('key')?.text ?? null;
        case 'assignment_expression':
            return p.childForFieldName?.('left')?.text ?? null;
        default:
            return null;
    }
}

/**
 * Scope-defining kinds — the ones that read as "where am I" in a breadcrumb: the
 * enclosing function / method / class / interface / enum a cursor sits inside.
 * Tighter than an outline (no variables/imports), so the structural location
 * stays to the containers that actually frame the cursor.
 * @type {Set<string>}
 */
export const SCOPE_KINDS = new Set(['function', 'method', 'class', 'interface', 'enum']);

/**
 * Labeling spec for a language descriptor key. Never null — every node is
 * recorded; unknown types simply keep their raw tree-sitter name.
 * @param {string} langKey
 * @returns {{ kindOf: (type:string)=>string, nameOf: (node:any)=>string|null }}
 */
export function structureSpecFor(langKey) {
    const map = KIND_MAPS[langKey] || {};
    return {
        kindOf: (type) => map[type] || type,
        nameOf,
    };
}
