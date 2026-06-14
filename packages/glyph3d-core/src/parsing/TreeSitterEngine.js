/**
 * TreeSitterEngine.js — main-thread tree-sitter wrapper (web-tree-sitter 0.26).
 *
 * Singleton. Initializes the WASM runtime once, lazily loads + caches one Language
 * per grammar (the ~MB grammar wasm is only fetched when a file of that type is
 * first opened), compiles + caches one highlight Query per language, and parses
 * source text into the two products of a single parse: flat highlight captures
 * and (given a structure spec) a nested structural tree. It holds NO opinion
 * about colors, buffers, or kind vocabulary — those are syntaxTheme,
 * SyntaxColorizer, and semanticKinds.
 *
 * web-tree-sitter is dynamically imported on first use, so it (and the runtime
 * wasm) stay out of the bundle until colorization actually runs. Runs on the main
 * thread; parse is synchronous once the grammar is loaded.
 */

/**
 * @typedef {Object} Capture
 * @property {string} scope
 * @property {number} startRow @property {number} startCol  - tree-sitter row/col (UTF-16 cols)
 * @property {number} endRow   @property {number} endCol
 * @property {number} startIndex @property {number} endIndex - absolute UTF-16 char offsets
 *   into the source. Render-neutral: 3D maps row/col → buffer slots; a 2D editor (CodeMirror)
 *   indexes by these absolute offsets for decorations. One parse feeds both.
 */

const RUNTIME_WASM_URL = new URL('./vendor/web-tree-sitter.wasm', import.meta.url).href;

let _initPromise = null;            // Promise<{Parser,Language,Query}>
let _ts = null;                     // resolved {Parser,Language,Query}
const _languages = new Map();       // key -> Promise<Language>
const _queries = new Map();         // key -> Query | null (null = compile failed)

async function ensureInit() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const mod = await import('web-tree-sitter');
        const ns = mod.default && mod.default.Parser ? mod.default : mod;
        const { Parser, Language, Query } = ns;
        await Parser.init({ locateFile: () => RUNTIME_WASM_URL });
        _ts = { Parser, Language, Query };
        return _ts;
    })();
    return _initPromise;
}

/**
 * Lazily load + cache a grammar Language.
 * @param {string} key
 * @param {string} grammarUrl
 * @returns {Promise<any>}
 */
function loadLanguage(key, grammarUrl) {
    let p = _languages.get(key);
    if (p) return p;
    p = ensureInit().then(({ Language }) => Language.load(grammarUrl));
    _languages.set(key, p);
    return p;
}

/**
 * Compile + cache a highlight query. A malformed query (e.g. a node name not in
 * the grammar) disables coloring for that language rather than throwing.
 * @returns {any|null}
 */
function getQuery(key, language, scmSource) {
    if (_queries.has(key)) return _queries.get(key);
    let q = null;
    try {
        q = new _ts.Query(language, scmSource);
    } catch (e) {
        console.warn(`[tree-sitter] highlight query failed to compile for "${key}":`, e?.message ?? e);
    }
    _queries.set(key, q);
    return q;
}

/**
 * Walk EVERY named node once into a faithful nested tree — the full AST minus
 * anonymous tokens (keywords/operators/punctuation), nesting free from the
 * parse. No pruning: depth is whatever the grammar resolved. Stays
 * vocabulary-agnostic — the spec (kindOf labels, nameOf) is the only opinion,
 * injected by the caller. Columns are raw tree-sitter (UTF-16); the caller
 * converts to codepoint columns where it owns the line text.
 * @param {any} node live tree-sitter node
 * @param {{kindOf:(t:string)=>string, nameOf:(n:any)=>string|null}} spec
 * @param {Array} out sibling list to append entries to
 */
function walkStructure(node, spec, out) {
    const count = node.namedChildCount;
    for (let i = 0; i < count; i++) {
        const child = node.namedChild(i);
        const entry = {
            kind: spec.kindOf(child.type),
            name: spec.nameOf(child) ?? null,
            type: child.type,
            start: { line: child.startPosition.row, col: child.startPosition.column },
            end: { line: child.endPosition.row, col: child.endPosition.column },
            startIndex: child.startIndex,
            endIndex: child.endIndex,
            children: [],
        };
        out.push(entry);
        walkStructure(child, spec, entry.children);
    }
}

/**
 * Parse `text` ONCE and return both products of that parse: the flat highlight
 * `captures` (for coloring) and, when a structure `spec` is given, the nested
 * `structure` roots (for the semantic model). One parse, two products — the
 * tree is walked for both before it's freed. Positions are tree-sitter
 * {row, column} in UTF-16 code units; the caller converts to codepoint columns
 * where it matters.
 * @param {string} text
 * @param {{ key:string, grammarUrl:string, query:string }} descriptor
 * @param {{kindOf:(t:string)=>string, nameOf:(n:any)=>string|null}|null} [spec]
 * @param {{ captures?: boolean }} [opts] set `captures:false` for a structure-only
 *   parse (the lazy semantic build) — skips the highlight query entirely.
 * @returns {Promise<{ captures: Capture[], structure: Array|null }>}
 */
export async function parseDocument(text, descriptor, spec = null, opts = {}) {
    const wantCaptures = opts.captures !== false;
    const { Parser } = await ensureInit();
    const language = await loadLanguage(descriptor.key, descriptor.grammarUrl);
    const query = wantCaptures ? getQuery(descriptor.key, language, descriptor.query) : null;

    const parser = new Parser();
    let tree = null;
    try {
        parser.setLanguage(language);
        tree = parser.parse(text);

        let captures = [];
        if (query) {
            const caps = query.captures(tree.rootNode);
            captures = new Array(caps.length);
            for (let i = 0; i < caps.length; i++) {
                const n = caps[i].node;
                captures[i] = {
                    scope: caps[i].name,
                    startRow: n.startPosition.row,
                    startCol: n.startPosition.column,
                    endRow: n.endPosition.row,
                    endCol: n.endPosition.column,
                    startIndex: n.startIndex,   // absolute UTF-16 offset — for 2D editor decorations
                    endIndex: n.endIndex,
                };
            }
        }

        let structure = null;
        if (spec) {
            structure = [];
            walkStructure(tree.rootNode, spec, structure);
        }

        return { captures, structure };
    } finally {
        tree?.delete?.();
        parser.delete?.();
    }
}
