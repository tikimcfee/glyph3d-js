#!/usr/bin/env bun
/**
 * Gate for real-browser strip card hover + click (`PlaneOverlay` + `Strip` + `CanvasInteraction`).
 *
 * Launches a PRIVATE relay (--no-gomuxai, a scratch root and tmux socket, gomux.autoScreens=false; GLYPH_CLI
 * names the binary, GLYPH_VITE_URL the Vite)
 * and a real GPU browser via Playwright:
 *   1. Enters a plane desk (`desk-alpha`) with a sibling plane desk (`desk-beta`) on the strip.
 *   2. Queries `overlay.list` for `strip:card:desk-beta` and reads its `screenRect`.
 *   3. Moves the real mouse (`page.mouse.move`) onto the card → asserts `canvas.style.cursor === 'pointer'`.
 *   4. Clicks the card (`page.mouse.click` at `screenRect` center) → asserts `carrel.enter` fires
 *      (in command log / relay log store) and `plane.state` lands on `desk-beta`.
 *   5. Teeth: with today's broken `onClick` (checking only `ctx.execute` and `ctx.commandRouter` on
 *      raw `client.ctx`, where both are null/undefined), `page.mouse.click` fails to enter the target desk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const PORT = Number(process.env.STRIP_TEST_PORT || 8098);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The relay binary: GLYPH_CLI (verify-staged hands it the worktree's), else this checkout's.
const CLI = process.env.GLYPH_CLI || path.join(REPO, 'glyph3d-cli');
const VITE_URL = (process.env.GLYPH_VITE_URL || 'http://localhost:5173').replace(/\/$/, '') + '/';
const TMUX_SOCKET = `scratch-strip-click-${process.pid}`;
if (!fs.existsSync(CLI)) { console.error(`strip-click: no relay binary at ${CLI} (make build, or set GLYPH_CLI)`); process.exit(2); }
// A SCRATCH root: a relay serving a real checkout would autosave its session over the person's.
const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphd-strip-click-'));
fs.writeFileSync(path.join(ROOT_DIR, 'README.md'), '# strip-click\n\nThe first desk reads this.\n');
fs.writeFileSync(path.join(ROOT_DIR, 'package.json'), '{ "name": "strip-click", "private": true }\n');

let passed = 0;
let failed = 0;

function check(cond, msg) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ FAIL: ${msg}`);
    }
}

const relay = spawn(CLI, [
    'serve',
    '-port', String(PORT),
    '-listen', '127.0.0.1',
    '-tmux-socket', TMUX_SOCKET,
    '-no-gomuxai',
    ROOT_DIR,
], { stdio: 'ignore' });

for (let i = 0; i < 100; i++) {
    if (relay.exitCode != null) { console.error(`strip-click: relay exited (${relay.exitCode})`); process.exit(2); }
    if (spawnSync('sh', ['-c', `ss -ltn | grep -q ':${PORT} '`]).status === 0) break;
    await new Promise((r) => setTimeout(r, 100));
}

let browser = null;
let app = null;

try {
    browser = await launchGpuBrowser();
    app = await openApp(browser, {
        url: VITE_URL,
        relayPort: PORT,
        session: 'off',
        viewport: { width: 1400, height: 900 },
        settings: {
            'gomux.autoScreens': false,
            'gomux.centerOnLoad': false,
            'chrome.dockHidden': true,
        },
        wait: 4000,
    });

    check(app.booted, 'App booted on private relay');

    // Open two files and seat them into two plane desks: desk-alpha and desk-beta
    await app.evalPage(async () => {
        const exec = (cmd) => window.__glyphClient.router.execute(cmd);
        await exec('file.open README.md');
        await exec('file.open package.json');
        await exec('carrel.create desk-alpha');
        await exec('carrel.add README.md desk-alpha');
        await exec('carrel.create desk-beta');
        await exec('carrel.add package.json desk-beta');
        await exec('carrel.enter desk-alpha');
    });
    await app.waitFor(1000);

    // Install a command-bus spy to record every `carrel.enter` invocation
    await app.evalPage(() => {
        window.__carrelEnterCalls = [];
        window.__glyphClient.router.use((name, args) => {
            if (name === 'carrel.enter') {
                window.__carrelEnterCalls.push(args.join(' '));
            }
        });
    });

    // Query `overlay.list` via the command bus
    const overlayData = await app.evalPage(async () => {
        const res = await window.__glyphClient.router.execute('overlay.list');
        return {
            enteredCarrel: window.__glyphClient.ctx.enteredCarrel,
            items: res?.data?.items || [],
            viewport: res?.data?.viewport || null,
        };
    });

    check(overlayData.enteredCarrel === 'desk-alpha', `Initially entered desk-alpha (got ${overlayData.enteredCarrel})`);
    const betaCard = overlayData.items.find((it) => it.id === 'strip:card:desk-beta');
    check(Boolean(betaCard && betaCard.screenRect), 'overlay.list includes strip:card:desk-beta with screenRect');

    if (betaCard && betaCard.screenRect) {
        const sr = betaCard.screenRect;
        const cx = sr.x + sr.w / 2;
        const cy = sr.y + sr.h / 2;

        // ── 1. Teeth check: today's broken onClick (only checking raw ctx.execute / ctx.commandRouter) ──
        const teethResult = await app.evalPage(() => {
            const ctx = window.__glyphClient.ctx;
            // Verify raw client.ctx has neither ctx.execute nor ctx.commandRouter
            const rawHasExecute = typeof ctx.execute === 'function';
            const rawHasCommandRouter = Boolean(ctx.commandRouter?.execute);
            // Temporarily give the strip the old reach: the raw ctx's own router, which it doesn't carry
            const strip = ctx.strip;
            const origExec = strip._exec;
            window.__restoreStripEnter = () => { strip._exec = origExec; };
            strip._exec = (cmd) => {
                if (typeof ctx.execute === 'function') return ctx.execute(cmd);
                if (ctx.commandRouter?.execute) return ctx.commandRouter.execute(cmd);
                return null;
            };
            return { rawHasExecute, rawHasCommandRouter };
        });

        await app.page.mouse.click(cx, cy);
        await app.waitFor(300);

        const afterTeeth = await app.evalPage(() => {
            window.__restoreStripEnter?.();
            return {
                enteredCarrel: window.__glyphClient.ctx.enteredCarrel,
                calls: [...(window.__carrelEnterCalls || [])],
            };
        });

        check(
            !teethResult.rawHasExecute && !teethResult.rawHasCommandRouter
                && afterTeeth.enteredCarrel === 'desk-alpha'
                && afterTeeth.calls.length === 0,
            `Teeth: old onClick on raw client.ctx fails to fire carrel.enter (entered=${afterTeeth.enteredCarrel}, calls=${afterTeeth.calls.length})`
        );

        // ── 2. Hover cursor gate ──
        await app.page.mouse.move(cx + 400, cy);
        await app.waitFor(150);
        await app.page.mouse.move(cx, cy);
        await app.waitFor(150);

        const hoverCursor = await app.evalPage(() => window.__glyphClient.ctx.renderer.domElement.style.cursor);
        check(hoverCursor === 'pointer', `Hovering strip card sets canvas cursor to 'pointer' (got '${hoverCursor}')`);

        // ── 3. Real browser click gate (`page.mouse.click` at card's screenRect) ──
        await app.page.mouse.click(cx, cy);
        await app.waitFor(600);

        const afterClick = await app.evalPage(async () => {
            const ctx = window.__glyphClient.ctx;
            const ps = await window.__glyphClient.router.execute('plane.state');
            return {
                enteredCarrel: ctx.enteredCarrel,
                carrelBack: ctx.carrelBack,
                calls: [...(window.__carrelEnterCalls || [])],
                planeState: ps?.data ?? null,
                cursor: ctx.renderer.domElement.style.cursor,
            };
        });

        check(
            afterClick.calls.includes('desk-beta'),
            `Real mouse click fired 'carrel.enter desk-beta' (calls=${JSON.stringify(afterClick.calls)})`
        );
        check(
            afterClick.enteredCarrel === 'desk-beta' && afterClick.carrelBack === 'desk-alpha',
            `Entered carrel switched to 'desk-beta' with carrelBack='desk-alpha' (got entered=${afterClick.enteredCarrel}, back=${afterClick.carrelBack})`
        );
        check(
            afterClick.planeState?.target === 'carrel:desk-beta' && afterClick.planeState?.leaving === false,
            `plane.state lands on 'carrel:desk-beta' (target=${afterClick.planeState?.target})`
        );

        // Click the card on the strip to return to desk-alpha
        const overlayData2 = await app.evalPage(async () => {
            const res = await window.__glyphClient.router.execute('overlay.list');
            return res?.data?.items || [];
        });
        const alphaCard = overlayData2.find((it) => it.id === 'strip:card:desk-alpha');
        check(Boolean(alphaCard?.screenRect), 'After entering desk-beta, strip shows card for desk-alpha');
        if (alphaCard?.screenRect) {
            const ax = alphaCard.screenRect.x + alphaCard.screenRect.w / 2;
            const ay = alphaCard.screenRect.y + alphaCard.screenRect.h / 2;
            await app.page.mouse.click(ax, ay);
            await app.waitFor(600);
            const backToAlpha = await app.evalPage(() => window.__glyphClient.ctx.enteredCarrel);
            check(backToAlpha === 'desk-alpha', `Clicking desk-alpha strip card returns to 'desk-alpha' (got '${backToAlpha}')`);
        }
    }

    check(app.errors.length === 0, `Zero console/page errors (${app.errors.length})`);
} finally {
    await app?.close?.().catch(() => {});
    await browser?.close?.().catch(() => {});
    relay.kill('SIGTERM');
    spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
    fs.rmSync(ROOT_DIR, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAIL' : 'ok'} strip-click: ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
