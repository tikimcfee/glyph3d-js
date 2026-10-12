/**
 * glyph-cull-truth.mjs — is every glyph mesh's stated bounds TRUE? three culls (and depth-sorts
 * transparents) by geometry.boundingSphere × matrixWorld, and an InstancedBufferGeometry's
 * bounds can't be computed by three (it only sees the base quad) — so each field STATES its
 * extent (InstancedField.setLayoutExtent). A quad drawn outside that box can be culled while
 * on screen. This walks every glyph mesh in the live scene and tests every slot's ACTUAL quad,
 * built the way the vertex shader builds it (glyphMaterial: mode-1 emoji quads are height
 * wide, every quad × uWidthCompress, y = center ± height/2), against geometry.boundingBox.
 *
 *   bun tools/glyph-cull-truth.mjs --dir ABS [--file ABS] [--url URL] [--relay 8099] [--compress K,K,…]
 *
 * Scenes: the --dir load (FileRows in the content tree), one opened CodeGrid per layout
 * preset, an arranged grid (structure.grid), and a TerminalGrid fed bytes in-page (no relay
 * terminal — nothing touches tmux). Each check runs at every --compress value (default 1,3:
 * the dial's default and its max).
 *
 * Needs Vite + a PRIVATE relay serving a scratch root (see tools/frame-profile.mjs).
 * Exit 1 if any quad escapes its mesh's bounds.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { resolve, dirname } from 'node:path';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const COMPRESS = (arg('--compress', '1,3')).split(',').map(Number);
if (!DIR) { console.error('--dir ABS is required (inside the relay root)'); process.exit(2); }
const FILE = arg('--file', resolve(dirname(DIR), 'mixed/emoji_tabs_wide.txt'));
const JSFILE = arg('--js', resolve(DIR, 'collections/StrataLayout.js'));
const CORE = resolve(import.meta.dir, '../packages/glyph3d-core/src');

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: 1600, height: 1000 } });
    if (!app.booted) throw new Error('app did not boot');
    await app.cmd(`file.openDir ${DIR}`);
    await app.waitFor(5000);

    // Scene builders, run in-page. Every one leaves its fields in the scene for the census.
    const setup = await app.evalPage(async ({ file, core }) => {
        const c = window.__glyphClient;
        const notes = [];
        // An opened CodeGrid on the emoji/tab/wide file (the preset stages re-fold it).
        const open = await c.router.execute(['file.open', file]);
        notes.push(`open: ${(open?.text ?? open?.error ?? '').slice(0, 70)}`);
        // A terminal, fed bytes directly (no relay adapter, no tmux). Workspace sources are
        // served un-bundled, so this /@fs URL is the module instance the app itself uses.
        const mod = await import(`/@fs${core}/collections/TerminalGrid.js`).catch((e) => ({ err: String(e) }));
        if (mod?.default) {
            const term = new mod.default(c.ctx.scene, c.ctx.atlas, { cols: 100, rows: 30, depthMax: 4 });
            let out = '';
            for (let i = 0; i < 90; i++) out += `row ${i}\t\x1b[3${i % 8}mcolored\x1b[0m 😀 ${'#'.repeat(i % 80)}\r\n`;
            term.writeBytes(out);
            window.__cullTruthTerm = term;
            notes.push('terminal: built + fed');
        } else notes.push(`terminal: import failed ${mod?.err ?? ''}`);
        return notes;
    }, { file: FILE, core: CORE });
    console.log(setup.map((n) => `[setup] ${n}`).join('\n'));
    await app.waitFor(3000);

    const presets = ['long-column', 'newspaper', 'no-wrap', 'wall', 'z-pages'];
    const stages = [...presets.map((p) => ({ name: `preset ${p}`, verbs: [`grid.layout ${FILE} ${p}`] })),
        { name: 'arranged (structure.grid)', verbs: [`file.open ${JSFILE}`, `structure.grid ${JSFILE}`] }];

    for (const stage of [{ name: 'as loaded', verbs: [] }, ...stages]) {
        for (const v of stage.verbs) {
            const r = await app.cmd(v);
            const t = (r.text ?? r.error ?? '').replace(/\s+/g, ' ');
            if (/^ERR|error/i.test(t)) console.log(`  [${v.split(' ')[0]}] ${t.slice(0, 110)}`);
            await app.waitFor(1500);
        }
        for (const k of COMPRESS) {
            await app.cmd(`settings.set glyph.widthCompress ${k}`);
            const r = await app.evalPage(async (k) => {
                const c = window.__glyphClient;
                await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
                const meshes = [];
                c.ctx.scene.traverse((o) => { if (o.userData?.glyphField && o.geometry?.instanceCount > 0) meshes.push(o); });
                let slots = 0, escaped = 0, worst = null, noBox = 0, culledOn = 0;
                const byKind = {};
                const kindOf = (m) => { for (let p = m.parent; p; p = p.parent) if (/Grid|FileRow|FieldLabel|Book|Labels/.test(p.constructor.name)) return p.constructor.name; return m.parent?.constructor?.name ?? '?'; };
                for (const m of meshes) {
                    const f = m.userData.glyphField;
                    if (m.frustumCulled) culledOn++;
                    const box = m.geometry.boundingBox;
                    if (!box && !m.frustumCulled) continue;   // three won't cull it — no claim to check
                    if (!box) { noBox++; byKind[`${kindOf(m)}(no bounds)`] = (byKind[`${kindOf(m)}(no bounds)`] ?? 0) + 1; continue; }
                    const map = f.glyphMapTexture?.image?.data, mapW = f.glyphMapWidth;
                    const kW = m.material.uniforms.uWidthCompress?.value || 1;
                    const f32 = f.slotBuffer.f32, n = m.geometry.instanceCount;
                    for (let s = 0; s < n; s++) {
                        const b = s * 8, x = f32[b], y = f32[b + 1], z = f32[b + 2];
                        const gid = Math.round(f32[b + 3]), adv = f32[b + 6], h = f32[b + 7];
                        if (h === 0) continue;   // hidden (arranger park): draws nothing
                        const mode = map ? map[(gid % mapW + Math.floor(gid / mapW) * mapW) * 4 + 2] : 0;
                        const w = (mode === 1 ? h : adv) * kW;
                        slots++;
                        const eps = 1e-3;
                        const out = Math.max(box.min.x - x, x + w - box.max.x, box.min.y - (y - h / 2), (y + h / 2) - box.max.y, box.min.z - z, z - box.max.z);
                        if (out > eps) {
                            escaped++;
                            const kk = kindOf(m); byKind[kk] = (byKind[kk] ?? 0) + 1;
                            if (!worst || out > worst.by) {
                                const axis = ['-x', '+x', '-y', '+y', '-z', '+z'][[box.min.x - x, x + w - box.max.x, box.min.y - (y - h / 2), (y + h / 2) - box.max.y, box.min.z - z, z - box.max.z].indexOf(out)];
                                worst = { by: +out.toFixed(3), axis, mesh: kindOf(m), slot: s, mode, h: +h.toFixed(3), box: [box.min.y.toFixed(2), box.max.y.toFixed(2), box.min.z.toFixed(2), box.max.z.toFixed(2)].join('|'), at: [x, y, z].map((v) => +v.toFixed(2)) };
                            }
                        }
                    }
                }
                return { meshes: meshes.length, culledOn, slots, escaped, noBox, worst, byKind };
            }, k);
            const ok = r.escaped === 0 && r.noBox === 0;
            if (!ok) failed++;
            console.log(`${ok ? '✓' : '✗'} ${stage.name.padEnd(28)} compress ${String(k).padEnd(4)} meshes ${r.meshes} (culled ${r.culledOn}) · ${r.slots} quads · ${r.escaped} escape${r.noBox ? ` · ${r.noBox} with NO bounds` : ''}${r.escaped || r.noBox ? ` · by kind ${JSON.stringify(r.byKind)}` : ''}${r.worst ? `\n      worst ${JSON.stringify(r.worst)}` : ''}`);
        }
    }
    await app.cmd('settings.reset glyph.widthCompress');
    if (app.errors.length) console.log('page errors:', JSON.stringify(app.errors.slice(0, 3)));
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
