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
 * @param {string|object} [wasmUrlOrOptions] - Override URL for hb.wasm, or an Emscripten options object (e.g. { wasmBinary, wasmUrl }).
 * @returns {Promise<object>} hbjs API with createBlob, createFace,
 *   createFont, createBuffer, shape, etc.
 */
export default async function initHarfBuzz(wasmUrlOrOptions) {
    let moduleArgs = {};
    if (typeof wasmUrlOrOptions === 'string') {
        const resolvedUrl = wasmUrlOrOptions;
        moduleArgs = {
            locateFile: (path) => (path.endsWith('.wasm') ? resolvedUrl : path)
        };
    } else if (wasmUrlOrOptions && typeof wasmUrlOrOptions === 'object') {
        moduleArgs = { ...wasmUrlOrOptions };
        if (wasmUrlOrOptions.wasmUrl) {
            moduleArgs.locateFile = (path) => (path.endsWith('.wasm') ? wasmUrlOrOptions.wasmUrl : path);
        }
    } else {
        // Default: resolve hb.wasm relative to this module's location
        const defaultWasmUrl = new URL('./hb.wasm', import.meta.url).href;
        moduleArgs = {
            locateFile: (path) => (path.endsWith('.wasm') ? defaultWasmUrl : path)
        };
    }
    const instance = await createHarfBuzz(moduleArgs);
    return hbjs(instance);
}
