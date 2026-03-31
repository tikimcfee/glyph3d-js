# Phase 0: Parsing Layer

File placement: `src/parsing/` -- pure functions, no DOM/Three.js deps, worker-safe.

```
src/parsing/
  index.js              # barrel export
  parseFileRef.js       # file:line:col patterns
  parseStackTrace.js    # JS/Python/Go/Java stack frames
  parseLogLine.js       # timestamped, leveled log lines
  parseAuto.js          # format inference + delegation
```

## 1. Core Data Structures

```js
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
 * @typedef {Object} StackFrameMeta
 * @property {string} language        - 'javascript' | 'python' | 'go' | 'java'
 * @property {string|null} fnName     - function/method name
 * @property {number} depth           - 0-based frame index within its trace
 * @property {boolean} isNative       - true for <anonymous>, native frames
 */

/**
 * @typedef {Object} LogLineMeta
 * @property {string|null} timestamp  - raw timestamp string
 * @property {string|null} level      - 'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'|null
 * @property {string} message         - log body after timestamp+level
 */

/**
 * @typedef {Object} ParseResult
 * @property {ParsedRef[]} refs       - extracted references, source order
 * @property {string[]} unmatched     - lines with no references
 */
```

## 2. `parseFileRef(text) -> ParseResult`

Handles `file.js:42:10`, `file.js:42`, `file.js(42,10)`, `"file.py", line 42`.

```js
// src/parsing/parseFileRef.js

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

const NOISE = new Set(['Error.js','Object.js','Array.js','Promise.js','Function.js','Module.js']);

function looksLikeFilePath(path) {
    if (!/\.[a-zA-Z]{1,10}$/.test(path)) return false;
    const base = path.split('/').pop();
    if (NOISE.has(base)) return false;
    return path.includes('/') || path.includes('\\') || base.length > 2;
}

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
```

## 3. `parseStackTrace(text) -> ParseResult`

Table-driven: each language is a regex + extractor. Depth resets on trace boundaries.

```js
// src/parsing/parseStackTrace.js

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
```

## 4. `parseLogLine(text) -> ParseResult`

```js
// src/parsing/parseLogLine.js
import { parseFileRef } from './parseFileRef.js';

const LEVELS = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE|VERBOSE)\b/i;
const TS = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?|\[?\d{2}:\d{2}:\d{2}\]?|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;

export function parseLogLine(text) {
    const lines = text.split('\n');
    const refs = [], unmatched = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) { unmatched.push(line); continue; }

        const tsMatch = TS.exec(line);
        const lvlMatch = LEVELS.exec(line);
        if (!tsMatch && !lvlMatch) { unmatched.push(line); continue; }

        const timestamp = tsMatch?.[1] ?? null;
        const level = lvlMatch ? lvlMatch[1].toUpperCase().replace('WARNING', 'WARN') : null;

        let msgStart = 0;
        if (tsMatch) msgStart = Math.max(msgStart, tsMatch.index + tsMatch[0].length);
        if (lvlMatch) msgStart = Math.max(msgStart, lvlMatch.index + lvlMatch[0].length);
        const message = line.slice(msgStart).replace(/^[\s:\-|]+/, '');

        const fileRefs = parseFileRef(line).refs;

        if (fileRefs.length > 0) {
            for (const fr of fileRefs) {
                refs.push({ ref: fr.ref, kind: 'log-line', rawText: line, sourceLineIndex: i,
                    meta: { timestamp, level, message } });
            }
        } else {
            refs.push({ ref: { filePath: null, line: null, col: null, endLine: null, endCol: null },
                kind: 'log-line', rawText: line, sourceLineIndex: i,
                meta: { timestamp, level, message } });
        }
    }
    return { refs, unmatched };
}
```

## 5. `parseAuto(text) -> ParseResult`

Runs all parsers, deduplicates by `(sourceLineIndex, filePath, line, col)`. Priority: stack > log > file-ref (most specific kind wins).

```js
// src/parsing/parseAuto.js
import { parseStackTrace } from './parseStackTrace.js';
import { parseLogLine } from './parseLogLine.js';
import { parseFileRef } from './parseFileRef.js';

export function parseAuto(text) {
    const sources = [parseStackTrace(text), parseLogLine(text), parseFileRef(text)];
    const seen = new Set(), refs = [];

    for (const { refs: srcRefs } of sources) {
        for (const r of srcRefs) {
            const k = `${r.sourceLineIndex}:${r.ref.filePath}:${r.ref.line}:${r.ref.col}`;
            if (!seen.has(k)) { seen.add(k); refs.push(r); }
        }
    }
    refs.sort((a, b) => a.sourceLineIndex - b.sourceLineIndex);

    const matchedLines = new Set(refs.map(r => r.sourceLineIndex));
    const unmatched = text.split('\n').filter((_, i) => !matchedLines.has(i));
    return { refs, unmatched };
}
```

## 6. Composability

```
              input text
                  |
       +----------+----------+
       |          |          |
parseStackTrace parseLogLine parseFileRef
       |          |          |
       +-----+----+----+----+
             |         |
         parseAuto (dedup + merge)
             |
        ParseResult
             |
        resolver (Phase 1 -- maps FileRef to loaded CodeGrids)
```

Each parser returns `ParseResult`. Use a specific parser when format is known, or `parseAuto` for unknown input. `parseLogLine` internally delegates to `parseFileRef` for embedded file references.

The resolver (not this layer) will: suffix-match `FileRef.filePath` against `grid.userData.sourcePath`, convert 1-based to 0-based (`line - 1`, `col - 1`), and call `grid.highlightRange()`.

## 7. Edge Cases

| Ambiguity | Resolution |
|-----------|-----------|
| "Error.js" -- filename or keyword? | `looksLikeFilePath()` noise list rejects bare "Error.js"; "src/Error.js" passes (has path separator) |
| Relative vs absolute paths | Parser preserves as-is; resolver does suffix matching |
| Multiple formats in one file | `parseAuto` runs all parsers; dedup key prevents duplicates; priority order keeps most specific `kind` |
| Multiple refs on one line | Global regex; produces multiple `ParsedRef` with same `sourceLineIndex` |
| 1-based vs 0-based | Parsers output 1-based (source-faithful); resolver converts in one place |
| Native/anonymous frames | `filePath: '<anonymous>'`, `isNative: true`; resolver skips, tour UI shows as unresolvable |
| Go two-line frames | Parser peeks previous line for function name; stateful within call, pure across calls |
| Diff headers (`--- a/src/foo.js`) | Caught by `parseFileRef`; `a/` prefix handled by resolver suffix matching |
