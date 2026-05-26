// src/parsing/parseAuto.js

import { parseStackTrace } from './parseStackTrace.js';
import { parseLogLine } from './parseLogLine.js';
import { parseFileRef } from './parseFileRef.js';

/**
 * Auto-detect format and parse all file references from text.
 * Runs all parsers, deduplicates by (sourceLineIndex, filePath, line, col).
 * Priority: stack-frame > log-line > file-ref (most specific kind wins per unique key).
 * @param {string} text
 * @returns {import('./parseFileRef.js').ParseResult}
 */
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
