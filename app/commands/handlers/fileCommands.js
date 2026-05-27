/**
 * File commands: file.save, file.dirty
 *
 * Editable-3d-ide L0 — the grid-content side of persistence. Grids in the
 * scene are in-memory copies of disk files (loaded via RemoteFileSystemProvider
 * at GitHubRepoViewer.js:543+ and shown via CodeGrid.loadText). Prior to L0
 * any edit to that in-memory copy was ephemeral: a grid.text mutation
 * vanished on reload and there was no way to get it back to disk.
 *
 * file.save <grid-id|index> [uri]
 *                            — persist the grid's current line buffer to the
 *                              URI in grid.userData.sourcePath (or grid.sourcePath,
 *                              whichever is set), via the fs/writeFile JSON-RPC
 *                              verb handled server-side in cli/fs.go. An
 *                              explicit second arg overrides the lookup —
 *                              useful for grids created via `grid.create` that
 *                              don't have userData.sourcePath wired yet.
 *                              Returns { uri, bytesWritten, mtime }.
 *
 * file.dirty <grid-id|index> — cheap dirty-check: SHA-free content-hash compare
 *                              against the last-saved snapshot. Returns
 *                              { id, dirty: bool }. Does NOT hit disk.
 *
 * With no arg both commands fall through to the current primary attention
 * target (ctx.attention.primary?.id), matching the ergonomics of mode.* verbs
 * so a user in reader mode can just type `file.save` with no arguments.
 *
 * The "last-saved snapshot" lives on the grid itself as a non-enumerable
 * `_savedTextHash` property, updated on successful save. The first save
 * establishes the baseline; before that file.dirty returns true if any lines
 * exist (conservative — a freshly loaded grid has never been "saved" in our
 * bookkeeping so it's technically dirty. This is fine for L0 and the L1
 * RemoteFileSystemProvider integration will snapshot at load-time; see
 * round3-hud-convergence.md §"File: fileCommands.js" / round1-hud E4).
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { flowLayout } from './layoutCommands.js';
import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';

/**
 * Fast non-crypto content hash. FNV-1a 32-bit over the full string. Collision
 * rate is acceptable for a dirty-check (false-negatives mean "looks clean
 * when it isn't" which is only possible if two texts genuinely collide — a
 * 1-in-4B event and the worst outcome is an unnecessary save prompt).
 */
export function contentHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        // 32-bit FNV prime multiply with wraparound (imul returns int32).
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Resolve the grid argument: explicit registry id / index, or fall back to
 * the current primary attention target when empty. Returns the same shape
 * as resolveGridByIdOrIndex plus a `uri` string pulled from sourcePath.
 */
function resolveSaveTarget(ctx, args) {
    const target = args[0] ?? ctx.attention?.primary?.id ?? null;
    if (!target) {
        return { error: 'ERR: no grid specified and no current primary attention target' };
    }
    const resolved = resolveGridByIdOrIndex(ctx, String(target));
    if (resolved.error) return resolved;

    const grid = resolved.grid;
    const explicit = args[1] || null;
    const uri = explicit || grid.getSourcePath?.() || null;
    if (!uri) {
        return {
            error: `ERR: grid "${resolved.registryId || target}" has no sourcePath. Usage: file.save <id> [uri-to-write-to] — or load the grid from the tree panel so userData.sourcePath gets set.`,
        };
    }
    return { ...resolved, uri };
}

/**
 * Reconstruct the text content the grid would write to disk. CodeGrid keeps
 * the canonical line buffer in `grid.lines` (set by loadText at CodeGrid.js:146,
 * re-split lazily elsewhere). Join with '\n' — no trailing newline unless the
 * last line was already empty.
 */
