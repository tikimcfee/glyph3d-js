#!/usr/bin/env bun
/**
 * planes-e2e.mjs — one command that runs all 9 plane feature LIVE checks in sequence against a
 * relay and prints one verdict table:
 *
 *   1. plane-live-check       (--desk / --back / --reload)
 *   2. carrel.check           (every desk member held live in its seat)
 *   3. frame-capture-check    (--live desktop stream + non-blank frame texture)
 *   4. desk-reload-check      (seated → layout.scheme relayout → save+reload → leave+re-enter)
 *   5. layer fan identity     (on the layers themselves — the scene alone, cropped to the member and the band
 *                              where its history pages peek: visible, plane.fan off twice byte-identical,
 *                              plane.fan on moves the band but not the member; with the layers hidden it moves
 *                              nothing there — the wider lens on the perspective endpoint; on the
 *                              orthographic the pages slide whole px and the member's whole box is
 *                              byte-identical)
 *   6. strip band             (column 0 lands to the right of the left-edge strip cards)
 *   7. team.channel rows      (show → rows -N holds view → rows +N resumes live tail)
 *   8. point.show → list      (deictic point.show does not steal camera/attention; listed in point.list)
 *   9. file-follow            (scratch file under user cache dir: open → disk write → landed in grid)
 *
 * Default target: starts a PRIVATE relay (scratch git root seeded with 4 files + 2 commits,
 * scratch --tmux-socket, gomux.autoScreens seeded off, --no-gomuxai unless --hub) and a private
 * headless GPU display so it never disturbs the shared display.
 * Pass `--port 8080` to target the shared relay/display explicitly.
 *
 * `--ortho` seeds plane.ortho on in the private display: every check runs on the orthographic plane
 * endpoint (PlaneCamera, DESIGN §4.6). Not with --port (the shared display's settings are the person's).
 *
 * Usage:
 *   bun tools/planes-e2e.mjs [--port 8080] [--hub] [--ortho] [--out-dir <dir>] [--desk <a] [--back <b>] [--url <viteUrl>]
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dialRelay } from './lib/relay.mjs';
import { decodePng, cropImage, writePng } from './lib/pixel-metrics.mjs';
import { launchGpuBrowser } from './itest/driver.mjs';

function diffImages(a, b, tol = 0) {
    const n = Math.min(a.data.length, b.data.length);
    let maxDelta = 0;
    let diffPixels = 0;
    for (let i = 0; i < n; i += 4) {
        const d = Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
        );
        if (d > maxDelta) maxDelta = d;
        if (d > tol) diffPixels++;
    }
    return { maxDelta, diffPixels };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const explicitPort = opt('port');
const sharedMode = explicitPort != null;
const hubFlag = flag('hub');
const orthoFlag = flag('ortho');
if (orthoFlag && sharedMode) { console.error('planes-e2e: --ortho seeds the private display only (not with --port)'); process.exit(2); }
const outDir = opt('out-dir');
const viteUrl = opt('url', process.env.GLYPH3D_TEST_URL || 'http://localhost:5173/');

if (outDir) fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const p = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(p));
        });
        srv.on('error', reject);
    });
}

async function waitRelayListening(port, proc, timeoutMs = 15000) {
    const t0 = Date.now();
    let stderr = '';
    proc?.stdout?.on('data', () => {});
    proc?.stderr?.on('data', (d) => { stderr += String(d); });
    while (Date.now() - t0 < timeoutMs) {
        if (proc && proc.exitCode != null) {
            throw new Error(`private relay exited early (${proc.exitCode}): ${stderr.trim()}`);
        }
        const ok = await new Promise((resolve) => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', () => { sock.destroy(); resolve(false); });
        });
        if (ok) return true;
        await sleep(50);
    }
    throw new Error(`private relay on :${port} failed to listen within ${timeoutMs}ms: ${stderr.trim()}`);
}

function makeScratchCode(name, rev = 1) {
    const lines = [
        `// ${name}.js — seeded module (rev ${rev})`,
        `export const MODULE_NAME = '${name}';`,
        `export const MODULE_REV = ${rev};`,
        '',
    ];
    for (let i = 1; i <= 36; i++) {
        lines.push(`export function ${name}Step${String(i).padStart(2, '0')}(x = ${i}) { return x * ${rev} + ${i * 3}; }`);
    }
    return lines.join('\n') + '\n';
}

function seedScratchRepo(dir) {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
        fs.writeFileSync(path.join(src, `${name}.js`), makeScratchCode(name, 1));
    }
    const git = (args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
    git(['init', '-q']);
    git(['config', 'user.email', 'e2e@local']);
    git(['config', 'user.name', 'e2e']);
    git(['add', '.']);
    git(['commit', '-qm', 'seed rev 1']);
    // alpha gets four past revisions, so step 5's history pages rise past its title row (ranks 3 and 4
    // peek over it: a page rises layers.riseRows per rank, and the title stands about two rows high).
    for (let rev = 2; rev <= 5; rev++) {
        fs.writeFileSync(path.join(src, 'alpha.js'), makeScratchCode('alpha', rev));
        git(['commit', '-am', `alpha rev ${rev}`]);
    }
}

async function assertNotHeldByOtherDesk(reqFn, id, targetDesk) {
    const chk = (await reqFn('carrel.check')).data?.members ?? [];
    const hit = chk.find((m) => m.id === id && m.desk && m.desk !== targetDesk);
    if (hit) {
        throw new Error(`refusing to carrel.add '${id}' to '${targetDesk}': already held by desk '${hit.desk}'`);
    }
    const list = (await reqFn('carrel.list')).data?.carrels ?? [];
    for (const c of list) {
        if (c.name === targetDesk) continue;
        if ((c.members ?? []).some((m) => m.id === id)) {
            throw new Error(`refusing to carrel.add '${id}' to '${targetDesk}': already held by desk '${c.name}'`);
        }
    }
}

async function safeCarrelAdd(reqFn, id, targetDesk) {
    await assertNotHeldByOtherDesk(reqFn, id, targetDesk);
    const res = await reqFn(`carrel.add ${id} ${targetDesk}`);
    if (!/^OK:/.test(res.text ?? '')) {
        throw new Error(`carrel.add ${id} ${targetDesk} failed: ${res.text}`);
    }
    return res;
}

function runSubscript(scriptRel, args, timeoutMs = 180000) {
    return new Promise((resolve) => {
        const child = spawn('bun', [path.join(ROOT, scriptRel), ...args], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, status: code, out: out.trim() });
        });
    });
}

let port = sharedMode ? Number(explicitPort) : await pickFreePort();
let scratchRoot = null;
let tmuxSocket = null;
let relayProc = null;
let browser = null;
let page = null;
let relay = null;

const req = async (line, ms = 30000) => relay.request(line, ms);
const reqAs = (caller, args, timeoutMs = 12000) => new Promise((resolve) => {
    const child = spawn(path.join(ROOT, 'glyph3d-cli'), ['--port', String(port), '--as', caller, ...args], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, status: code, out: out.trim() });
    });
});

async function reconnectRelay() {
    try { relay?.close(); } catch { /* ignore */ }
    relay = await dialRelay(port);
}

