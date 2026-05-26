// src/parsing/parseStackTrace.js

/**
 * @typedef {Object} StackFrameMeta
 * @property {string} language        - 'javascript' | 'python' | 'go' | 'java'
 * @property {string|null} fnName     - function/method name
 * @property {number} depth           - 0-based frame index within its trace
 * @property {boolean} isNative       - true for <anonymous>, native frames
 */

const FRAME_MATCHERS = [
    { // JavaScript: "    at fn (file.js:10:5)" or "    at file.js:10:5"
        lang: 'javascript',
        re: /^\s+at\s+(?:(.+?)\s+\()?([^\s()]+):(\d+):(\d+)\)?$/,
        toRef: (m) => ({
            ref: { filePath: m[2], line: +m[3], col: +m[4], endLine: null, endCol: null },
            fnName: m[1] || null, isNative: false,
        }),
    },
    { // JavaScript native: "    at Object.<anonymous>"
        lang: 'javascript',
        re: /^\s+at\s+(.+?)\s+\(<anonymous>\)$/,
        toRef: (m) => ({
            ref: { filePath: '<anonymous>', line: null, col: null, endLine: null, endCol: null },
            fnName: m[1], isNative: true,
        }),
    },
    { // Python: '  File "path.py", line 10, in func'
        lang: 'python',
        re: /^\s+File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/,
        toRef: (m) => ({
            ref: { filePath: m[1], line: +m[2], col: null, endLine: null, endCol: null },
            fnName: m[3] || null, isNative: false,
        }),
    },
    { // Java: "    at com.pkg.Class.method(File.java:42)"
        lang: 'java',
        re: /^\s+at\s+([\w.$]+)\(([^)]+\.java):(\d+)\)$/,
        toRef: (m) => {
            const q = m[1], d = q.lastIndexOf('.');
            return {
                ref: { filePath: m[2], line: +m[3], col: null, endLine: null, endCol: null },
                fnName: d >= 0 ? q.slice(d + 1) : q, isNative: false,
            };
        },
    },
    { // Go: "path/file.go:123 +0x..."
        lang: 'go',
        re: /^\s*([^\s]+\.go):(\d+)\s/,
        toRef: (m) => ({
            ref: { filePath: m[1], line: +m[2], col: null, endLine: null, endCol: null },
            fnName: null, isNative: false,
        }),
    },
];

const GO_QUAL = /^([a-zA-Z0-9_./]+)\.([a-zA-Z0-9_]+)\(.*\)$/;

/**
 * Parse stack traces (JS/Python/Go/Java) from text.
 * Outputs 1-based line numbers (source-faithful).
 * @param {string} text
 * @returns {import('./parseFileRef.js').ParseResult}
 */
export function parseStackTrace(text) {
    const lines = text.split('\n');
    const refs = [], unmatched = [];
    let depth = 0, lastLang = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let matched = false;

        for (const { lang, re, toRef } of FRAME_MATCHERS) {
            const m = re.exec(line);
            if (!m) continue;
            if (lastLang !== lang) { depth = 0; lastLang = lang; }
            const { ref, fnName, isNative } = toRef(m);

            // Go: peek previous line for function name
            let resolvedFn = fnName;
            if (lang === 'go' && !fnName && i > 0) {
                const prev = GO_QUAL.exec(lines[i - 1].trim());
                if (prev) resolvedFn = prev[2];
            }

            refs.push({
                ref, kind: 'stack-frame', rawText: line, sourceLineIndex: i,
                meta: { language: lang, fnName: resolvedFn, depth: depth++, isNative },
            });
            matched = true;
            break; // first matcher wins per line
        }

        if (!matched) {
            if (line.trim() !== '') { lastLang = null; depth = 0; }
            unmatched.push(line);
        }
    }
    return { refs, unmatched };
}
