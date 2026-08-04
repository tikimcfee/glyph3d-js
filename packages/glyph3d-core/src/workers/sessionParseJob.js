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
 * `cap` slices the event tail BEFORE normalizing — EXACTLY hydrate's order
 * (cap counts EVENTS, noise then drops), so the book's depth semantics don't
 * move an inch. `total` always reports the FULL pre-slice count.
 */

import { parseClaudeSession, parseKimiSession } from '../collections/sessionAdapter.js';
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
        if (rec) records.push(rec);
    }
    return records;
}

/**
 * @param {Object} job
 * @param {Uint8Array} job.bytes - raw transcript bytes (JSONL)
 * @param {string} [job.harness='claude'] - 'claude' | 'kimi'
 * @param {string} [job.cwd] - kimi: the archive index's workDir fallback
 * @param {number} [job.cap=Infinity] - keep only the newest N events (Infinity = all)
 * @returns {{ records: Array, total: number, cwd: string|null, meta: Object,
 *             firstTs: number|null, lastTs: number|null }}
 */
export function runSessionParseJob({ bytes, harness = 'claude', cwd = null, cap = Infinity }) {
    const text = _utf8.decode(bytes);
    const out = harness === 'kimi' ? parseKimiSession(text, cwd) : parseClaudeSession(text);
    const total = out.events.length;
    const slice = Number.isFinite(cap) && total > cap ? out.events.slice(-cap) : out.events;
    const records = eventsToRecords(slice, out.cwd ?? cwd ?? '');
    return { records, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
}
