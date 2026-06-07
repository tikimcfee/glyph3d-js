// smoke.mjs — ad-hoc: boot the app in a real (WebGPU) browser, optionally drive verbs /
// eval / screenshot, report console + resource errors, exit non-zero on real JS errors.
// This is what catches render-crash bugs (e.g. an undefined variable in a component)
// before they reach the browser by hand.
//
//   bun tools/smoke.mjs [--url URL] [--shot OUT.png] [--headed] [--wait MS] [--cmd 'verb arg']... [--eval 'expr']
//
//   bun tools/smoke.mjs                                          # boot :5173, report errors
//   bun tools/smoke.mjs --headed --shot /tmp/app.png            # real GPU render + screenshot
//   bun tools/smoke.mjs --cmd 'repo.load owner/repo' --cmd 'file.open path.go' --eval '<expr>'
//
// For structured, repeatable assertions across many steps, write a tools/itests/*.itest.mjs
// and run tools/itest.mjs — both share tools/itest/driver.mjs. Needs the dev loop up
// (tools/dev.sh). --headed gives real WebGPU on a GPU box; headless still catches JS
// errors (GPU-init noise + resource 404s are reported, not counted as failures).

import { launchBrowser, openApp } from './itest/driver.mjs';

function parseArgs(argv) {
  const a = { url: 'http://localhost:5173/', shot: null, headed: false, wait: 5000, cmds: [], eval: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--url') a.url = argv[++i];
    else if (t === '--shot') a.shot = argv[++i];
    else if (t === '--headed') a.headed = true;
    else if (t === '--wait') a.wait = Number(argv[++i]);
    else if (t === '--cmd') a.cmds.push(argv[++i]);
    else if (t === '--eval') a.eval = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const browser = await launchBrowser({ headed: args.headed });
const app = await openApp(browser, { url: args.url, wait: args.wait });

try {
  for (const cmd of args.cmds) {
    const r = await app.cmd(cmd);
    console.log(`cmd: ${cmd} → ${r.error ? 'ERROR ' + r.error : (r.text ?? 'ok')}`);
    await app.waitFor(3000); // repo fetch / file open / lazy grammar load + colorize are async
  }
  if (args.cmds.length) await app.waitFor(2500); // final settle
  if (args.eval) {
    const r = await app.evalPage(args.eval).catch((e) => ({ evalError: e?.message || String(e) }));
    console.log('eval:', JSON.stringify(r, null, 2));
  }
  if (args.shot) { await app.shot(args.shot); console.log(`shot: ${args.shot}`); }
} finally {
  const { booted, errors, gpuErrors, failedResources, warnings } = app;
  console.log(`\n── smoke report ──`);
  console.log(`url:    ${args.url}   (${args.headed ? 'headed' : 'headless'})`);
  console.log(`booted: ${booted ? 'yes (window.__glyphClient present)' : 'NO — app did not initialize'}`);
  console.log(`errors: ${errors.length} | failed-resources: ${failedResources.length} | gpu-noise: ${gpuErrors.length} | warnings: ${warnings.length}`);
  for (const e of errors) console.log(`  ✗ [${e.kind}] ${e.text}`);
  for (const r of [...new Set(failedResources)].slice(0, 12)) console.log(`  ↯ ${r}`);
  for (const w of warnings.slice(0, 12)) console.log(`  ⚠ ${w}`);
  if (gpuErrors.length) console.log(`  (gpu-noise, non-fatal: ${gpuErrors[0].text.slice(0, 80)}…)`);
  await browser.close();
  const ok = booted && errors.length === 0;
  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exit(ok ? 0 : 1);
}
