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
 * ROWS, NOT ACTORS (docs/perf-swarm/landing-plan.md move 1): the load unit is the
 * FileRow — bytes staged + measured + colorized, no interaction machinery. The
 * CodeGrid ACTOR materializes at the interaction seam (materializeActor): focus,
 * edit, save, and the single-file open paths that end in interaction.
 *
 * Public surface (kept deliberately small — a shared Surface protocol is the eventual home):
 *   renderSheetGrid(ctx, path)          classify + fetch + register + MATERIALIZE one file → id
 *   addFileRow(ctx, path, content, mtime?, baked?)  register already-fetched text (openDir's batch path)
 *   addUnfetchedRow(ctx, path, bytes)   register an oversize file as a placeholder from metadata
 *   materializeActor(ctx, id)           row → CodeGrid actor swap (idempotent)
 */

import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import FileRow from '@glyph3d/core/collections/FileRow.js';
import FrameGrid from '@glyph3d/core/collections/FrameGrid.js';
import { gridTheme } from '../../client/settings.js';
import { unreadableReason, READABLE_MAX_CHARS, READABLE_MAX_LINE_CHARS } from '@glyph3d/core';
import { classifyByExtension, classifyBytes } from '@glyph3d/core';
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
/**
 * Stash the disk mtime a grid's buffer is in sync with — the token file.save sends
 * as baseMtime so the relay can refuse a write when the file changed on disk
 * underneath us. Non-enumerable to keep grid serialization clean (mirrors
 * _savedTextHash). Set at load (the fs/readFile stat) and after each save (the
 * writeFile result's fresh mtime); a no-op when mtime is unknown (e.g. GitHub).
 */
export function setDiskMtime(grid, mtime) {
    if (grid == null || mtime == null) return;
    try {
        Object.defineProperty(grid, '_diskMtime', { value: mtime, writable: true, configurable: true, enumerable: false });
    } catch {
        grid._diskMtime = mtime;
    }
}

/** The disk mtime this grid's buffer is known in sync with, or null if never synced. */
export function getDiskMtime(grid) {
    return grid?._diskMtime ?? null;
}

/** Dedupe + construct the FileRow shell for a text path (shared by every text
 *  build path). Returns null when the file is already open. @private */
function prepFileRow(ctx, path, notRendered) {
    const uri = `file:///${String(path).replace(/^\/+/, '')}`;
    if ((ctx.registry.findByMeta?.('sourcePath', uri) || []).length) return null;
    const row = new FileRow(ctx.scene, ctx.atlas, { name: path, worldScale: 0.025, ...gridTheme() });
    row.setSourcePath(uri); // so file.save / fs/didChange refresh can find it
    if (notRendered) row.userData.notRendered = notRendered;
    return row;
}

/** Seat a BUILT row: disk-sync token, tree insertion, registration (the shared tail
 *  of both build paths). Real content only carries the mtime — a placeholder/hex
 *  row's text is synthetic, never the file's bytes (file.save is disabled for it).
 *  The single insertion point into the content tree: parent the row under its
 *  directory node BEFORE addGrid (so addGrid's `if (!grid.parent) scene.add` skips —
 *  the tree owns it). The caller relayouts once after a batch. @private */
function seatFileRow(ctx, path, row, notRendered, mtime) {
    if (!notRendered) setDiskMtime(row, mtime);
    ctx.contentTree?.insert(row, path);
    return ctx.addGrid(row, { id: path, type: 'grid' }); // registers (scene.add skipped — parented)
}

/**
 * Create, load, and seat a text ROW — the load unit of rows-not-actors. Seating
 * (tree insert + registration) is SYNCHRONOUS — the tree grows in walk order and
 * the bulk path's mid-stream pours see the row immediately — while the bytes
 * stage on the shared arena. The returned `load` resolves when the row is staged,
 * adopted, and MEASURED — the baked record answers before the GPU does, so the
 * bulk settle never waits on a per-file bounds readback.
 * @private
 * @returns {{id: string, load: Promise}|null}
 */
function registerFileRow(ctx, path, body, notRendered, mtime, baked) {
    const row = prepFileRow(ctx, path, notRendered);
    if (!row) return null;
    // The baked record (repo layout index) warm-starts the row's measure; real
    // content only — a placeholder's synthetic text has nothing to do with the
    // file's bake, so the row self-bakes it.
    const load = row.load(path, body, { baked: notRendered ? null : baked });
    const id = seatFileRow(ctx, path, row, notRendered, mtime);
    return { id, load };
}

/** Register fetched text content as a ROW — unreadable content renders as a
 *  placeholder card. Resolves once the row is seated + staged (null if already
 *  open). `mtime` (optional) is the disk mtime the content was read at, stashed
 *  for the save-time stale-write check; omit it for content with no disk identity
 *  (GitHub). */
export async function addFileRow(ctx, path, content, mtime, baked) {
    const reason = unreadableReason(content);
    const r = registerFileRow(ctx, path, reason ? placeholderBody(reason) : content, reason, mtime, baked);
    if (!r) return null;
    await r.load;
    return r.id;
}

/** Register a placeholder row from tree metadata alone — the file was never fetched (oversize). */
export async function addUnfetchedRow(ctx, path, bytes) {
    const reason = { bytes };
    const r = registerFileRow(ctx, path, placeholderBody(reason), reason);
    if (!r) return null;
    await r.load;
    return r.id;
}

// ── Materialization: row → actor ────────────────────────────────────────────

/**
 * Swap a FileRow for its CodeGrid ACTOR — the interaction seam of rows-not-actors.
 * Idempotent: an entry already holding an actor (or a FrameGrid, or nothing)
 * returns it untouched. The swap is SYNCHRONOUS — the registry entry, the tree
 * book, and the pose are the actor's when this returns — while the actor's
 * content load runs behind it; the detached row keeps rendering its glyphs
 * (frozen pose) until the actor's are laid, so the upgrade overlaps instead of
 * flashing blank.
 *
 * Callers: attention focus (primary/key), edit/save/semantic/grid verbs — any
 * path about to exercise the interactive surface a row doesn't carry.
 * @returns {Object|null} the actor grid (or whatever the entry holds)
 */
export function materializeActor(ctx, id) {
    const entry = ctx.registry.get(id);
    const row = entry?.grid;
    if (!row?.isFileRow) return row ?? null;
    const path = entry.id;
    const uri = row.getSourcePath();
    const mtime = getDiskMtime(row);
    const notRendered = row.userData?.notRendered ?? null;
    const oldBook = ctx.contentTree?.bookAt?.(path);
    const pose = oldBook ? { pos: oldBook.position.clone(), quat: oldBook.quaternion.clone() } : null;

    const grid = new CodeGrid(ctx.scene, ctx.atlas, { name: path, worldScale: 0.025, ...gridTheme() });
    grid.setSourcePath(uri);
    if (notRendered) grid.userData.notRendered = notRendered;
    else setDiskMtime(grid, mtime);
    if (row._bakedRecord) grid.setBakedRecord(row._bakedRecord);
    // Hand the actor the row's parse: content is identical, so the colorizer's
    // content-cache repaints from these captures instead of re-parsing the file.
    if (row._highlights) grid._highlights = row._highlights;

    ctx.registry.holdChanges(() => {
        ctx.contentTree?.insert(grid, path);          // replaces the row's book in place
        const newBook = ctx.contentTree?.bookAt?.(path);
        if (newBook && pose) {
            newBook.position.copy(pose.pos);
            newBook.quaternion.copy(pose.quat);
            newBook.updateMatrix();
        }
        ctx.registry.unregister(id);                  // then re-register: no overwrite warn
        ctx.addGrid(grid, { id, type: 'grid' });
    });

    const load = grid.loadFile(path, row.content);
    load.catch((err) => console.warn(`materializeActor: ${path} load failed:`, err))
        .finally(() => row.dispose());
    return grid;
}

// ── image grids ─────────────────────────────────────────────────────────────────────────
// Decode lives in FrameGrid.textureFromImageBytes (core) so the trail's image snapshots share it.

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

/** Create + register a binary file as a hex BLOCK row — "can't read it, here are the bytes". */
async function registerBinaryGrid(ctx, path, bytes) {
    const size = bytes.length >= SNIFF_BYTES ? ` (first ${bytes.length.toLocaleString()} bytes)` : ` (${bytes.length.toLocaleString()} bytes)`;
    const body = `binary — no text or image signature${size}\n\n` + bytesToHexView(bytes, { cols: HEX_COLS });
    const r = registerFileRow(ctx, path, body, { binary: true });
    if (!r) return null;
    await r.load;
    return r.id;
}

// ── the classify → render entry ─────────────────────────────────────────────────────────

/**
 * Render core shared by file.open and the workspace's sheet.render: ensure a grid exists for
 * `path` AND that it is the ACTOR — every caller (file.open, LSP jump, workspace sheet
 * restore) is a path where the user is about to interact, so a row poured by a bulk load
 * materializes here. Returns the registry id (= path). Does NOT position/flow (the caller
 * decides). Throws if the read fails.
 *
 * Extension is the confident hint (image / known-text route with no extra fetch); anything
 * unknown asks the bytes — a magic-signature sniff names an image even with no extension,
 * else a UTF-8 probe splits text from binary, and binary gets the hex-render attempt.
 */
export async function renderSheetGrid(ctx, path) {
    const uri = `file:///${String(path).replace(/^\/+/, '')}`;
    const id = await classifySheetGrid(ctx, path, uri);
    // The one materialize boundary for single-file opens: rows upgrade, actors
    // and FrameGrids pass through untouched (materializeActor is idempotent).
    if (id != null) materializeActor(ctx, id);
    return id;
}

/** The classify + ensure-registered core (returns an id that may be a ROW). @private */
async function classifySheetGrid(ctx, path, uri) {
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
            if (bk.kind === 'binary') return (await registerBinaryGrid(ctx, path, head)) ?? racedId(ctx, uri);
            // bk.kind === 'text' → fall through to the text path
        }
    }
    return renderTextSheet(ctx, path, uri);
}

