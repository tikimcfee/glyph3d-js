/**
 * Search commands — directory CONTENT search, bound as a book.
 *
 *   search <query>            start a search over the served root; results stream into
 *                             the search book, hits lit in place as they land
 *   search.in <dir> <query>   the same, rooted at a directory
 *   search.cancel             stop the walk, keep what it found
 *   search.clear              drop the run and its book — the scene as it was
 *   search.show / .hide / .toggle    the book's visibility (the run keeps going)
 *   search.page <next|prev|first|last|N>   turn to a RESULT (1-based for the operator)
 *   search.block <next|prev>  jump a whole page-block
 *   search.results [n]        the cached results as a table (page-free, no scene cost)
 *   search.status             the run + the view, as numbers
 *
 * The walk runs relay-side (fs/search) and PUSHES matches; nothing here blocks on it.
 * Flags may follow the query: `-i` (case-insensitive is the DEFAULT — `-s` makes it
 * sensitive), `-w` whole word, `-e` treat the query as a regexp.
 *
 * The operator-facing line numbers are 1-BASED here (what an editor says); the cache
 * and the grid highlights are 0-based throughout. This is the only place that converts.
 */

import { box, table, kvLines } from '../formatResponse.js';

/** Split trailing flags off the query words. Flags are exact tokens, so a query
 *  containing `-e` as text still works when it isn't in flag position. */
function parseSearchArgs(args) {
    const opts = {};
    const words = [];
    for (const a of args) {
        switch (a) {
            case '-e': opts.regex = true; break;
            case '-s': opts.caseSensitive = true; break;
            case '-i': opts.caseSensitive = false; break;
            case '-w': opts.wholeWord = true; break;
            default: words.push(a);
        }
    }
    return { query: words.join(' '), opts };
}

const shortPath = (p, n = 52) => (p.length > n ? '…' + p.slice(-(n - 1)) : p);

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSearchCommands(router) {

    /** The one control object. Absent only before the scene is wired. */
    const bookOf = (ctx) => ctx.searchBook || null;
    const need = (ctx) => {
        const b = bookOf(ctx);
        return b ? { book: b } : { error: 'ERR: search is not available (no scene/relay yet)' };
    };

    async function runSearch(ctx, uri, args) {
        const { query, opts } = parseSearchArgs(args);
        if (!query) return { text: 'ERR: usage: search <query> [-e regex] [-s case] [-w word]', data: null };
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        try {
            await r.book.search(query, { uri, ...opts });
        } catch (e) {
            // A search that cannot START is a real failure (bad pattern, unreachable
            // directory, no relay) — report the cause, don't leave a silent empty book.
            return { text: `ERR: ${e?.message ?? e}`, data: null };
        }
        const st = r.book.status();
        return {
            text: `OK: searching ${uri} for '${query}' — results stream into the search book`,
            data: st,
        };
    }

    router.register('search', (args, ctx) => runSearch(ctx, 'file:///', args),
        { description: 'Search file contents under the served root', usage: '<query> [-e] [-s] [-w]' });

    router.register('search.in', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: search.in <dir> <query> [-e] [-s] [-w]', data: null };
        const [dir, ...rest] = args;
        const uri = dir.startsWith('file://') ? dir : `file://${dir.startsWith('/') ? '' : '/'}${dir}`;
        return runSearch(ctx, uri, rest);
    }, { description: 'Search file contents under a directory', usage: '<dir> <query> [-e] [-s] [-w]' });

    router.register('search.cancel', async (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        await r.book.cancel();
        const st = r.book.status();
        return { text: `OK: search cancelled — ${st.total} matches in ${st.count} files kept`, data: st };
    }, { description: 'Stop the walk, keep the results found so far' });

    router.register('search.clear', async (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        await r.book.clear();
        return { text: 'OK: search cleared', data: r.book.status() };
    }, { description: 'Drop the search and its book' });

    router.register('search.show', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        r.book.show();
        return { text: 'OK: search book shown', data: r.book.status() };
    }, { description: 'Show the search book' });

    router.register('search.hide', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        r.book.hide();
        return { text: 'OK: search book hidden (the run continues)', data: r.book.status() };
    }, { description: 'Hide the search book without ending the search' });

    router.register('search.toggle', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        const visible = r.book.toggle();
        return { text: `OK: search book ${visible ? 'shown' : 'hidden'}`, data: r.book.status() };
    }, { description: 'Toggle the search book' });

    router.register('search.page', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        const book = r.book;
        const count = book.status().count;
        if (!count) return { text: 'ERR: no results to page', data: book.status() };
        const w = String(args[0] ?? 'next').toLowerCase();
        let st;
        if (w === 'next') st = book.scroll(1);
        else if (w === 'prev') st = book.scroll(-1);
        else if (w === 'first') st = book.pageTo(0);
        else if (w === 'last') st = book.pageTo(count - 1);
        else {
            const n = parseInt(w, 10);
            if (isNaN(n)) return { text: 'ERR: usage: search.page <next|prev|first|last|N>', data: null };
            st = book.pageTo(n - 1);   // operator-facing N is 1-based
        }
        const group = book.session.fileAt(st.index);
        return {
            text: `OK: result ${st.index + 1} of ${st.count} — ${group?.path ?? '?'}`
                + ` (block ${st.block + 1}/${st.blocks}, ${st.materialized} sheets live)`,
            data: st,
        };
    }, { description: 'Turn the search book to a result', usage: '<next|prev|first|last|N>' });

    router.register('search.block', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        const w = String(args[0] ?? 'next').toLowerCase();
        const st = r.book.blockScroll(w === 'prev' ? -1 : 1);
        return { text: `OK: block ${st.block + 1} of ${st.blocks} (result ${st.index + 1}/${st.count})`, data: st };
    }, { description: 'Jump the search book a whole page-block', usage: '<next|prev>' });

    router.register('search.results', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        const session = r.book.session;
        const limit = Math.max(1, parseInt(args[0], 10) || 50);
        const files = session.files;
        if (!files.length) {
            return { text: session.params ? `No results for '${session.params.query}' [${session.state}]` : 'No search running', data: r.book.status() };
        }
        const rows = files.slice(0, limit).map((f, i) => [
            String(i + 1),
            shortPath(f.path),
            String(f.matches.length),
            `L${(f.matches[0]?.line ?? 0) + 1}`,
        ]);
        const more = files.length > limit ? `\n(showing ${limit} of ${files.length})` : '';
        return {
            text: table(['#', 'file', 'hits', 'first'], rows)
                + `\nOK: ${session.summary()}${more}`,
            data: { ...r.book.status(), files: files.map((f) => ({ path: f.path, hits: f.matches.length })) },
        };
    }, { description: 'The cached search results as a table', usage: '[limit]' });

    router.register('search.status', (args, ctx) => {
        const r = need(ctx);
        if (r.error) return { text: r.error, data: null };
        const st = r.book.status();
        return {
            text: box('search', kvLines({
                query: st.query ?? '(none)',
                where: st.uri ?? '(none)',
                state: st.state,
                files: st.count,
                matches: st.total,
                scanned: st.scanned,
                truncated: st.truncated ? 'yes' : 'no',
                visible: st.visible ? 'yes' : 'no',
                result: st.count ? `${st.index + 1}/${st.count}` : '—',
                block: `${st.block + 1}/${st.blocks} (${st.pageSize}/block, ${st.materialized} live)`,
                note: st.note || '—',
            })),
            data: st,
        };
    }, { description: 'The search run and the book, as numbers' });
}
