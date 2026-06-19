/**
 * fileLoader — the file-data vending layer behind file.open / file.openDir / the workspace.
 *
 * One job: turn a PATH into the right renderable grid and register it. A file is just
 * bounded bits, so this classifies which renderable it wants —
 *
 *   text   → a CodeGrid (the buffer)
 *   image  → a single-cell FrameGrid sampling the decoded texture (the pixels live in the
 *            texture, NOT in cells — cols/rows stay 1×1; never pixel dims)
 *   binary → a hex BLOCK rendered as a CodeGrid ("can't read it, here are the bytes")
 *
 * — fetches over the matching transport (UTF-8 text vs raw bytes), builds the grid, and
 * inserts it into the content tree + registry. It owns NO canvas side effects: no camera,
 * no attention, no relayout. That split is the point — this module answers "what is this
 * file and how is it rendered"; the command layer (fileCommands.js) answers "what happens
 * on screen when you open it".
 *
 * Classification lives in core/fileKind.js and is threaded as a dedicated value:
 *   extension → image / known-text (the fast path, no extra fetch)
 *   unknown   → sniff a head window: magic signature → image (even with no extension),
 *               else a UTF-8 probe splits text from binary.
 *
 * Public surface (kept deliberately small — a shared Surface protocol is the eventual home):
 *   renderSheetGrid(ctx, path)          classify + fetch + build + register one file → id
 *   addFileGrid(ctx, path, content)     register already-fetched text (openDir's batch path)
 *   addUnfetchedGrid(ctx, path, bytes)  register an oversize file as a placeholder from metadata
 */

import * as THREE from 'three';
import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import FrameGrid from '@glyph3d/core/collections/FrameGrid.js';
import { gridTheme } from '../../client/settings.js';
import { unreadableReason, READABLE_MAX_CHARS, READABLE_MAX_LINE_CHARS } from '@glyph3d/core';
import { classifyByExtension, classifyBytes, mimeForFormat } from '@glyph3d/core';
import { bytesToHexView } from '@glyph3d/core/memory/hexView.js';

const SNIFF_BYTES = 4096;        // head window for the magic-bytes + UTF-8 probe (doubles as the hex block)
const IMAGE_CARD_WIDTH = 32;     // world width of an image quad; height follows the source aspect
const HEX_COLS = 16;             // bytes per hex row

// ── text grids ──────────────────────────────────────────────────────────────────────────

/**
 * The in-space stand-in for a file whose content isn't readable source (built artifact,
 * data dump). The file still EXISTS in the field — addressable, clickable, in the tree —
 * it just doesn't cost millions of glyphs to say so.
 */
function placeholderBody(reason) {
    const why = reason.bytes != null
        ? [`  size: ${reason.bytes.toLocaleString()} bytes on disk  (not fetched; limit ${READABLE_MAX_CHARS.toLocaleString()})`]
        : [
            `  chars:        ${reason.chars.toLocaleString()}  (limit ${READABLE_MAX_CHARS.toLocaleString()})`,
            `  longest line: ${reason.maxLineChars.toLocaleString()}  (limit ${READABLE_MAX_LINE_CHARS.toLocaleString()})`,
        ];
    return [
        'file not rendered because: {',
        ...why,
        '}',
        '',
        'looks like a built artifact or data dump, not readable source.',
        'the file on disk is untouched; file.save is disabled for this grid.',
    ].join('\n');
}

/**
 * Create + register a CodeGrid for `path` with the given body — the shared core of every
 * TEXT path. No positioning (the caller lays out). Returns the registry id, or null if the
 * file is already open. `notRendered` marks placeholder/hex grids so file.save refuses to
 * write that synthetic text over the real file.
 */
function registerFileGrid(ctx, path, body, notRendered) {
    const uri = `file:///${String(path).replace(/^\/+/, '')}`;
    if ((ctx.registry.findByMeta?.('sourcePath', uri) || []).length) return null;
    const grid = new CodeGrid(ctx.scene, ctx.atlas, { name: path, worldScale: 0.025, ...gridTheme() });
    grid.setSourcePath(uri); // so file.save / fs/didChange refresh can find it
    if (notRendered) grid.userData.notRendered = notRendered;
    grid.loadFile(path, body);
    // The single insertion point into the content tree: parent the grid under its directory
    // node BEFORE addGrid (so addGrid's `if (!grid.parent) scene.add` skips — the tree owns it).
    // The caller relayouts once after a batch.
    ctx.contentTree?.insert(grid, path);
    return ctx.addGrid(grid, { id: path, type: 'grid' }); // registers (scene.add skipped — parented)
}

/** Register fetched text content — unreadable content renders as a placeholder card. */
export function addFileGrid(ctx, path, content) {
    const reason = unreadableReason(content);
    return registerFileGrid(ctx, path, reason ? placeholderBody(reason) : content, reason);
}

/** Register a placeholder from tree metadata alone — the file was never fetched (oversize). */
export function addUnfetchedGrid(ctx, path, bytes) {
    const reason = { bytes };
    return registerFileGrid(ctx, path, placeholderBody(reason), reason);
}

