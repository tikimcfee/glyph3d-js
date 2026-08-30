// cli-flag-order.test.mjs — behavior lock on glyph3d-cli's argument parsing.
//
//   bun tools/cli-flag-order.test.mjs
//
// The defect: Go's flag package stops parsing at the FIRST non-flag token, so
// `serve <dir> --port 8121 --relay-only` parsed zero flags. The port and the mode
// the operator typed were dropped on the floor and the 8080 DEFAULT was bound
// instead — announced in the banner as if it had been asked for. That is the
// silent-fallback shape CLAUDE.md forbids at substrate seams, and `tools/dev.sh`
// carried the same ordering, so `RELAY_PORT=9000 tools/dev.sh relay` served 8080.
//
// This test drives the REAL BINARY, not the parse function: a unit test on
// parseServeArgs still passes if serveCmd stops calling it. It also runs dev.sh's
// own invocation, lifted verbatim out of the script, so the script cannot drift
// back to an ordering the binary won't honor.
//
// PORTS: 8121/8122 only. Never 8080 (the live relay), 5173 (Vite), or 8099/5174.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = path.join(ROOT, 'cli');
const PORT_A = 8121;
const PORT_B = 8122;
const PORT_C = 8123; // sentinel: the port a BROKEN build binds, so it never reaches for 8080
const FORBIDDEN = [8080, 5173, 8099, 5174];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
const die = (msg) => { console.error(`FATAL: ${msg}`); process.exit(2); };

// ── build the binary under test ───────────────────────────────────────────────
// go:embed all:web needs cli/web to exist (make prep stages the Vite build there).
// A stub satisfies the compiler; nothing here serves static files (--relay-only).
const webDir = path.join(CLI_DIR, 'web');
if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>stub for go:embed</title>\n');
    console.log(`  (created ${webDir}/index.html — go:embed placeholder; make prep overwrites it)`);
}
if (!fs.existsSync(path.join(CLI_DIR, 'go.sum'))) die('cli/go.sum missing (it is gitignored) — run `make build` once, or copy it in');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-flagtest-'));
const BIN = path.join(outDir, 'glyph3d-cli');
const build = spawnSync('go', ['build', '-o', BIN, '.'], { cwd: CLI_DIR, encoding: 'utf8' });
if (build.status !== 0) die(`go build failed:\n${build.stderr}`);

// Provenance: a stale binary that passes is the ambiguous negative this repo keeps
// getting bitten by. Print what we built and what we built it FROM.
const binStat = fs.statSync(BIN);
const srcNewest = ['args.go', 'main.go'].map((f) => fs.statSync(path.join(CLI_DIR, f)).mtime);
console.log(`binary: ${BIN}`);
console.log(`        built ${binStat.mtime.toISOString()} (${binStat.size} bytes)`);
console.log(`source: cli/args.go ${srcNewest[0].toISOString()} · cli/main.go ${srcNewest[1].toISOString()}`);
if (srcNewest.some((m) => m > binStat.mtime)) die('binary is older than its sources — refusing to test a stale build');

// ── helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 400);
});

async function waitForPort(port, ms = 6000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await portOpen(port)) return true;
        await sleep(100);
    }
    return false;
}

