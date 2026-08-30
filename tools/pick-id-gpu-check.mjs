// pick-id-gpu-check.mjs — the pick-ID HARDWARE gate: an ID past 2^24 must survive the
// round trip and resolve to the thing it was aimed at.
//
//   bun tools/pick-id-gpu-check.mjs            # needs the Vite server
//   bun tools/pick-id-gpu-check.mjs --headed
//   bun tools/pick-id-gpu-check.mjs --json
//
// WHY THIS FILE EXISTS. Picking resolves every hover and click by rendering per-object
// IDs into RGBA8 and reading a pixel back. The ID base rode `uniform(0)` — a JS number,
// which is an f32 uniform, exact only to 2^24 — and the id was then narrowed with int(),
// capping the space at 2^31 and making shiftRight arithmetic rather than logical. Three
// carriers were wrong (the third: instancePickingId, the CPU mirror harnesses check
// against, was a Float32Array).
//
// tools/pick-identity.test.mjs covers the pack/unpack arithmetic and the source-level
// carrier declarations. It cannot cover the SHADER: whether a u32 uniform actually
// arrives intact on the device, whether the alpha byte survives the render target, and
// whether the readback decodes it. Nothing in this tree rendered a pick pass at all. So
// a mis-resolved pick — the app acting on the wrong target, silently — had no gate.
//
// This runs the REAL PickingSystem on the app's live WebGPU renderer, at IDs chosen to
// break an f32 carrier: 2^24 + 1 (collapses onto 2^24 in f32), ARENA_MAX_BYTES
// (44,739,242 -> 44,739,240), and values above 2^31 where a signed shiftRight
// sign-extends into the alpha byte.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const HEADED = has('--headed');
const AS_JSON = has('--json');
const C = { bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };

// IDs that a wrong carrier cannot represent. Each is here for a stated reason.
const IDS = [
  { id: 1,           why: 'the low end still works (a guard that breaks everything proves nothing)' },
  { id: 0xFFFFFF,    why: 'the last id an f32 carries exactly — must pass BEFORE the interesting ones' },
  { id: 0x1000001,   why: '2^24 + 1 — collapses onto 2^24 in f32' },
  { id: 44739242,    why: 'ARENA_MAX_BYTES — the ceiling that made this reachable; aliases to ...240 in f32' },
  { id: 0x7FFFFFFF,  why: 'the old guard bound — the largest positive i32' },
  { id: 0x80000000,  why: 'sign bit set — an arithmetic shiftRight smears it through ALPHA' },
  { id: 0xFFFFFFFE,  why: 'near the top of the u32 space' },
];

