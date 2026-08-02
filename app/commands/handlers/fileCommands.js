/**
 * File commands — the command layer over file data: file.open, file.openDir, file.save, file.dirty.
 *
 * These own the CANVAS SIDE EFFECTS of opening/persisting a file — sheet tracking, attention,
 * content-tree relayout, the status line, dirty bookkeeping. The actual "turn a path into the
 * right renderable grid" vending lives in fileLoader.js (text / image / binary); these commands
 * compose it. file.open is the one load primitive the IDE file tree AND the CLI both call, so
 * "click a file" and `glyph3d-cli file.open <path>` — and "Claude, open these files" — travel
 * the same path.
 *
 * Persistence (file.save / file.dirty): grids in the scene are in-memory copies of disk files.
 * file.save persists a grid's current line buffer to its sourcePath URI via the fs/writeFile
 * JSON-RPC verb (cli/fs.go). file.dirty is a cheap content-hash compare against the last-saved
 * snapshot (a non-enumerable `_savedTextHash` on the grid) — no disk hit. With no arg both fall
 * through to the current primary attention target, matching the ergonomics of the mode.* verbs.
 */

import { resolveGridByIdOrIndex, WORLD_FLOOR_Y } from './spatialHelpers.js';
import { table } from '../formatResponse.js';
import { beginLoad } from '../loadTrace.js';
import { isWorkersSupported } from '@glyph3d/core/workers';
import { READABLE_MAX_CHARS } from '@glyph3d/core';
import { FS_ERROR_CODES } from '@glyph3d/core/services/data';
import { renderSheetGrid, addFileGrid, addFileGridAsync, addUnfetchedGrid, getDiskMtime, setDiskMtime } from './fileLoader.js';
import { canonicalPath, toFileUri } from './pathResolve.js';

/**
 * Fast non-crypto content hash. FNV-1a 32-bit over the full string. Collision rate is
 * acceptable for a dirty-check (false-negatives mean "looks clean when it isn't", only
 * possible if two texts genuinely collide — a 1-in-4B event whose worst outcome is an
 * unnecessary save prompt).
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
 * Resolve the save target: explicit registry id / index, or fall back to the current primary
 * attention target when empty. Returns the resolveGridByIdOrIndex shape plus a `uri` to write.
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
 * Reconstruct the text a grid would write to disk. CodeGrid keeps the canonical line buffer
 * in `grid.lines`. Join with '\n' — no trailing newline unless the last line was already empty.
 */
function gridToText(grid) {
    if (!Array.isArray(grid.lines)) return '';
    return grid.lines.join('\n');
}

