/**
 * repo.* commands — load a GitHub repo as a 3D field, client-only.
 *
 * repo.load <owner/repo[/branch] | github-url>
 *   The progressive-enhancement baseline: fetch a public GitHub repo entirely
 *   client-side (no relay) and render it as the 3D tree field. Clears any prior
 *   scene state first, ensures a GitHub-backed fileProvider is the active source
 *   (swapping from a relay/local one if needed), then reuses the provider-agnostic
 *   bulk-open (`file.openDir ''`) — so the exact browse/open/layout path the relay
 *   uses now sources from GitHub instead.
 *
 * repo.clear
 *   Tear the current field down — a clean slate.
 */

import GitHubFileProvider from '@glyph3d/core/services/data/GitHubFileProvider.js';

/** Dispose every code grid, clear annotations, stop any camera animation. */
function clearScene(ctx) {
    // removeGrids is the canonical bulk-dispose path: geometry freed, unregistered,
    // zero intermediate re-packs, one world settle at the end.
    const cleared = ctx.removeGrids(ctx.registry.findLoose('grid').map((e) => e.id));
    ctx.annotations?.clear?.();
    ctx.workspace?.clear?.();
    ctx._cancelCameraAnimation?.();
    ctx.fieldSources = []; // the field is gone — clear the one source-of-truth (capture reads it)
    return cleared;
}

import { beginLoad } from '../loadTrace.js';

/** owner/repo/branch (3+ plain segments) → a /tree/ URL parseGitHubUrl accepts; else pass through. */
function normalizeRepoRef(ref) {
    const s = String(ref).trim();
    if (/^https?:\/\//.test(s) || s.startsWith('git@')) return s;
    const parts = s.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length >= 3) {
        return `https://github.com/${parts[0]}/${parts[1]}/tree/${parts.slice(2).join('/')}`;
    }
    return s; // owner/repo
}

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerRepoCommands(router) {
    router.register('repo.load', async (args, ctx) => {
        const ref = args[0];
        if (!ref) return { text: 'ERR: usage: repo.load <owner/repo[/branch] | github-url> [--no-frame]', data: null };
        const noFrame = args.includes('--no-frame');   // session restore: a saved pose already landed
        const url = normalizeRepoRef(ref);

        ctx.status?.set(`Loading ${ref}…`);   // live status; cleared however we return
        const trace = beginLoad(ctx, 'repo', ref);
        try {
            // 1. Fetch FIRST, commit after. The fetch is provider-local, so a bad
            //    ref or a failed download leaves the current source and the scene
            //    exactly as they were. (A failed load once swapped in an EMPTY
            //    GitHub tree and cleared the field up front — every browse after
            //    that answered a success-shaped "0 dir(s), 0 file(s)".)
            const provider = new GitHubFileProvider();
            let info;
            try {
                info = await provider.loadRepository(url);
            } catch (err) {
                return { text: `ERR: repo load failed for ${ref}: ${err?.message || err}`, data: null };
            }
            trace.mark('tree');

            // 2. The load is real — now it owns the scene: swap the source, fresh slate.
            ctx.fileProvider = provider;
            const cleared = clearScene(ctx);
            trace.mark('clear', { cleared });

            // 3. Render the whole repo as the field — the same provider-agnostic bulk-open +
            //    tree layout the relay path uses, now sourcing from GitHub. (It runs its own
            //    openDir trace — this stage is the envelope.)
            const open = await router.execute(['file.openDir', '']);
            trace.mark('field', { opened: open?.data?.opened });

            // 4. Frame the field — unless the caller already owns the pose (restore).
            if (!noFrame) await router.execute('camera.fitall');
            trace.mark('frame').end();

            // 5. Record the field source — the ONE decider the session persists. file.openDir (step 3)
            //    just appended {type:'local'}; a repo load owns the whole (freshly cleared) scene, so
            //    it REPLACES the list with its single ref — a reload restores via repo.load, not a
            //    local dir pop. owner/repo/branch is the form repo.load parses.
            ctx.fieldSources = [{ type: 'repo', ref: `${info.owner}/${info.repo}/${info.branch}` }];

            const where = `${info.owner}/${info.repo}@${info.branch}`;
            const opened = open?.data?.opened;
            return {
                text: `OK: loaded ${where}${cleared ? ` (cleared ${cleared} prior)` : ''} — ${opened ?? '?'} files`,
                data: { repo: where, owner: info.owner, name: info.repo, branch: info.branch, cleared, ...(open?.data || {}) },
            };
        } finally {
            ctx.status?.clear();
        }
    }, {
        description: 'Load a GitHub repo as a 3D field, client-only (no relay needed)',
        usage: '<owner/repo[/branch] | github-url> [--no-frame]',
        returns: '{ repo, owner, name, branch, cleared, opened, ... }',
    });

    router.register('repo.clear', (_args, ctx) => {
        const cleared = clearScene(ctx);
        return { text: `OK: cleared ${cleared} grid(s)`, data: { cleared } };
    }, { description: 'Tear down the current field (grids + annotations) — a clean slate' });
}
