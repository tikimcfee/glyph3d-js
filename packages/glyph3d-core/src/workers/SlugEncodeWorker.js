/**
 * SlugEncodeWorker — outline extraction + Slug packing, off the main thread.
 *
 * Holds its own HarfBuzz instance with one face per font of the chain (the bytes arrive in
 * `init`), and answers `encode` requests — triplets [slot, fontIdx, gid] — with an
 * EncodedBatch (slugData.js) whose arrays transfer back without a copy. The main thread keeps
 * routing, shaping and slot allocation (a cell needs its slot synchronously); only the
 * per-glyph work — glyphToJson, the curve conversion, the packing — happens here.
 *
 * Requests (WorkerRpc: each carries an id, answered `{ id, … }` or `{ id, error }`):
 *   { type: 'init', fonts: [{ name, bytes }], wasmUrl?, wasmBinary? }  → { fonts }
 *   { type: 'encode', items: Uint32Array }                             → { batch, ms }
 * An encode that arrives before init finishes waits for it; a failed init fails every encode.
 *
 * No DOM, no Three.js (CLAUDE.md: worker code stays free of both).
 */

import HarfBuzzShaper from '../shaping/HarfBuzzShaper.js';
import { encodeGlyphBatch } from '../shaping/slugData.js';

/** @type {HarfBuzzShaper[]} one per font, in chain order */
let shapers = [];
/** @type {Promise<void>|null} */
let ready = null;

async function init({ fonts, wasmUrl, wasmBinary }) {
    let hb = null;
    for (const f of fonts) {
        const s = new HarfBuzzShaper();
        await s.init(f.bytes, { wasmUrl, wasmBinary, hb, name: f.name });
        hb = hb || s.hb;
        shapers.push(s);
    }
}

const shaperOf = (fontIdx) => {
    const s = shapers[fontIdx];
    if (!s) throw new Error(`no font ${fontIdx} (the chain has ${shapers.length})`);
    return s;
};

self.onmessage = async (event) => {
    const msg = event.data;
    try {
        if (msg.type === 'init') {
            ready = init(msg);
            await ready;
            self.postMessage({ id: msg.id, fonts: shapers.length });
        } else if (msg.type === 'encode') {
            if (!ready) throw new Error('encode before init');
            await ready;
            const t0 = performance.now();
            const batch = encodeGlyphBatch(msg.items, shaperOf);
            self.postMessage(
                { id: msg.id, batch, ms: performance.now() - t0 },
                [batch.slots.buffer, batch.counts.buffer, batch.texels.buffer],
            );
        } else {
            throw new Error(`unknown request type ${msg.type}`);
        }
    } catch (e) {
        self.postMessage({ id: msg.id, error: `${msg.type}: ${e?.message || e}` });
    }
};
