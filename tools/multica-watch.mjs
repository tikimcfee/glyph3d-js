// multica-watch.mjs — watch a Multica board drive glyph3d, headlessly.
//
//   bun tools/multica-watch.mjs                          follow the board (Ctrl-C to stop)
//   bun tools/multica-watch.mjs --once                   one snapshot, then exit
//   bun tools/multica-watch.mjs --json                   one NDJSON record per verb
//   bun tools/multica-watch.mjs --board runtime          group the snapshot by CLI
//   bun tools/multica-watch.mjs --quiet                  snapshots only, no per-verb lines
//
// Env: MULTICA_URL, MULTICA_TOKEN, MULTICA_WORKSPACE, MULTICA_SLUG
//
// This runs the REAL MulticaBridge with a recording `execute` in place of the router.
// Every line you see is a command the browser would have run — so if the board looks
// right here, the only thing left between this and the field is rendering. That makes it
// the fast loop: no browser, no WebGPU, no reload cycle.
//
// It is also the answer to "is it working" during a live agent run: the verbs stream past
// as the agents pick work up, and the snapshot shows the board's shape at any moment.

import { MulticaClient, MulticaSocket, MulticaBridge } from '../packages/glyph3d-multica/src/index.js';
import boardLayout from '../packages/glyph3d-core/src/collections/layouts/boardLayout.js';

const has = (f) => process.argv.includes(`--${f}`);
const arg = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i > -1 ? process.argv[i + 1] : d; };

const url = arg('url', process.env.MULTICA_URL || 'http://localhost:8099');
const token = arg('token', process.env.MULTICA_TOKEN);
const workspaceId = arg('workspace', process.env.MULTICA_WORKSPACE);
const slug = arg('slug', process.env.MULTICA_SLUG || null);
const boardAxis = arg('board', 'state');
const asJson = has('json');
const quiet = has('quiet');
const once = has('once');

if (!token || !workspaceId) {
    console.error('multica-watch: need MULTICA_URL, MULTICA_TOKEN and MULTICA_WORKSPACE');
    console.error('  (tools/multica-seed.mjs prints all three)');
    process.exit(2);
}

const AXES = { state: 'state', provider: 'meta.provider', runtime: 'meta.runtimeName', agent: 'meta.title' };
const groupBy = AXES[boardAxis] || boardAxis;

// -- board model --------------------------------------------------------------
// The watcher keeps the same shape a book carries on the field — `userData` with state
// and meta — so the SAME layout scheme the renderer uses can be run over it. The column
// counts printed below are literally what the field would place.
/** @type {Map<string, {name: string, state: string, meta: Object, sheets: number, lastLine: string}>} */
const books = new Map();

const ensureBook = (id) => {
    if (!books.has(id)) books.set(id, { name: id, state: 'idle', meta: {}, sheets: 0, lastLine: '' });
    return books.get(id);
};

/** Apply a dispatched verb to the local board model. Mirrors what AgentBooks would do. */
function applyVerb([verb, ...args]) {
    const id = args[0];
    switch (verb) {
        case 'agent.spawn': ensureBook(id).meta.provider = args[1]; break;
        case 'agent.meta': {
            const book = ensureBook(id);
            try { Object.assign(book.meta, JSON.parse(args[1])); } catch { /* keep what we had */ }
            book.name = book.meta.title || id;
            break;
        }
        case 'agent.state': ensureBook(id).state = args[1]; break;
        case 'agent.activity': {
            const book = ensureBook(id);
            book.sheets += 1;
            book.lastLine = `${args[2]} ${args[3] || ''} ${args[4] || ''}`.trim();
            break;
        }
        case 'agent.message': {
            const book = ensureBook(id);
            book.sheets += 1;
            book.lastLine = `say: ${String(args[3] || '').replace(/\s+/g, ' ').slice(0, 60)}`;
            break;
        }
        default: break;
    }
}

/** Render the board through the real layout scheme, so columns match the field's. */
function snapshot() {
    const children = [...books.entries()].map(([id, b]) => ({
        name: id,
        visible: true,
        userData: { name: b.name, state: b.state, meta: b.meta },
        position: { set() {} },
        layoutBounds: () => ({ isEmpty: () => false, getSize: (v) => { v.x = 100; v.y = 200; v.z = 0; return v; } }),
    }));
    const { columns } = boardLayout({ children }, { groupBy, columns: boardAxis === 'state' ? undefined : 'auto' });
    return columns;
}

const ICON = { active: '▶', stalled: '‖', idle: '·', done: '✓' };

function printSnapshot() {
    const columns = snapshot();
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`\n── board by ${boardAxis} · ${books.size} book(s) · ${stamp} ${'─'.repeat(28)}`);
    if (!columns.length) { console.log('   (empty)'); return; }
    for (const col of columns) {
        console.log(`  ${col.key}  (${col.count})`);
        for (const [id, b] of books) {
            const key = boardAxis === 'state' ? b.state
                : boardAxis === 'provider' ? (b.meta.provider ?? 'other')
                : boardAxis === 'runtime' ? (b.meta.runtimeName ?? 'other')
                : (b.meta.title ?? id);
            if (String(key) !== String(col.key)) continue;
            const tail = b.lastLine ? `  ${b.lastLine}` : '';
            console.log(`    ${ICON[b.state] || '?'} ${b.name.padEnd(16)} ${String(b.sheets).padStart(3)} sheets${tail}`);
        }
    }
}

// -- wire it up ---------------------------------------------------------------
const client = new MulticaClient({ baseUrl: url, token, workspaceId });
const socket = new MulticaSocket({ baseUrl: url, token, workspaceSlug: slug, warn: (m) => console.error(m) });

let verbCount = 0;
const bridge = new MulticaBridge({
    client,
    socket,
    // Stand in for the router. Everything the field would do passes through here.
    execute: async (input) => {
        verbCount += 1;
        applyVerb(input);
        if (asJson) {
            console.log(JSON.stringify({ t: new Date().toISOString(), verb: input[0], args: input.slice(1) }));
        } else if (!quiet) {
            const [verb, ...rest] = input;
            const flat = rest.map(a => String(a).replace(/\s+/g, ' ')).join(' ');
            console.log(`  ${verb.padEnd(15)} ${flat.slice(0, 110)}`);
        }
        return { text: 'ok', data: null };
    },
    warn: (m) => console.error(m),
});

socket.connect();
// Give the handshake a beat — hydration reads REST, but a frame landing before the
// socket authenticates would be missed, and the whole point is to watch the live stream.
await new Promise(r => setTimeout(r, 1200));
if (!socket.authenticated) console.error('! socket not authenticated yet — continuing, it will retry');

const counts = await bridge.start();
if (!asJson) console.log(`\nconnected: ${counts.agents} agent book(s), ${counts.issues} issue line(s), ${verbCount} verbs replayed`);
printSnapshot();

if (once) { socket.close(); process.exit(0); }

if (!asJson) {
    console.log('\nfollowing — Ctrl-C to stop\n');
    // Re-print on a settle, not per frame: a busy board would scroll the snapshot away
    // faster than it could be read. Same instinct as the log storm brake.
    let timer = null;
    const origExecute = bridge.execute;
    bridge.execute = async (input) => {
        const out = await origExecute(input);
        clearTimeout(timer);
        timer = setTimeout(printSnapshot, 1500);
        return out;
    };
}

process.on('SIGINT', () => {
    console.log(`\n${verbCount} verbs seen. unmapped: ${JSON.stringify(Object.fromEntries(bridge.unhandled))}`);
    socket.close();
    process.exit(0);
});
