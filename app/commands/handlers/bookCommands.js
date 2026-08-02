/**
 * Book commands — the durable Book objects: every file's spatial carrier (wrapped at
 * insert by the ContentTree) AND every agent's run-book (grown by AgentBooks as work
 * streams in). One address space, one paging surface.
 *
 *   book.list            → every book: the tree's (path · form) + the agent shelf's (id · sheets)
 *   book.list <path|id>  → one book's full record (form, page, sheets, head, world position)
 *   book.page   [id] <next|prev|first|last|N>   turn a book's head (1-based index; N of M)
 *   book.scroll [id] <delta>                    turn by ±N sheets (− older / + newer)
 *   book.move   <id> <x> <y> <z>                pin an agent book where you put it (drag-release / CLI)
 *   book.config [key value]                     get/set an agent-shelf constant — re-flows live
 *   book.limit  [id] [n|all|default]            get/set ONE book's kept-turns cap (overrides the
 *                                               shelf default, cfg.maxSheets; 'all' keeps every turn)
 *
 * Paging resolves an AGENT book first (by agent id, or the first lane when omitted),
 * else a TREE book by path — a one-sheet file book pages trivially today and grows
 * into real page-turning as file books gain sheets. The file library's page dims stay
 * layout-scheme opts (`layout.scheme library --page-w …`); book.config dials the agent
 * shelf's cfg (page dims, deck pitch, card scales, faces, covers).
 */

import { box, kvLines } from '../formatResponse.js';

const r2 = (n) => Math.round(n * 100) / 100;

/** An agent lane (any address it answers to — lane id, registry group id, the
 *  `agent:<id>` display label, or the first lane when omitted), a library VOLUME
 *  (by its directory path), or a tree book (by file path) — or null.
 *
 *  Every agent form resolves inside AgentBooks.resolveLane by LOOKUP + field
 *  check — no prefix surgery here. (A blind `agent:` strip once mutilated the
 *  wheel's `agent:book:<id>` group ids into nonsense and the covers stopped
 *  turning; the id-space owner is the only party fit to read its own addresses.) */
function resolveBook(ctx, id) {
    const books = ctx.agentBooks;
    const hit = books?.resolveLane?.(id);
    if (hit) return { kind: 'agent', books, agentId: hit[0], book: hit[1].book };
    const tree = ctx.contentTree;
    const vol = id && tree?.volumeAt?.(id);
    if (vol) return { kind: 'volume', book: vol };
    const bk = id && tree?.bookAt?.(id);
    return bk ? { kind: 'tree', book: bk } : null;
}

/** A volume's page turn changes which file fronts the deck — the open-page label's TEXT
 *  changes with it, so the label field re-bakes (position keeps following live). */
function afterTurn(ctx, hit) {
    if (hit.kind === 'volume') ctx.contentTreeLabels?.rebuild?.();
}

