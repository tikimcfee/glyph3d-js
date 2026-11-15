/**
 * SlugEncodeWorker — outline extraction + Slug packing, off the main thread.
 *
 * Holds its own HarfBuzz instance with one font per font of the chain (the bytes arrive in
 * `init`; a font that is a variation instance of another's file shares that font's face), and
 * answers `encode` requests — triplets [slot, fontIdx, gid], and composites (a shaped cluster's
 * parts, slugData.encodeGlyphBatch) — with an EncodedBatch (slugData.js) whose arrays transfer
 * back without a copy. The main thread keeps
 * routing, shaping and slot allocation (a cell needs its slot synchronously); only the
 * per-glyph work — glyphToJson, the curve conversion, the packing — happens here.
 *
 * Requests (WorkerRpc: each carries an id, answered `{ id, … }` or `{ id, error }`):
 *   { type: 'init', fonts: [{ name, bytes, variations, lineGap, instanceOf }], wasmUrl?, wasmBinary? }  → { fonts }
 *   { type: 'encode', items: Uint32Array, composites?: Int32Array }    → { batch, ms }
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
        if (f.instanceOf >= 0) {
            // The same file as an earlier font, at other axis values: share its face.
            const of = shapers[f.instanceOf];
            if (!of) throw new Error(`"${f.name}" is an instance of font ${f.instanceOf}, which is not loaded before it`);
            shapers.push(of.instance(f.variations, f.name));
            continue;
        }
        const s = new HarfBuzzShaper();
        await s.init(f.bytes, { wasmUrl, wasmBinary, hb, name: f.name, variations: f.variations || null, lineGap: !!f.lineGap });
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
            const batch = encodeGlyphBatch(msg.items, shaperOf, msg.composites);
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
