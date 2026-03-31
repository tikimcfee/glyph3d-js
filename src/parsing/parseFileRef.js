// src/parsing/parseFileRef.js

/**
 * @typedef {Object} FileRef
 * @property {string} filePath       - path as appeared in source (absolute, relative, or bare)
 * @property {number|null} line      - 1-based line number
 * @property {number|null} col       - 1-based column number
 * @property {number|null} endLine   - 1-based end line (for ranges)
 * @property {number|null} endCol    - 1-based end column (for ranges)
 */

/**
 * @typedef {Object} ParsedRef
 * @property {FileRef} ref
 * @property {string} kind                - 'stack-frame' | 'log-line' | 'file-ref'
 * @property {string} rawText             - original source line
 * @property {number} sourceLineIndex     - 0-based index in input text
 * @property {Object|null} meta           - kind-specific (StackFrameMeta | LogLineMeta | null)
 */

/**
 * @typedef {Object} ParseResult
 * @property {ParsedRef[]} refs       - extracted references, source order
 * @property {string[]} unmatched     - lines with no references
 */

const PATTERNS = [
    { // file:line:col (gcc, eslint, tsc, rust)
        re: /(?:^|[\s"'(])([^\s"'():]+\.[a-zA-Z]{1,10}):(\d+):(\d+)/,
        extract: (m) => ({ filePath: m[1], line: +m[2], col: +m[3], endLine: null, endCol: null }),
    },
    { // file(line,col) (MSVC, C#)
        re: /(?:^|[\s"'(])([^\s"'():]+\.[a-zA-Z]{1,10})\((\d+),(\d+)\)/,
        extract: (m) => ({ filePath: m[1], line: +m[2], col: +m[3], endLine: null, endCol: null }),
    },
    { // file:line
        re: /(?:^|[\s"'(])([^\s"'():]+\.[a-zA-Z]{1,10}):(\d+)(?=[:\s,)"']|$)/,
        extract: (m) => ({ filePath: m[1], line: +m[2], col: null, endLine: null, endCol: null }),
    },
    { // "file", line N (Python SyntaxError)
        re: /"([^"]+\.[a-zA-Z]{1,10})",\s*line\s+(\d+)/,
        extract: (m) => ({ filePath: m[1], line: +m[2], col: null, endLine: null, endCol: null }),
    },
];

const NOISE = new Set(['Error.js', 'Object.js', 'Array.js', 'Promise.js', 'Function.js', 'Module.js']);

function looksLikeFilePath(path) {
    if (!/\.[a-zA-Z]{1,10}$/.test(path)) return false;
    const base = path.split('/').pop();
    if (NOISE.has(base)) return false;
    return path.includes('/') || path.includes('\\') || base.length > 2;
}

/**
 * Parse file references (file:line:col patterns) from text.
 * Outputs 1-based line/col numbers (source-faithful).
 * @param {string} text
 * @returns {ParseResult}
 */
export function parseFileRef(text) {
    const lines = text.split('\n');
    const refs = [], unmatched = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found = false;
        for (const { re, extract } of PATTERNS) {
            const gre = new RegExp(re.source, 'g');
            let m;
            while ((m = gre.exec(line)) !== null) {
                const ref = extract(m);
                if (!looksLikeFilePath(ref.filePath)) continue;
                refs.push({ ref, kind: 'file-ref', rawText: line, sourceLineIndex: i, meta: null });
                found = true;
            }
        }
        if (!found) unmatched.push(line);
    }
    return { refs, unmatched };
}
