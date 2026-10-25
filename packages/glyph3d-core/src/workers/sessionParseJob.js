/**
 * sessionParseJob — the transcript CODEC, pure: bytes → { records, meta, … }.
 *
 * Decode is decode, transport is transport: the relay ships raw transcript
 * bytes (the binary result plane), and THIS module owns turning them into
 * the normalized records the books hydrate from. It runs the ONE dialect
 * implementation (sessionAdapter) AND the ONE normalization registry
 * (toolRegistry) — both deliberately free of THREE/DOM/node — so the archive
 * parse, the live hook ingress, and any future server-side parse can never
 * drift apart. Normalization lives HERE, not at the consume site: the worker
 * is the right thread for it, and noise events drop before the clone.
 *
 * Pure by construction — the SAME file runs:
 *   - inside SessionParseWorker (off the main thread, the production path),
 *   - on the main thread in the pool's no-worker fallback (tests, headless),
 *   - directly in headless behavior locks (tools/session-parse.test.mjs).
 *
 * Every record carries `at`: the absolute byte offset (in the transcript file) of the line its
 * event came from — `base` (where these bytes start in the file) + the line's start in them.
 * A book pages back through a record by these: its oldest resident record's `at` is the
 * backward cursor, and an older window keeps only records before it.
 *
 * `cap` slices the event tail BEFORE normalizing — EXACTLY hydrate's order
 * (cap counts EVENTS, noise then drops), so the book's depth semantics don't
 * move an inch. `total` always reports the FULL pre-slice count.
 */

import { parseSession } from '../collections/sessionAdapter.js';
import { normalizeToolCall, normalizeMessage } from '../collections/toolRegistry.js';

const _utf8 = new TextDecoder();

/**
 * Events → normalized records through the ONE registry (noise drops here).
 * Pre-normalized records pass through untouched (kind == null) — hydrate and
 * the codec share this, so an entry is interpreted in exactly one place.
 * @param {Array} events @param {string} [cwd] session cwd (target relativization)
 * @returns {Array<{action:string, target:string, detail:string, result:string, meta:Object|null}>}
 */
export function eventsToRecords(events, cwd = '') {
    const records = [];
    for (const ev of events) {
        const rec = ev.kind == null ? ev
            : ev.kind === 'message'
                ? normalizeMessage(ev.mtype, ev.text)
                : normalizeToolCall(ev.name, ev.input, ev.response, ev.cwd ?? cwd);
        if (rec) {
            if (ev.at != null && rec !== ev) rec.at = ev.at;
            records.push(rec);
        }
    }
    return records;
}

/**
 * Give each event its line's absolute byte offset: base + the line's start in `bytes`
 * (line i starts after the i-th 0x0A — the adapters split the decoded text on '\n', and a
 * UTF-8 newline is that one byte, so line indices agree across text and bytes).
 * @param {Array<{line?:number, at?:number}>} events @param {Uint8Array} bytes @param {number} base
 */
export function stampOffsets(events, bytes, base = 0) {
    const starts = [0];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A) starts.push(i + 1);
    for (const ev of events) if (Number.isInteger(ev.line) && ev.line < starts.length) ev.at = base + starts[ev.line];
}

/**
 * @param {Object} job
 * @param {Uint8Array} job.bytes - raw transcript bytes (JSONL)
 * @param {string} [job.harness='claude'] - 'claude' | 'kimi' | 'agy' (unknown → throws)
 * @param {string} [job.cwd] - the archive index's working dir (kimi: fallback; agy: the workspace)
 * @param {number} [job.cap=Infinity] - keep only the newest N events (Infinity = all)
 * @param {number} [job.base=0] - the absolute file offset these bytes start at (records' `at`)
 * @param {boolean} [job.countOnly=false] - return only how many records the bytes hold
 *        (`records` comes back empty) — a book counting the turns before its oldest resident
 *        one, without cloning a whole history back
 * @returns {{ records: Array, total: number, cwd: string|null, meta: Object,
 *             firstTs: number|null, lastTs: number|null }}
 */
export function runSessionParseJob({ bytes, harness = 'claude', cwd = null, cap = Infinity, base = 0, countOnly = false }) {
    const text = _utf8.decode(bytes);
    const out = parseSession(text, { harness, cwd });
    stampOffsets(out.events, bytes, base);
    const total = out.events.length;
    const slice = Number.isFinite(cap) && total > cap ? out.events.slice(-cap) : out.events;
    const records = eventsToRecords(slice, out.cwd ?? cwd ?? '');
    if (countOnly) return { records: [], count: records.length, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
    return { records, count: records.length, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
}
