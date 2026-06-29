/**
 * slugCoreCache — persist the prebaked slug core so boot hydrates instead of re-encoding.
 *
 * The first client of {@link BlobStore}. It owns the slug-specific concerns the store
 * deliberately does not: a content-addressed KEY, a versioned binary ENVELOPE, gzip,
 * and the fail-safe load/save the boot ladder calls. The store stays dumb bytes-by-key.
 *
 * Boot ladder (in bootGlyphEngine):
 *   key = slugCoreKey({ fonts, encodeRanges })
 *   loadSlugCore(key)  → descriptor → LiveSlugAtlas hydrates (SKIP the encode)
 *     miss/corrupt     → live encode (today's path) → saveSlugCore(key, …) for next boot
 *
 * So with no prebaked asset at all, the FIRST boot computes-and-caches and every boot
 * after hydrates. A served/remote source is a future entry in the same ladder; the key
 * IS the content address (and the eventual remote path). Everything here is fail-safe:
 * any envelope/gzip/version problem returns null (or skips the save) — the renderer
 * always has the live encode to fall back to, so a bad cache never breaks boot.
 *
 * Envelope layout (one Uint32 array, then gzipped — all targets are little-endian):
 *   [0] MAGIC 'SLGC'  [1] envelopeVersion  [2] payloadFormat (SLUG_BUFFER_FORMAT)
 *   [3] curveCount    [4] entryCount (=maxGlyphId+1, 0 ⇒ empty)
 *   [5] encodedLen    [6] curveLen  [7] mapLen
 *   [ encodedIds … ][ curve … ][ map … ]
 */

import { SlugBuffer, SLUG_BUFFER_FORMAT } from './slugData.js';
import { blobStore } from '../services/state/index.js';

const NS = 'slug-core';
const ENVELOPE_VERSION = 1;
const MAGIC = 0x43474c53;   // 'SLGC' as a little-endian uint32
const HEADER_U32 = 8;

// Bump when the FONT FILES change (a new .ttf, a different fallback) without a name change —
// the key is identity-based (font NAMES, not urls), so it can't otherwise notice new bytes.
// Names, because Vite `?url` imports resolve to DIFFERENT strings in dev vs build; keying on
// the url would make the key environment-volatile and a baked asset unfindable at runtime.
const FONT_CHAIN_VERSION = 2;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Last cache outcome (boot or runtime), surfaced by the `atlas.cache` verb. Boot's
// hit/miss logs fire before the relay WebSocket connects, so they never reach the log
// store — a pull-based verb reading this is the reliable way to observe what happened.
let _lastEvent = null;

// ── key ──────────────────────────────────────────────────────────────────────

/**
 * Content-addressed cache key for a font chain + encoded ranges + buffer format.
 * Keyed on font NAMES (+ FONT_CHAIN_VERSION), NOT urls — Vite hashes `?url` imports
 * per-environment, so a url-based key would differ dev↔build and a baked asset would be
 * unfindable. With names, the key is stable everywhere, so a build-time bake matches the
 * runtime lookup. Any change to names/ranges/format/version misses → the ladder recomputes.
 * Pure + synchronous.
 * @param {{ fonts?: Array<{url:string,name?:string}>, encodeRanges: Array<[number,number]> }} cfg
 * @returns {string} e.g. 'slug-core.x7k2p9'
 */
export function slugCoreKey({ fonts, encodeRanges }) {
    const canonical = JSON.stringify({
        fonts: (fonts || []).map((f) => f.name || f.url),
        ranges: encodeRanges,
        fmt: SLUG_BUFFER_FORMAT,
        fontVer: FONT_CHAIN_VERSION,
    });
    return `${NS}.${cyrb53(canonical).toString(36)}`;
}

/** cyrb53 — a small, well-distributed 53-bit string hash (sync, no crypto dependency). */
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ── envelope (pure) ──────────────────────────────────────────────────────────

/** Pack a SlugBuffer descriptor into one Uint32Array (header + the three arrays). */
function packDescriptor(d) {
    const encodedLen = d.encodedIds.length, curveLen = d.curve.length, mapLen = d.map.length;
    const out = new Uint32Array(HEADER_U32 + encodedLen + curveLen + mapLen);
    out[0] = MAGIC;
    out[1] = ENVELOPE_VERSION;
    out[2] = d.v;
    out[3] = d.curveCount;
    out[4] = d.maxGlyphId + 1;          // entryCount — keeps the field unsigned (empty ⇒ 0)
    out[5] = encodedLen;
    out[6] = curveLen;
    out[7] = mapLen;
    out.set(d.encodedIds, HEADER_U32);
    out.set(d.curve, HEADER_U32 + encodedLen);
    out.set(d.map, HEADER_U32 + encodedLen + curveLen);
    return out;
}

