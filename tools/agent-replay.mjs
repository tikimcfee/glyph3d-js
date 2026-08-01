#!/usr/bin/env bun
// agent-replay — replay a REAL Claude Code session's tool calls into the agent books, as a
// big, repeatable stress fixture. Reads a session JSONL (~/.claude/projects/...), maps every
// tool_use → an `agent.activity` verb, and streams them over the relay (same WS the CLI uses).
// So we stop hand-rebuilding state and instead fly a real run of hundreds of actions.
//
//   bun tools/agent-replay.mjs                                  # latest session, 1 agent, all
//   bun tools/agent-replay.mjs --limit 200 --split-agents 6 --rate 25
//   bun tools/agent-replay.mjs --session <path.jsonl> --dry     # preview the parse, send nothing
//
// FLAGS
//   --session <path|latest>  session JSONL (default: newest in this project's dir)
//   --agent <prefix>         agent id / id prefix (default 'run')
//   --split-agents N         round-robin actions across N agents → N books (default 1)
//   --limit N                cap to the first N actions
//   --latest N               cap to the LAST N actions (the most recent — what you usually want
//                            on a chunky session; applied after --limit)
//   --rate <ms>              delay between sends (default 0; the WS reply already paces)
//   --port N                 relay port (default 8080)
//   --no-clear               don't `agent.clear all` first
//   --dry                    parse + print a summary, send nothing

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeToolCall } from '../packages/glyph3d-core/src/collections/toolRegistry.js';

const VALUE = new Set(['session', 'agent', 'split-agents', 'limit', 'latest', 'rate', 'port']);
const BOOL = new Set(['no-clear', 'dry', 'help']);
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

const PROJ = path.join(os.homedir(), '.claude/projects/-home-ivan-dev-glyph3d-js');
const REPO = '/home/ivan/dev/glyph3d-js/';
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
const sessionPath = (!flags.session || flags.session === 'latest') ? latestSession() : flags.session;

// The replay is a DUMB FORWARDER: it ships the RAW tool event (name, input, response) and lets the
// ONE tool registry derive action/target/detail/result/meta — the SAME path the live hook takes, so
// replay and live can't drift. The session keeps the structured `toolUseResult` (the meta side:
// structuredPatch / numLines / stdout) separate from the tool_result TEXT; merge them so the
// registry's output extractor finds the text without any per-tool knowledge living here.
function forwardResponse(tur, resultText) {
  if (tur && typeof tur === 'object') {
    const hasText = tur.stdout || tur.content || tur.result || tur.output;
    return (resultText && !hasText) ? { ...tur, content: resultText } : tur;
  }
  return tur ?? (resultText || null);
}

// --- parse the session JSONL ---
const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean);
const results = new Map();   // tool_use_id -> FULL result text
const metas = new Map();     // tool_use_id -> structured toolUseResult (per-tool details)
const raw = [];
for (const line of lines) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b.type === 'tool_use') raw.push({ id: b.id, name: b.name, input: b.input || {} });
    else if (b.type === 'tool_result') {
      const c = b.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : '')).join('\n') : '';
      results.set(b.tool_use_id, txt);
      if (obj.toolUseResult != null) metas.set(b.tool_use_id, obj.toolUseResult);  // structured details ride alongside
    }
  }
}

let mapped = raw.map((a) => {
  const response = forwardResponse(metas.get(a.id) ?? null, results.get(a.id) || '');
  const rec = normalizeToolCall(a.name, a.input, response, REPO);   // null = a noise tool (TodoWrite/ToolSearch/…)
  return rec && { name: a.name, input: a.input, response, action: rec.action, target: rec.target, detail: rec.detail };
}).filter(Boolean);
if (flags.limit) mapped = mapped.slice(0, Number(flags.limit));
if (flags.latest) mapped = mapped.slice(-Number(flags.latest));   // keep the most recent N (tail)

const A = Math.max(1, Number(flags['split-agents'] || 1));
const prefix = flags.agent || 'run';
const agentId = (i) => (A === 1 ? prefix : `${prefix}${(i % A) + 1}`);

// summary
const byType = {};
for (const m of mapped) byType[m.action] = (byType[m.action] || 0) + 1;
const withFile = mapped.filter((m) => m.target).length;
console.error(`[agent-replay] session: ${path.basename(sessionPath)}`);
console.error(`[agent-replay] ${mapped.length} actions · ${withFile} with a file (→ snapshots) · ${A} agent(s)`);
console.error(`[agent-replay] by action: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);

if (flags.dry) {
  for (const m of mapped.slice(0, 16)) console.error(`   ${m.action.padEnd(7)} ${m.target || '(' + m.detail.slice(0, 50) + ')'}`);
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

let sent = 0;
for (const m of mapped) {
  // Raw forward: input/response ride as JSON STRINGS (the `call` hatch String-coerces objects);
  // the agent.tool verb JSON.parses them and the registry does the rest — see toolRegistry.js.
  c.send(enc('agent.tool', agentId(sent), 'claude', m.name,
    JSON.stringify(m.input), m.response != null ? JSON.stringify(m.response) : '', REPO));
  await c.take().catch(() => {});
  if (++sent % 25 === 0) console.error(`[agent-replay] sent ${sent}/${mapped.length}`);
  if (RATE) await sleep(RATE);
}
c.ws.close();
console.error(`[agent-replay] done — streamed ${sent} actions into the books`);
process.exit(0);
