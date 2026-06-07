/**
 * TreeSitterEngine.js — main-thread tree-sitter wrapper (web-tree-sitter 0.26).
 *
 * Singleton. Initializes the WASM runtime once, lazily loads + caches one Language
 * per grammar (the ~MB grammar wasm is only fetched when a file of that type is
 * first opened), compiles + caches one highlight Query per language, and turns
 * source text into a flat list of capture ranges. It holds NO opinion about
 * colors or buffers — that's syntaxTheme + SyntaxColorizer.
 *
 * web-tree-sitter is dynamically imported on first use, so it (and the runtime
 * wasm) stay out of the bundle until colorization actually runs. Runs on the main
 * thread; parse is synchronous once the grammar is loaded.
 */

/** @typedef {{ scope:string, startRow:number, startCol:number, endRow:number, endCol:number }} Capture */

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
 * Parse `text` with the given language descriptor and return highlight captures.
 * Positions are tree-sitter {row, column}; columns are UTF-16 code units for
 * string input (the caller converts to codepoint columns where it matters).
 * @param {string} text
 * @param {{ key:string, grammarUrl:string, query:string }} descriptor
 * @returns {Promise<Capture[]>}
 */
export async function highlight(text, descriptor) {
    const { Parser } = await ensureInit();
    const language = await loadLanguage(descriptor.key, descriptor.grammarUrl);
    const query = getQuery(descriptor.key, language, descriptor.query);
    if (!query) return [];

    const parser = new Parser();
    let tree = null;
    try {
        parser.setLanguage(language);
        tree = parser.parse(text);
        const caps = query.captures(tree.rootNode);
        const out = new Array(caps.length);
        for (let i = 0; i < caps.length; i++) {
            const n = caps[i].node;
            out[i] = {
                scope: caps[i].name,
                startRow: n.startPosition.row,
                startCol: n.startPosition.column,
                endRow: n.endPosition.row,
                endCol: n.endPosition.column,
            };
        }
        return out;
    } finally {
        tree?.delete?.();
        parser.delete?.();
    }
}
