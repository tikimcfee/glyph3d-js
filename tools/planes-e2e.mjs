#!/usr/bin/env bun
/**
 * planes-e2e.mjs — one command that runs all 9 plane feature LIVE checks in sequence against a
 * relay and prints one verdict table:
 *
 *   1. plane-live-check       (--desk / --back / --reload)
 *   2. carrel.check           (every desk member held live in its seat)
 *   3. frame-capture-check    (--live desktop stream + non-blank frame texture)
 *   4. desk-reload-check      (seated → layout.scheme relayout → save+reload → leave+re-enter)
 *   5. layer fan identity     (plane.fan off twice pixel-identical on a layer stack; plane.fan on spreads —
 *                              the wider lens on the perspective endpoint, the whole-px shear on the orthographic)
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
    fs.writeFileSync(path.join(src, 'alpha.js'), makeScratchCode('alpha', 2));
    git(['commit', '-am', 'alpha rev 2']);
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

    // ── 5. layer fan identity (fan off twice identical, fan on spreads, on a layer stack) ──
    {
        const t0 = performance.now();
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
            const seedLines = Array.from({ length: 30 }, (_, i) => `scrollback line ${i + 1}: layer fan probe`).join('\n');
            await reqAs('', ['terminal.depth.seed', fanTarget, seedLines]);
        }
        try {
            await req(`plane.enter ${fanTarget}`);
            await untilPlane((s) => s && !s.tweening, 15000);
            const showRes = await req(`layer.show ${fanTarget} 2`, 15000);
            const layers = showRes.data?.layers ?? [];
            const hasHistory = /^OK:/.test(showRes.text ?? '') && layers.length >= 2;

            // Folded: the perspective endpoint at its own lens (fov 1), the orthographic one unsheared.
            const folded = (s) => s && !s.tweening && (s.ortho ? s.fan === null && s.camera.shear === 0 : s.fovDeg === 1);
            await req('plane.fan off');
            await untilPlane(folded, 10000);
            await sleep(400);
            const shot1 = decodePng(Buffer.from((await req('screenshot', 15000)).data.image, 'base64'));
            if (outDir) writePng(path.join(outDir, 'layer-fan-off.png'), shot1);

            const fanOn = await req('plane.fan on');
            await untilPlane((s) => s && !s.tweening && (s.ortho ? s.fan?.px > 0 : s.fovDeg > 1), 10000);
            await sleep(400);
            const shotFan = decodePng(Buffer.from((await req('screenshot', 15000)).data.image, 'base64'));
            if (outDir) writePng(path.join(outDir, 'layer-fan-on.png'), shotFan);

            await req('plane.fan off');
            await untilPlane(folded, 10000);
            await sleep(400);
            const stateDef = (await req('plane.state')).data;
            const shotDef = decodePng(Buffer.from((await req('screenshot', 15000)).data.image, 'base64'));
            if (outDir) writePng(path.join(outDir, 'layer-fan-off-again.png'), shotDef);

            const ov = (await req('overlay.list --all')).data;
            const stripCards = (ov?.items ?? []).filter((i) => i.kind === 'strip' && String(i.id).startsWith('strip:card:'));
            const stripRightPx = stripCards.length
                ? Math.min(shot1.width - 1, Math.max(0, Math.ceil(Math.max(...stripCards.map((c) => c.rect.x + c.rect.w)) + 4)))
                : 0;
            const planeRect = { x: stripRightPx, y: 0, w: shot1.width - stripRightPx, h: shot1.height };
            const diffIdentity = diffImages(cropImage(shot1, planeRect), cropImage(shotDef, planeRect), 0);
            const diffFan = diffImages(cropImage(shot1, planeRect), cropImage(shotFan, planeRect), 5);
            await req(`layer.hide ${fanTarget}`);
            await req('plane.leave');
            await untilPlane((s) => !s, 10000);

            const ok = hasHistory && folded(stateDef) && diffIdentity.maxDelta === 0 && diffFan.diffPixels > 0;
            recordVerdict(
                '5. layer fan identity',
                ok,
                performance.now() - t0,
                `${stateDef?.ortho ? 'orthographic' : 'perspective'}, layers=${layers.length - 1}, off==off maxDelta=${diffIdentity.maxDelta} (diffPx=${diffIdentity.diffPixels}), ${String(fanOn.text ?? '').replace(/^OK: /, '').split(' (')[0]} diffPx=${diffFan.diffPixels}`,
            );
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
