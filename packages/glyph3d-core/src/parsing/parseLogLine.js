// src/parsing/parseLogLine.js

import { parseFileRef } from './parseFileRef.js';

/**
 * @typedef {Object} LogLineMeta
 * @property {string|null} timestamp  - raw timestamp string
 * @property {string|null} level      - 'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'|null
 * @property {string} message         - log body after timestamp+level
 */

const LEVELS = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE|VERBOSE)\b/i;
const TS = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?|\[?\d{2}:\d{2}:\d{2}\]?|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;

/**
 * Parse structured log lines. Extracts timestamps, log levels, and embedded file references.
 * For log lines without file references, a ParsedRef with filePath:null is emitted so that
 * structured log metadata (level, message) is preserved for display purposes.
 * Outputs 1-based line numbers (source-faithful; resolver converts to 0-based).
 * @param {string} text
 * @returns {import('./parseFileRef.js').ParseResult}
 */
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
            // Emit with null filePath so structured log metadata is preserved.
            // The resolver guards against null filePath and returns matchType:'none'.
            refs.push({ ref: { filePath: null, line: null, col: null, endLine: null, endCol: null },
                kind: 'log-line', rawText: line, sourceLineIndex: i,
                meta: { timestamp, level, message } });
        }
    }
    return { refs, unmatched };
}
