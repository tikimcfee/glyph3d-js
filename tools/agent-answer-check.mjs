#!/usr/bin/env bun
// agent-answer-check.mjs — answering an agent from the display, END TO END, without touching the
// person's display or their agents (slice 1b's live gate).
//
//   bun tools/agent-answer-check.mjs [--port 8097] [--url http://localhost:5173/] [--keep]
//
// It spawns a SCRATCH gomuxai agent (a plain shell: `agent spawn <name> --backend shell`), starts a
// PRIVATE relay (scratch root, scratch tmux socket for its own terminals, gomuxai ON so the hub sees
// the agent) and a private headless display whose store has gomux.input ON and gomux.autoScreens
// OFF — the person's display and settings are never touched. Through the bus it then:
//   - agent.say <scratch> echo <token>  → the text is typed at the agent's prompt (agent capture),
//     through gomuxai's `agent send`, signed "[from a person on <host>]" — never as the agent whose
//     shell started the relay
//   - agent.say from an IDENTIFIED caller → refused, and nothing reaches the pane
//   - agent.approve <scratch> with no permission prompt pending → refused, nothing sent (never blind)
//   - agent.say to a name gomuxai doesn't know → refused
// and cleans up the scratch agent, relay, display and root (--keep leaves the agent for a look).
// Exits non-zero on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launchGpuBrowser } from './itest/driver.mjs';
import { dialRelay } from './lib/relay.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('port', '8097'));
const viteUrl = opt('url', 'http://localhost:5173/');
const keep = argv.includes('--keep');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AGENT = spawnSync('sh', ['-c', 'command -v agent'], { encoding: 'utf8' }).stdout.trim() || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const report = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${name.padEnd(22)} ${detail}`); };

if (!AGENT) { console.error('agent-answer-check: no gomuxai `agent` on PATH'); process.exit(2); }
const name = `answer-check-${process.pid}`;
const token = `answer-ok-${process.pid}-${Math.floor(performance.now())}`;   // lowercase, one token
const agent = (...a) => spawnSync(AGENT, a, { encoding: 'utf8', timeout: 30000 });
const paneText = () => agent('capture', name, '--lines', '300').stdout || '';
// The answer as the agent received it: gomuxai's `agent send` types "[from <sender>] <text>" at its
// prompt — the sender must be the PERSON, never the agent whose shell started the relay.
// The pane is 80 columns: a long typed line wraps, so read the pane with its wrapped rows joined and
// take the stretch from the prompt's "[from" up to the token.
const typedLine = (tok) => {
    const flat = paneText().split('\n').map((l) => l.replace(/\s+$/, '')).join('');
    const at = flat.indexOf(tok);
    if (at < 0) return null;
    const from = flat.lastIndexOf('[from', at);
    return flat.slice(from >= 0 ? from : Math.max(0, at - 80), at + tok.length);
};

let scratch = null, relayProc = null, browser = null, relay = null, spawned = false;
try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphd-answer-'));
    // The scratch agent: a plain shell, so a sent line simply RUNS and its output is plain to read.
    const sp = spawnSync(AGENT, ['spawn', name, '--backend', 'shell'], { cwd: scratch, encoding: 'utf8', timeout: 30000 });
    spawned = sp.status === 0;
    if (!spawned) throw new Error(`agent spawn failed: ${(sp.stderr || sp.stdout || '').trim()}`);
    await sleep(1500);

    relayProc = spawn(path.join(ROOT, 'glyph3d-cli'), ['serve', '--relay-only', '--port', String(port), '--listen', '127.0.0.1',
        '--tmux-socket', `glyphd-answer-${process.pid}`, scratch], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    for (let i = 0; i < 150; i++) {
        if (relayProc.exitCode != null) throw new Error(`relay exited (${relayProc.exitCode})`);
        if (spawnSync('sh', ['-c', `ss -ltn | grep -q ':${port} '`]).status === 0) break;
        await sleep(100);
    }

    browser = await launchGpuBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
        localStorage.setItem('g3d.gomux.input', 'true');          // this private display only
        localStorage.setItem('g3d.gomux.autoScreens', 'false');   // never open an agent's screen
    });
    const page = await context.newPage();
    await page.goto(`${viteUrl}${viteUrl.includes('?') ? '&' : '?'}relay=${port}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__glyphClient?.ctx?.wsbridge?.connected), { timeout: 30000 });

    relay = await dialRelay(port);
    const req = (line, ms = 20000) => relay.request(line, ms);
    // The hub must know the scratch agent before answering it (agent.say refuses unknown names).
    let known = false;
    for (let i = 0; i < 60 && !known; i++) {
        const l = await req('gomux.list').catch(() => null);
        known = (l?.data?.agents ?? []).some((a) => a.name === name);
        if (!known) await sleep(1000);
    }
    report('hub knows the agent', known, known ? `'${name}' in gomux.list` : `'${name}' never appeared in gomux.list`);

    // 1. The answer reaches the agent's prompt, signed as the person.
    const say = await req(`agent.say ${name} echo ${token}`);
    let line = null;
    for (let i = 0; i < 30 && !line; i++) { line = typedLine(token); if (!line) await sleep(500); }
    report('agent.say lands', say.text?.startsWith('OK') && !!line, `${say.text?.split('\n')[0]} — ${line ? `typed at its prompt: ${line.trim().slice(0, 100)}` : 'never reached the pane'}`);
    report('signed as the person', !!line && /\[from a person on /.test(line), line ? (/\[from a person on /.test(line) ? 'gomuxai signed it "[from a person on …]"' : `signed otherwise: ${line.trim().slice(0, 80)}`) : 'nothing to read');

    // 2. An identified caller is refused, and nothing reaches the pane.
    // dialRelay connects anonymously; the identified case goes through glyph3d-cli --as.
    const t2 = `${token}-ident`;
    const cli = spawnSync(path.join(ROOT, 'glyph3d-cli'), ['--port', String(port), '--as', 'some-agent', 'agent.say', name, 'echo', t2], { encoding: 'utf8', timeout: 20000 });
    await sleep(1500);
    const identOut = `${cli.stdout}${cli.stderr}`;
    const leaked = !!typedLine(t2);
    report('identified refused', /person's verb/.test(identOut) && !leaked, `${(identOut.match(/ERR:.*/) || [identOut.trim().split('\n').pop()])[0].slice(0, 110)}${leaked ? ' — BUT it reached the pane' : ''}`);

    // 3. Approve with nothing pending: refused, nothing sent.
    const ap = await req(`agent.approve ${name}`);
    report('approve never blind', /^ERR/.test(ap.text ?? '') && /no pending tool/.test(ap.text ?? ''), ap.text?.split('\n')[0]);

    // 4. An unknown agent: refused.
    const unk = await req(`agent.say no-such-agent-${process.pid} hi`);
    report('unknown refused', /^ERR/.test(unk.text ?? ''), unk.text?.split('\n')[0]);
} catch (e) {
    report('run', false, e.message);
} finally {
    try { relay?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    if (relayProc) { try { relayProc.kill('SIGTERM'); } catch { /* ignore */ } }
    spawnSync('tmux', ['-L', `glyphd-answer-${process.pid}`, 'kill-server'], { stdio: 'ignore' });
    if (spawned && !keep) agent('cleanup', name);
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
}
console.log(`${failed ? 'FAIL' : 'PASS'} agent-answer-check: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