/** Text path — fetch UTF-8, render as a row (placeholder if oversize). */
async function renderTextSheet(ctx, path, uri) {
    const fp = ctx.fileProvider;
    // Prefer the stat-aware read so the grid learns the disk mtime it's synced to
    // (the save-time stale-write token). Providers without it (GitHub) fall back to a
    // plain content fetch — those grids carry no mtime and skip the stale check.
    if (typeof fp.getFileWithStat === 'function') {
        const { content, mtime } = await fp.getFileWithStat(path);
        return (await addFileRow(ctx, path, content, mtime)) ?? racedId(ctx, uri);
    }
    const content = await fp.getFile(path);
    return (await addFileRow(ctx, path, content)) ?? racedId(ctx, uri);
}

/** Image path — fetch bytes, decode to a texture, render as a single-cell FrameGrid sized to aspect. */
async function renderImageSheet(ctx, path, uri, kind) {
    if (typeof ctx.fileProvider.getBytes !== 'function') throw new Error('image open needs the relay file source');
    const bytes = await ctx.fileProvider.getBytes(path);
    const { texture, width, height } = await FrameGrid.textureFromImageBytes(bytes, kind.format);
    return registerImageGrid(ctx, path, texture, width, height, kind) ?? racedId(ctx, uri);
}

/** A concurrent open registered this path during our await — return its id, never null. */
function racedId(ctx, uri) {
    const raced = ctx.registry.findByMeta?.('sourcePath', uri) || [];
    return raced[0]?.id ?? null;
}