function gridToText(grid) {
    if (!Array.isArray(grid.lines)) return '';
    return grid.lines.join('\n');
}

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerFileCommands(router) {
    // file.open <path> [x y z]
    //
    // Load a file from the relay filesystem (ctx.fileProvider) into a new grid.
    // The one load primitive the IDE file tree AND the CLI both call — so
    // "click a file" and "glyph3d-cli file.open <path>" travel the same path.
    // The god-class did this inline in loadRepository(); here it's a command,
    // which is what makes "Claude, open these files" work over the bus.
    router.register('file.open', async (args, ctx) => {
        const path = args[0];
        if (!path) return { text: 'ERR: usage: file.open <path> [x y z]', data: null };

        const uri = `file:///${String(path).replace(/^\/+/, '')}`;

        // Don't duplicate an already-open file — report the existing grid.
        const existing = ctx.registry.findByMeta?.('sourcePath', uri) || [];
        if (existing.length) {
            return {
                text: `OK: ${path} already open as "${existing[0].id}"`,
                data: { id: existing[0].id, path, alreadyOpen: true },
            };
        }

        if (!ctx.fileProvider) {
            return { text: 'ERR: no fileProvider — relay bridge not connected', data: null };
        }

        let content;
        try {
            content = await ctx.fileProvider.getFile(path);
        } catch (err) {
            return { text: `ERR: read failed for ${path}: ${err?.message || err}`, data: null };
        }

        const grid = new CodeGrid(ctx.scene, ctx.atlas, { name: path, worldScale: 0.025 });
        grid.setSourcePath(uri);   // so file.save / fs/didChange refresh can find it
        grid.loadFile(path, content);

        // Explicit coords place precisely (tour scripts position by hand);
        // otherwise the grid joins the shelf via flowLayout after registration.
        const x = parseFloat(args[1]), y = parseFloat(args[2]), z = parseFloat(args[3]);
        const explicit = Number.isFinite(x);
        if (explicit) {
            grid.position.set(x, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0);
        }

        // addGrid reads sourcePath/filename off the grid and registers it; it
        // also scene.adds (the core ctor's scene.add is dead).
        const id = ctx.addGrid(grid, { id: path, type: 'grid' });

        // Reflow the shelf so the new file lands cleanly beside the others —
        // bounds + margins, never stacked (skip when positioned explicitly).
        if (!explicit) flowLayout(ctx.getGrids());

        return {
            text: `OK: opened ${path} (${grid.getLineCount()} lines, ${grid.getGlyphCount?.() ?? '?'} glyphs)`,
            data: { id, path, uri, lines: grid.getLineCount() },
        };
    }, {
        description: 'Load a file from the relay filesystem into a new grid',
        usage: '<path> [x y z]',
        returns: '{ id, path, uri, lines }',
    });

    router.register('file.save', async (args, ctx) => {
        const r = resolveSaveTarget(ctx, args);
        if (r.error) return { text: r.error, data: null };

        if (!ctx.wsbridge || !ctx.wsbridge.connected) {
            return {
                text: 'ERR: WebSocket bridge not connected — cannot reach fs/writeFile',
                data: null,
            };
        }

        const content = gridToText(r.grid);

        let result;
        try {
            result = await ctx.wsbridge.rpcRequest('fs/writeFile', {
                uri: r.uri,
                content,
                encoding: 'utf8',
            });
        } catch (err) {
            return {
                text: `ERR: fs/writeFile failed: ${err.message || err}`,
                data: { uri: r.uri, code: err.code ?? null },
            };
        }

        // Stash the hash so the next file.dirty can detect further edits.
        // Attach as a non-enumerable prop to keep grid.toString/JSON.stringify
        // clean.
        try {
            Object.defineProperty(r.grid, '_savedTextHash', {
                value: contentHash(content),
                writable: true,
                configurable: true,
                enumerable: false,
            });
        } catch {
            // Fall back to a plain assign if defineProperty is somehow blocked.
            r.grid._savedTextHash = contentHash(content);
        }

        const bytes = result?.bytesWritten ?? content.length;
        return {
            text: `OK: wrote ${bytes} bytes to ${r.uri}`,
            data: {
                uri: r.uri,
                bytesWritten: bytes,
                mtime: result?.mtime ?? null,
                registryId: r.registryId,
                index: r.idx,
            },
        };
    }, {
        description: 'Persist a grid\'s current text to disk via fs/writeFile',
        usage: '[grid-id|index] [uri]',
        returns: '{ uri, bytesWritten, mtime, registryId, index }',
    });

    router.register('file.dirty', (args, ctx) => {
        const target = args[0] ?? ctx.attention?.primary?.id ?? null;
        if (!target) {
            return { text: 'ERR: no grid specified and no current primary attention target', data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, String(target));
        if (resolved.error) return { text: resolved.error, data: null };

        const current = contentHash(gridToText(resolved.grid));
        const saved = resolved.grid._savedTextHash;
        // If we've never saved, treat as dirty only when the buffer is
        // non-empty — an empty-from-disk grid shouldn't report dirty just
        // because we haven't snapshotted it yet.
        const dirty = saved === undefined
            ? (resolved.grid.lines?.length ?? 0) > 0
            : saved !== current;

        return {
            text: `OK: dirty=${dirty}`,
            data: {
                id: resolved.registryId,
                index: resolved.idx,
                dirty,
                hashed: saved !== undefined,
            },
        };
    }, {
        description: 'Check whether a grid\'s in-memory text differs from its last save',
        usage: '[grid-id|index]',
        returns: '{ id, index, dirty, hashed }',
    });
}
