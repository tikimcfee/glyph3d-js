// frame-capture-check.mjs — headless render check for screen captures (FrameGrid).
//
// getDisplayMedia needs a real screen-share, so a capture is normally only verifiable by eye. The
// fake-media Chrome flags auto-grant a SYNTHETIC stream, so frame.capture renders a moving test
// pattern we can screenshot — making the FrameGrid render path verifiable headlessly. Opens
// CLIENT-ONLY (no relay dial) so it never touches the live session.
//
//   bun tools/frame-capture-check.mjs   →   /tmp/frame-capture-check.png + a state dump

import { chromium } from 'playwright';
import { openApp } from './itest/driver.mjs';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
    '--use-angle=vulkan', '--use-gl=angle',
    // Auto-grant getDisplayMedia with a synthetic moving pattern.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});
try {
  const app = await openApp(browser, { wait: 4000 }); // relayPort null → client-only, no contention
  const cap = await app.cmd('frame.capture');
  console.log('frame.capture →', JSON.stringify(cap));
  await app.waitFor(2500); // let the video deliver frames + the field render
  const state = await app.evalPage(`(() => {
    const c = window.__glyphClient;
    const fr = c?.ctx?.registry?.findByType?.('frame') || [];
    const g = fr[0]?.grid;
    if (!g) return { frames: 0 };
    // Sample the centre of the canvas to see if the capture rendered anything non-black there.
    const cv = document.querySelector('canvas');
    return {
      frames: fr.length, id: fr[0]?.id,
      hasTexture: !!g._texture, cols: g.cols, rows: g.rows,
      scale: [g.scale.x, g.scale.y, g.scale.z],
      videoSize: g._video ? [g._video.videoWidth, g._video.videoHeight] : null,
      panelOpacity: g._panel ? 'panel-present' : 'no-panel',
      // Picking-wired? (proves the 'glyph'/'grid' registration ran — so the screenshot's verdict
      // covers that path, not just a render with picking off.)
      hasPickingSystem: !!c?.ctx?.pickingSystem,
      framePickingSet: !!g._pickingSystem,
      glyphLayer7: g._renderer?.instanceMesh ? g._renderer.instanceMesh.layers.isEnabled(7) : null,
    };
  })()`);
  console.log('frame state →', JSON.stringify(state, null, 2));
  await app.shot('/tmp/frame-capture-check.png');
  console.log('shot → /tmp/frame-capture-check.png');
} finally {
  await browser.close();
}