/** Parse the envelope bytes back into a descriptor. Throws on magic/version/length drift. */
function unpackDescriptor(u8) {
    if (u8.byteLength < HEADER_U32 * 4) throw new Error('envelope too small');
    const u32 = new Uint32Array(u8.slice().buffer);     // slice → fresh, 4-aligned buffer
    if (u32[0] !== MAGIC) throw new Error('bad magic');
    if (u32[1] !== ENVELOPE_VERSION) throw new Error(`envelope v${u32[1]} != ${ENVELOPE_VERSION}`);
    const v = u32[2], curveCount = u32[3], entryCount = u32[4];
    const encodedLen = u32[5], curveLen = u32[6], mapLen = u32[7];
    const need = HEADER_U32 + encodedLen + curveLen + mapLen;
    if (u32.length !== need) throw new Error(`envelope length ${u32.length} != ${need}`);
    let o = HEADER_U32;
    const encodedIds = u32.slice(o, o + encodedLen); o += encodedLen;
    const curve = u32.slice(o, o + curveLen); o += curveLen;
    const map = u32.slice(o, o + mapLen);
    return { v, curveCount, maxGlyphId: entryCount - 1, encodedIds, curve, map };
}

// ── gzip (CompressionStream — browser + bun + node ≥18) ──────────────────────

// The readable side carries both the output AND the failure (we await it), so the
// writable-side promises are duplicate error signals — swallow them so a corrupt entry
// doesn't also spew an unhandled-rejection stack to the console (it's caught upstream).
async function gzip(bytes) {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(bytes).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bytes).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// ── load / save / discard ────────────────────────────────────────────────────

/**
 * Load + validate the cached core for `key`. Returns a SlugBuffer descriptor ready to
 * hydrate, or null on any miss/corruption (and self-heals by deleting a bad entry).
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export async function loadSlugCore(key) {
    const t0 = now();
    let bytes;
    try { bytes = await blobStore.getBytes(key); } catch { return null; }
    if (!bytes) {
        _lastEvent = { op: 'miss', key, ms: now() - t0 };
        console.log(`[slugCoreCache] miss ${key}`);
        return null;
    }
    try {
        const raw = await gunzip(bytes);
        const descriptor = unpackDescriptor(raw);
        SlugBuffer.deserialize(descriptor);              // structural validation (throws if bad)
        _lastEvent = {
            op: 'loaded', key, glyphs: descriptor.encodedIds.length, curves: descriptor.curveCount,
            gzBytes: bytes.byteLength, rawBytes: raw.byteLength, ms: now() - t0,
        };
        console.log(
            `[slugCoreCache] loaded ${key}: ${descriptor.encodedIds.length} glyphs, ` +
            `${descriptor.curveCount} curves · ${(bytes.byteLength / 1024).toFixed(1)}KB gz → ` +
            `${(raw.byteLength / 1024).toFixed(1)}KB raw in ${(now() - t0).toFixed(1)}ms`
        );
        return descriptor;
    } catch (e) {
        _lastEvent = { op: 'corrupt', key, error: e.message, ms: now() - t0 };
        console.warn(`[slugCoreCache] ${key} unreadable (${e.message}) → discard + recompute`);
        await discardSlugCore(key);
        return null;
    }
}

/**
 * Load the core from a STATIC ASSET (the build-time bake), e.g. `/slug-core/<key>.bin`.
 * The ladder tries this AFTER the local blob store and BEFORE a live encode, so a fresh
 * device (empty IndexedDB) still hydrates instead of encoding. On a hit the bytes are
 * SELF-PROMOTED into the blob store, so every later boot takes the faster local path and
 * never re-fetches. Same fail-safe contract as loadSlugCore — a 404 (no baked asset, e.g.
 * in dev) or any corruption returns null and the ladder falls through to a live encode.
 *
 * @param {string} key
 * @param {string} [baseUrl] - asset base path (default '/'); pass import.meta.env.BASE_URL
 *        so a sub-path deploy (/ide/) resolves correctly.
 * @returns {Promise<object|null>}
 */
