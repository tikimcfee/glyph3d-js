/**
 * ESM wrapper for vendored harfbuzzjs (CJS/UMD).
 *
 * hb.js exports `createHarfBuzz` via CJS module.exports (patched with ESM
 * `export default` at vendor time). hbjs.js exports the JS API wrapper
 * `hbjs` the same way.
 *
 * This module initializes the WASM instance and returns the hbjs API object.
 */

import createHarfBuzz from './hb.js';
import hbjs from './hbjs.js';

/**
 * Initialize HarfBuzz WASM and return the hbjs API object.
 * @param {string} [wasmUrl] - Override URL for hb.wasm (needed in workers
 *   where import.meta.url-relative resolution may not work).
 * @returns {Promise<object>} hbjs API with createBlob, createFace,
 *   createFont, createBuffer, shape, etc.
 */
export default async function initHarfBuzz(wasmUrl) {
    // Default: resolve hb.wasm relative to this module's location
    const defaultWasmUrl = new URL('./hb.wasm', import.meta.url).href;
    const resolvedUrl = wasmUrl || defaultWasmUrl;

    const moduleArgs = {
        locateFile: (path) => {
            if (path.endsWith('.wasm')) return resolvedUrl;
            return path;
        }
    };
    const instance = await createHarfBuzz(moduleArgs);
    return hbjs(instance);
}
