/**
 * SlugEncodeClient — the main thread's handle on SlugEncodeWorker.
 *
 *   const client = new SlugEncodeClient({ fonts: chain.fontSources() });
 *   const { batch } = await client.encode(Uint32Array.of(slot, fontIdx, gid, …));
 *
 * One worker, requests answered in order. The font bytes go over once (`init`, sent at
 * construction); each `encode` transfers its item array and gets an EncodedBatch back by
 * transfer. A worker failure rejects the request with the worker's own message — the atlas
 * logs it with what it asked for; nothing falls back to encoding on the main thread.
 */

import WorkerRpc from './WorkerRpc.js';

export default class SlugEncodeClient {
    /**
     * @param {Object} opts
     * @param {Array<{name:string, bytes:ArrayBuffer|null, variations?:Record<string, number>|null, lineGap?:boolean, instanceOf?:number}>} opts.fonts
     *   - the chain's fonts, in order (FontChain.fontSources)
     * @param {string} [opts.wasmUrl] - hb.wasm override (else the worker resolves its own)
     * @param {ArrayBuffer|Uint8Array} [opts.wasmBinary] - hb.wasm bytes
     */
    constructor({ fonts, wasmUrl, wasmBinary }) {
        if (typeof Worker === 'undefined') {
            throw new Error('SlugEncodeClient: this environment has no Worker — Slug outlines are encoded off the main thread');
        }
        /** @private */
        this._rpc = new WorkerRpc(
            new Worker(new URL('./SlugEncodeWorker.js', import.meta.url), { type: 'module' }),
            'SlugEncodeWorker',
        );
        /** Resolves once the worker has loaded every font (rejects with its failure). */
        this.ready = this._rpc.request({ type: 'init', fonts, wasmUrl, wasmBinary });
        this.ready.catch(() => {});   // the failure also rejects every encode — reported there
    }

    /** @returns {number} requests awaiting an answer */
    get inFlight() { return this._rpc.inFlight; }

    /**
     * Encode glyphs off the main thread.
     * @param {Uint32Array} items - triplets [slot, fontIdx, gid]; transferred (unusable after)
     * @param {Int32Array|null} [composites] - composite glyphs (slugData.encodeGlyphBatch); transferred
     * @returns {Promise<{ batch: import('../shaping/slugData.js').EncodedBatch, ms: number }>}
     */
    async encode(items, composites = null) {
        const { batch, ms } = await this._rpc.request(
            composites ? { type: 'encode', items, composites } : { type: 'encode', items },
            composites ? [items.buffer, composites.buffer] : [items.buffer],
        );
        return { batch, ms };
    }

    dispose() {
        this._rpc.dispose();
    }
}
