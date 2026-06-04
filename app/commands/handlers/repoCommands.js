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
    // Snapshot ids first — removeGrid mutates the registry as we iterate. removeGrid is
    // the canonical dispose path (geometry freed, scene.remove, unregister, reconcile).
    const ids = ctx.registry.findByType('grid').map((e) => e.id);
    let cleared = 0;
    for (const id of ids) if (ctx.removeGrid(id)) cleared++;
    ctx.annotations?.clear?.();
    ctx.workspace?.clear?.();
    ctx._cancelCameraAnimation?.();
    return cleared;
}

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
        if (!ref) return { text: 'ERR: usage: repo.load <owner/repo[/branch] | github-url>', data: null };
        const url = normalizeRepoRef(ref);

        // The active source must be GitHub-backed. In the hosted baseline it already is;
        // if a relay swapped in the local provider, switch back to GitHub for this load.
        let provider = ctx.fileProvider;
        if (!(provider instanceof GitHubFileProvider)) {
            provider = new GitHubFileProvider();
            ctx.fileProvider = provider;
        }

        // 1. Fresh slate.
        const cleared = clearScene(ctx);

        // 2. Client-side GitHub fetch of the tree (sets the provider's _currentTree so
        //    listTree/filterCodeFiles/getFile resolve against this repo).
        let info;
        try {
            info = await provider.loadRepository(url);
        } catch (err) {
            return { text: `ERR: repo load failed for ${ref}: ${err?.message || err}`, data: null };
        }

        // 3. Render the whole repo as the field — the same provider-agnostic bulk-open +
        //    tree layout the relay path uses, now sourcing from GitHub.
        const open = await router.execute(['file.openDir', '']);

        // 4. Frame the field.
        await router.execute('camera.fitall');

        const where = `${info.owner}/${info.repo}@${info.branch}`;
        const opened = open?.data?.opened;
        return {
            text: `OK: loaded ${where}${cleared ? ` (cleared ${cleared} prior)` : ''} — ${opened ?? '?'} files`,
            data: { repo: where, owner: info.owner, name: info.repo, branch: info.branch, cleared, ...(open?.data || {}) },
        };
    }, {
        description: 'Load a GitHub repo as a 3D field, client-only (no relay needed)',
        usage: '<owner/repo[/branch] | github-url>',
        returns: '{ repo, owner, name, branch, cleared, opened, ... }',
    });

    router.register('repo.clear', (_args, ctx) => {
        const cleared = clearScene(ctx);
        return { text: `OK: cleared ${cleared} grid(s)`, data: { cleared } };
    }, { description: 'Tear down the current field (grids + annotations) — a clean slate' });
}
