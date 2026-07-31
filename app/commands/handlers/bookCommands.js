/**
 * Book commands — the durable Book objects (every file's spatial carrier, wrapped at
 * insert by the ContentTree and addressable for the file's whole life).
 *
 * book.list          → every book: path · current form (fitted page ×scale, or natural)
 * book.list <path>   → one book's full record (form, page, content size, world position)
 *
 * Books are the units the library scheme stacks; verbs that manipulate form live here
 * as the object grows (labels, shelves, page splay ride on this address space).
 */

import { box, kvLines } from '../formatResponse.js';

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerBookCommands(router) {
    router.register('book.list', (args, ctx) => {
        const tree = ctx.contentTree;
        if (!tree) return { text: 'ERR: no content tree in this context', data: null };

        // One path → the full record.
        if (args[0]) {
            const book = tree.bookAt(args[0]);
            if (!book) return { text: `ERR: no book at "${args[0]}"`, data: null };
            const f = book.fitInfo;
            const b = book.getBounds();
            const record = {
                path: book.userData.path,
                form: f ? 'fitted' : 'natural',
                ...(f ? { page: `${f.pageW}×${f.pageH}`, scale: r2(f.scale), content: `${r2(f.contentW)}×${r2(f.contentH)}` } : {}),
                world: `${r2((b.min.x + b.max.x) / 2)}, ${r2((b.min.y + b.max.y) / 2)}, ${r2((b.min.z + b.max.z) / 2)}`,
            };
            return {
                text: box('BOOK', kvLines(record), 56) + '\nOK: book.list',
                data: record,
            };
        }

        const books = tree.books();
        const lines = books.map((bk) => {
            const f = bk.fitInfo;
            return `${f ? `page ×${r2(f.scale)}` : 'natural'}  ${bk.userData.path}`;
        });
        return {
            text: box('BOOKS', lines.length ? lines : ['(none)'], 56) + `\nOK: book.list (${books.length})`,
            data: { count: books.length, books: books.map((bk) => ({ path: bk.userData.path, fitted: bk.fitted })) },
        };
    }, {
        description: 'List the durable books (every file\'s spatial carrier) and their current form',
        usage: '[path]',
        returns: '{ count, books:[{path,fitted}] } or one book\'s full record',
    });
}
