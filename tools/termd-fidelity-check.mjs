/**
 * termd-fidelity-check.mjs — the vt conformance snippets through g3d-termd, compared to xterm.
 *
 *   bun tools/termd-fidelity-check.mjs [--termd PATH] [--conf DIR] [-v]
 *
 * Each snippet (tools/fixtures/vt-conf/*.vt: SGR, wide and combining text, emoji, margins, the
 * alternate screen, origin mode, tabs, DEC graphics, titles, …) is written by a program in its own
 * 40×10 termd terminal, and read back two ways:
 *   - RAW: the OUTPUT bytes a subscriber gets must be the snippet's bytes, exactly (termd passes
 *     the program's bytes on unfiltered — the browser's xterm parses the same stream it would);
 *   - REPAINT: a late subscriber's repaint, written into a fresh xterm, against xterm fed the
 *     snippet directly: every cell (character, width, colours, attributes), the cursor, the
 *     screen and the title. libghostty (termd's emulator) and xterm disagree on a few things by
 *     design (emoji width, invalid UTF-8, a wide char wrapping at the edge, the pending-wrap
 *     cursor, SGR black), measured in the VT spike; a snippet that differs ONLY where xterm and
 *     libghostty already differ is KNOWN, any other difference is a FAIL.
 * It runs its own daemon on a scratch socket (tools/lib/termd.mjs) and stops it at the end.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal as XTerm } from '@xterm/headless';
import { privateTermd, stopTermd } from './lib/termd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BIN = arg('--termd', path.join(ROOT, 'g3d-termd'));
const CONF = arg('--conf', path.join(ROOT, 'tools/fixtures/vt-conf'));
const VERBOSE = process.argv.includes('-v');
const COLS = 40, ROWS = 10, NS = 'fid';

/**
 * Where xterm and libghostty already disagree on the snippet itself (fed directly, no termd):
 * the VT spike's measured fidelity table. A repaint can't be closer to xterm than its source.
 */
const ENGINE_DIFFS = {
    'sgr-16': 'SGR 30/40 black: the spike harness could not configure pure black',
    'sgr-256': '256-colour index 0, as sgr-16',
    'sgr-truecolor': 'pending-wrap cursor: xterm reports x = cols, libghostty cols − 1 + a pending flag',
    'wide-cjk': 'a wide char wrapping at the last column leaves a spacer cell',
    'emoji': 'emoji width: xterm (Unicode 6) 1, libghostty 2',
    'autowrap': 'pending-wrap cursor, as sgr-truecolor',
    'invalid-utf8': 'libghostty draws U+FFFD per bad byte, xterm drops them',
};

// ── a minimal termd client (PROTOCOL.md) ─────────────────────────────────────────────────────
function dial(sock) {
    return new Promise((resolve, reject) => {
        const s = net.connect(sock);
        let buf = Buffer.alloc(0);
        const waiters = [];
        const frames = [];
        const push = (f) => { const w = waiters.shift(); if (w) w(f); else frames.push(f); };
        s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 4) {
                const len = buf.readUInt32LE(0);
                if (buf.length < 4 + len) break;
                push({ type: buf[4], stream: buf.readUInt32LE(8), payload: buf.subarray(12, 4 + len) });
                buf = buf.subarray(4 + len);
            }
        });
        s.on('error', reject);
        const send = (type, stream, payload) => {
            const p = Buffer.from(payload);
            const h = Buffer.alloc(12);
            h.writeUInt32LE(8 + p.length, 0); h[4] = type; h.writeUInt32LE(stream, 8);
            s.write(Buffer.concat([h, p]));
        };
        const next = (ms = 5000) => new Promise((res, rej) => {
            if (frames.length) return res(frames.shift());
            const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('termd: no frame in time')); }, ms);
            const w = (f) => { clearTimeout(t); res(f); };
            waiters.push(w);
        });
        let req = 0;
        const request = async (op, fields = {}) => {
            const id = ++req;
            send(0x02, 0, JSON.stringify({ req: id, op, ...fields }));
            const held = [];
            for (;;) {
                const f = await next();
                if (f.type === 0x82) {
                    const r = JSON.parse(f.payload);
                    if (r.req === id) { frames.unshift(...held); if (!r.ok) throw new Error(`${op}: ${r.error.code}: ${r.error.message}`); return r; }
                }
                held.push(f);
            }
        };
        s.on('connect', async () => {
            send(0x01, 0, JSON.stringify({ proto: [1, 0], client: 'termd-fidelity-check' }));
            const w = await next();
            if (w.type !== 0x81) return reject(new Error(`termd: no WELCOME (${String(w.payload)})`));
            resolve({ request, next, send, close: () => s.end() });
        });
    });
}