export async function loadServedSlugCore(key, baseUrl = '/') {
    const t0 = now();
    const url = `${baseUrl}slug-core/${encodeURIComponent(key)}.bin`;
    let resp;
    try { resp = await fetch(url); } catch { return null; }   // offline / network error
    if (!resp || !resp.ok) return null;                        // 404 = no baked asset (dev)
    try {
        const bytes = new Uint8Array(await resp.arrayBuffer());
        // Quiet bail if it isn't a gzip stream — e.g. a dev server's SPA index.html fallback
        // served with a 200. Avoids a per-boot "unreadable" warning when there's no real asset.
        if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
        const raw = await gunzip(bytes);
        const descriptor = unpackDescriptor(raw);
        SlugBuffer.deserialize(descriptor);                    // structural validation
        // Promote into the local store so subsequent boots hit IndexedDB, not the network.
        try {
            await blobStore.put(key, bytes, {
                env: ENVELOPE_VERSION, fmt: descriptor.v, glyphs: descriptor.encodedIds.length,
                curves: descriptor.curveCount, rawBytes: raw.byteLength, source: 'served',
            });
        } catch { /* a failed promote just means we re-fetch next boot */ }
        _lastEvent = {
            op: 'served', key, glyphs: descriptor.encodedIds.length, curves: descriptor.curveCount,
            gzBytes: bytes.byteLength, rawBytes: raw.byteLength, ms: now() - t0,
        };
        console.log(
            `[slugCoreCache] served ${key}: ${descriptor.encodedIds.length} glyphs, ` +
            `${(bytes.byteLength / 1024).toFixed(1)}KB gz → promoted to local in ${(now() - t0).toFixed(1)}ms`
        );
        return descriptor;
    } catch (e) {
        console.warn(`[slugCoreCache] served ${key} unreadable (${e.message}) → ignore`);
        return null;
    }
}

/**
 * Pack + gzip + store the descriptor under `key`. Never throws — a failed save just
 * means this boot stays uncached. Returns the gzipped byte length (or 0 on failure).
 * @param {string} key
 * @param {object} descriptor - from SlugBuffer.serialize()
 * @returns {Promise<number>}
 */
export async function saveSlugCore(key, descriptor) {
    const t0 = now();
    try {
        const raw = packDescriptor(descriptor);
        const rawBytes = raw.byteLength;
        const gz = await gzip(new Uint8Array(raw.buffer));
        await blobStore.put(key, gz, {
            env: ENVELOPE_VERSION,
            fmt: descriptor.v,
            glyphs: descriptor.encodedIds.length,
            curves: descriptor.curveCount,
            rawBytes,
        });
        _lastEvent = {
            op: 'cached', key, glyphs: descriptor.encodedIds.length, curves: descriptor.curveCount,
            gzBytes: gz.byteLength, rawBytes, ms: now() - t0,
        };
        console.log(
            `[slugCoreCache] cached ${key}: ${descriptor.encodedIds.length} glyphs, ` +
            `${descriptor.curveCount} curves · ${(rawBytes / 1024).toFixed(1)}KB → ` +
            `${(gz.byteLength / 1024).toFixed(1)}KB gz ` +
            `(${(100 * gz.byteLength / rawBytes).toFixed(0)}%) in ${(now() - t0).toFixed(1)}ms`
        );
        return gz.byteLength;
    } catch (e) {
        _lastEvent = { op: 'save-failed', key, error: e.message };
        console.warn(`[slugCoreCache] save failed (${e.message}) — boot proceeds, just uncached`);
        return 0;
    }
}

/** Delete a cached core entry. Used on corruption + by a manual cache clear. */
export async function discardSlugCore(key) {
    try { await blobStore.delete(key); } catch { /* best-effort */ }
}

/**
 * Current cache state for introspection — the last boot/runtime outcome plus the
 * stored entries. Backs the `atlas.cache` verb (and the Local Data panel later).
 * @returns {Promise<{ last: object|null, entries: Array }>}
 */
export async function getSlugCacheState() {
    let entries = [];
    try { entries = await blobStore.statNamespace(NS); } catch { /* ignore */ }
    return { last: _lastEvent, entries };
}

/** Wipe every slug-core cache entry — the dev clear-cache control. @returns {Promise<number>} */
export async function clearSlugCore() {
    try { return await blobStore.clearNamespace(NS); } catch { return 0; }
}
