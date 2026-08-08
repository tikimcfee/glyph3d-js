/**
 * languageRegistry.js — file extension → tree-sitter language descriptor.
 *
 * Each descriptor carries the grammar wasm URL (a static `new URL(...)` so Vite
 * emits it as a hashed asset baked into the binary) and a compact highlight query.
 * Grammars are lazy-loaded by TreeSitterEngine on first use. Adding a language —
 * or letting a user drop in their own grammar later — is one entry here.
 *
 * Queries are intentionally compact: the common scopes, ordered so that more
 * specific captures appear after general ones (the colorizer applies in order,
 * last write wins per glyph). They are not the exhaustive nvim-treesitter sets.
 */

const grammar = (name) => {
    const url = new URL(`./vendor/tree-sitter-${name}.wasm`, import.meta.url);
    // file: → plain path (emscripten's node branch reads via fs — bun tests /
    // headless); browser keeps the href. Posix pathname; the harness is linux.
    return url.protocol === 'file:' ? url.pathname : url.href;
};

// ── Queries ─────────────────────────────────────────────────────────────────

const JS_QUERY = `
(comment) @comment
[(string) (template_string) (regex)] @string
(number) @number
[(true) (false) (null) (undefined)] @constant.builtin
[(this) (super)] @variable.builtin
(property_identifier) @property
(class_declaration name: (_) @type)
(new_expression constructor: (identifier) @type)
(function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (property_identifier) @function))
[
  "const" "let" "var" "function" "return" "if" "else" "for" "while" "do"
  "switch" "case" "break" "continue" "new" "delete" "typeof" "instanceof"
  "void" "class" "extends" "import" "export" "from" "as" "async" "await"
  "yield" "try" "catch" "finally" "throw" "default" "static" "get" "set"
] @keyword
`;

const TS_QUERY = JS_QUERY + `
(type_identifier) @type
(predefined_type) @type.builtin
(interface_declaration name: (type_identifier) @type)
(type_alias_declaration name: (type_identifier) @type)
(enum_declaration name: (identifier) @type)
[
  "interface" "type" "enum" "namespace" "declare" "abstract" "implements"
  "public" "private" "protected" "readonly" "keyof" "satisfies"
] @keyword
`;

const PYTHON_QUERY = `
(comment) @comment
(string) @string
[(integer) (float)] @number
[(true) (false) (none)] @constant.builtin
(decorator) @function
(function_definition name: (identifier) @function)
(class_definition name: (identifier) @type)
(call function: (identifier) @function)
(call function: (attribute attribute: (identifier) @function))
[
  "def" "class" "return" "if" "elif" "else" "for" "while" "import" "from"
  "as" "with" "try" "except" "finally" "raise" "pass" "break" "continue"
  "lambda" "yield" "global" "nonlocal" "assert" "del" "in" "is" "not"
  "and" "or" "async" "await"
] @keyword
`;

const GO_QUERY = `
(comment) @comment
[(interpreted_string_literal) (raw_string_literal) (rune_literal)] @string
[(int_literal) (float_literal) (imaginary_literal)] @number
(type_identifier) @type
(function_declaration name: (identifier) @function)
(method_declaration name: (field_identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (selector_expression field: (field_identifier) @function))
[
  "func" "return" "if" "else" "for" "range" "var" "const" "type" "struct"
  "interface" "map" "chan" "package" "import" "go" "defer" "select" "switch"
  "case" "default" "break" "continue" "fallthrough" "goto"
] @keyword
`;

const JSON_QUERY = `
(string) @string
(number) @number
[(true) (false) (null)] @constant.builtin
(pair key: (string) @property)
`;

// ── Extension → descriptor ───────────────────────────────────────────────────

const LANGUAGES = {
    javascript: { key: 'javascript', grammarUrl: grammar('javascript'), query: JS_QUERY },
    typescript: { key: 'typescript', grammarUrl: grammar('typescript'), query: TS_QUERY },
    tsx:        { key: 'tsx',        grammarUrl: grammar('tsx'),        query: TS_QUERY },
    go:         { key: 'go',         grammarUrl: grammar('go'),         query: GO_QUERY },
    python:     { key: 'python',     grammarUrl: grammar('python'),     query: PYTHON_QUERY },
    json:       { key: 'json',       grammarUrl: grammar('json'),       query: JSON_QUERY },
};

/** @type {Record<string, keyof typeof LANGUAGES>} */
const EXT_TO_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    tsx: 'tsx',
    go: 'go',
    py: 'python', pyi: 'python',
    json: 'json', jsonc: 'json',
};

/**
 * Resolve a filename/path to a language descriptor, or null if unsupported.
 * @param {string} filename
 * @returns {{ key:string, grammarUrl:string, query:string } | null}
 */
export function detectLanguage(filename) {
    if (!filename) return null;
    const base = filename.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = base.slice(dot + 1).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    return lang ? LANGUAGES[lang] : null;
}

export { LANGUAGES };
