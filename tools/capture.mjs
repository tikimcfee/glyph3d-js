// capture.mjs — Playwright-driven capture of a glyph3d app. Records a looping
// video + stills while scripting the real controls (orbit / zoom / type), so
// glyph3d.dev media is generated, not hand-shot. Loopable & re-runnable: point
// it at any glyph3d URL (the hero, or the full app once the binary serves it).
//
//   bun tools/capture.mjs <url> <outDir>
//   bun tools/capture.mjs http://127.0.0.1:5181/ /tmp/cap
//
// WebGPU needs a real GPU, so this runs headed Chromium with the WebGPU flag.
// Playwright bundles both Chromium and ffmpeg (video), so no extra installs.

import { chromium } from 'playwright';
import { mkdir, rename } from 'node:fs/promises';

const url = process.argv[2] || 'http://127.0.0.1:5181/';
const outDir = process.argv[3] || '/tmp/glyph3d-capture';
const name = process.argv[4] || 'capture';
await mkdir(outDir, { recursive: true });

const W = 1280, H = 800;
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: outDir, size: { width: W, height: H } },
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(4000);           // atlas gen + first WebGPU frame
await page.screenshot({ path: `${outDir}/${name}-1.png` });

const cx = W / 2, cy = H / 2;

// Gentle continuous tumble — small closed loops that keep the text framed the
// whole time and return to start, so the clip loops seamlessly. (A wheel-zoom
// here flew the camera past the text into black; a tumble is the safe beauty.)
const tumble = async (radiusX, radiusY, steps, hold) => {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    await page.mouse.move(cx + Math.sin(a) * radiusX, cy + Math.cos(a) * radiusY, { steps: 1 });
    await page.waitForTimeout(hold);
  }
  await page.mouse.up();
};

await tumble(110, 45, 48, 30);
await page.screenshot({ path: `${outDir}/${name}-2.png` });

// type a couple visible chars onto the last line, then settle framed
await page.keyboard.type('  <- live', { delay: 80 });
await page.waitForTimeout(700);
await tumble(90, 38, 48, 30);
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/${name}-3.png` });

const video = page.video();
await context.close();                      // finalizes the webm
const vp = await video.path();
await rename(vp, `${outDir}/${name}.webm`);
await browser.close();
console.log(`capture: ${outDir}/${name}.webm + ${name}-{1,2,3}.png`);