const probe = (o) => `(async (o) => {
  const R = { teeth: [], notes: [] };
  const tooth = (name, pass, detail) => { R.teeth.push({ name, pass: !!pass, detail: detail ?? null }); return !!pass; };

  const client = window.__glyphClient;
  if (!client) return { fatal: 'window.__glyphClient missing — the app did not boot' };
  const ps = client.ctx && client.ctx.pickingSystem;
  if (!ps) return { fatal: 'ctx.pickingSystem missing' };
  const THREE = client.ctx.THREE || (await import('/@fs' + o.repo + '/node_modules/three/build/three.webgpu.js'));
  const scene = client.ctx.scene, camera = client.ctx.camera;
  if (!scene || !camera) return { fatal: 'ctx.scene / ctx.camera missing' };

  // A dedicated channel on a free layer (7..10 are the app's). 'flat' = one constant id
  // per mesh, which is exactly the baseId uniform under test.
  const CH = '__pickIdGate';
  ps.defineChannel(CH, { layer: 11, kind: 'flat' });

  // A quad pinned in front of the camera, filling the view, on the channel's layer only
  // for the pick pass (it also stays on 0, but we never render the main scene here).
  const geo = new THREE.PlaneGeometry(1000, 1000);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const wall = new THREE.Mesh(geo, mat);
  wall.frustumCulled = false;
  scene.add(wall);
  const place = () => {
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    wall.position.copy(camera.position).add(d.multiplyScalar(20));
    wall.quaternion.copy(camera.quaternion);
    wall.updateMatrixWorld(true);
  };

  // Aim at the centre of the picking target.
  const size = client.ctx.renderer.getSize(new THREE.Vector2());
  ps.setMousePosition(size.x / 2, size.y / 2);

  const results = [];
  try {
    for (const spec of o.ids) {
      // RESERVE the id space below the target so the REAL first-fit allocator hands out
      // the id we want — rather than writing pickStartId by hand, which would skip the
      // allocator and the guard entirely.
      const holder = new THREE.Mesh(new THREE.PlaneGeometry(0.001, 0.001), mat);
      holder.visible = false;
      scene.add(holder);
      let assigned = 0, allocErr = null;
      try {
        if (spec.id > 1) {
          ps.register(CH, holder, 'reservation', { material: mat, count: spec.id - 1 });
        }
        place();
        assigned = ps.register(CH, wall, 'the-wall');
      } catch (e) { allocErr = (e && e.message) || String(e); }

      let decoded = null, hit = null, err = allocErr;
      if (!err) {
        try {
          ps.markDirty();
          hit = await ps.pickAsync(CH, camera, scene);
          ps.markDirty();
          const t0 = ps._renderChannelPass(ps._channel(CH), camera, scene);
          const px = await ps.readPixelAsync(t0);
          decoded = px[3] * 0x1000000 + ((px[0] << 16) | (px[1] << 8) | px[2]);
          R.notes.push('id ' + spec.id + ' -> rgba ' + Array.from(px).join(','));
        } catch (e) { err = (e && e.message) || String(e); }
      }
      results.push({ want: spec.id, assigned, decoded, token: hit && hit.token, slot: hit && hit.slotIndex, err, why: spec.why });

      ps.unregister(CH, wall);
      ps.unregister(CH, holder);
      scene.remove(holder);
      holder.geometry.dispose();
    }
  } finally {
    scene.remove(wall);
    geo.dispose(); mat.dispose();
  }

  // ── teeth ───────────────────────────────────────────────────────────────────────
  for (const r of results) {
    const label = 'id ' + r.want;
    if (r.err) { tooth(label + ': no error', false, r.err + '  (' + r.why + ')'); continue; }
    tooth(label + ': allocator assigned it', r.assigned === r.want,
          'wanted ' + r.want + ', got ' + r.assigned + '  — ' + r.why);
    tooth(label + ': readback decodes EXACTLY', r.decoded === r.want,
          'rendered ' + r.want + ', read ' + r.decoded
          + (r.decoded !== null && r.decoded !== r.want ? '  (delta ' + (r.decoded - r.want) + ')' : '')
          + '  — ' + r.why);
    tooth(label + ': resolves to the aimed object', r.token === 'the-wall',
          'token=' + JSON.stringify(r.token) + ' slot=' + r.slot);
  }

  // TEETH ON THE TEETH: if nothing actually rendered, every comparison above is
  // vacuous. A pick of 0 means the pass drew nothing at the cursor.
  tooth('the pass actually drew (no id decoded as 0)',
        results.every((r) => r.err || r.decoded !== 0),
        'zero means the pick pass hit background — every id comparison above would be meaningless');
  tooth('distinct ids produced distinct readbacks',
        new Set(results.filter((r) => !r.err).map((r) => r.decoded)).size === results.filter((r) => !r.err).length,
        'two ids reading back the same value is the aliasing this gate exists to catch');

  R.results = results;
  return R;
})(${JSON.stringify(o)})`;

const main = async () => {
  const browser = await launchGpuBrowser({ headed: HEADED });
  let out;
  try {
    const { page } = await openApp(browser, { session: 'off', wait: 900 });
    out = await page.evaluate(probe({ repo: REPO, ids: IDS }));
  } finally { await browser.close(); }

  if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(out?.fatal || out.teeth.some((t) => !t.pass) ? 1 : 0); }
  if (out?.fatal) { console.error('FATAL: ' + out.fatal); process.exit(1); }

  let fail = 0;
  for (const t of out.teeth) {
    if (t.pass) console.log(`  ✓ ${t.name}${t.detail ? C.dim(' — ' + t.detail) : ''}`);
    else { fail++; console.log(`  ✗ ${t.name}${t.detail ? ' — ' + t.detail : ''}`); }
  }
  console.log(fail === 0 ? C.bold('\n✓ PASS  pick-id-gpu (ids past 2^24 survive the round trip)')
                         : C.bold(`\n✗ FAIL  pick-id-gpu — ${fail} tooth/teeth`));
  process.exit(fail === 0 ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
