/**
 * fileKind — classify a file into the renderable it wants: text, image, or binary.
 *
 * A file is just bounded bits; this decides how to make sense of them. The result is a
 * DEDICATED VALUE meant to be threaded through loading — it drives transport (text vs
 * bytes), decode (which image format → which MIME for the Blob), texture handling, and
 * the registry meta. Knowing the type up front is what makes the tricky parts (conversion,
 * texture orientation) tractable, so we name it once and carry it.
 *
 * Two stages, cheap-first:
 *   1. Extension — a confident hint. Image exts → image; a broad text allowlist → text
 *      (the fast path: a source file opens with no extra round-trip). Everything else
 *      (unknown or known-binary ext, or extensionless) returns null = "ask the bytes".
 *   2. Bytes — a magic-signature sniff (PNG/JPEG/GIF/WebP/BMP) names an image even with no
 *      extension; otherwise a UTF-8 probe decides text vs binary. Binary falls to a
 *      hex-render attempt ("can't tell what this is — here's a block, make sense of it").
 *
 * Pure + worker-safe: no DOM, no THREE. The caller owns the byte fetch and the decode.
 *
 * Also home to partitionDirEntries — the pure listing split a bulk open makes between
 * its image / text / oversized build lanes (all-files mode).
 *
 * @typedef {Object} FileKind
 * @property {'text'|'image'|'binary'} kind   - the renderable family
 * @property {string} format  - image: 'png'|'jpeg'|'gif'|'webp'|'bmp'; text: 'utf8'; binary: 'unknown'
 * @property {'ext'|'magic'|'utf8'|'fallback'} source - how we decided (for debugging / display)
 */

/** Image extensions → canonical format token. */
const IMAGE_BY_EXT = {
    png: 'png', apng: 'png',
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg',
    gif: 'gif', webp: 'webp', bmp: 'bmp',
};

/** Canonical format → MIME, for the Blob handed to createImageBitmap. */
const IMAGE_MIME = {
    png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp',
};

/**
 * Extensions we treat as text without touching the bytes (the bulk fast path). Not
 * exhaustive — anything missing falls through to the byte probe, which is correct (it'll
 * be confirmed text by the UTF-8 check), just one RPC slower. Kept deliberately broad so
 * ordinary source/config/docs never pay the probe.
 */
const TEXT_EXT = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
    'md', 'mdx', 'markdown', 'txt', 'text', 'rst', 'adoc', 'log', 'csv', 'tsv',
    'go', 'rs', 'py', 'pyi', 'rb', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm',
    'cs', 'swift', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'dart', 'scala', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'ml', 'fs', 'nim', 'zig', 'v',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'make', 'mk', 'cmake', 'dockerfile', 'gradle', 'sql', 'graphql', 'gql', 'proto', 'wgsl', 'glsl', 'vert', 'frag', 'tsl',
    'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'lock', 'patch', 'diff',
]);

