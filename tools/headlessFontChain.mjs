/**
 * headlessFontChain — the app's REAL font chain booted in bun: no browser, no GPU,
 * no DOM. Shared by bake-slug-core.mjs (slug curve bake) and bake.mjs (layout index
 * bake) so both bakes shape through the exact pipeline the runtime shapes through.
 *
 * Three pieces, each mandatory for bit-identity with the runtime:
 *
 *   installDiskFetch   FontChain and emscripten's hb.wasm loader both fetch();
 *                      this maps file:// and /-prefixed URLs to readFileSync.
 *   FONTS              MUST match app/main.jsx FONT_CHAIN names AND ORDER —
 *                      routing takes the first covering cmap, so a different
 *                      list resolves different glyphs/advances.
 *   stubEmojiAtlas     the runtime's EmojiAtlas allocates BITMAP slots for
 *                      emoji-presentable codepoints no outline font covers, from
 *                      the same dense counter as outline glyphs — and FontChain
 *                      DOUBLES the advance of a bitmap-slotted codepoint. Without
 *                      the stub those codepoints get no slot: later slots shift
 *                      and emoji advances halve. It draws nothing; only the
 *                      allocation (and the advance doubling) matters.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** MUST match app/main.jsx FONT_CHAIN names/order. A drift here costs a stale
 *  slug-core key (runtime 404 → live encode) and a metrics-hash miss (full rebake)
 *  — loud and fail-safe, never wrong glyphs. */
export const FONTS = [
    { name: 'Cousine',          file: 'packages/glyph3d-core/src/fonts/Cousine-Regular.ttf' },
    { name: 'MesloLGS NF Mono', file: 'packages/glyph3d-core/src/fonts/MesloLGS-NF-Mono.ttf' },
    { name: 'DejaVu Sans',      file: 'packages/glyph3d-core/src/fonts/DejaVuSans.ttf' },
];

/** Disk-backed fetch so FontChain (and emscripten's wasm load) read the filesystem. */
export function installDiskFetch() {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = String(input?.url ?? input);
        if (url.startsWith('file://') || url.startsWith('/')) {
            try {
                const p = url.startsWith('file://') ? fileURLToPath(url) : url;
                const buf = readFileSync(p);
                return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
            } catch { return { ok: false, status: 404 }; }
        }
        return realFetch(input, init);
    };
}

/** EmojiAtlas.ensure() as a bare monotonic counter — allocation order, no pixels. */
export function stubEmojiAtlas() {
    return {
        _byCp: new Map(), _next: 0,
        ensure(cp) {
            const c = this._byCp.get(cp);
            if (c !== undefined) return c;
            const idx = this._next++;
            this._byCp.set(cp, idx);
            return idx;
        },
    };
}

/**
 * Boot the chain. Imports shaping AFTER the fetch shim is installed (the wasm
 * loader resolves its URL at import time but fetches lazily — shim first anyway).
 * @returns {Promise<{chain: Object, fonts: Array<{url:string, name:string}>}>}
 */
export async function bootHeadlessFontChain() {
    installDiskFetch();
    const { FontChain } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/index.js`);
    const fonts = FONTS.map((f) => ({ url: `file://${ROOT}/${f.file}`, name: f.name }));
    const chain = new FontChain();
    await chain.init(fonts);
    chain.setEmojiAtlas(stubEmojiAtlas());
    return { chain, fonts };
}
