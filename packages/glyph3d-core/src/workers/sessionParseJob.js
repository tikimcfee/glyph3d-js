/**
 * sessionParseJob — the transcript CODEC, pure: bytes → { events, meta, … }.
 *
 * Decode is decode, transport is transport: the relay ships raw transcript
 * bytes (the binary result plane), and THIS module owns turning them into
 * the event stream the books hydrate from. It runs the ONE dialect
 * implementation (sessionAdapter — deliberately free of THREE/DOM/node) so
 * the archive parse, the live hook ingress, and any future server-side parse
 * can never drift apart.
 *
 * Pure by construction — the SAME file runs:
 *   - inside SessionParseWorker (off the main thread, the production path),
 *   - on the main thread in the pool's no-worker fallback (tests, headless),
 *   - directly in headless behavior locks (tools/session-parse.test.mjs).
 *
 * `cap` pre-slices the event tail IN THE WORKER: the books materialize only
 * the newest `cap` turns (a VISUAL bound — hydrate re-derives and re-slices
 * identically, so an off derivation costs nothing), and structured-cloning 20
 * events back beats cloning a 45MB transcript's worth. `total` always reports
 * the FULL pre-slice count, so the book knows the record's real depth.
 */

import { parseClaudeSession, parseKimiSession } from '../collections/sessionAdapter.js';

const _utf8 = new TextDecoder();

/**
 * @param {Object} job
 * @param {Uint8Array} job.bytes - raw transcript bytes (JSONL)
 * @param {string} [job.harness='claude'] - 'claude' | 'kimi'
 * @param {string} [job.cwd] - kimi: the archive index's workDir fallback
 * @param {number} [job.cap=Infinity] - keep only the newest N events (Infinity = all)
 * @returns {{ events: Array, total: number, cwd: string|null, meta: Object,
 *             firstTs: number|null, lastTs: number|null }}
 */
export function runSessionParseJob({ bytes, harness = 'claude', cwd = null, cap = Infinity }) {
    const text = _utf8.decode(bytes);
    const out = harness === 'kimi' ? parseKimiSession(text, cwd) : parseClaudeSession(text);
    const total = out.events.length;
    const events = Number.isFinite(cap) && total > cap ? out.events.slice(-cap) : out.events;
    return { events, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
}
