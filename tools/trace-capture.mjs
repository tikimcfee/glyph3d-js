// trace-capture.mjs — capture a REAL Chrome trace (CPU stacks + GPU process + our
// performance.measure stage marks) around any bus command, headless, and print a
// digest. The artifact is the point: open it in DevTools Performance (load profile)
// or ui.perfetto.dev for the full call-stack timeline — loadTrace's stage measures
// ride along in blink.user_timing, so custom stages and real stacks share one clock.
//
//   bun tools/trace-capture.mjs --cmd 'file.openDir fake' --synthetic 450
//   bun tools/trace-capture.mjs --cmd 'repo.load tikimcfee/glyph3d-js'
//   bun tools/trace-capture.mjs --cmd 'grid.frame package.json 8' --out /tmp/frame.trace.json
//
// SAFETY: client-only (no relay). --synthetic N injects a fake provider with N
// generated ~9KB files under 'fake/' so file.openDir storms deterministically.
import { chromium } from 'playwright';
import { webgpuArgs } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const CMD = flag('--cmd', 'file.openDir fake');
const SYNTHETIC = Number(flag('--synthetic', CMD.includes('fake') ? '450' : '0'));
const OUT = flag('--out', '/tmp/g3d.trace.json');
const URL = flag('--url', 'http://localhost:5173/');

// Categories: renderer timeline + V8 sampling stacks + user_timing (loadTrace's
// performance.measure) + GPU process + Dawn. toplevel gives the RunTask spine.
const CATEGORIES = [
    'toplevel', 'v8.execute', 'devtools.timeline', 'blink.user_timing',
    'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-v8.cpu_profiler',
    'gpu', 'disabled-by-default-gpu.dawn',
];

const browser = await chromium.launch({
    headless: true,
    args: webgpuArgs(),
});
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.__glyphClient && !!window.__glyphClient.ctx.renderer', null, { timeout: 20000 });
    await page.waitForTimeout(4000);

    if (SYNTHETIC > 0) {
        await page.evaluate(`(() => {
            const c = window.__glyphClient;
            const mk = (seed) => Array.from({ length: 220 }, (_, i) =>
                'export function fn_' + seed + '_' + i + '(alpha, beta) { const gamma = alpha * ' + i + ' + beta; return { gamma, tag: "file-' + seed + '-line-' + i + '" }; }').join('\\n');
            const entries = [], contents = new Map();
            for (let f = 0; f < ${SYNTHETIC}; f++) {
                const p = 'srcgen/dir' + (f % 12) + '/file_' + f + '.js';
                const body = mk(f);
                entries.push({ path: p, size: body.length, type: 'file' });
                contents.set('fake/' + p, { content: body });
            }
            c.ctx.fileProvider = {
                listTree: async () => ({ entries, truncated: false }),
                filterCodeFiles: ({ tree }) => tree.filter((e) => e.path.endsWith('.js')),
                getMultipleFiles: async (_a, _b, want) => {
                    const m = new Map();
                    for (const p of want) if (contents.has(p)) m.set(p, contents.get(p));
                    return m;
                },
            };
        })()`);
    }

    await browser.startTracing(page, { path: OUT, screenshots: false, categories: CATEGORIES });
    const t0 = Date.now();
    const result = await page.evaluate(`window.__glyphClient.router.execute(${JSON.stringify(CMD)})`);
    await page.waitForTimeout(500);   // let trailing frames/GPU work land in the trace
    await browser.stopTracing();
    console.log(`cmd: ${CMD} → ${JSON.stringify(result?.text?.slice(0, 80))} (wall ${Date.now() - t0}ms)`);
    console.log(`trace: ${OUT} — open in DevTools Performance ("Load profile…") or ui.perfetto.dev\n`);

    // ---- digest: long main-thread tasks, our stage measures, per-name totals, GPU ----
    const parsed = JSON.parse(await Bun.file(OUT).text());
    const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents || parsed.events || []);
    const threads = new Map();   // pid:tid → name
    for (const e of events) {
        if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
    }
    const mainKey = [...threads.entries()].find(([, n]) => n === 'CrRendererMain')?.[0];
    const gpuKeys = new Set([...threads.entries()].filter(([, n]) => /Gpu|VizCompositor/i.test(n)).map(([k]) => k));

    const onMain = (e) => `${e.pid}:${e.tid}` === mainKey;
    const xs = events.filter((e) => e.ph === 'X' && e.dur > 0);

    // Our loadTrace stages (performance.measure → blink.user_timing).
    const measures = events.filter((e) => e.cat?.includes('blink.user_timing') && (e.ph === 'b' || e.ph === 'X'))
        .map((e) => `${e.name}${e.dur ? ` ${(e.dur / 1000).toFixed(0)}ms` : ''}`);
    if (measures.length) console.log('stage measures in-trace:', measures.slice(0, 12).join(' · '));

    // Longest top-level tasks on the renderer main thread, each with its fattest child.
    const tasks = xs.filter((e) => onMain(e) && e.name === 'RunTask' && e.dur > 50_000)
        .sort((a, b) => b.dur - a.dur).slice(0, 10);
    console.log(`\nlong main-thread tasks (>50ms): ${tasks.length ? '' : 'none'}`);
    for (const t of tasks) {
        const WRAPPERS = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'RunMicrotasks',
            'BlinkScheduler_PerformMicrotaskCheckpoint', 'TimerFire', 'FunctionCall', 'FireAnimationFrame']);
        const kids = xs.filter((e) => onMain(e) && e !== t && !WRAPPERS.has(e.name)
            && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur)
            .sort((a, b) => b.dur - a.dur);
        const top = kids[0];
        const fn = top?.args?.data?.functionName || top?.args?.data?.url?.split('/').pop() || '';
        console.log(`  ${(t.dur / 1000).toFixed(0).padStart(5)}ms  → ${top ? `${top.name} ${fn} (${(top.dur / 1000).toFixed(0)}ms)` : '(opaque)'}`);
    }

    // Main-thread totals by event name (self-dur approximation: leaf events only).
    const byName = new Map();
    for (const e of xs) {
        if (!onMain(e) || e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') continue;
        byName.set(e.name, (byName.get(e.name) || 0) + e.dur);
    }
    console.log('\nmain-thread totals by event:');
    for (const [n, us] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`  ${(us / 1000).toFixed(0).padStart(6)}ms  ${n}`);
    }

    // GPU-process presence — proof the gpu categories captured (depth belongs to perfetto).
    const gpuUs = xs.filter((e) => gpuKeys.has(`${e.pid}:${e.tid}`)).reduce((a, e) => a + e.dur, 0);
    const dawnEvents = events.filter((e) => e.cat?.includes('gpu.dawn')).length;
    console.log(`\ngpu process: ${(gpuUs / 1000).toFixed(0)}ms of events across ${gpuKeys.size} thread(s); dawn events: ${dawnEvents}`);
} finally {
    await browser.close();
}
