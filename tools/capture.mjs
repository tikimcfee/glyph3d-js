// capture.mjs — clean, smooth capture of a glyph3d app for glyph3d.dev media.
//
//   bun tools/capture.mjs <url> <outFile.webm> [frames]
//   bun tools/capture.mjs http://127.0.0.1:8300/ ../glyph3d.dev/media/showcase.webm 150
//
// Two modes, auto-detected:
//   • SEEK   — if the page exposes window.demo.seek(t)/duration (the cinematic),
//              drive t∈[0,1) frame-perfect and screenshot each. The cinematic is
//              self-closing (t=1 ≡ t=0), so frames assemble straight into a loop.
//   • DRAG   — otherwise, do a smooth one-way drag and ffmpeg a boomerang loop.
//
// WHY screenshots not recordVideo: Playwright's live recorder captures the page
// through the compositor, which mangles a WebGPU canvas (color artifacts) and
// ties motion to real time (jitter). Per-frame CDP screenshots capture WebGPU
// correctly, so smoothness is a property of the frame sequence — it can't stutter.
// Needs system ffmpeg (full codecs); Playwright's bundled ffmpeg is VP8-only.

import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:8300/';
const out = process.argv[3] || '/tmp/glyph3d-loop.webm';
const N = Number(process.argv[4] || 150);
const FPS = 30;
const W = 1280, H = 800;                       // 16:10, matches the .stage box
const framesDir = '/tmp/glyph3d-frames';
const pad = (n) => String(n).padStart(4, '0');
await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(5500);               // atlas gen + async content + first frames

const hasDemo = await page.evaluate(() => !!(window.demo && window.demo.seek));
let boomerang;

if (hasDemo) {
  console.log('capture: SEEK mode (window.demo)');
  for (let i = 0; i < N; i++) {
    await page.evaluate((t) => window.demo.seek(t), i / N);  // [0,1)
    await page.waitForTimeout(45);             // let r3f render the seeked state
    await page.screenshot({ path: `${framesDir}/f${pad(i)}.png` });
  }
  boomerang = false;                           // cinematic already self-loops
} else {
  console.log('capture: DRAG mode (fallback)');
  const cx = W / 2, cy = H / 2, span = W * 0.30;
  await page.mouse.move(cx - span / 2, cy);
  await page.mouse.down();
  for (let i = 0; i < N; i++) {
    await page.mouse.move(cx - span / 2 + span * (i / (N - 1)), cy, { steps: 1 });
    await page.waitForTimeout(45);
    await page.screenshot({ path: `${framesDir}/f${pad(i)}.png` });
  }
  await page.mouse.up();
  boomerang = true;
}
await browser.close();

const filter = boomerang
  ? '[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1,format=yuv420p[v]'
  : '[0]format=yuv420p[v]';
const args = [
  '-y', '-framerate', String(FPS), '-i', `${framesDir}/f%04d.png`,
  '-filter_complex', filter, '-map', '[v]',
  '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-an', out,
];
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
console.log(`capture: ${out}  (${hasDemo ? N : 2 * N} frames @ ${FPS}fps${boomerang ? ', boomerang' : ''})`);