// ── xterm, dumped cell by cell (the spike's comparison) ─────────────────────────────────────────
const BASE16 = [[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
    [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
const pal256 = (i) => {
    if (i < 16) return BASE16[i];
    if (i >= 232) { const v = 8 + (i - 232) * 10; return [v, v, v]; }
    const n = i - 16, l = [0, 95, 135, 175, 215, 255];
    return [l[Math.floor(n / 36)], l[Math.floor(n / 6) % 6], l[n % 6]];
};
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
async function xterm(bytes) {
    const t = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
    let title = '';
    t.onTitleChange((s) => { title = s; });
    await new Promise((r) => t.write(bytes, r));
    const col = (isDef, isRGB, isPal, v) => isDef ? 'd' : isRGB ? hex([(v >> 16) & 255, (v >> 8) & 255, v & 255]) : isPal ? hex(pal256(v)) : 'd';
    const buf = t.buffer.active;
    const cells = [];
    let cell;
    for (let y = 0; y < ROWS; y++) {
        const line = buf.getLine(buf.baseY + y);
        for (let x = 0; x < COLS; x++) {
            cell = line.getCell(x, cell);
            const w = cell.getWidth();
            const fl = (cell.isBold() ? 'B' : '') + (cell.isItalic() ? 'I' : '') + (cell.isUnderline() ? 'U' : '') +
                (cell.isInverse() ? 'R' : '') + (cell.isDim() ? 'F' : '') + (cell.isStrikethrough() ? 'S' : '');
            cells.push(`${w === 0 ? '' : (cell.getChars() || ' ')}|${w}|${col(cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor())}|${col(cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())}|${fl}`);
        }
    }
    const out = { cells, cursor: `${buf.cursorX},${buf.cursorY}`, alt: buf.type === 'alternate', hidden: t._core?.coreService?.isCursorHidden ?? null, title };
    t.dispose();
    return out;
}
function diff(a, b) {
    const d = [];
    let cells = 0;
    for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) { if (cells++ < 3) d.push(`(${i % COLS},${Math.floor(i / COLS)}) xterm ${JSON.stringify(a.cells[i])} termd ${JSON.stringify(b.cells[i])}`); }
    if (cells > 3) d.push(`… ${cells} cells`);
    if (a.cursor !== b.cursor) d.push(`cursor ${b.cursor}≠${a.cursor}`);
    if (a.alt !== b.alt) d.push(`alt ${b.alt}≠${a.alt}`);
    if (a.hidden !== b.hidden) d.push(`cursor hidden ${b.hidden}≠${a.hidden}`);
    if (a.title !== b.title) d.push(`title ${JSON.stringify(b.title)}≠${JSON.stringify(a.title)}`);
    return d;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
const termd = privateTermd(`fid${process.pid}`);
const sock = path.join(termd.dir, `termd-${NS}.sock`);
const daemon = spawn(BIN, ['--socket', sock, '--idle-exit', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
let daemonLog = '';
daemon.stderr.on('data', (b) => { daemonLog += b; });
process.on('exit', () => { try { daemon.kill('SIGKILL'); } catch { /* gone */ } });
let c = null;
for (let i = 0; i < 100 && !c; i++) {
    c = await dial(sock).catch(() => null);
    if (!c) await new Promise((r) => setTimeout(r, 30));
}
if (!c) { console.log(`FAIL  no daemon at ${sock}\n${daemonLog}`); process.exit(1); }

let fail = 0, known = 0, same = 0;
const files = readdirSync(CONF).filter((f) => f.endsWith('.vt')).sort();
for (const file of files) {
    const name = file.replace(/\.vt$/, '');
    const bytes = readFileSync(path.join(CONF, file));
    // The program waits for a key so the subscriber sees every byte; raw so the tty adds nothing.
    const script = `stty raw -echo; head -c1 >/dev/null; cat '${path.join(CONF, file)}'; exec sleep 600`;
    await c.request('create', { id: name, argv: ['sh', '-c', script], cols: COLS, rows: ROWS });
    const sub = await c.request('subscribe', { id: name, mode: 'raw', role: 'attach' });
    await c.next(); // the (empty) repaint
    await new Promise((r) => setTimeout(r, 100));
    c.send(0x03, sub.handle, 'x');
    let raw = Buffer.alloc(0);
    while (raw.length < bytes.length) {
        const f = await c.next();
        if (f.type === 0x83 && f.stream === sub.handle) raw = Buffer.concat([raw, f.payload.subarray(8)]);
    }
    await new Promise((r) => setTimeout(r, 50));
    const rawSame = raw.equals(bytes);
    // A late subscriber, on its own connection: what it sees is the repaint alone.
    const late = await dial(sock);
    await late.request('subscribe', { id: name, mode: 'raw', role: 'watch' });
    let rp;
    do rp = await late.next(); while (rp.type !== 0x85);
    late.close();
    const ref = await xterm(bytes);
    const got = await xterm(rp.payload.subarray(16));
    const d = diff(ref, got);
    await c.request('kill', { id: name });
    const why = ENGINE_DIFFS[name];
    let verdict;
    if (!rawSame) { verdict = 'FAIL'; fail++; }
    else if (!d.length) { verdict = 'PASS'; same++; }
    else if (why) { verdict = 'KNOWN'; known++; }
    else { verdict = 'FAIL'; fail++; }
    console.log(`${verdict.padEnd(5)} ${name.padEnd(20)} raw ${rawSame ? 'byte-exact' : `DIFFERS (${raw.length} of ${bytes.length} B)`} · repaint ${d.length ? `differs: ${d.join('; ')}` : 'equal to xterm'}${verdict === 'KNOWN' ? ` — ${why}` : ''}`);
    if (VERBOSE && d.length) console.log(`      repaint bytes: ${JSON.stringify(String(rp.payload.subarray(16)))}`);
}
c.close();
daemon.kill('SIGTERM');
await stopTermd(termd.dir, NS);
console.log(`\n${files.length} snippets: ${same} identical to xterm, ${known} differ only where libghostty and xterm already differ, ${fail} failed`);
process.exit(fail ? 1 : 0);
