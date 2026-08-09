/**
 * FarTextAtlas — the sampled half of the minified text-mass LOD.
 *
 * One shared 1024² RGBA8 texture, partitioned into 16×16 = 256 fixed slabs of
 * 64×64 texels — one slab per file (arena item). Content is produced GPU-side by
 * the far kernels (glyphPipelineKernels K10a farScatter / K10b farNormalize — see
 * the FAR block in compute/glyphPipelineReference.js): the normalize dispatch packs
 * RGBA8 texels into a buffer, the CPU reads it back and blits the dirty slabs here.
 * The fragment then samples this texture with an explicit mip level in place of the
 * flat impostor block (GlyphField's slug branch), so minified text is a prefiltered,
 * temporally stable, content-true color mass.
 *
 * Texel semantics: rgb = ink-weighted average syntax color, LINEAR (the scatter
 * linearizes before accumulating — mips then average ink energy, so distant text
 * dims physically instead of gamma-crushing); a = average ink coverage of the
 * texel's grid region. The texture is therefore tagged NoColorSpace (passthrough —
 * no decode on sample; the slug path's math is already linear).
 *
 * Slab lifecycle is CPU-side: acquire on an item's first extent landing, release on
 * dispose. Exhaustion is graceful — an item without a slab keeps the old impostor
 * block (the fragment's hasSlab select).
 *
 * The allocator is deliberately dumb (a free-list, no packing, no eviction): 256
 * files of headroom covers the current working scale; WebRender-style paging is a
 * later milestone and lands HERE, not in the kernels or the shader.
 */

import * as THREE from 'three';
import {
    FAR_TEX, FAR_SLAB, FAR_SLABS_PER_SIDE, FAR_MAX_SLABS,
} from '../compute/glyphPipelineReference.js';

/** The impostor's ink-density calibration, reused: curveCount × K, capped. The ink
 *  table is CPU-built, so a truer density (a GPU coverage bake over the curve data)
 *  drops in HERE later without touching a shader or a kernel. */
const FAR_INK_PER_CURVE = 0.035;
const FAR_INK_MAX = 0.72;
/** Bitmap (emoji) glyphs carry no curves — a flat mid-density so they read as ink. */
const FAR_INK_BITMAP = 0.5;

export default class FarTextAtlas {
    constructor() {
        this._free = [];
        for (let i = FAR_MAX_SLABS - 1; i >= 0; i--) this._free.push(i);

        const data = new Uint8Array(FAR_TEX * FAR_TEX * 4);   // zero = no ink anywhere
        const tex = new THREE.DataTexture(data, FAR_TEX, FAR_TEX, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.LinearMipmapLinearFilter;   // the mip chain IS the prefilter
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        // NoColorSpace (default): texels are LINEAR already — passthrough on sample.
        tex.needsUpdate = true;
        this.texture = tex;
        // Packed writes land through a uint32 view over the same RGBA8 bytes (little-endian
        // r|g<<8|b<<16|a<<24 — the kernel's farPacked layout exactly).
        this._texelView = new Uint32Array(data.buffer);
    }

    /** @returns {number} a slab index, or -1 when the atlas is full (impostor fallback). */
    acquire() {
        return this._free.length > 0 ? this._free.pop() : -1;
    }

    /** Return a slab to the free-list. Its texels are NOT cleared — the next owner's
     *  first regen overwrites every texel it maps (and the fragment only samples
     *  slabs whose group says hasSlab). */
    release(slabIndex) {
        if (slabIndex >= 0) this._free.push(slabIndex);
    }

    /** @returns {{x:number, y:number}} the slab's origin in atlas texels. */
    static slabOrigin(slabIndex) {
        return {
            x: (slabIndex % FAR_SLABS_PER_SIDE) * FAR_SLAB,
            y: Math.floor(slabIndex / FAR_SLABS_PER_SIDE) * FAR_SLAB,
        };
    }

    /**
     * Blit one slab's fresh texels from the normalize readback (full-atlas packed
     * layout — the same indexing as the texture, so rows copy straight across).
     * Sets needsUpdate once per call; the renderer re-uploads and regenerates mips.
     * @param {Uint32Array} packed - FAR_TEX² packed RGBA8 (kernels.readFarPacked())
     * @param {number} slabIndex
     */
    blitSlab(packed, slabIndex) {
        const { x, y } = FarTextAtlas.slabOrigin(slabIndex);
        const dst = this._texelView;
        for (let ty = 0; ty < FAR_SLAB; ty++) {
            const row = (y + ty) * FAR_TEX + x;
            dst.set(packed.subarray(row, row + FAR_SLAB), row);
        }
        this.texture.needsUpdate = true;
    }

    dispose() {
        this.texture.dispose();
        this._free.length = 0;
    }
}

/**
 * Build the gid → ink-density table the far scatter weights colors by, from the
 * live glyph-map texture's CPU-side data ([curveStart, curveCount, mode, emojiCell]
 * per glyph slot). Density is the impostor's calibration — curveCount × K, capped —
 * with a flat mid value for bitmap (emoji) slots; gid 0 (.notdef) and unencoded
 * slots read 0. The bitmap atlas is retired, so this is the density source that
 * exists today; the table is CPU-built precisely so a truer bake drops in later.
 *
 * @param {THREE.DataTexture|null} glyphMapTexture - slugData.glyphMapTexture
 * @returns {Float32Array} glyphId → density 0..1
 */
export function buildFarInkTable(glyphMapTexture) {
    const data = glyphMapTexture?.image?.data;
    if (!data || data.length < 4) return new Float32Array(1);
    const entries = (data.length / 4) | 0;
    const table = new Float32Array(entries);
    for (let gid = 1; gid < entries; gid++) {          // gid 0 = .notdef — no ink
        const curveCount = data[gid * 4 + 1];
        const mode = data[gid * 4 + 2];
        table[gid] = mode === 1
            ? FAR_INK_BITMAP
            : Math.min(curveCount * FAR_INK_PER_CURVE, FAR_INK_MAX);
    }
    return table;
}
