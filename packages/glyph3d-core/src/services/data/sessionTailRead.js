/**
 * sessionTailRead — TAIL-GROW reads for agent-session hydration (the
 * transport-stream spec's first implementation).
 *
 * A book shows its newest ~cap turns, but a whole-transcript read pays for
 * every byte ever written — ~30MB per restore to display 20 spreads. JSONL is
 * newline-delimited, so the tail needs no sidecar: request the final N bytes
 * (the relay seeks and line-aligns the window), parse, and if the window holds
 * fewer events than the book's quota AND didn't reach the file's start, double
 * N and re-request. Older records load on demand via the fromOffset cursor
 * (the returned `offset` is the next backward cursor), never at boot.
 *
 * Provenance: the tail's meta is the session's PRESENT (a renamed/resumed
 * session's ai-title lines repeat through the file — the tail carries the
 * CURRENT title, where whole-file first-seen showed the oldest). But the sparse
 * provenance lines (claude ai-title/agent-name, kimi metadata/turn.prompt)
 * cluster near the transcript's start, so a tail that carries NO title would
 * silently demote its nameplate to a slug — one bounded fromOffset:0 head read
 * gap-fills what the tail lacks (records discarded, tail values kept).
 *
 * Pure transport+codec composition: the read is the provider's, the parse is
 * the caller's (the session parse pool in the app; the main-thread codec in
 * headless tests) — this module owns only the grow policy, the head meta
 * top-up, and the loud torn-first-line guard.
 */

/** Session ids already warned about a torn first line — the guard fires once. */
const _warnedTorn = new Set();

/**
 * The relay's boundary scan makes a mid-file window open on a record boundary;
 * a torn first line means a relay-side window bug (or a rewrite race), and the
 * parser would skip it SILENTLY — say so once, loudly, before the buffer
 * transfers to the parse worker.
 * @param {string} sessionId @param {Uint8Array} bytes @param {number} offset
 */
function warnIfTornFirstLine(sessionId, bytes, offset) {
    if (offset === 0 || bytes.byteLength === 0 || _warnedTorn.has(sessionId)) return;
    const nl = bytes.indexOf(0x0A);
    const first = new TextDecoder().decode(nl < 0 ? bytes : bytes.subarray(0, nl));
    if (!first.trim()) return;
    try { JSON.parse(first); } catch {
        _warnedTorn.add(sessionId);
        console.warn(`[sessions] ${sessionId}: tail window opens mid-record at offset ${offset} — parser skips the torn first line`);
    }
}

/**
 * Read + parse a session's newest events, growing the tail window until the
 * quota is met or the file's start is reached. An unbounded cap (Infinity)
 * reads the whole transcript in one request — the tail IS the file.
 * @param {{ read: Function }} provider - AgentSessionProvider (or a test double)
 * @param {string} sessionId
 * @param {Object} opts
 * @param {string} [opts.harness] - 'claude' | 'kimi'
 * @param {number} [opts.cap] - the book's event quota (Infinity = whole record)
 * @param {number} [opts.startBytes] - first tail window size (doubles per retry)
 * @param {number} [opts.headMetaBytes] - head window re-harvesting first-seen
 *        provenance a tail can't see (0 disables)
 * @param {(bytes: Uint8Array, opts: {harness: string, cwd: string|null, cap: number})
 *         => Promise<{records: Array, total: number, cwd: string|null, meta: Object}>} opts.parse
 *        the codec — NOTE it may TRANSFER the buffer (the parse pool does)
 * @returns {Promise<{records: Array, total: number, cwd: string|null, meta: Object,
 *          offset: number, size: number|null, bytes: number, attempts: number,
 *          readMs: number, parseMs: number}>}
 *          `total` counts the events IN THE WINDOW (≥ cap unless offset 0);
 *          `bytes` is the final window's length; readMs/parseMs sum all attempts;
 *          `offset` is the absolute byte the window starts at — the cursor for
 *          paging further back (0 = the whole record was seen).
 */
export async function readSessionTail(provider, sessionId, {
    harness = 'claude', cap = Infinity, startBytes = 512 * 1024, headMetaBytes = 64 * 1024, parse,
} = {}) {
    const now = () => performance.now();
    let readMs = 0, parseMs = 0, attempts = 0;
    let tailBytes = Math.max(1, Math.floor(startBytes));
    for (;;) {
        attempts++;
        const wantWhole = !Number.isFinite(cap);
        const t0 = now();
        const r = await provider.read(sessionId, wantWhole ? { harness } : { harness, tailBytes });
        readMs += now() - t0;
        const byteLen = r.bytes.byteLength;   // parse may transfer the buffer — measure first
        warnIfTornFirstLine(sessionId, r.bytes, r.offset);
        const t1 = now();
        const out = await parse(r.bytes, { harness, cwd: r.cwd, cap });
        parseMs += now() - t1;
        if (wantWhole || out.total >= cap || r.offset === 0) {
            if (r.offset > 0 && headMetaBytes > 0 && out.meta?.title == null) {
                const t2 = now();
                out.meta = await readHeadMeta(provider, sessionId, { harness, headMetaBytes, parse, tailMeta: out.meta });
                readMs += now() - t2;   // read-dominated (a 64KB parse is noise) — one column, honestly named
            }
            return { ...out, offset: r.offset, size: r.size, bytes: byteLen, attempts, readMs, parseMs };
        }
        tailBytes *= 2;
    }
}

/**
 * Harvest provenance from the transcript's head and GAP-FILL the tail's meta:
 * the tail's values stay (the session's present), the head supplies only what
 * the tail never saw — plus firstTs, where the head's IS the true first. cap 1
 * keeps the discarded record clone minimal; the adapters harvest meta across
 * the whole window regardless of cap. A failed head read degrades LOUDLY to
 * the tail's meta — the book still opens, the nameplate says less.
 * @private
 */
async function readHeadMeta(provider, sessionId, { harness, headMetaBytes, parse, tailMeta }) {
    try {
        const h = await provider.read(sessionId, { harness, fromOffset: 0, maxBytes: headMetaBytes });
        const { meta } = await parse(h.bytes, { harness, cwd: h.cwd, cap: 1 });
        const merged = { ...(tailMeta || {}) };
        for (const [k, v] of Object.entries(meta || {})) if (v != null && merged[k] == null) merged[k] = v;
        if (meta?.firstTs != null) merged.firstTs = meta.firstTs;
        return merged;
    } catch (e) {
        console.warn(`[sessions] ${sessionId}: head meta read failed — nameplate keeps the tail's provenance:`, e?.message || e);
        return tailMeta;
    }
}