/** @param {string} path @returns {string} lowercased extension without the dot, or '' */
export function extOf(path) {
    const base = String(path || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** @param {string} format @returns {string} MIME for createImageBitmap's Blob */
export function mimeForFormat(format) {
    return IMAGE_MIME[format] || 'application/octet-stream';
}

/**
 * Stage 1 — classify by extension alone (no bytes).
 * @param {string} path
 * @returns {FileKind|null} a confident kind, or null when the bytes must decide
 */
export function classifyByExtension(path) {
    const ext = extOf(path);
    if (ext && IMAGE_BY_EXT[ext]) return { kind: 'image', format: IMAGE_BY_EXT[ext], source: 'ext' };
    if (ext && TEXT_EXT.has(ext)) return { kind: 'text', format: 'utf8', source: 'ext' };
    return null;   // unknown / known-binary / extensionless → sniff the bytes
}

/**
 * Stage 2a — magic-signature sniff over the head bytes. Names an image regardless of
 * (missing/wrong) extension. Returns null if no image signature matches.
 * @param {Uint8Array} bytes - the head window (≥16 bytes recommended)
 * @returns {FileKind|null}
 */
export function sniffMagic(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const b = bytes;
    const at = (i, ...sig) => sig.every((v, k) => b[i + k] === v);
    // PNG  89 50 4E 47 0D 0A 1A 0A
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', format: 'png', source: 'magic' };
    // JPEG FF D8 FF
    if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', format: 'jpeg', source: 'magic' };
    // GIF  "GIF8"
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return { kind: 'image', format: 'gif', source: 'magic' };
    // BMP  "BM"
    if (at(0, 0x42, 0x4d)) return { kind: 'image', format: 'bmp', source: 'magic' };
    // WEBP "RIFF"...."WEBP"
    if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { kind: 'image', format: 'webp', source: 'magic' };
    return null;
}

/**
 * Stage 2b — is this byte window plausibly UTF-8 text? A NUL byte or an invalid UTF-8
 * sequence means binary; a high density of control characters (excluding tab/CR/LF) also
 * reads as binary. A multibyte sequence truncated at the window edge is tolerated.
 * Mirrors the relay's non-UTF-8 rejection so the two agree on what counts as text.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isProbablyUtf8(bytes) {
    if (!bytes || bytes.length === 0) return true;   // empty file is valid (empty) text
    const n = bytes.length;
    let i = 0, ctrl = 0;
    while (i < n) {
        const c = bytes[i];
        if (c === 0x00) return false;                // NUL → binary
        if (c < 0x80) {
            if (c < 0x09 || (c > 0x0d && c < 0x20) || c === 0x7f) ctrl++;
            i++; continue;
        }
        let extra;
        if ((c & 0xe0) === 0xc0) extra = 1;
        else if ((c & 0xf0) === 0xe0) extra = 2;
        else if ((c & 0xf8) === 0xf0) extra = 3;
        else return false;                           // invalid lead byte
        if (i + extra >= n) break;                   // truncated at window edge — tolerate
        for (let j = 1; j <= extra; j++) if ((bytes[i + j] & 0xc0) !== 0x80) return false;
        i += extra + 1;
    }
    return ctrl / n < 0.3;
}

/**
 * Full classification given a head byte window: magic first (image even if extensionless),
 * then a UTF-8 probe (text vs binary). Use when extension classification returned null.
 * @param {Uint8Array} head
 * @returns {FileKind}
 */
export function classifyBytes(head) {
    return sniffMagic(head) || (isProbablyUtf8(head)
        ? { kind: 'text', format: 'utf8', source: 'utf8' }
        : { kind: 'binary', format: 'unknown', source: 'fallback' });
}

/**
 * Partition a directory listing (entries with { path, size }) into the three build lanes
 * of a bulk open — the all-files-mode split:
 *   images    — extension says image (showAll only). An image's byte size is NOT a char
 *               count, so images must never fall into the size-based placeholder lane.
 *   oversized — too big to fetch; renders as a placeholder card from metadata alone.
 *   texty     — batch-fetched as text (known-text ext, unknown, extensionless). Real
 *               binaries hiding here fail the text fetch and fall to the byte-classify
 *               route at build time.
 * With showAll off, images is always empty and the oversized/texty split is exactly the
 * historical behavior.
 * @param {Array<{path: string, size?: number}>} entries
 * @param {{ showAll?: boolean, readableMax?: number }} [opts]
 * @returns {{ images: Array, texty: Array, oversized: Array }}
 */
export function partitionDirEntries(entries, { showAll = false, readableMax = Infinity } = {}) {
    const images = [], texty = [], oversized = [];
    for (const e of entries || []) {
        if (showAll && classifyByExtension(e.path)?.kind === 'image') { images.push(e); continue; }
        if ((e.size ?? 0) > readableMax) { oversized.push(e); continue; }
        texty.push(e);
    }
    return { images, texty, oversized };
}
