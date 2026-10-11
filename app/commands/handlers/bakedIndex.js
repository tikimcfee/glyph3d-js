/**
 * bakedIndex — legacy precomputed layout index loader.
 * In the WebGL2 InstancedField architecture, files are rendered directly via InstancedSlotBuffer.
 */

/**
 * Load the baked index for `dir`, or null. Null is normal (direct InstancedField rendering).
 * @param {Object} ctx - command context (fileProvider + atlas)
 * @param {string} dir - the openDir root ('' = the served root)
 * @returns {Promise<null>}
 */
export async function loadBakedIndex(ctx, dir) {
    return null;
}
