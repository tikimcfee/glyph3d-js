#!/usr/bin/env bun
// agent-replay — replay a REAL agent session into the agent books, as a big, repeatable
// stress fixture. Reads a session transcript (claude: ~/.claude/projects/...; kimi with
// --kimi: ~/.kimi-code/sessions/... wire.jsonl) through the core session adapter,
// forwards every tool_use as `agent.tool` and every assistant text/thinking block as
// `agent.message` (the same pair the live hook sends), streamed over the relay (same WS the CLI
// uses). So we stop hand-rebuilding state and instead fly a real run of hundreds of actions.
//
//   bun tools/agent-replay.mjs                                  # latest session, 1 agent, all
//   bun tools/agent-replay.mjs --limit 200 --split-agents 6 --rate 25
//   bun tools/agent-replay.mjs --session <path.jsonl> --dry     # preview the parse, send nothing
//   bun tools/agent-replay.mjs --kimi --dry                     # latest KIMI session (wire.jsonl)
//
// FLAGS
//   --session <path|latest>  session transcript (default: newest in this project's archive;
//                            with --kimi, a direct wire.jsonl path)
//   --kimi                   replay a Kimi Code session (wire.jsonl via session_index.jsonl)
//                            instead of a Claude Code one
//   --agent <prefix>         agent id / id prefix (default 'run')
//   --split-agents N         round-robin actions across N agents → N books (default 1)
//   --limit N                cap to the first N actions
//   --latest N               cap to the LAST N actions (the most recent — what you usually want
//                            on a chunky session; applied after --limit)
//   --rate <ms>              delay between sends (default 0; the WS reply already paces)
//   --port N                 relay port (default 8080)
//   --no-clear               don't `agent.clear all` first
//   --no-conv                skip conversation (text/thinking → agent.message) forwarding
//   --dry                    parse + print a summary, send nothing

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeToolCall } from '../packages/glyph3d-core/src/collections/toolRegistry.js';
import { parseClaudeSession, parseKimiSession } from '../packages/glyph3d-core/src/collections/sessionAdapter.js';

const VALUE = new Set(['session', 'agent', 'split-agents', 'limit', 'latest', 'rate', 'port']);
const BOOL = new Set(['kimi', 'no-clear', 'no-conv', 'dry', 'help']);
const flags = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (BOOL.has(k)) flags[k] = true;
    else if (VALUE.has(k)) flags[k] = a[++i];
    else { console.error(`[agent-replay] unknown flag ${a[i]}`); process.exit(2); }
  }
}

// The repo is wherever this script lives; the Claude project dir derives from that
// path by the harness's naming convention (separators → dashes) — machine-portable.
const REPO = new URL('..', import.meta.url).pathname;
const PROJ = path.join(os.homedir(), '.claude/projects',
  REPO.replace(/\/$/, '').replace(/[/.]/g, '-'));
const KIMI_INDEX = path.join(os.homedir(), '.kimi-code/session_index.jsonl');
const PORT = Number(flags.port ?? 8080);
const RATE = Number(flags.rate ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestSession() {
  const files = fs.readdirSync(PROJ).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, t: fs.statSync(path.join(PROJ, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) { console.error(`[agent-replay] no .jsonl in ${PROJ}`); process.exit(2); }
  return path.join(PROJ, files[0].f);
}

// Kimi: the session index (one {sessionId, sessionDir, workDir} JSON per line) is the ONLY
// map from a project root to its sessions — the workspace dir names carry an opaque hash.
// Newest main-agent wire.jsonl for this repo wins.
function latestKimiSession() {
  let lines = [];
  try { lines = fs.readFileSync(KIMI_INDEX, 'utf8').split('\n'); } catch { /* no kimi yet */ }
  const cands = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || String(e.workDir || '').replace(/\/$/, '') !== REPO.replace(/\/$/, '')) continue;
    const wire = path.join(e.sessionDir, 'agents/main/wire.jsonl');
    try { cands.push({ wire, t: fs.statSync(wire).mtimeMs }); } catch { /* no main wire */ }
  }
  if (!cands.length) { console.error(`[agent-replay] no kimi sessions for ${REPO} in ${KIMI_INDEX}`); process.exit(2); }
  cands.sort((a, b) => b.t - a.t);
  return cands[0].wire;
}

const sessionPath = flags.kimi
  ? ((!flags.session || flags.session === 'latest') ? latestKimiSession() : flags.session)
  : ((!flags.session || flags.session === 'latest') ? latestSession() : flags.session);

// The replay is a DUMB FORWARDER: the core session adapter (parseClaudeSession /
// parseKimiSession) reads the transcript into the ordered tool/message event stream —
// result text already paired + merged, kimi's dialect already translated to Claude shapes —
// and the ONE tool registry derives action/target/detail/result/meta from each raw tool
// event. That's the SAME pair of seams the live hook rides, so replay and live can't drift.
const TYPE = flags.kimi ? 'kimi' : 'claude';
const session = flags.kimi
  ? parseKimiSession(fs.readFileSync(sessionPath, 'utf8'), REPO)
  : parseClaudeSession(fs.readFileSync(sessionPath, 'utf8'));

