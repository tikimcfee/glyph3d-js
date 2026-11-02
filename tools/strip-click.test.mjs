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
fs.writeFileSync(path.join(ROOT_DIR, 'README.md'), '# strip-click\n\nThe first desk reads this.\nexport function alpha() {\n  return "desk-alpha preview";\n}\n');
fs.writeFileSync(path.join(ROOT_DIR, 'package.json'), '{\n  "name": "strip-click",\n  "private": true,\n  "version": "1.0.0"\n}\n');
for (let i = 1; i <= 12; i++) {
    fs.writeFileSync(
        path.join(ROOT_DIR, `module-${i}.js`),
        `// Module ${i} — desk preview content\nexport class DeskService${i} {\n  constructor(cfg = {}) {\n    this.id = ${i};\n    this.ready = true;\n    this.cfg = cfg;\n  }\n  run() {\n    return this.id * 42;\n  }\n}\n`
    );
}

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
        const r1 = await exec('file.open README.md');
        const r2 = await exec('file.open package.json');
        await exec('carrel.create desk-alpha');
        await exec(`carrel.add ${r1?.data?.id || 'README.md'} desk-alpha`);
        await exec('carrel.create desk-beta');
        await exec(`carrel.add ${r2?.data?.id || 'package.json'} desk-beta`);
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

        // ── 4. Open-world strip visibility & real-mouse click in the OPEN WORLD ──
        await app.evalPage(async () => {
            await window.__glyphClient.router.execute('plane.leave');
        });
        await app.waitFor(900);

        const openWorldPre = await app.evalPage(async () => {
            const ctx = window.__glyphClient.ctx;
            const res = await window.__glyphClient.router.execute('overlay.list');
            return {
                enteredCarrel: ctx.enteredCarrel,
                inPlane: Boolean(ctx.cameraController?.isInPlane?.()),
                items: res?.data?.items || [],
            };
        });
        check(
            openWorldPre.enteredCarrel === null && openWorldPre.inPlane === false,
            `Left plane back to the open world (entered=${openWorldPre.enteredCarrel}, inPlane=${openWorldPre.inPlane})`
        );
        const openBetaCard = openWorldPre.items.find((it) => it.id === 'strip:card:desk-beta');
        check(
            Boolean(openBetaCard?.screenRect),
            'Strip remains visible in the open world and lists strip:card:desk-beta'
        );

        // Teeth: if strip hid when !inPlane, open-world click at strip card rect would hit nothing
        const openWorldTeeth = await app.evalPage(() => {
            const ctx = window.__glyphClient.ctx;
            const strip = ctx.strip;
            strip.configure({ enabled: false });
            strip.update();
            const hitWhenHidden = ctx.planeOverlay.hitTestAtClient(80, 140);
            strip.configure({ enabled: true });
            strip.update();
            return { hitWhenHidden: Boolean(hitWhenHidden) };
        });
        check(
            openWorldTeeth.hitWhenHidden === false,
            'Teeth: when strip hides in open world, clicking the left edge hits no strip card'
        );

        if (openBetaCard?.screenRect) {
            await app.evalPage(() => { window.__carrelEnterCalls = []; });
            const bx = openBetaCard.screenRect.x + openBetaCard.screenRect.w / 2;
            const by = openBetaCard.screenRect.y + openBetaCard.screenRect.h / 2;
            await app.page.mouse.click(bx, by);
            await app.waitFor(600);

            const afterOpenClick = await app.evalPage(async () => {
                const ctx = window.__glyphClient.ctx;
                const ps = await window.__glyphClient.router.execute('plane.state');
                return {
                    enteredCarrel: ctx.enteredCarrel,
                    calls: [...(window.__carrelEnterCalls || [])],
                    planeState: ps?.data ?? null,
                };
            });
            check(
                afterOpenClick.calls.includes('desk-beta')
                    && afterOpenClick.enteredCarrel === 'desk-beta'
                    && afterOpenClick.planeState?.target === 'carrel:desk-beta',
                `Clicking strip row in OPEN WORLD enters 'desk-beta' (entered=${afterOpenClick.enteredCarrel}, target=${afterOpenClick.planeState?.target})`
            );
        }

        // ── 5. Real mouse wheel over the strip band scrolls the list and camera does NOT move ──
        // Leave plane to open world and populate a full desk tree (gomux hub + nested team desks + peers)
        // so the strip list overflows the 900px viewport height and is scrollable.
        await app.evalPage(async () => {
            const exec = (cmd) => window.__glyphClient.router.execute(cmd);
            await exec('plane.leave');
        });
        await app.waitFor(900);

        const scrollSetup = await app.evalPage(async () => {
            const ctx = window.__glyphClient.ctx;
            const exec = (cmd) => window.__glyphClient.router.execute(cmd);
            let fileIdx = 1;
            const openNextFile = async () => {
                const f = `module-${fileIdx++}.js`;
                const res = await exec(`file.open ${f}`);
                return res?.data?.id || f;
            };
            await exec('carrel.create gomux');
            await exec(`carrel.add ${await openNextFile()} gomux`);
            const depth1 = [
                'gomux/glyph3d-root-delegate',
                'gomux/agy-makepad-integration',
                'gomux/glyph3d-js-root',
                'gomux/gomuxai-host-a',
                'gomux/claude-makepad-integration',
            ];
            for (const tName of depth1) {
                await exec(`carrel.create ${tName}`);
                await exec(`carrel.add ${await openNextFile()} ${tName}`);
                const hub = ctx.carrels.get('gomux');
                const child = ctx.carrels.get(tName);
                if (hub && child) hub.lock(child.name, child, { immediate: true });
            }
            const depth2 = [
                'gomux/glyph3d-js-root-desktop',
                'gomux/glyph3d-js-root-pixels',
                'gomux/glyph3d-js-root-camera',
                'gomux/glyph3d-js-root-scroll',
            ];
            for (const tName of depth2) {
                await exec(`carrel.create ${tName}`);
                await exec(`carrel.add ${await openNextFile()} ${tName}`);
                const parent = ctx.carrels.get('gomux/glyph3d-js-root');
                const child = ctx.carrels.get(tName);
                if (parent && child) parent.lock(child.name, child, { immediate: true });
            }
            for (const dName of ['glyph3d-root-delegate-idx-makepad-fit', 'desk-extra-1']) {
                await exec(`carrel.create ${dName}`);
                await exec(`carrel.add ${await openNextFile()} ${dName}`);
            }
            await new Promise((r) => setTimeout(r, 600));
            // Capture 256-tier thumbnails for every desk so strip cards have live previews
            for (const c of ctx.carrels.values()) {
                ctx.carrelCards?.capture?.(c, { tier: 256, reason: 'test' });
            }
            ctx.strip.setScroll(0);
            ctx.strip.update();
            return ctx.strip.getState();
        });
        await app.waitFor(400);

        check(
            scrollSetup.maxScrollPx > 0 && scrollSetup.cards.length >= 12,
            `Populated ${scrollSetup.cards.length} desks in tree order with maxScrollPx=${scrollSetup.maxScrollPx} > 0`
        );
        const allLabelsInBand = scrollSetup.cards
            .filter((c) => c.shown)
            .every((c) => (
                c.labelRect &&
                c.labelRect.x >= 0 &&
                c.labelRect.x + c.labelRect.w <= scrollSetup.stripRightPx &&
                c.labelRect.y >= c.rect.y + c.rect.h
            ));
        check(
            allLabelsInBand,
            `Every visible strip label in real browser sits below its card and inside stripRightPx=${scrollSetup.stripRightPx}`
        );

        const shotDir = process.env.STRIP_SCREENSHOT_DIR || '';
        if (shotDir) {
            fs.mkdirSync(shotDir, { recursive: true });
            await app.page.screenshot({ path: path.join(shotDir, 'strip-expanded.png') });
        }

        // Teeth for wheel: if PlaneOverlay does not intercept wheel over the strip band,
        // wheeling at (80, 300) moves the 3D camera and leaves strip.scrollPx === 0.
        const wheelTeethBefore = await app.evalPage(() => {
            const ctx = window.__glyphClient.ctx;
            const strip = ctx.strip;
            const origHandleWheel = strip.handleWheelAt.bind(strip);
            window.__restoreHandleWheel = () => { strip.handleWheelAt = origHandleWheel; };
            strip.handleWheelAt = () => false;
            const p = ctx.camera.position;
            return { x: p.x, y: p.y, z: p.z, scrollPx: strip.scrollPx() };
        });

        await app.page.mouse.move(80, 300);
        await app.page.mouse.wheel(0, 240);
        await app.waitFor(250);

        const wheelTeethAfter = await app.evalPage((savedPos) => {
            const ctx = window.__glyphClient.ctx;
            window.__restoreHandleWheel?.();
            const p = ctx.camera.position;
            const camDelta = Math.hypot(p.x - savedPos.x, p.y - savedPos.y, p.z - savedPos.z);
            // Restore camera position
            ctx.camera.position.set(savedPos.x, savedPos.y, savedPos.z);
            ctx.camera.updateMatrixWorld(true);
            return { camDelta, scrollPx: ctx.strip.scrollPx() };
        }, wheelTeethBefore);

        check(
            wheelTeethAfter.camDelta > 0.1 && wheelTeethAfter.scrollPx === 0,
            `Teeth: without strip wheel interception, wheeling over the strip moves the camera (camDelta=${wheelTeethAfter.camDelta.toFixed(2)}) and does not scroll strip (scrollPx=${wheelTeethAfter.scrollPx})`
        );

        // Gate for wheel: wheeling over the strip band scrolls the list and keeps camera completely still
        const camBeforeWheel = await app.evalPage(() => {
            const ctx = window.__glyphClient.ctx;
            const p = ctx.camera.position;
            return { x: p.x, y: p.y, z: p.z, scrollPx: ctx.strip.scrollPx() };
        });

        await app.page.mouse.move(80, 300);
        await app.page.mouse.wheel(0, 280);
        await app.waitFor(300);

        const afterWheel = await app.evalPage((before) => {
            const ctx = window.__glyphClient.ctx;
            const p = ctx.camera.position;
            return {
                camDelta: Math.hypot(p.x - before.x, p.y - before.y, p.z - before.z),
                scrollPx: ctx.strip.scrollPx(),
                maxScrollPx: ctx.strip.maxScrollPx(),
            };
        }, camBeforeWheel);

        check(
            afterWheel.scrollPx > 0 && afterWheel.camDelta < 1e-6,
            `Real mouse wheel over strip band scrolls list (scrollPx=${afterWheel.scrollPx}) and camera does NOT move (camDelta=${afterWheel.camDelta})`
        );

        if (shotDir) {
            await app.evalPage(() => {
                const strip = window.__glyphClient.ctx.strip;
                strip.setScroll(strip.maxScrollPx());
            });
            await app.waitFor(200);
            await app.page.screenshot({ path: path.join(shotDir, 'strip-scrolled.png') });
        }

        // ── 6. Real mouse click on `strip:header` collapses and expands the strip ──
        const headerInfo = await app.evalPage(async () => {
            const res = await window.__glyphClient.router.execute('overlay.list');
            const items = res?.data?.items || [];
            return items.find((it) => it.id === 'strip:header') || null;
        });
        check(Boolean(headerInfo?.screenRect), 'overlay.list includes strip:header with screenRect');

        if (headerInfo?.screenRect) {
            const hx = headerInfo.screenRect.x + headerInfo.screenRect.w / 2;
            const hy = headerInfo.screenRect.y + headerInfo.screenRect.h / 2;

            // Teeth: if header click is a no-op, strip stays expanded and reserves stripRightPx > 0
            const collapseTeeth = await app.evalPage(() => {
                const strip = window.__glyphClient.ctx.strip;
                return { collapsed: strip.isCollapsed(), stripRightPx: strip.stripRightPx() };
            });
            check(
                collapseTeeth.collapsed === false && collapseTeeth.stripRightPx > 0,
                `Teeth: before collapsing, strip reserves stripRightPx=${collapseTeeth.stripRightPx}`
            );

            await app.page.mouse.click(hx, hy);
            await app.waitFor(300);

            const afterHeaderCollapse = await app.evalPage(async () => {
                const ctx = window.__glyphClient.ctx;
                const res = await window.__glyphClient.router.execute('overlay.list');
                const items = res?.data?.items || [];
                return {
                    collapsed: ctx.strip.isCollapsed(),
                    stripRightPx: ctx.strip.stripRightPx(),
                    persisted: window.localStorage.getItem('g3d.strip.collapsed'),
                    cardCountInOverlay: items.filter((it) => String(it.id).startsWith('strip:card:')).length,
                    hasHeader: items.some((it) => it.id === 'strip:header'),
                };
            });

            check(
                afterHeaderCollapse.collapsed === true
                    && afterHeaderCollapse.stripRightPx === 0
                    && afterHeaderCollapse.persisted === 'true'
                    && afterHeaderCollapse.cardCountInOverlay === 0
                    && afterHeaderCollapse.hasHeader === true,
                `Clicking strip:header collapses strip (collapsed=${afterHeaderCollapse.collapsed}, stripRightPx=${afterHeaderCollapse.stripRightPx}, persisted=${afterHeaderCollapse.persisted}, overlayCards=${afterHeaderCollapse.cardCountInOverlay})`
            );

            if (shotDir) {
                await app.page.screenshot({ path: path.join(shotDir, 'strip-collapsed.png') });
            }

            // Click `strip:header` again to expand back
            await app.page.mouse.click(hx, hy);
            await app.waitFor(300);

            const afterHeaderExpand = await app.evalPage(async () => {
                const ctx = window.__glyphClient.ctx;
                const res = await window.__glyphClient.router.execute('overlay.list');
                const items = res?.data?.items || [];
                return {
                    collapsed: ctx.strip.isCollapsed(),
                    stripRightPx: ctx.strip.stripRightPx(),
                    persisted: window.localStorage.getItem('g3d.strip.collapsed'),
                    cardCountInOverlay: items.filter((it) => String(it.id).startsWith('strip:card:')).length,
                };
            });

            check(
                afterHeaderExpand.collapsed === false
                    && afterHeaderExpand.stripRightPx > 0
                    && afterHeaderExpand.persisted === 'false'
                    && afterHeaderExpand.cardCountInOverlay > 0,
                `Clicking strip:header again expands strip (collapsed=${afterHeaderExpand.collapsed}, stripRightPx=${afterHeaderExpand.stripRightPx}, overlayCards=${afterHeaderExpand.cardCountInOverlay})`
            );

            if (shotDir) {
                await app.evalPage(async () => {
                    const ctx = window.__glyphClient.ctx;
                    await window.__glyphClient.router.execute('carrel.enter "gomux/glyph3d-js-root"');
                    ctx.strip.setScroll(0);
                    ctx.strip.update();
                });
                await app.waitFor(800);
                await app.page.screenshot({ path: path.join(shotDir, 'strip-labels-plane.png') });
            }
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