// Run the binary to completion (for the invocations that must REFUSE to run).
// SIGKILL on timeout: a build that does NOT refuse starts a server, and a lingering
// one must not outlive this process.
const run = (args, ms = 4000) =>
    spawnSync(BIN, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', cwd: ROOT });

// Start a server invocation, return { child, output(), stop() }.
function start(args) {
    const child = spawn(BIN, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    return {
        child,
        output: () => buf,
        stop: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
    };
}

const started = [];
process.on('exit', () => started.forEach((s) => s.stop()));

// ── guard: never test on a port someone is using ──────────────────────────────
for (const p of [PORT_A, PORT_B, PORT_C]) {
    if (await portOpen(p)) die(`port ${p} is already in use — this test refuses to fight over it`);
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-flagproj-'));

console.log('\n── the reported invocation: flags AFTER the positional dir ──');
{
    // The reported command is `serve <dir> --port PORT_A --relay-only`. The leading
    // `--port PORT_C` is a SENTINEL, not part of the case: a build that stops parsing
    // at <dir> keeps PORT_C (a scratch port) instead of falling back to the 8080
    // default and fighting the operator's live relay. Repeated flags are last-wins, so
    // a build that parses past <dir> must land on PORT_A — and PORT_C must stay shut.
    const s = start(['serve', '--port', String(PORT_C), projectDir, '--port', String(PORT_A), '--relay-only']);
    started.push(s);
    const up = await waitForPort(PORT_A);
    ok(up, `serve <dir> --port ${PORT_A} --relay-only binds ${PORT_A}`);
    ok(!(await portOpen(PORT_C)), `the flag after <dir> WON — nothing is listening on the sentinel ${PORT_C}`);
    const out = s.output();
    ok(new RegExp(`:${PORT_A}\\b`).test(out), `banner names the requested port (got: ${out.trim().split('\n').pop() || '<no output>'})`);
    ok(!FORBIDDEN.some((p) => out.includes(`:${p}`)), 'no default port appears in the output');
    // --relay-only is honored: the relay banner, not the static-server banner.
    ok(!/glyph3d-cli — single-binary server/.test(out), '--relay-only after the dir is honored (relay banner, not the server banner)');
    s.stop();
    await sleep(200);
}

console.log("\n── tools/dev.sh's own invocation, lifted from the script ──");
{
    const devsh = fs.readFileSync(path.join(ROOT, 'tools', 'dev.sh'), 'utf8');
    const line = devsh.split('\n').find((l) => l.includes('./glyph3d-cli serve'));
    ok(!!line, 'found the serve invocation in tools/dev.sh');
    const m = line.match(/\.\/glyph3d-cli\s+(.*?)\s*>"?\$/);
    ok(!!m, 'parsed its argv');
    const argv = m[1].split(/\s+/)
        .map((t) => t.replace(/"/g, ''))
        .map((t) => (t === '$RELAY_PORT' ? String(PORT_B) : t === '$ROOT' ? projectDir : t));
    console.log(`  dev.sh argv → ${argv.join(' ')}`);
    // SAFETY + the real assertion in one: if dev.sh stopped passing the port through,
    // running this argv would bind the 8080 DEFAULT — i.e. fight the operator's live
    // relay. Fail here instead of spawning it.
    if (!argv.includes(String(PORT_B))) {
        fail++;
        console.log(`  ✗ dev.sh does not pass RELAY_PORT through to the binary (argv: ${argv.join(' ')}) — not running it`);
    } else {
        const s = start([...argv, '--relay-only']);
        started.push(s);
        ok(await waitForPort(PORT_B), `dev.sh's invocation honors RELAY_PORT (bound ${PORT_B})`);
        ok(!s.output().includes(':8080'), 'dev.sh invocation never mentions the 8080 default');
        s.stop();
        await sleep(200);
    }
}

console.log('\n── a flag-shaped argument that is not a flag must be LOUD ──');
{
    // Every invocation here MUST exit 2 without serving. `--port PORT_A` leads so that
    // a build which fails to refuse binds a scratch port rather than the 8080 default —
    // the operator's live relay is not this test's to fight over. (Observed while
    // mutating: with the defect reinstated, `serve <dir> --nope` did exactly that.)
    const safe = ['serve', '--port', String(PORT_A), projectDir];

    const r = run([...safe, '--nope']);
    ok(r.status === 2, `undefined flag after the dir exits 2 (got ${r.status})`);
    ok(/nope/.test(r.stderr || ''), `stderr names the offending flag (got: ${(r.stderr || '').trim().split('\n')[0] || '<none>'})`);

    const typo = run([...safe, '--prot', String(PORT_B)]);
    ok(typo.status === 2, `a typo'd --prot exits 2 instead of quietly serving (got ${typo.status})`);

    const two = run([...safe, '/tmp']);
    ok(two.status === 2, `a second positional directory is refused (got ${two.status})`);
    // Match the refusal itself, not merely a path that also appears in a startup
    // banner — /tmp/ alone passed under the defect because the banner lists reach dirs.
    ok(/^glyph3d-cli serve: serve takes at most one directory/m.test(two.stderr || ''),
        `the refusal states the rule (got: ${(two.stderr || '').trim().split('\n')[0] || '<none>'})`);
}

console.log('\n── one-shot: a global flag after the verb is refused before dialing ──');
{
    // --host points at a DEAD scratch port: if the guard ever regresses, the binary
    // dials that instead of the operator's live relay on 8080 (and the failed dial is
    // itself the tell — a refusal must happen before any connection).
    const r = run(['--host', `ws://127.0.0.1:${PORT_C}`, 'grid.list', '--json']);
    ok(r.status === 2, `exits 2 (got ${r.status})`);
    ok(/--json/.test(r.stderr) && /BEFORE/.test(r.stderr), `stderr explains the ordering (got: ${(r.stderr || '').trim()})`);
    ok(!/dial|connect:/.test(r.stderr), 'refused before opening a connection');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