async function untilPlane(pred, timeoutMs = 30000, everyMs = 40) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
        try {
            const s = (await req('plane.state', 2500)).data;
            if (pred(s)) return performance.now() - t0;
        } catch { /* display may be reloading */ }
        await sleep(everyMs);
    }
    return null;
}

async function waitRestoreComplete(timeoutMs = 60000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
        try {
            const r = await req('session.status', 2500);
            if (/^restore: complete/m.test(r.text ?? '')) return true;
        } catch { /* reloading */ }
        await sleep(150);
    }
    return false;
}

const verdicts = [];
function recordVerdict(name, ok, ms, detail) {
    verdicts.push({ name, ok: !!ok, ms: Math.round(ms), detail: String(detail || '') });
    const icon = ok ? '✓' : '✗';
    console.log(`${icon} ${name.padEnd(24)} ${String(Math.round(ms) + 'ms').padStart(8)}  ${detail}`);
}

let deskA = opt('desk');
let deskB = opt('back');
let fileA = null;
let layerFile = null;
let createdTempDesks = false;
let sharedScratchDir = null;
const openedScratchFiles = [];
let initialCamera = null;
let initialPlane = null;
let initialAttention = null;
let initialCheck = [];

try {
    // ── Boot private relay + display when --port is not passed ─────────────────
    if (!sharedMode) {
        scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphd-planes-e2e-'));
        seedScratchRepo(scratchRoot);
        tmuxSocket = `glyphd-e2e-${process.pid}`;
        const serveArgs = [
            'serve',
            '--relay-only',
            '--port', String(port),
            '--listen', '127.0.0.1',
            '--tmux-socket', tmuxSocket,
        ];
        if (!hubFlag) serveArgs.push('--no-gomuxai');
        serveArgs.push(scratchRoot);

        relayProc = spawn(path.join(ROOT, 'glyph3d-cli'), serveArgs, {
            cwd: scratchRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitRelayListening(port, relayProc, 15000);

        browser = await launchGpuBrowser();
        const context = await browser.newContext({
            viewport: { width: 1600, height: 1000 },
            deviceScaleFactor: 1,
        });
        await context.addInitScript((ortho) => {
            try { localStorage.setItem('g3d.gomux.autoScreens', 'false'); } catch { /* ignore */ }
            if (ortho) try { localStorage.setItem('g3d.plane.ortho', 'true'); } catch { /* ignore */ }
        }, orthoFlag);
        page = await context.newPage();
        const targetUrl = `${viteUrl}${viteUrl.includes('?') ? '&' : '?'}relay=${port}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(
            () => Boolean(window.__glyphClient?.ctx?.atlas && window.__glyphClient?.ctx?.wsbridge?.connected),
            { timeout: 30000 },
        );
        await sleep(600);
    }

    await reconnectRelay();

    if (sharedMode) {
        await waitRestoreComplete(30000);
        initialPlane = (await req('plane.state')).data;
        if (initialPlane) {
            await req('carrel.leave');
            await untilPlane((s) => !s, 10000);
            await sleep(500);
        }
        initialCamera = (await req('camera.info')).data;
        initialAttention = (await req('attention.info')).data;
        initialCheck = (await req('carrel.check')).data?.members ?? [];
    } else {
        const srcDir = path.join(scratchRoot, 'src');
        await req(`file.openDir ${srcDir}`);
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
            await req(`file.open ${path.join(srcDir, `${name}.js`)}`);
        }
        deskA = 'e2e-desk-a';
        deskB = 'e2e-desk-b';
        fileA = path.join(srcDir, 'alpha.js');
        layerFile = fileA;
        await req(`carrel.create ${deskA}`);
        await safeCarrelAdd(req, path.join(srcDir, 'alpha.js'), deskA);
        await safeCarrelAdd(req, path.join(srcDir, 'beta.js'), deskA);
        await req(`carrel.create ${deskB}`);
        await safeCarrelAdd(req, path.join(srcDir, 'gamma.js'), deskB);
        await safeCarrelAdd(req, path.join(srcDir, 'delta.js'), deskB);
        await sleep(800);
        await req('session.save');
    }

    // On shared relay, if --desk/--back were not explicitly provided, stand up two temporary
    // plane desks with our OWN scratch files under the user cache dir (never touching user files/desks).
    if (sharedMode && (!deskA || !deskB)) {
        const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
        fs.mkdirSync(cacheBase, { recursive: true });
        sharedScratchDir = fs.mkdtempSync(path.join(cacheBase, 'glyph3d-planes-e2e-'));
        // Register empty sharedScratchDir as a reach root on the relay without adding to fieldSources.
        await req(`file.openDir ${sharedScratchDir}`);
        for (const name of ['e2e-alpha', 'e2e-beta', 'e2e-gamma', 'e2e-delta']) {
            const f = path.join(sharedScratchDir, `${name}.js`);
            fs.writeFileSync(f, makeScratchCode(name, 1));
            await req(`file.open ${f}`);
            openedScratchFiles.push(f);
        }
        fileA = openedScratchFiles[0];
        deskA = deskA || 'e2e-desk-a';
        deskB = deskB || 'e2e-desk-b';
        createdTempDesks = true;
        await req(`carrel.create ${deskA}`);
        await safeCarrelAdd(req, openedScratchFiles[0], deskA);
        await safeCarrelAdd(req, openedScratchFiles[1], deskA);
        await req(`carrel.create ${deskB}`);
        await safeCarrelAdd(req, openedScratchFiles[2], deskB);
        await safeCarrelAdd(req, openedScratchFiles[3], deskB);
        await sleep(800);
        await req('session.save');
    } else if (sharedMode && !fileA) {
        const chk = (await req(`carrel.check ${deskA}`)).data?.members ?? [];
        const fileMember = chk.find((m) => m.id?.startsWith('/'));
        if (fileMember) fileA = fileMember.id;
    }

    // ── 1. plane-live-check (--desk / --back / --reload) ───────────────────────
    {
        const t0 = performance.now();
        const args = ['--desk', deskA, '--back', deskB, '--reload', '--gate', '--port', String(port)];
        if (outDir) args.push('--out-dir', outDir);
        const r = await runSubscript('tools/plane-live-check.mjs', args);
        await reconnectRelay();
        await waitRestoreComplete(60000);
        const summaryLine = r.out.split('\n').filter(Boolean).pop() || '';
        if (!r.ok) console.log(r.out.split('\n').filter((l) => /✗|FAIL|Error/.test(l)).map((l) => `   ${l}`).join('\n'));
        recordVerdict('1. plane-live-check', r.ok, performance.now() - t0, summaryLine);
    }

    // ── 2. carrel.check on every desk ──────────────────────────────────────────
    {
        const t0 = performance.now();
        let chk = null;
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            chk = await req('carrel.check');
            const members = chk.data?.members ?? [];
            const anyMoving = members.some((m) => m.moving);
            if (/^OK:/m.test(chk.text ?? '') && members.length > 0 && members.every((m) => m.ok) && !anyMoving) break;
            await sleep(250);
        }
        const members = chk?.data?.members ?? [];
        const desks = new Set(members.map((m) => m.desk));
        const okCount = members.filter((m) => m.ok).length;
        const ok = /^OK:/m.test(chk?.text ?? '') && members.length > 0 && okCount === members.length;
        recordVerdict(
            '2. carrel.check (all)',
            ok,
            performance.now() - t0,
            `${desks.size} desk(s), ${okCount}/${members.length} member(s) held live in seat`,
        );
    }

    // ── 3. frame-capture-check --live ──────────────────────────────────────────
    {
        const t0 = performance.now();
        const r = await runSubscript('tools/frame-capture-check.mjs', ['--live', '--port', String(port)]);
        await reconnectRelay();
        await waitRestoreComplete(60000);
        if (outDir) {
            for (const f of ['frame-capture-live.png', 'frame-capture-live-crop.png']) {
                const src = path.join('/tmp', f);
                if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
            }
        }
        const texLine = r.out.split('\n').find((l) => l.includes('PASS: frame-capture-check'))?.trim()
            || r.out.split('\n').filter(Boolean).pop() || '';
        recordVerdict('3. frame-capture-check', r.ok, performance.now() - t0, texLine);
    }

    // ── 4. desk-reload-check ───────────────────────────────────────────────────
    {
        const t0 = performance.now();
        const args = ['--live', '--port', String(port), '--desk', deskA];
        if (outDir) args.push('--out-dir', outDir);
        const r = await runSubscript('tools/desk-reload-check.mjs', args);
        await reconnectRelay();
        await waitRestoreComplete(60000);
        const stepsOk = (r.out.match(/^✓ /gm) || []).length;
        const summary = r.out.split('\n').filter(Boolean).pop() || '';
        recordVerdict('4. desk-reload-check', r.ok, performance.now() - t0, `${stepsOk}/4 steps (${summary})`);
    }

    // ── 5. layer fan identity — measured on the LAYERS: the scene alone (screenshot --passes main: no
    //    overlay, no minimap — they move on their own timing), cropped by layer.where's screen boxes.
    //    The BAND is the strip above the member where its history pages peek (ranks rise
    //    layers.riseRows each, past the member's title); nothing but the pages draws there.
    //      visible   the band with the layers vs without (layer.hide) differs — the pages show
    //      identity  fan off, on, off: the member + layer crop byte-identical (maxDelta 0)
    //      moves     fan on moves the band (perspective: the wider lens' parallax; orthographic: the
    //                pages' own whole-px slide)
    //      member    the member's own text (its glyphs' box) stays put with the fan on: resampling
    //                noise only (≤ MEMBER_NOISE), never a move; on the orthographic endpoint the
    //                member's WHOLE box — text, backdrop, focus border — is byte-identical (only the
    //                pages slide; on the perspective one the lens' parallax rightly moves its chrome)
    //      control   the same fan with the layers hidden moves nothing in the band — the member's own
    //                resampling (what a whole-frame diff counts) can't pass the measure
    {
        const t0 = performance.now();
        const MEMBER_NOISE = 16;   // max channel delta: f32 resampling of the member's text reads ≤ 3 here; a 1 px move reads ~100+
        if ((await req('plane.state')).data) {
            await req('plane.leave');
            await untilPlane((s) => !s, 10000);
        }
        let fanTarget = layerFile;
        let createdFanTerm = false;
        if (!fanTarget) {
            fanTarget = 'e2e-fan-term';
            createdFanTerm = true;
            await req(`terminal.create ${fanTarget} 60 12`);
            await req(`terminal.move ${fanTarget} -50000 50000 0`);
            await reqAs('', ['terminal.write', fanTarget, 'live terminal front row 1\r\nlive terminal front row 2\r\n']);
            const seedLines = Array.from({ length: 60 }, (_, i) => `scrollback line ${i + 1}: layer fan probe`).join('\n');
            await reqAs('', ['terminal.depth.seed', fanTarget, seedLines]);
        }
        try {
            await req(`plane.enter ${fanTarget}`);
            await untilPlane((s) => s && !s.tweening, 15000);
            const showRes = await req(`layer.show ${fanTarget} 4`, 15000);
            const layers = showRes.data?.layers ?? [];
            const hasHistory = /^OK:/.test(showRes.text ?? '') && layers.length >= 2;

            // Folded: the perspective endpoint at its own lens (fov 1), the orthographic one's pages home.
            const folded = (s) => s && !s.tweening && (s.ortho ? s.fan === null && s.fanPx === 0 : s.fovDeg === 1);
            const fanned = (s) => s && !s.tweening && (s.ortho ? s.fan?.px > 0 && s.fanPx === s.fan.px : s.fovDeg > 1);
            const shotAt = async (pred, name) => {
                await untilPlane(pred, 10000);
                await sleep(400);
                const img = decodePng(Buffer.from((await req('screenshot --passes main', 15000)).data.image, 'base64'));
                if (outDir) writePng(path.join(outDir, `layer-fan-${name}.png`), img);
                return img;
            };
            const where = async () => {
                const rows = (await req(`layer.where ${fanTarget}`)).data?.rows ?? [];
                return {
                    member: rows.find((r) => r.id === 'member-back')?.screen ?? null,
                    text: rows.find((r) => r.id === 'member-text')?.screen ?? null,
                    pages: rows.filter((r) => r.back).map((r) => r.back.screen).filter(Boolean),
                };
            };

            await req('plane.fan off');
            const off1 = await shotAt(folded, 'off');
            const wOff = await where();
            const fanOn = await req('plane.fan on');
            const on = await shotAt(fanned, 'on');
            const wOn = await where();
            await req('plane.fan off');
            const off2 = await shotAt(folded, 'off-again');
            const stateDef = (await req('plane.state')).data;
            await req(`layer.hide ${fanTarget}`);
            const bareOff = await shotAt(folded, 'bare-off');
            await req('plane.fan on');
            const bareOn = await shotAt(fanned, 'bare-on');
            await req('plane.fan off');
            await untilPlane(folded, 10000);
            await req('plane.leave');
            await untilPlane((s) => !s, 10000);

            const M = wOff.member;
            const pages = [...wOff.pages, ...wOn.pages];
            let ok = false;
            let detail;
            if (!hasHistory || !M || !wOff.text || pages.length < 2) {
                detail = `no layer stack to measure (${showRes.text?.split('\n')[0]}; member box ${JSON.stringify(M)}, text box ${JSON.stringify(wOff.text)}, ${pages.length} page box(es))`;
            } else {
                const W = off1.width, H = off1.height;
                const union = (rs) => {
                    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
                    return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
                };
                const pxBox = (r) => {   // whole px inside the image
                    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
                    return { x: x0, y: y0, w: Math.min(W, Math.ceil(r.x + r.w)) - x0, h: Math.min(H, Math.ceil(r.y + r.h)) - y0 };
                };
                const L = union(pages);
                const crop = pxBox(union([M, L]));
                const band = pxBox({ x: L.x, y: L.y, w: L.w, h: Math.floor(M.y) - 1 - L.y });   // above the member's edge row
                // The member's own text: its glyphs' stated extent (layer.where's member-text, which carries
                // a row of right-side overdraw), inside the member's box less MEMBER_EDGE px — not its
                // backdrop or focus border, which stand off the plane, so the perspective fan's parallax
                // moves them (the orthographic one leaves the whole box still: checked below).
                const MEMBER_EDGE = 10;
                const tx0 = Math.max(Math.ceil(wOff.text.x), Math.ceil(M.x + MEMBER_EDGE)), ty0 = Math.max(Math.ceil(wOff.text.y), Math.ceil(M.y + MEMBER_EDGE));
                const tx1 = Math.min(Math.floor(wOff.text.x + wOff.text.w), Math.floor(M.x + M.w - MEMBER_EDGE)), ty1 = Math.min(Math.floor(wOff.text.y + wOff.text.h), Math.floor(M.y + M.h - MEMBER_EDGE));
                const inner = { x: tx0, y: ty0, w: tx1 - tx0, h: ty1 - ty0 };
                const d = (a, b, r, tol = 0) => (r.w > 0 && r.h > 0 ? diffImages(cropImage(a, r), cropImage(b, r), tol) : { maxDelta: 0, diffPixels: 0 });
                const visible = d(off1, bareOff, band);
                const identity = d(off1, off2, crop);
                const moves = d(off1, on, band, 5);
                const member = d(off1, on, inner);
                const wx0 = Math.ceil(M.x), wy0 = Math.ceil(M.y);
                const whole = d(off1, on, { x: wx0, y: wy0, w: Math.floor(M.x + M.w) - wx0, h: Math.floor(M.y + M.h) - wy0 });
                const ortho = !!stateDef?.ortho;
                const control = d(bareOff, bareOn, band, 5);
                const controlMember = d(bareOff, bareOn, inner);
                ok = folded(stateDef) && band.h > 0 && visible.diffPixels > 0 && identity.maxDelta === 0
                    && moves.diffPixels > 0 && member.maxDelta <= MEMBER_NOISE && control.diffPixels === 0
                    && (!ortho || whole.maxDelta === 0);
                const fanText = String(fanOn.text ?? '').replace(/^OK: /, '').split(' (')[0];
                detail = `${stateDef?.ortho ? 'orthographic' : 'perspective'}, ${layers.length - 1} layers, band ${band.w}×${band.h} px: `
                    + `visible ${visible.diffPixels} px, off==off maxDelta=${identity.maxDelta} (${identity.diffPixels} px of ${crop.w}×${crop.h}), `
                    + `${fanText}: band moved ${moves.diffPixels} px, member text maxDelta=${member.maxDelta} (≤${MEMBER_NOISE}), `
                    + `member box maxDelta=${whole.maxDelta}${ortho ? ' (=0)' : ''}; `
                    + `control (layers hidden): band ${control.diffPixels} px, member ${controlMember.diffPixels} px`;
            }
            recordVerdict('5. layer fan identity', ok, performance.now() - t0, detail);
        } finally {
            if (createdFanTerm) {
                await req(`terminal.close ${fanTarget}`).catch(() => {});
            }
        }
    }

    // ── 6. strip band (column 0 right of it) ───────────────────────────────────
    {
        const t0 = performance.now();
        if ((await req('plane.state')).data) {
            await req('plane.leave');
            await untilPlane((s) => !s, 10000);
        }
        const enterRes = await req(`plane.enter ${fileA}`);
        await untilPlane((s) => s && !s.tweening, 15000);
        const s = (await req('plane.state')).data;
        const ov = (await req('overlay.list --all')).data;
        const stripCards = (ov?.items ?? []).filter((i) => i.kind === 'strip' && String(i.id).startsWith('strip:card:'));
        const stripRightPx = stripCards.length
            ? Math.max(...stripCards.map((c) => c.rect.x + c.rect.w))
            : 0;
        const col0ScreenX = s ? s.viewport.width / 2 + (s.origin.x - s.aim.x) * s.pxPerUnit : -1;
        if (outDir) {
            const shot = decodePng(Buffer.from((await req('screenshot', 15000)).data.image, 'base64'));
            writePng(path.join(outDir, 'strip-band.png'), shot);
        }
        await req('plane.leave');
        await untilPlane((st) => !st, 10000);

        const ok = /^OK:/.test(enterRes.text ?? '') && stripCards.length > 0 && col0ScreenX >= stripRightPx;
        recordVerdict(
            '6. strip band',
            ok,
            performance.now() - t0,
            `col0=${col0ScreenX.toFixed(1)}px >= stripRight=${stripRightPx.toFixed(1)}px (${stripCards.length} strip card(s))`,
        );
    }

    // ── 7. team.channel rows ───────────────────────────────────────────────────
    {
        const t0 = performance.now();
        let teamName = null;
        let injectedSyntheticTeam = false;
        const preTeams = new Set((await req('team.channel')).data?.teams ?? []);

        if (!sharedMode && !hubFlag && page) {
            teamName = 'e2e-team';
            injectedSyntheticTeam = true;
            await page.evaluate((tName) => {
                const books = window.__glyphClient?.ctx?.agentBooks;
                if (!books) return;
                const changes = [];
                for (let i = 1; i <= 25; i++) {
                    changes.push({
                        op: 'add',
                        pos: { at: i },
                        event: {
                            id: `e2e-msg-${i}`,
                            at: i,
                            ts: new Date(Date.now() - (30 - i) * 1000).toISOString(),
                            kind: 'prompt',
                            prompt: {
                                origin: 'peer',
                                text: `[from helper@local] synthetic team message #${i}\ndetail line A for message ${i}\ndetail line B for message ${i}`,
                            },
                        },
                    });
                }
                books.applyEvents(tName, changes, { agentType: 'claude' });
            }, teamName);
        } else {
            // Find an existing team with messages (preferring already-shown channels, then gomux roots).
            const gList = (await req('gomux.list')).data?.agents ?? [];
            const roots = gList.filter((a) => !a.parent).map((a) => a.name);
            const books = (await req('book.list')).data?.books ?? [];
            const candidates = [...new Set([...preTeams, ...roots, ...gList.map((a) => a.name), ...books.map((b) => b.lane).filter(Boolean)])];
            for (const c of candidates) {
                const wasShown = preTeams.has(c);
                const probe = await req(`team.channel ${c} show`);
                if (/^OK:/.test(probe.text ?? '') && (probe.data?.messages ?? 0) > 0) {
                    teamName = c;
                    break;
                }
                if (!wasShown) await req(`team.channel ${c} hide`).catch(() => {});
            }
        }

        if (!teamName) {
            recordVerdict('7. team.channel rows', false, performance.now() - t0, 'no team with messages found');
        } else {
            const showRes = await req(`team.channel ${teamName} show`);
            const upRes = await req(`team.channel ${teamName} rows -5`);
            const heldOk = /^OK:/.test(upRes.text ?? '') && upRes.data?.following === false;
            const heldRow = upRes.data?.top ?? 0;
            const liveRes = await req(`team.channel ${teamName} rows 10000`);
            const liveOk = /^OK:/.test(liveRes.text ?? '') && liveRes.data?.following === true;
            const liveRow = liveRes.data?.top ?? 0;

            if (!preTeams.has(teamName)) {
                await req(`team.channel ${teamName} hide`).catch(() => {});
            }
            if (injectedSyntheticTeam && page) {
                await page.evaluate((tName) => {
                    window.__glyphClient?.ctx?.agentBooks?.remove?.(tName);
                }, teamName);
            }

            const ok = /^OK:/.test(showRes.text ?? '') && heldOk && liveOk && liveRow > heldRow;
            recordVerdict(
                '7. team.channel rows',
                ok,
                performance.now() - t0,
                `team=${teamName} (${showRes.data?.messages ?? 0} msgs): rows -5 → held@${heldRow}, rows +10000 → live@${liveRow}`,
            );
        }
    }

    // ── 8. point.show → point.list ─────────────────────────────────────────────
    {
        const t0 = performance.now();
        const camBefore = (await req('camera.info')).data;
        const attBefore = (await req('attention.info')).data;
        const caller = 'e2e-probe';
        const showOut = await reqAs(caller, ['point.show', `${fileA}:2`, '--kind', 'suggest', '--say', 'e2e point check', '--with', '// proposed line']);
        const camAfter = (await req('camera.info')).data;
        const attAfter = (await req('attention.info')).data;
        const listRes = await req('point.list');
        const pts = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.points ?? []);
        const found = pts.find((p) => (p.id === caller || p.who === caller) && p.kind === 'suggest' && p.say === 'e2e point check');
        await reqAs(caller, ['point.clear']);

        const noSteal = JSON.stringify(camBefore) === JSON.stringify(camAfter)
            && JSON.stringify(attBefore) === JSON.stringify(attAfter);
        const ok = showOut.ok && Boolean(found) && found.status === 'shown' && noSteal;
        recordVerdict(
            '8. point.show → list',
            ok,
            performance.now() - t0,
            `${caller} → ${found?.ref?.text ?? 'missing'} [${found?.kind ?? '?'}] status=${found?.status ?? '?'}, noSteal=${noSteal}`,
        );
    }

    // ── 9. file-follow (scratch file under user cache dir, open → write → landed)
    {
        const t0 = performance.now();
        const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
        fs.mkdirSync(cacheBase, { recursive: true });
        const scratchCacheDir = fs.mkdtempSync(path.join(cacheBase, 'glyph3d-e2e-follow-'));
        const followFile = path.join(scratchCacheDir, 'follow.js');
        try {
            // Register scratchCacheDir as a reach root while empty so no extra files are opened.
            await req(`file.openDir ${scratchCacheDir}`);
            fs.writeFileSync(followFile, 'export const e2eFollow = 1;\n// line 2 initial');
            const openRes = await req(`file.open ${followFile}`);
            const openedLines = Number(openRes.data?.lines ?? 0);
            // Give FileWatch.sync() a moment to register fs/watch on the relay.
            await sleep(250);
            const writeT0 = performance.now();
            const marker = '// line 3 landed from disk';
            fs.writeFileSync(followFile, `export const e2eFollow = 2;\n// line 2 initial\n${marker}`);

            let landedLines = 0;
            let landedMarker = false;
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
                const info = (await req(`grid.info ${followFile}`)).data;
                landedLines = Number(info?.lines ?? 0);
                if (landedLines > openedLines) {
                    const readRes = await req(`grid.read ${followFile}`);
                    if ((readRes.text ?? '').includes(marker)) {
                        landedMarker = true;
                        break;
                    }
                }
                await sleep(60);
            }
            const landMs = Math.round(performance.now() - writeT0);
            await req(`grid.close ${followFile}`);

            const ok = openedLines === 2 && landedLines === 3 && landedMarker;
            recordVerdict(
                '9. file-follow',
                ok,
                performance.now() - t0,
                `open=${openedLines} lines → write → landed=${landedLines} lines in ${landMs}ms ("${marker}")`,
            );
        } finally {
            try { fs.rmSync(scratchCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
} finally {
    if (sharedMode && relay) {
        try {
            if ((await req('plane.state')).data) {
                await req('carrel.leave');
                await untilPlane((s) => !s, 8000);
            }
            // Close our own scratch files first so their registry entries unregister
            // and prune from the temp desks immediately, then dissolve the temp desks.
            for (const f of openedScratchFiles) {
                await req(`grid.close ${f}`).catch(() => {});
            }
            if (createdTempDesks) {
                for (const d of [deskA, deskB]) {
                    if (d) await req(`carrel.dissolve ${d}`).catch(() => {});
                }
                // Wait until both temp desks have finished draining from carrel.list
                const drainDeadline = Date.now() + 5000;
                while (Date.now() < drainDeadline) {
                    const list = (await req('carrel.list')).data?.carrels ?? [];
                    if (!list.some((c) => c.name === deskA || c.name === deskB)) break;
                    await sleep(80);
                }
            }
            // Re-materialize any pre-existing CodeGrid desk members if reload downgraded them to FileRow
            const postCheck = (await req('carrel.check')).data?.members ?? [];
            for (const m0 of initialCheck) {
                if (m0.heldKind === 'CodeGrid') {
                    const mNow = postCheck.find((m) => m.desk === m0.desk && m.id === m0.id);
                    if (mNow && mNow.heldKind !== 'CodeGrid') {
                        await req(`attention.set primary ${m0.id}`).catch(() => {});
                    }
                }
            }
            await req(`attention.set primary ${initialAttention?.primary?.id ?? 'none'}`).catch(() => {});
            await req(`attention.set key ${initialAttention?.key?.id ?? 'none'}`).catch(() => {});
            if (initialPlane?.target?.startsWith('carrel:')) {
                await req(`carrel.enter ${initialPlane.target.slice('carrel:'.length)}`).catch(() => {});
                await untilPlane((s) => s && !s.tweening, 10000);
            } else if (initialPlane?.target) {
                await req(`plane.enter ${initialPlane.target}`).catch(() => {});
                await untilPlane((s) => s && !s.tweening, 10000);
            } else if (initialCamera?.position) {
                const { x, y, z } = initialCamera.position;
                await req(`camera.move ${x} ${y} ${z}`);
            }
            await req('session.save');
        } catch { /* best-effort shared restore */ }
    }
    if (sharedScratchDir) {
        try { fs.rmSync(sharedScratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { relay?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    if (relayProc) {
        try { relayProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (tmuxSocket) {
        try { spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    if (scratchRoot) {
        try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// ── Print Verdict Table ────────────────────────────────────────────────────────
const targetLabel = sharedMode ? `shared relay :${port}` : `private relay :${port}${hubFlag ? ' (--hub)' : ' (--no-gomuxai)'}`;
const col1 = Math.max(24, ...verdicts.map((v) => v.name.length));
const col2 = 6;
const col3 = 8;
console.log(`\n=== planes-e2e verdict table (${targetLabel}) ===`);
console.log(`${'CHECK'.padEnd(col1)} | ${'STATUS'.padEnd(col2)} | ${'TIME'.padStart(col3)} | DETAIL`);
console.log(`${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+-${'-'.repeat(col3)}-+-------`);
for (const v of verdicts) {
    console.log(`${v.name.padEnd(col1)} | ${(v.ok ? 'PASS' : 'FAIL').padEnd(col2)} | ${(v.ms + 'ms').padStart(col3)} | ${v.detail}`);
}
const passCount = verdicts.filter((v) => v.ok).length;
const failCount = verdicts.length - passCount;
console.log(`${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+-${'-'.repeat(col3)}-+-------`);
console.log(`${failCount === 0 ? 'PASS' : 'FAIL'} planes-e2e: ${passCount}/${verdicts.length} passed`);
process.exit(failCount === 0 && verdicts.length === 9 ? 0 : 1);
