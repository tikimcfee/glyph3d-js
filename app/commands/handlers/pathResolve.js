/**
 * Canonical path normalization at the verb boundary.
 *
 * Relay-mode canonical key = ABSOLUTE path WITH leading slash. Registry ids,
 * grid sourcePath URIs (via toFileUri), ContentTree keys, and sheet ids all
 * derive from it, so the same file reached by any route — relative CLI arg,
 * browse selection, saved session, agent tool event — is the same entity.
 *
 * The normalizer is idempotent: '/'-leading input is already canonical;
 * anything else resolves against the served root (fileProvider.rootInfo,
 * learned on connect BEFORE session restore — which is what migrates old
 * relative-path sessions for free). '~' resolves against the served home dir.
 *
 * Without rootInfo (GitHub mode, headless mock ctx) paths pass through with
 * only slash-trimming: repo-relative keys ARE the GitHub-mode key space.
 */

/**
 * @param {object} ctx - command context (reads ctx.fileProvider.rootInfo)
 * @param {string} path
 * @returns {string} canonical key for this provider's key space
 */
export function canonicalPath(ctx, path) {
    let p = String(path ?? '').trim();
    const info = ctx?.fileProvider?.rootInfo;
    if (p === '~' || p.startsWith('~/')) {
        const home = info?.home;
        if (home) p = home + p.slice(1);
    }
    if (p.startsWith('/')) {
        const t = p.replace(/\/+$/, '');
        return t || '/';
    }
    p = p.replace(/^\/+|\/+$/g, '');
    if (!info?.root) return p;               // GitHub / mock: repo-relative space
    if (!p || p === '.') return info.root;   // '' = the served root itself
    return `${info.root}/${p}`;
}

/** path → file:/// URI — the ONE strip point (leading slashes fold into the scheme). */
export function toFileUri(path) {
    return `file:///${String(path).replace(/^\/+/, '')}`;
}