// ── image grids ─────────────────────────────────────────────────────────────────────────

/** Decode image bytes → a WebGPU-ready texture (mirrors the capture path's filter/colorspace dials). */
async function imageTextureFromBytes(bytes, kind) {
    const blob = new Blob([bytes], { type: mimeForFormat(kind.format) });
    const bitmap = await createImageBitmap(blob);
    const texture = new THREE.Texture(bitmap);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;   // same WebGPU path as the VideoTexture capture
    texture.needsUpdate = true;
    return { texture, width: bitmap.width, height: bitmap.height };
}

/** Create + register an image as a single-cell FrameGrid — the texture carries the pixels, NOT the cells. */
function registerImageGrid(ctx, path, texture, width, height, kind) {
    const uri = `file:///${String(path).replace(/^\/+/, '')}`;
    if ((ctx.registry.findByMeta?.('sourcePath', uri) || []).length) return null;
    const aspect = (width > 0 && height > 0) ? width / height : 1;
    // cols:1, rows:1 — one quad samples the full-resolution texture. NEVER cols×rows = pixel dims.
    const grid = new FrameGrid(ctx.scene, ctx.atlas, { name: path, sourcePath: uri, cols: 1, rows: 1, width: IMAGE_CARD_WIDTH, aspect });
    grid.userData.fileKind = { ...kind, width, height };   // the dedicated type value + dims, on the entity
    grid.setFrameTexture(texture);
    ctx.contentTree?.insert(grid, path);
    return ctx.addGrid(grid, { id: path, type: 'grid' });
}

// ── binary grids (hex) ──────────────────────────────────────────────────────────────────

/** Create + register a binary file as a hex BLOCK in a CodeGrid — "can't read it, here are the bytes". */
function registerBinaryGrid(ctx, path, bytes) {
    const size = bytes.length >= SNIFF_BYTES ? ` (first ${bytes.length.toLocaleString()} bytes)` : ` (${bytes.length.toLocaleString()} bytes)`;
    const body = `binary — no text or image signature${size}\n\n` + bytesToHexView(bytes, { cols: HEX_COLS });
    return registerFileGrid(ctx, path, body, { binary: true });
}

// ── the classify → render entry ─────────────────────────────────────────────────────────

/**
 * Render core shared by file.open and the workspace's sheet.render: ensure a grid exists for
 * `path`. Returns the registry id (= path) — the existing one if already rendered, else a
 * freshly classified + loaded + registered grid. Does NOT position/flow (the caller decides).
 * Throws if the read fails.
 *
 * Extension is the confident hint (image / known-text route with no extra fetch); anything
 * unknown asks the bytes — a magic-signature sniff names an image even with no extension,
 * else a UTF-8 probe splits text from binary, and binary gets the hex-render attempt.
 */
export async function renderSheetGrid(ctx, path) {
    const uri = `file:///${String(path).replace(/^\/+/, '')}`;
    const existing = ctx.registry.findByMeta?.('sourcePath', uri) || [];
    if (existing.length) return existing[0].id;          // already rendered
    if (!ctx.fileProvider) throw new Error('no file source — load a repo or connect the relay');

    const kind = classifyByExtension(path);
    if (kind?.kind === 'image') return renderImageSheet(ctx, path, uri, kind);
    if (kind?.kind === 'text')  return renderTextSheet(ctx, path, uri);

    // Unknown / extensionless / binary-ext — let the bytes decide.
    if (typeof ctx.fileProvider.getBytes === 'function') {
        let head = null;
        try { head = await ctx.fileProvider.getBytes(path, { maxBytes: SNIFF_BYTES }); } catch { /* fall through to text */ }
        if (head) {
            const bk = classifyBytes(head);
            if (bk.kind === 'image')  return renderImageSheet(ctx, path, uri, bk);
            if (bk.kind === 'binary') return registerBinaryGrid(ctx, path, head) ?? racedId(ctx, uri);
            // bk.kind === 'text' → fall through to the text path
        }
    }
    return renderTextSheet(ctx, path, uri);
}

/** Text path — fetch UTF-8, render as a CodeGrid (placeholder if oversize). */
async function renderTextSheet(ctx, path, uri) {
    const content = await ctx.fileProvider.getFile(path);
    return addFileGrid(ctx, path, content) ?? racedId(ctx, uri);
}

/** Image path — fetch bytes, decode to a texture, render as a single-cell FrameGrid sized to aspect. */
async function renderImageSheet(ctx, path, uri, kind) {
    if (typeof ctx.fileProvider.getBytes !== 'function') throw new Error('image open needs the relay file source');
    const bytes = await ctx.fileProvider.getBytes(path);
    const { texture, width, height } = await imageTextureFromBytes(bytes, kind);
    return registerImageGrid(ctx, path, texture, width, height, kind) ?? racedId(ctx, uri);
}

/** A concurrent open registered this path during our await — return its id, never null. */
function racedId(ctx, uri) {
    const raced = ctx.registry.findByMeta?.('sourcePath', uri) || [];
    return raced[0]?.id ?? null;
}
