/**
 * GlyphAtlasLoader — Load a pre-baked glyph atlas from static assets.
 *
 * Eliminates runtime Canvas 2D font rasterization for the common charset.
 * Pre-baked atlases are generated via `tools/bake-atlas.mjs` and ship as a
 * PNG + JSON pair. Loading them skips the ~200ms generate() cost entirely.
 *
 * ensureGraphemes() still works after loading — unknown graphemes fall through
 * to runtime Canvas 2D rasterization and are appended to the existing atlas.
 *
 * Usage:
 *   import { loadPrebakedAtlas } from 'glyph3d-js/atlas-loader';
 *
 *   const atlas = await loadPrebakedAtlas(
 *     '/assets/atlas-2048.png',
 *     '/assets/atlas-2048.json'
 *   );
 *   // atlas is ready — no generate() call needed
 */

import GlyphAtlas from './GlyphAtlas.js';

/**
 * Load a pre-baked glyph atlas from static assets.
 *
 * Fetches the PNG and JSON descriptor in parallel, then reconstructs a fully
 * operational GlyphAtlas via GlyphAtlas.fromPrebuilt(). The returned atlas
 * behaves identically to one produced by generate() — getSharedThreeTexture(),
 * getAtlasMapTexture(), getSerializableUVMap(), and ensureGraphemes() all work.
 *
 * @param {string} imageUrl - URL to atlas PNG (e.g. '/assets/atlas-2048.png')
 * @param {string} descriptorUrl - URL to atlas JSON descriptor (e.g. '/assets/atlas-2048.json')
 * @returns {Promise<GlyphAtlas>}
 */
export async function loadPrebakedAtlas(imageUrl, descriptorUrl) {
    const [image, descriptor] = await Promise.all([
        _loadImage(imageUrl),
        fetch(descriptorUrl).then(r => {
            if (!r.ok) throw new Error(`GlyphAtlasLoader: failed to fetch descriptor ${descriptorUrl} (${r.status})`);
            return r.json();
        }),
    ]);

    return GlyphAtlas.fromPrebuilt(descriptor, image);
}

/**
 * Load an HTMLImageElement from a URL.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function _loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`GlyphAtlasLoader: failed to load image ${url}`));
        img.src = url;
    });
}
