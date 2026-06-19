#!/usr/bin/env bun
// trail-replay — replay a REAL Claude Code session's tool calls into the agent trail, as a
// big, repeatable stress fixture. Reads a session JSONL (~/.claude/projects/...), maps every
// tool_use → an `agent.activity` verb, and streams them over the relay (same WS the CLI uses).
// So we stop hand-rebuilding state and instead fly a real run of hundreds of actions.
//
//   bun tools/trail-replay.mjs                                  # latest session, 1 agent, all
//   bun tools/trail-replay.mjs --limit 200 --split-agents 6 --rate 25
//   bun tools/trail-replay.mjs --session <path.jsonl> --dry     # preview the parse, send nothing
//
// FLAGS
//   --session <path|latest>  session JSONL (default: newest in this project's dir)
//   --agent <prefix>         agent id / id prefix (default 'run')
//   --split-agents N         round-robin actions across N agents → N corridors (default 1)
//   --limit N                cap to the first N actions
//   --rate <ms>              delay between sends (default 0; the WS reply already paces)
//   --port N                 relay port (default 8080)
//   --no-clear               don't `trail.clear all` first
//   --dry                    parse + print a summary, send nothing

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VALUE = new Set(['session', 'agent', 'split-agents', 'limit', 'rate', 'port']);
const BOOL = new Set(['no-clear', 'dry', 'help']);
const flags = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (BOOL.has(k)) flags[k] = true;
    else if (VALUE.has(k)) flags[k] = a[++i];
    else { console.error(`[trail-replay] unknown flag ${a[i]}`); process.exit(2); }
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
  if (!files.length) { console.error(`[trail-replay] no .jsonl in ${PROJ}`); process.exit(2); }
  return path.join(PROJ, files[0].f);
}
const sessionPath = (!flags.session || flags.session === 'latest') ? latestSession() : flags.session;

const rel = (p) => (typeof p === 'string' && p.startsWith(REPO) ? p.slice(REPO.length) : p);
// No munging here: a command and its output ship RAW to the trail, which renders them in grids
// whose layout system already does line-splitting + windowing. Managing size is the layout's job.
function mapTool(name, input = {}) {
  const t = String(name || '');
  if (t === 'Read') return { action: 'read', target: rel(input.file_path), detail: '' };
  if (t === 'Edit' || t === 'MultiEdit') return { action: 'edit', target: rel(input.file_path), detail: '' };
  if (t === 'Write') return { action: 'write', target: rel(input.file_path), detail: '' };
  if (t === 'NotebookEdit') return { action: 'edit', target: rel(input.notebook_path), detail: '' };
  if (t === 'Bash') return { action: 'bash', target: '', detail: input.command || '' };
  if (t === 'Grep') return { action: 'grep', target: rel(input.path) || '', detail: input.pattern || '' };
  if (t === 'Glob') return { action: 'glob', target: '', detail: input.pattern || '' };
  if (t === 'Task' || t === 'Agent') return { action: 'task', target: '', detail: input.subagent_type || input.description || '' };
  if (t === 'Workflow') return { action: 'task', target: '', detail: 'workflow: ' + (input.name || '') };
  if (t === 'WebFetch') return { action: 'fetch', target: '', detail: input.url || '' };
  if (t === 'WebSearch') return { action: 'search', target: '', detail: input.query || '' };
  return { action: t.toLowerCase() || 'act', target: '', detail: JSON.stringify(input) };
}

// Pull the structured per-tool metadata out of the session's top-level `toolUseResult` — the little
// details (lines read/written, +/−, tokens) the result TEXT never carries. Shipped as a `meta`
// object on the activity record; the trail renders it as a terse subtitle.
function extractMeta(name, tur) {
  if (!tur || typeof tur !== 'object') return null;
  const t = String(name || '');
  if (t === 'Read') {
    if (tur.file?.numLines != null) return { lines: tur.file.numLines };
    if (tur.file?.originalSize != null) return { bytes: tur.file.originalSize };
    return null;
  }
  if (t === 'Write') return { kind: tur.type, lines: String(tur.content || '').split('\n').length };
  if (t === 'Edit' || t === 'MultiEdit') {
    let added = 0, removed = 0;
    for (const h of (tur.structuredPatch || [])) for (const ln of (h.lines || [])) { if (ln[0] === '+') added++; else if (ln[0] === '-') removed++; }
    return { added, removed };
  }
  if (t === 'Bash') {
    const out = String(tur.stdout || '');
    const m = { lines: out ? out.replace(/\n$/, '').split('\n').length : 0 };
    if (tur.interrupted) m.interrupted = true;
    return m;
  }
  if (t === 'Task' || t === 'Agent') return { tools: tur.totalToolUseCount, tokens: tur.totalTokens, ms: tur.totalDurationMs };
  return null;
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
  const m = mapTool(a.name, a.input);
  // A file action's content IS its snapshot, so it carries no result. A no-target action's output
  // (bash/grep/…) ships RAW — it becomes a sibling output grid that does its own line-splitting.
  const result = m.target ? '' : (results.get(a.id) || '');
  const meta = extractMeta(a.name, metas.get(a.id));   // little details: lines read/written, +/−, tokens
  return { ...m, result, meta };
})
  .filter((m) => m.action && m.action !== 'todowrite' && m.action !== 'task_get' && m.action !== 'toolsearch');
if (flags.limit) mapped = mapped.slice(0, Number(flags.limit));

const A = Math.max(1, Number(flags['split-agents'] || 1));
const prefix = flags.agent || 'run';
const agentId = (i) => (A === 1 ? prefix : `${prefix}${(i % A) + 1}`);

// summary
const byType = {};
for (const m of mapped) byType[m.action] = (byType[m.action] || 0) + 1;
const withFile = mapped.filter((m) => m.target).length;
console.error(`[trail-replay] session: ${path.basename(sessionPath)}`);
console.error(`[trail-replay] ${mapped.length} actions · ${withFile} with a file (→ snapshots) · ${A} agent(s)`);
console.error(`[trail-replay] by action: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);

if (flags.dry) {
  for (const m of mapped.slice(0, 16)) console.error(`   ${m.action.padEnd(7)} ${m.target || '(' + m.detail.slice(0, 50) + ')'}`);
  console.error(`[trail-replay] dry run — nothing sent`);
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

const c = await dial(PORT).catch((e) => { console.error(`[trail-replay] ${e.message}`); process.exit(2); });
if (!flags['no-clear']) { c.send('trail.clear all'); await c.take().catch(() => {}); }

let sent = 0;
for (const m of mapped) {
  c.send(enc('agent.activity', agentId(sent), 'claude', m.action, m.target || '', m.detail || '', m.result || '', m.meta ? JSON.stringify(m.meta) : ''));
  await c.take().catch(() => {});
  if (++sent % 25 === 0) console.error(`[trail-replay] sent ${sent}/${mapped.length}`);
  if (RATE) await sleep(RATE);
}
c.ws.close();
console.error(`[trail-replay] done — streamed ${sent} actions into the trail`);
process.exit(0);