// A page-arg keyword/index, optionally preceded by an id. One trailing arg → default book.
const splitTarget = (args) => (args.length >= 2 ? [args[0], args[1]] : [undefined, args[0]]);
const fmtHead = (s) => (s ? `sheet ${s.head + 1}/${s.count}${s.following ? ' · live' : ''}` : '');

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerBookCommands(router) {
    router.register('book.list', (args, ctx) => {
        const tree = ctx.contentTree;
        const shelf = ctx.agentBooks;

        // One path/id → the full record.
        if (args[0]) {
            const hit = resolveBook(ctx, args[0]);
            if (!hit) return { text: `ERR: no book at "${args[0]}"`, data: null };
            const bk = hit.book;
            const f = bk.fitInfo;
            const b = bk.getBounds();
            const h = bk.headState();
            const record = {
                ...(hit.kind === 'agent' ? { agent: hit.agentId } : { path: bk.userData.path }),
                form: f ? 'fitted' : 'natural',
                sheets: h.count,
                head: `${h.head + 1}/${h.count}${h.following ? ' (live)' : ''}`,
                ...(f ? { page: `${f.pageW}×${f.pageH}`, scale: r2(f.scale), content: `${r2(f.contentW)}×${r2(f.contentH)}` } : {}),
                world: `${r2((b.min.x + b.max.x) / 2)}, ${r2((b.min.y + b.max.y) / 2)}, ${r2((b.min.z + b.max.z) / 2)}`,
            };
            return {
                text: box('BOOK', kvLines(record), 56) + '\nOK: book.list',
                data: record,
            };
        }

        const lines = [];
        const treeBooks = tree ? tree.books() : [];
        for (const bk of treeBooks) {
            const f = bk.fitInfo;
            lines.push(`${f ? `page ×${r2(f.scale)}` : 'natural'}  ${bk.userData.path}`);
        }
        const agentRows = shelf ? shelf.agents() : [];
        for (const a of agentRows) {
            lines.push(`${a.count} sheet${a.count === 1 ? '' : 's'} [${a.state}]  agent:${a.id}`);
        }
        return {
            text: box('BOOKS', lines.length ? lines : ['(none)'], 56) + `\nOK: book.list (${treeBooks.length + agentRows.length})`,
            data: {
                count: treeBooks.length + agentRows.length,
                books: treeBooks.map((bk) => ({ path: bk.userData.path, fitted: bk.fitted })),
                agents: agentRows.map((a) => ({ id: a.id, sheets: a.count, state: a.state })),
            },
        };
    }, {
        description: 'List the durable books — the tree\'s file carriers and the agent shelf',
        usage: '[path|agentId]',
        returns: '{ count, books:[{path,fitted}], agents:[{id,sheets,state}] } or one book\'s record',
    });

    router.register('book.scroll', (args, ctx) => {
        const [id, delta] = splitTarget(args);
        const hit = resolveBook(ctx, id);
        if (!hit) return { text: id ? `ERR: no book '${id}'` : 'ERR: no book to scroll', data: null };
        const ok = hit.book.scroll(Number(delta) || 0);
        if (ok) afterTurn(ctx, hit);
        const s = ok ? hit.book.headState() : null;
        return ok
            ? { text: `OK: ${fmtHead(s)}`, data: { ...(hit.agentId ? { agentId: hit.agentId } : {}), ...s } }
            : { text: 'ERR: could not scroll', data: null };
    }, { description: 'Turn a book by ±N sheets (− older / + newer)', usage: '[id] <delta>' });

    router.register('book.page', (args, ctx) => {
        const [id, arg] = splitTarget(args);
        const hit = resolveBook(ctx, id);
        if (!hit) return { text: id ? `ERR: no book '${id}'` : 'ERR: no book to page', data: null };
        const bk = hit.book;
        const s0 = bk.headState();
        if (!s0.count) return { text: 'ERR: the book has no sheets', data: null };
        const a = String(arg ?? '').toLowerCase();
        // next/prev step ±1 in time; first/last jump to the ends; a bare number is a 1-based index.
        const ok = a === 'next' ? bk.scroll(+1)
                 : a === 'prev' ? bk.scroll(-1)
                 : a === 'first' ? bk.pageTo(0)
                 : a === 'last' ? bk.pageTo(s0.count - 1)
                 : bk.pageTo((Number(a) || 1) - 1);
        if (ok) afterTurn(ctx, hit);
        const s = bk.headState();
        return ok
            ? { text: `OK: ${fmtHead(s)}`, data: { ...(hit.agentId ? { agentId: hit.agentId } : {}), ...s } }
            : { text: 'ERR: could not page', data: null };
    }, { description: 'Turn a book\'s head — next|prev|first|last or a 1-based sheet index', usage: '[id] <next|prev|first|last|N>' });

    router.register('book.move', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return { text: 'ERR: agent books not wired', data: null };
        if (args.length < 4) return { text: 'ERR: usage: book.move <id> <x> <y> <z>', data: null };
        const [id, x, y, z] = args;
        const ok = books.moveGroup(id, Number(x) || 0, Number(y) || 0, Number(z) || 0);
        return ok
            ? { text: `OK: moved ${id}`, data: { id, x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 } }
            : { text: `ERR: no agent book '${id}'`, data: null };
    }, { description: 'Reposition (pin) an agent book — drag-release / CLI', usage: '<id> <x> <y> <z>' });

    router.register('book.config', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return { text: 'ERR: agent books not wired', data: null };
        if (args.length < 2) return { text: `book cfg: ${JSON.stringify(books.cfg)}`, data: books.cfg };
        const [key, val] = args;
        const n = Number(val);
        // booleans first ("false" is a truthy string and Number("false") is NaN),
        // then numbers, else the raw string.
        books.cfg[key] = (val === 'true' || val === 'false') ? (val === 'true')
                       : Number.isFinite(n) ? n : val;
        books.applyScales();   // re-scale live cards + re-fit pages + re-flow the shelf
        return { text: `OK: book.${key} = ${books.cfg[key]} (re-flowed)`, data: { [key]: books.cfg[key] } };
    }, { description: 'Get or set an agent-shelf constant — re-fits and re-flows live', usage: '[key value]' });

    router.register('book.limit', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return { text: 'ERR: agent books not wired', data: null };
        // book.limit                → report the default book's cap
        // book.limit <id>           → report that book's cap
        // book.limit [id] <n|all|default> → set: n>0 caps it, 'all' (or 0) keeps every
        //                             turn, 'default' follows the shelf knob again.
        const isCap = (a) => a === 'all' || a === 'default' || Number.isFinite(Number(a));
        const [id, arg] = args.length >= 2 ? [args[0], args[1]]
                        : isCap(args[0]) ? [undefined, args[0]]
                        : [args[0], undefined];
        const s = arg === undefined
            ? books.limitOf(id)
            : books.setLimit(id, arg === 'default' ? null : arg === 'all' ? 0 : Number(arg));
        if (!s) return { text: id ? `ERR: no agent book '${id}'` : 'ERR: no agent books', data: null };
        const keeps = s.cap ? `the last ${s.cap}` : 'every turn';
        const src = s.override == null ? ' (shelf default)' : '';
        const shed = s.evicted ? ` — shed ${s.evicted}` : '';
        return {
            text: `OK: ${s.agentId} keeps ${keeps}${src} · ${s.count} sheet${s.count === 1 ? '' : 's'} on hand${shed}`,
            data: s,
        };
    }, { description: "One agent book's kept-turns cap — n>0 caps, 'all' keeps everything, 'default' follows the shelf", usage: '[id] [n|all|default]' });
}