let events = [];
for (const e of session.events) {
  if (e.kind === 'tool') {
    const rec = normalizeToolCall(e.name, e.input, e.response, REPO);   // null = a noise tool (TodoWrite/ToolSearch/…)
    if (rec) events.push({ ...e, action: rec.action, target: rec.target, detail: rec.detail });
  } else if (!flags['no-conv']) {
    events.push(e);   // assistant text/thinking → agent.message (hook parity)
  }
}

// --limit / --latest count TOOL ACTIONS (messages ride along with the kept span): --limit N keeps
// everything up to the Nth action; --latest N keeps everything from the Nth-from-last action on
// (so the tail's trailing prose comes too).
const toolIdx = () => events.flatMap((e, i) => (e.kind === 'tool' ? [i] : []));
if (flags.limit) {
  const t = toolIdx(), n = Number(flags.limit);
  events = t.length > n ? events.slice(0, t[n - 1] + 1) : events;
}
if (flags.latest) {
  const t = toolIdx(), n = Number(flags.latest);
  events = t.length > n ? events.slice(t[t.length - n]) : events;
}
const actions = events.filter((e) => e.kind === 'tool');
const messages = events.length - actions.length;

const A = Math.max(1, Number(flags['split-agents'] || 1));
const prefix = flags.agent || 'run';
const agentId = (i) => (A === 1 ? prefix : `${prefix}${(i % A) + 1}`);

// summary
const byType = {};
for (const m of actions) byType[m.action] = (byType[m.action] || 0) + 1;
const withFile = actions.filter((m) => m.target).length;
console.error(`[agent-replay] session: ${path.basename(sessionPath)} (${TYPE})`);
console.error(`[agent-replay] ${actions.length} actions · ${messages} messages · ${withFile} with a file (→ snapshots) · ${A} agent(s)`);
console.error(`[agent-replay] by action: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);

if (flags.dry) {
  for (const e of events.slice(0, 16)) {
    if (e.kind === 'tool') console.error(`   ${e.action.padEnd(8)} ${e.target || '(' + e.detail.slice(0, 50) + ')'}`);
    else console.error(`   ${e.mtype.padEnd(8)} "${e.text.replace(/\s+/g, ' ').slice(0, 50)}"`);
  }
  console.error(`[agent-replay] dry run — nothing sent`);
  process.exit(0);
}

// --- dial the relay (same handshake as glance/buslog) ---
function dial(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const inbox = [], waiters = [];
    ws.onmessage = (e) => { const w = waiters.shift(); if (w) { clearTimeout(w.t); w.res(String(e.data)); } else inbox.push(String(e.data)); };
    const take = (ms = 15000) => new Promise((res, rej) => {
      if (inbox.length) return res(inbox.shift());
      const en = { res, t: setTimeout(() => { const i = waiters.indexOf(en); if (i >= 0) waiters.splice(i, 1); rej(new Error('relay timeout')); }, ms) };
      waiters.push(en);
    });
    ws.onerror = () => reject(new Error(`cannot reach relay on :${port} — dev loop up?`));
    ws.onopen = async () => { try { ws.send('ping'); await take(5000); await take(5000); resolve({ ws, take, send: (s) => ws.send(s) }); } catch (e) { reject(e); } };
  });
}
const enc = (verb, ...a) => 'call ' + Buffer.from(JSON.stringify([verb, ...a])).toString('base64');

const c = await dial(PORT).catch((e) => { console.error(`[agent-replay] ${e.message}`); process.exit(2); });
if (!flags['no-clear']) { c.send('agent.clear all'); await c.take().catch(() => {}); }

let sentTools = 0, sent = 0;
for (const e of events) {
  if (e.kind === 'tool') {
    // Raw forward: input/response ride as JSON STRINGS (the `call` hatch String-coerces objects);
    // the agent.tool verb JSON.parses them and the registry does the rest — see toolRegistry.js.
    c.send(enc('agent.tool', agentId(sentTools), TYPE, e.name,
      JSON.stringify(e.input), e.response != null ? JSON.stringify(e.response) : '', REPO));
    sentTools++;
  } else {
    // Prose decks just AHEAD of the tool it produced (the hook's flush order), so a message rides
    // the same agent as the NEXT tool when --split-agents fans out.
    c.send(enc('agent.message', agentId(sentTools), TYPE, e.mtype, e.text));
  }
  await c.take().catch(() => {});
  if (++sent % 25 === 0) console.error(`[agent-replay] sent ${sent}/${events.length}`);
  if (RATE) await sleep(RATE);
}
c.ws.close();
console.error(`[agent-replay] done — streamed ${sentTools} actions + ${sent - sentTools} messages into the books`);
process.exit(0);
