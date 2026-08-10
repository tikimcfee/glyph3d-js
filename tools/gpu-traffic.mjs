// gpu-traffic.mjs — per-frame GPU upload attribution: wraps device.queue.writeBuffer /
// writeTexture in the page, counts display frames, and reports a per-label bytes/frame
// histogram. THE measurement that found the group-table full re-upload (a broken change
// gate silently re-uploading 1.28MB/frame for months) and the minimap's 652KB/frame
// (three's ≤1024-instance uniform-matrix path + a f32-truncated change stamp).
//
// The law it enforces: a STILL scene should upload ~0 bytes/frame. Code-reads of the
// change gates are not evidence — this is the wire-level truth, one command, any box.
//
//   bun tools/gpu-traffic.mjs                                  # boot, settle, sample idle
//   bun tools/gpu-traffic.mjs --cmd 'file.openDir app' --seconds 6
//   bun tools/gpu-traffic.mjs --stacks GlyphGroups             # who WRITES a label (stack histogram)
//   bun tools/gpu-traffic.mjs --url http://localhost:5173/ --relay 8099 --top 25
//
// Buffers are attributed by GPUBuffer label (attribute .name → the label; unlabeled
// buffers pool under "(unlabeled)" — name the attribute, or chase the owner with the
// deeper probes in CHECKS.md). Textures report as "<label> [tex]". Uploads that ride
// mappedAtCreation (first-fill at buffer creation) are outside the queue and uncounted —
// this is the STEADY-STATE instrument.

import { launchGpuBrowser, openApp, assertRealGpu } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const cmds = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--cmd') cmds.push(argv[i + 1]);

const URL_ = flag('--url', 'http://localhost:5173/');
const RELAY = Number(flag('--relay', 8099));
const SECONDS = Number(flag('--seconds', 4));
const TOP = Number(flag('--top', 15));
const STACK_LABEL = flag('--stacks', null);
const HEADED = argv.includes('--headed');

const human = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(2) + 'MB'
  : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : Math.round(n) + 'B';

// --headed forces it; otherwise resolve by platform (macOS headless = software).
const browser = await launchGpuBrowser({ headed: HEADED || null });
try {
  const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 6000 });
  const gpu = await assertRealGpu(app, { tool: 'gpu-traffic' });
  console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}`);
  if (!app.booted) { console.error('app did not boot'); process.exit(1); }

  for (const c of cmds) {
    const r = await app.cmd(c);
    console.log(`cmd: ${c} → ${r.error ? 'ERROR ' + r.error : (r.text ?? 'ok').split('\n')[0]}`);
    await app.waitFor(2500);
  }
  await app.waitFor(2000);   // settle: eases finish, covers stop breathing

  const armed = await app.evalPage(`(() => {
    const c = window.__glyphClient;
    const renderer = c?.ctx?.renderer;
    const dev = renderer?.backend?.device;
    if (!dev) return { err: 'no WebGPU device on __glyphClient.ctx.renderer.backend' };
    const S = window.__gpuTraffic = { frames: 0, renders: 0, labels: new Map(), stacks: new Map() };
    const stackLabel = ${JSON.stringify(STACK_LABEL)};
    const rec = (label, n) => {
      const e = S.labels.get(label) || { bytes: 0, writes: 0 };
      e.bytes += n; e.writes += 1; S.labels.set(label, e);
    };
    const q = dev.queue;
    const wb = q.writeBuffer.bind(q);
    q.writeBuffer = (buf, off, data, dOff, size) => {
      const n = size ?? (data?.byteLength ?? 0);
      const label = (buf && buf.label) || '(unlabeled)';
      rec(label, n);
      if (stackLabel && label.includes(stackLabel) && S.stacks.size < 12) {
        const st = new Error().stack.split('\\n').slice(2, 9).join('\\n');
        S.stacks.set(st, (S.stacks.get(st) || 0) + 1);
      }
      return wb(buf, off, data, dOff, size);
    };
    const wt = q.writeTexture.bind(q);
    q.writeTexture = (dst, data, layout, size3) => {
      rec(((dst?.texture?.label) || '(texture)') + ' [tex]', data?.byteLength ?? 0);
      return wt(dst, data, layout, size3);
    };
    const render = renderer.render.bind(renderer);
    renderer.render = (...a) => { S.renders += 1; return render(...a); };
    const tick = () => { S.frames += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { ok: true };
  })()`);
  if (!armed?.ok) { console.error('arm failed:', armed?.err ?? armed); process.exit(1); }

  // Zero after arming (the wrap itself saw the tail of settling), then sample.
  await app.evalPage(`(() => { const S = window.__gpuTraffic; S.frames = 0; S.renders = 0; S.labels.clear(); S.stacks.clear(); })()`);
  console.log(`sampling ${SECONDS}s${STACK_LABEL ? ` (stacks for *${STACK_LABEL}*)` : ''}…`);
  await app.waitFor(SECONDS * 1000);

  const R = await app.evalPage(`(() => {
    const S = window.__gpuTraffic;
    return {
      frames: S.frames, renders: S.renders,
      labels: [...S.labels.entries()].map(([label, e]) => ({ label, ...e })),
      stacks: [...S.stacks.entries()].map(([stack, count]) => ({ stack, count })),
    };
  })()`);

  const frames = Math.max(R.frames, 1);
  const rows = R.labels.sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  console.log(`\n── gpu-traffic ── ${R.frames} frames (${(R.frames / SECONDS).toFixed(0)} fps), ${R.renders} renders (${(R.renders / frames).toFixed(1)}/frame)`);
  console.log(`   TOTAL ${human(total / frames)}/frame  (${human(total)} over the window)\n`);
  for (const r of rows.slice(0, TOP)) {
    console.log(`   ${human(r.bytes / frames).padStart(10)}/frame  ${(r.writes / frames).toFixed(1).padStart(6)} writes/frame  ${r.label}`);
  }
  if (rows.length > TOP) console.log(`   … ${rows.length - TOP} more labels (raise --top)`);
  if (STACK_LABEL) {
    console.log(`\n── writers of *${STACK_LABEL}* ──`);
    for (const s of R.stacks.sort((a, b) => b.count - a.count)) {
      console.log(`   ×${s.count}\n${s.stack.split('\n').map((l) => '     ' + l.trim()).join('\n')}`);
    }
    if (!R.stacks.length) console.log('   (no writes to that label in the window)');
  }
  // The verdict line agents can grep: idle should be near-zero.
  console.log(`\nverdict: ${human(total / frames)}/frame across ${rows.length} buffers`);
} finally {
  await browser.close();
}