/** A one-line human summary of a freshly opened grid, by kind (image dims vs text line/glyph counts). */
function openedSummary(grid) {
    const fk = grid.userData?.fileKind;
    if (fk?.kind === 'image') return `image · ${fk.format} ${fk.width}×${fk.height}`;
    if (typeof grid.getLineCount === 'function') return `${grid.getLineCount()} lines, ${grid.getGlyphCount?.() ?? '?'} glyphs`;
    return 'rendered';
}

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerFileCommands(router) {
    // file.open <path> [x y z]
    //
    // Load a file from the relay filesystem (ctx.fileProvider) into a new grid — text, image,
    // or binary (fileLoader classifies + vends; this verb owns the canvas effects). The one
    // load primitive the IDE file tree AND the CLI both call.
    router.register('file.open', async (args, ctx) => {
        if (!args[0]) return { text: 'ERR: usage: file.open <path> [x y z]', data: null };
        const path = canonicalPath(ctx, args[0]);
        const uri = toFileUri(path);

        // file.open IS the workspace's sheet.open + sheet.render — one path (Step 3). Track the
        // sheet regardless of render state so the HUD reflects every open.
        const sheet = ctx.workspace?.openSheet({ kind: 'file', source: { path, uri } });

        // Don't duplicate an already-open file — report the existing grid (+ record its panel).
        const existing = ctx.registry.findByMeta?.('sourcePath', uri) || [];
        if (existing.length) {
            if (sheet) ctx.workspace.setPanelId(sheet.id, existing[0].id);
            // Re-opening focuses the existing grid (so the 2D editor panel links to it).
            ctx.attentionManager?.set?.('primary', existing[0].id, { registry: ctx.registry });
            return {
                text: `OK: ${path} already open as "${existing[0].id}"`,
                data: { id: existing[0].id, path, alreadyOpen: true },
            };
        }

        if (!ctx.fileProvider) {
            return { text: 'ERR: no file source — load a repo or connect the relay', data: null };
        }

        ctx.status?.set(`Opening ${path}…`);
        const trace = beginLoad(ctx, 'open', path);
        let id;
        try {
            id = await renderSheetGrid(ctx, path);   // classify + load + create + register (id = path)
        } catch (err) {
            return { text: `ERR: read failed for ${path}: ${err?.message || err}`, data: null };
        } finally {
            ctx.status?.clear();
        }
        trace.mark('render');                        // classify + fetch + build + register, one call
        const grid = id ? ctx.registry.get(id)?.grid : null;
        if (!grid) return { text: `ERR: could not open ${path}`, data: null };   // guard: no deref / no setPanelId(null)
        if (sheet) ctx.workspace.setPanelId(sheet.id, id);

        // Phase 1.5 — auto-focus: opening a file makes it the primary attention target, so the
        // 2D editor panel links to it (and the HUD reflects it) for EVERY open path — tree
        // click, CLI, Claude — not just sheet.focus. Frame-the-camera stays a separate gesture
        // (sheet.focus / camera.focus), so a scripted/bulk open never yanks the view.
        ctx.attentionManager?.set?.('primary', id, { registry: ctx.registry });

        // The grid is already in the content tree (fileLoader inserted it). Relayout the tree
        // and rest it on the world floor — a single open is the degenerate one-leaf batch of
        // the same machine a repo load uses.
        ctx.contentTree.relayoutAndRest(WORLD_FLOOR_Y);
        trace.mark('relayout').end();

        return {
            text: `OK: opened ${path} (${openedSummary(grid)})`,
            data: {
                id, path, uri,
                kind: grid.userData?.fileKind?.kind ?? 'text',
                lines: typeof grid.getLineCount === 'function' ? grid.getLineCount() : undefined,
            },
        };
    }, {
        description: 'Load a file from the relay filesystem into a new grid (text / image / binary)',
        usage: '<path> [x y z]',
        returns: '{ id, path, uri, kind, lines }',
    });

    // file.openDir <dir-path>
    //
    // Open every code file under a directory and lay the result out as a 3D tree (directory
    // volumes + labels + depth). The directory-row button in the file tree runs this — "pop
    // this folder out into space". No count cap: unreadable content renders as placeholder
    // cards, so the whole dir always arrives; fetch is concurrent.
    router.register('file.openDir', async (args, ctx) => {
        if (!ctx.fileProvider) {
            return { text: 'ERR: no file source — load a repo or connect the relay', data: null };
        }
        const dir = canonicalPath(ctx, args[0] || '');
        const trace = beginLoad(ctx, 'openDir', dir || '/');

        // An absolute dir may sit outside the served root + reach set: register
        // it as a runtime reach root first (the server no-ops when it's already
        // covered, so no client-side root arithmetic). This is also the early
        // "does it exist / is it a dir" check for browse-opened directories.
        if (dir.startsWith('/') && typeof ctx.fileProvider.addRoot === 'function') {
            try {
                await ctx.fileProvider.addRoot(dir);
            } catch (err) {
                return { text: `ERR: cannot reach ${dir}: ${err?.message || err}`, data: null };
            }
            trace.mark('reach');
        }

        // The server walks the named directory itself (entries come back
        // relative to it); join the dir back on so grid keys stay full paths.
        let listing;
        try {
            listing = await ctx.fileProvider.listTree(toFileUri(dir));
        } catch (err) {
            return { text: `ERR: listTree failed: ${err?.message || err}`, data: null };
        }
        trace.mark('list', { entries: listing.entries.length });
        const joinBase = dir === '/' ? '' : dir;
        const entries = dir
            ? listing.entries.map((e) => ({ ...e, path: `${joinBase}/${e.path}` }))
            : listing.entries;
        const truncated = !!listing.truncated;
        const under = ctx.fileProvider.filterCodeFiles({ tree: entries });
        if (under.length === 0) {
            return { text: `OK: no code files under "${dir || '/'}"`, data: { dir, opened: 0, truncated } };
        }

        // Partition by the walker's size metadata: an oversized file becomes a placeholder card
        // straight from its tree entry — never fetched. (Bytes ≈ chars for source; the post-fetch
        // line check in addFileGrid catches the under-limit long-line artifacts.) Skip already-open.
        const notOpen = (p) => !(ctx.registry.findByMeta?.('sourcePath', toFileUri(p)) || []).length;
        const oversized = under.filter((f) => (f.size ?? 0) > READABLE_MAX_CHARS && notOpen(f.path));
        const want = under
            .filter((f) => (f.size ?? 0) <= READABLE_MAX_CHARS)
            .map((f) => f.path)
            .filter(notOpen);

        // Live status — the only activity signal on the local (relay) path, which has no
        // getProgress counts; cleared no matter how we return.
        const n = want.length + oversized.length;
        ctx.status?.set(`Opening ${n} file${n === 1 ? '' : 's'}${dir ? ' · ' + dir : ''}…`);
        try {
            let contentMap;
            try {
                contentMap = await ctx.fileProvider.getMultipleFiles(null, null, want);
            } catch (err) {
                return { text: `ERR: fetch failed: ${err?.message || err}`, data: null };
            }
            let kb = 0;
            for (const c of contentMap.values()) kb += c?.content?.length ?? 0;
            trace.mark('fetch', { files: contentMap.size, kb: Math.round(kb / 1024) });

            let opened = 0;
            let placeholders = 0;
            let chunks = 1;
            // The whole build runs under a registry HOLD: 350 grids registering means
            // ONE listener pass per pour beat + one at close — not 350 × the full
            // suite (projector, workspace reconcile, every mirroring React panel).
            await ctx.registry.holdChanges(async () => {
            for (const f of oversized) {
                if (addUnfetchedGrid(ctx, f.path, f.size) != null) { opened++; placeholders++; }
            }
            // STREAMED build. Two paths, one builder:
            //   worker (default) — buffers build OFF-THREAD (CodeGrid.loadFileAsync,
            //   the same builder agent books render through), a small in-flight pool
            //   keeps the worker fed while the main thread only seats finished grids
            //   (~0.1ms each). The frame never blocks — even a fat file's build is
            //   somebody else's milliseconds. (The sliced sync path capped the AVERAGE
            //   but a single big file is atomic: measured 78–97ms frame blocks.)
            //   sync fallback — no worker support: slice under the per-frame budget
            //   and yield between slices (budget 0 = the old single tick).
            // Either way: status counts up, and a throttled relayout mid-stream lets
            // the glide pour grids into their slots — held under a restore's batch
            // window, so a launch still settles exactly once (Settings ▸ Loading).
            const budget = Number(ctx.loadBuildBudget ?? 12);
            const yieldFrame = () => new Promise((r) => {
                // rAF is the real frame boundary; the timer keeps a hidden tab
                // (no frames) from stalling the load forever.
                let done = false;
                const settle = () => { if (!done) { done = true; r(); } };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle);
                setTimeout(settle, 50);
            });
            let lastPour = performance.now();
            let lastStatus = 0;
            // Mid-stream pours re-lay the WHOLE growing tree — as it gets big, each
            // pour costs more, so the interval backs off adaptively (a pour that took
            // T earns a ≥8×T quiet period). The status line throttles to ~10Hz —
            // per-file DOM churn is invisible anyway. Both start from the base
            // interval; a restore's batch window holds the relayouts entirely.
            let pourInterval = 300;
            const pour = (i) => {
                const now = performance.now();
                if (now - lastStatus > 100) {
                    ctx.status?.set(`Opening ${i}/${n}${dir ? ' · ' + dir : ''}…`);
                    lastStatus = now;
                }
                if (now - lastPour > pourInterval) {
                    // The pour beat is also the registry heartbeat: held change
                    // notifications flush here, so the projector/panels see the
                    // batch a few times per load instead of once per grid.
                    ctx.registry.flushHeld?.();
                    const t0 = performance.now();
                    ctx.contentTree.relayoutAndRest(WORLD_FLOOR_Y);   // held under a batch window
                    lastPour = performance.now();
                    pourInterval = Math.max(pourInterval, (lastPour - t0) * 8);
                }
            };
            const seat = (id) => {
                if (id == null) return;
                opened++;
                if (ctx.registry.get(id)?.grid?.userData?.notRendered) placeholders++;
            };
            if (budget > 0 && isWorkersSupported()) {
                let next = 0, done = 0;
                let lastYield = performance.now();
                const POOL = 4;   // in-flight builds — keeps the worker pipelined, not swamped
                await Promise.all(Array.from({ length: POOL }, async () => {
                    while (next < want.length) {
                        const p = want[next++];
                        const c = contentMap.get(p);
                        if (c == null) { done++; continue; }
                        seat(await addFileGridAsync(ctx, p, c.content));
                        done++;
                        if (done < want.length) pour(done);
                        // The breather: resolved worker promises stack their main-thread
                        // continuations (prep ~10ms on a fat file × POOL) into ONE task —
                        // measured 80–90ms blocks. A shared wall-clock yield breaks the
                        // stack at frame cadence; when main is idle it costs one frame.
                        if (performance.now() - lastYield > 32) {
                            await yieldFrame();
                            lastYield = performance.now();
                        }
                    }
                }));
                chunks = 0;   // build never held the thread past a frame's worth
            } else {
                let i = 0;
                while (i < want.length) {
                    const slice0 = performance.now();
                    while (i < want.length && (budget <= 0 || performance.now() - slice0 < budget)) {
                        const p = want[i++];
                        const c = contentMap.get(p);
                        if (c == null) continue;
                        seat(addFileGrid(ctx, p, c.content)); // inserts into the tree
                    }
                    if (i >= want.length) break;
                    chunks++;
                    pour(i);
                    await yieldFrame();
                }
            }
            });   // registry hold closes: one coalesced listener pass for the batch
            trace.mark('build', { grids: opened, chunks });

            // One relayout for the whole batch (the RenderPlan), then rest on the world floor —
            // the directory structure IS the scene graph now (the walk-tree scheme places it).
            ctx.contentTree.relayoutAndRest(WORLD_FLOOR_Y);
            const dirs = ctx.contentTree.dirCount();
            trace.mark('relayout', { dirs });
            trace.end({ opened, placeholders });

            // Record the pop in the session's field sources — a LIST now: every opened
            // root restores (additive multi-root world). Session capture persists exactly
            // this intent — the field is never inferred from a census of the registry.
            const prior = Array.isArray(ctx.fieldSources) ? ctx.fieldSources : [];
            ctx.fieldSources = [
                ...prior.filter((s) => !(s?.type === 'local' && s.dir === dir)),
                { type: 'local', dir },
            ];

            let text = `OK: opened ${opened} file(s) under "${dir || '/'}" → content tree (${dirs} dirs)`;
            if (placeholders) text += `; ${placeholders} as not-rendered placeholder${placeholders === 1 ? '' : 's'}`;
            if (truncated) text += `; LISTING TRUNCATED at the server entry cap — deeper content not loaded`;
            return { text, data: { dir, opened, placeholders, dirs, truncated } };
        } finally {
            ctx.status?.clear();
        }
    }, {
        description: 'Open all code files under a directory (recursive) and lay them out as a 3D tree',
        usage: '<dir-path>   (empty path = whole project)',
        returns: '{ dir, opened, placeholders, dirs, truncated }',
    });

    // file.list <path>
    //
    // Shallow, unfiltered listing of one directory — the browse primitive the file
    // browser (and the CLI: `glyph3d-cli file.list ~/dev`) reads. Nothing loads;
    // this is pure looking. In relay mode it lists ANY absolute directory the
    // operator can read; in GitHub mode it synthesizes from the loaded repo tree.
    router.register('file.list', async (args, ctx) => {
        if (!ctx.fileProvider) {
            return { text: 'ERR: no file source — load a repo or connect the relay', data: null };
        }
        if (typeof ctx.fileProvider.readDir !== 'function') {
            return { text: 'ERR: this file source cannot browse directories', data: null };
        }
        const path = canonicalPath(ctx, args[0] || '');
        let res;
        try {
            res = await ctx.fileProvider.readDir(path);
        } catch (err) {
            return { text: `ERR: list failed for ${path || '/'}: ${err?.message || err}`, data: null };
        }
        const dirs = res.entries.filter((e) => e.type === 'directory');
        const files = res.entries.filter((e) => e.type !== 'directory');
        const rows = [...dirs, ...files].map((e) => [
            e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-',
            e.name,
            e.type === 'directory' ? '' : String(e.size),
        ]);
        let text = rows.length ? table(['t', 'name', 'size'], rows) + '\n' : '';
        text += `OK: ${res.path || path || '/'} — ${dirs.length} dir(s), ${files.length} file(s)`;
        if (res.truncated) text += ' (TRUNCATED at the server entry cap)';
        return { text, data: { path: res.path ?? path, entries: res.entries, truncated: !!res.truncated } };
    }, {
        description: 'List one directory (shallow, unfiltered — dirs, hidden files, binaries) without loading anything',
        usage: '<path>   (relative to the served root, absolute, or ~/…)',
        returns: '{ path, entries: [{name,type,size}], truncated }',
    });

    // file.sources — the field's OWNERS. fieldSources is the session's
    // source-of-truth intent list ("this world = these roots/repos"), which
    // nothing on the bus could answer until now: asked "what sources are
    // loaded?", a driver's best proxy was a census of grids.
    router.register('file.sources', (_args, ctx) => {
        const sources = Array.isArray(ctx.fieldSources) ? ctx.fieldSources : [];
        const grids = ctx.registry?.findLoose?.('grid')?.length ?? 0;
        const dirs = ctx.contentTree?.dirCount?.() ?? 0;
        if (!sources.length) {
            return {
                text: 'OK: no sources loaded — the field is empty (file.openDir <dir> or repo.load <owner/repo>)',
                data: { sources: [], grids, dirs },
            };
        }
        const rows = sources.map((s) => (s?.type === 'repo'
            ? ['repo', s.ref]
            : ['local', s?.dir || '(served root)']));
        return {
            text: table(['type', 'source'], rows)
                + `\nOK: ${sources.length} source(s) — ${grids} grid(s) in ${dirs} dir(s)`,
            data: { sources, grids, dirs },
        };
    }, {
        description: "List the field's loaded sources — the roots/repos that own the scene (what a session restores)",
        returns: '{ sources:[{type,dir|ref}], grids, dirs }',
    });

    // file.closeDir <dir-path>
    //
    // The unload half of file.openDir: close every grid under a directory — the
    // per-node ✕ for directories in the file browser. Bulk by construction: grids
    // are removed directly (no per-grid router re-entry), sheets/tabs backing them
    // are dropped, attention is cleared where it pointed inside, ONE relayout
    // re-settles the tree, and the matching fieldSources entries are forgotten so
    // a session reload doesn't resurrect the closed root.
    router.register('file.closeDir', async (args, ctx) => {
        if (!args[0]) return { text: 'ERR: usage: file.closeDir <dir-path>', data: null };
        const dir = canonicalPath(ctx, args[0]);
        const prefix = dir === '/' ? '/' : dir + '/';
        const doomed = ctx.registry.findLoose('grid')
            .filter((e) => e.id === dir || String(e.id).startsWith(prefix));
        if (!doomed.length) {
            return { text: `OK: nothing loaded under "${dir}"`, data: { dir, closed: 0 } };
        }

        const ws = ctx.workspace;
        const am = ctx.attentionManager;
        for (const e of doomed) {
            const id = e.id;
            // Clear key BEFORE primary (exitEdit on a still-live grid), same order
            // sheet.close uses — then neither slot dangles on a removed panel.
            if (am?.get?.('key')?.id === id) am.set('key', null, { registry: ctx.registry });
            if (am?.get?.('primary')?.id === id) am.set('primary', null, { registry: ctx.registry });
            const sheet = ws ? [...ws.sheets.values()].find((s) => s.panelId === id) : null;
            if (sheet) { ws.setPanelId(sheet.id, null); ws.removeSheet(sheet.id); }
        }
        const closed = ctx.removeGrids(doomed.map((e) => e.id));

        if (Array.isArray(ctx.fieldSources)) {
            ctx.fieldSources = ctx.fieldSources.filter(
                (s) => !(s?.type === 'local' && (s.dir === dir || String(s.dir).startsWith(prefix)))
            );
        }
        return { text: `OK: closed ${closed} grid(s) under "${dir}"`, data: { dir, closed } };
    }, {
        description: 'Close every loaded grid under a directory (tabs drop, tree re-settles, session forgets the root)',
        usage: '<dir-path>',
        returns: '{ dir, closed }',
    });

    router.register('file.save', async (args, ctx) => {
        // --force (-f) overrides the relay's two correctness barriers: it skips the
        // stale-write check (omits baseMtime) and permits an empty overwrite
        // (allowEmpty). Strip it before positional resolution.
        const force = args.includes('--force') || args.includes('-f');
        const posArgs = args.filter(a => a !== '--force' && a !== '-f');

        const r = resolveSaveTarget(ctx, posArgs);
        if (r.error) return { text: r.error, data: null };
        if (r.grid.userData?.notRendered) {
            return { text: `ERR: "${r.registryId}" is a not-rendered placeholder — its buffer is not the file's content; save disabled`, data: null };
        }

        if (!ctx.wsbridge || !ctx.wsbridge.connected) {
            return {
                text: 'ERR: save needs the local relay — GitHub repos are read-only',
                data: null,
            };
        }

        const content = gridToText(r.grid);

        // baseMtime is the disk mtime this buffer last synced to (load, or a prior
        // save); the relay refuses the write if disk has moved since — so we never
        // clobber an external change with a stale buffer. --force omits it and opts
        // into the empty-overwrite path.
        const params = { uri: r.uri, content, encoding: 'utf8' };
        if (force) {
            params.allowEmpty = true;
        } else {
            const base = getDiskMtime(r.grid);
            if (base != null) params.baseMtime = base;
        }

        const shortUri = r.uri.replace(/^file:\/\//, '');
        const forceHint = `file.save ${r.registryId ?? r.idx ?? ''} --force`.replace(/\s+/g, ' ').trim();
        ctx.status?.set(`Saving ${shortUri}…`);
        let result;
        try {
            result = await ctx.wsbridge.rpcRequest('fs/writeFile', params);
        } catch (err) {
            const code = err.code ?? null;
            if (code === FS_ERROR_CODES.StaleWrite) {
                return {
                    text: `ERR: ${shortUri} changed on disk since you opened it — reopen to pick up the change, or "${forceHint}" to overwrite it.`,
                    data: { uri: r.uri, code, currentMtime: err.data?.currentMtime ?? null, baseMtime: err.data?.baseMtime ?? null },
                };
            }
            if (code === FS_ERROR_CODES.WouldTruncate) {
                return {
                    text: `ERR: refusing to write empty content over non-empty ${shortUri} — "${forceHint}" if you really mean to clear it.`,
                    data: { uri: r.uri, code, currentSize: err.data?.currentSize ?? null },
                };
            }
            return {
                text: `ERR: fs/writeFile failed: ${err.message || err}`,
                data: { uri: r.uri, code },
            };
        } finally {
            ctx.status?.clear();
        }

        // Stash the hash so the next file.dirty can detect further edits. Non-enumerable to
        // keep grid.toString / JSON.stringify clean.
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

        // Re-sync the disk-mtime token to the file we just wrote, so the NEXT save
        // compares against this write — not the now-stale load-time mtime.
        setDiskMtime(r.grid, result?.mtime);

        // Clear the live unsaved flag (the HUD's • marker) — content now matches disk.
        r.grid.markSaved?.();

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
        description: 'Persist a grid\'s current text to disk via fs/writeFile (atomic + mode-preserving; refuses stale/empty overwrites — pass --force to override)',
        usage: '[grid-id|index] [uri] [--force]',
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
        // Never saved → dirty only when the buffer is non-empty (an empty-from-disk grid
        // shouldn't report dirty just because we haven't snapshotted it yet).
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
