#!/usr/bin/env bun
// buslog — structured log client for the relay's in-memory SQLite log store.
//
//   bun tools/buslog.mjs [flags]                 follow: live push feed ({"relay":"log.follow"})
//   bun tools/buslog.mjs q "<sql>"               log.query  — SELECT/WITH over the store
//   bun tools/buslog.mjs search <expr> [flags]   log.search — FTS5 match (LIKE under 3 chars)
//   bun tools/buslog.mjs errors [flags]          log.errors — recent error/warn records
//   bun tools/buslog.mjs stats                   log.stats  — rows / levels / scopes / pages
//   bun tools/buslog.mjs dump [path]             log.dump   — VACUUM INTO a snapshot .db
//
// The verb split: STORE verbs (q / search / errors / stats / dump, plus the follow
// feed) are RELAY-resident — they answer even with no page attached. RING verbs
// (log.tail, log.level) live in the PAGE — reach them via ./glyph3d-cli, or send
// log.level from here with --level-set.
//
// Follow mode is a push subscription — lossless, no polling, no timestamp dedupe.

const VALUE_FLAGS = new Set(['port', 'filter', 'level', 'scope', 'level-set', 'since', 'page', 'limit', 'fuzzy']);
const BOOL_FLAGS = new Set(['json', 'help']);
const SUBS = new Set(['q', 'search', 'errors', 'stats', 'dump']);

const flags = {};
const positional = [];
let sub = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
      if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined) die(`--${name} needs a value`);
        flags[name] = v;
        continue;
      }
      die(`unknown flag --${name} (see --help)`);
    }
    if (!sub && positional.length === 0 && SUBS.has(a)) { sub = a; continue; }
    positional.push(a);
  }
}
const PORT = Number(flags.port ?? 8080);

if (flags.help) { help(); process.exit(0); }

function die(msg) { console.error(`[buslog] ${msg}`); process.exit(2); }

function help() {
  console.log(`buslog — structured log client for the glyph3d relay (SQLite log store)

USAGE
  bun tools/buslog.mjs [flags]                  follow the live record feed (default mode)
  bun tools/buslog.mjs q "<sql>"                log.query  — SELECT/WITH only, ≤1000 rows
  bun tools/buslog.mjs search <expr> [flags]    log.search — FTS5 (LIKE when expr <3 chars)
  bun tools/buslog.mjs errors [flags]           log.errors — error/warn records, newest first
  bun tools/buslog.mjs stats                    log.stats  — store shape
  bun tools/buslog.mjs dump [path]              log.dump   — snapshot to a .db file
                                                (default /tmp/glyph3d/logs-<ts>.db)

FLAGS (before or after the subcommand)
  --port N            relay port (default 8080)
  --json              raw records as JSONL / raw data JSON instead of rendered lines

  follow mode (client-side narrowing — the feed itself is everything):
  --filter <substr>   case-insensitive substring match on msg
  --level <csv>       only these levels, e.g. --level error,warn
  --scope <s>         only this scope
  --level-set <LVL>   send 'log.level <LVL>' to the PAGE once after subscribing
                      (this is the old --level flag, renamed: --level now filters)

  search / errors (passed through to the relay verb):
  --since 30s|5m|2h|1d   relative window (relay receive time)
  --level <csv>          level filter
  --scope <s>            scope filter
  --page cur|all         page-load scope (default all)
  --limit N              max hits (default 50; errors default 30)
  --fuzzy <query>        search only: fetch up to max(500, --limit) candidates, then
                         rank client-side with fzf over msg; expr defaults to the
                         fuzzy query when omitted

VERB SPLIT
  Store verbs (q/search/errors/stats/dump + this follow feed) are RELAY-resident:
  they work with NO page attached. Ring verbs (log.tail, log.level) live in the
  page — reach them via ./glyph3d-cli, or --level-set here.`);
}

// ---------------------------------------------------------------------------
// relay connection — handshake is: send "ping" → "OK: connected as ctrl-N" → "pong"

function dial(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const inbox = [];
    /** @type {{resolve: (s: string) => void, timer: any}[]} */
    const waiters = [];
    ws.onmessage = (e) => {
      const raw = String(e.data);
      const w = waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(raw); } else inbox.push(raw);
    };
    const take = (timeoutMs = 15000) => new Promise((res, rej) => {
      if (inbox.length) return res(inbox.shift());
      const entry = {
        resolve: res,
        timer: setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(`no reply from relay within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiters.push(entry);
    });
    ws.onerror = () => reject(new Error(`cannot reach relay on :${port} — is the dev loop / binary up?`));
    ws.onopen = async () => {
      try {
        ws.send('ping');
        const hello = await take(5000); // 'OK: connected as ctrl-N'
        if (!hello.startsWith('OK:')) throw new Error(`unexpected hello: ${hello}`);
        await take(5000); // 'pong'
        resolve({ ws, take, hello, send: (s) => ws.send(s) });
      } catch (e) { reject(e); }
    };
  });
}

/** Parse a controller reply: JSON {response,data} or plain text. */
function parseReply(raw) {
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') return { text: m.response ?? null, data: m.data ?? null };
  } catch { /* plain text */ }
  return { text: raw, data: null };
}

/** One command on a fresh connection, then close — no shared-pending confusion. */
async function oneShot(command) {
  const c = await dial(PORT).catch((e) => die(e.message));
  c.send(command);
  const reply = parseReply(await c.take().catch((e) => die(e.message)));
  c.ws.close();
  if (typeof reply.text === 'string' && reply.text.startsWith('ERR')) die(reply.text);
  return reply;
}

// ---------------------------------------------------------------------------
// rendering

function fmtTs(ts) {
  const d = new Date(Number(ts));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One record/entry line: HH:MM:SS.mmm level [scope] msg ×N */
function renderEntry(rec) {
  const scope = rec.scope ? ` [${rec.scope}]` : '';
  const rep = rec.repeat > 1 ? ` ×${rec.repeat}` : '';
  console.log(`${fmtTs(rec.ts)} ${String(rec.level || 'log').padEnd(5)}${scope} ${rec.msg ?? ''}${rep}`);
}

function emitEntries(entries, summary) {
  if (flags.json) { for (const e of entries) console.log(JSON.stringify(e)); }
  else { for (const e of entries) renderEntry(e); }
  if (summary && !flags.json) console.error(`[buslog] ${summary}`);
}

/** Aligned table for log.query results; long cells clipped to keep alignment sane. */
function renderTable(data) {
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const clip = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
  const cell = (v) => clip(v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cells = rows.map((r) => r.map(cell));
  const widths = columns.map((c, i) => Math.max(String(c).length, ...cells.map((r) => (r[i] ?? '').length)));
  console.log(columns.map((c, i) => String(c).padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of cells) console.log(r.map((v, i) => (v ?? '').padEnd(widths[i])).join('  '));
}

function renderStats(d) {
  console.log(`rows    ${d.rows}`);
  console.log(`bytes   ${d.bytes}${typeof d.bytes === 'number' ? ` (${(d.bytes / 1024).toFixed(1)} KiB)` : ''}`);
  const lv = Object.entries(d.byLevel ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join('  ·  ');
  console.log(`levels  ${lv || '(none)'}`);
  const sc = (d.topScopes ?? []).map((s) => `${s.scope ?? '(none)'} ${s.count}`).join('  ·  ');
  console.log(`scopes  ${sc || '(none)'}`);
  for (const p of d.pages ?? []) {
    console.log(`page    ${p.id}  ${fmtTs(p.first)} → ${fmtTs(p.last)}  (${p.count})`);
  }
}

// ---------------------------------------------------------------------------
// modes

async function follow() {
  const c = await dial(PORT).catch((e) => die(e.message));
  const narrows = [
    flags.filter && `filter:${flags.filter}`, flags.level && `level:${flags.level}`,
    flags.scope && `scope:${flags.scope}`,
  ].filter(Boolean).join(' ');
  console.error(`[buslog] ${c.hello} — following ws://localhost:${PORT} (push feed)${narrows ? ` [${narrows}]` : ''}`);
  c.ws.onclose = () => { console.error('[buslog] relay closed'); process.exit(1); };

  const levelSel = flags.level
    ? new Set(flags.level.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;
  const filter = flags.filter ? flags.filter.toLowerCase() : null;

  c.ws.onmessage = (e) => {
    const raw = String(e.data);
    let m;
    try { m = JSON.parse(raw); } catch { console.error(`[buslog] ${raw}`); return; }
    if (m?.event === 'browser.log' && m.data) {
      const rec = m.data;
      if (levelSel && !levelSel.has(String(rec.level).toLowerCase())) return;
      if (flags.scope && rec.scope !== flags.scope) return;
      if (filter && !String(rec.msg ?? '').toLowerCase().includes(filter)) return;
      if (flags.json) console.log(JSON.stringify(rec));
      else renderEntry(rec);
      return;
    }
    if (m && typeof m === 'object' && 'response' in m) console.error(`[buslog] ${m.response}`);
  };

  c.send(JSON.stringify({ relay: 'log.follow' }));
  if (flags['level-set']) {
    c.send(`log.level ${flags['level-set']}`);
    console.error(`[buslog] log.level → ${flags['level-set'].toUpperCase()} (sent to the page)`);
  }
}

async function runQuery() {
  const sql = positional.join(' ').trim();
  if (!sql) die('q needs a SQL string, e.g.  q "SELECT level, count(*) FROM logs GROUP BY level"');
  const reply = await oneShot(`log.query ${sql}`);
  if (flags.json) console.log(JSON.stringify(reply.data));
  else { renderTable(reply.data ?? {}); if (reply.text) console.error(`[buslog] ${reply.text}`); }
}

async function runSearch() {
  let expr = positional.join(' ').trim();
  if (!expr && flags.fuzzy) expr = flags.fuzzy;
  if (!expr) die('search needs an expression (or --fuzzy <query>)');
  const userLimit = flags.limit ? Number(flags.limit) : 50;
  const fetchLimit = flags.fuzzy ? Math.max(500, userLimit) : userLimit;

  let cmd = `log.search ${expr}`;
  if (flags.since) cmd += ` --since ${flags.since}`;
  if (flags.level) cmd += ` --level ${flags.level}`;
  if (flags.scope) cmd += ` --scope ${flags.scope}`;
  if (flags.page) cmd += ` --page ${flags.page}`;
  cmd += ` --limit ${fetchLimit}`;

  const reply = await oneShot(cmd);
  let entries = reply.data?.entries ?? [];
  let summary = reply.text;
  if (flags.fuzzy) {
    const { Fzf } = await import('fzf'); // hoisted from the app workspace; bun resolves it
    const ranked = new Fzf(entries, { selector: (e) => e.msg ?? '' }).find(flags.fuzzy);
    entries = ranked.map((r) => r.item).slice(0, userLimit);
    summary = `${entries.length} fuzzy hit(s) of ${reply.data?.entries?.length ?? 0} candidates`;
  }
  emitEntries(entries, summary);
}

async function runErrors() {
  let cmd = 'log.errors';
  if (flags.since) cmd += ` --since ${flags.since}`;
  if (flags.limit) cmd += ` --limit ${flags.limit}`;
  const reply = await oneShot(cmd);
  emitEntries(reply.data?.entries ?? [], reply.text);
}

async function runStats() {
  const reply = await oneShot('log.stats');
  if (flags.json) console.log(JSON.stringify(reply.data));
  else renderStats(reply.data ?? {});
}

async function runDump() {
  const path = positional.join(' ').trim();
  const reply = await oneShot(`log.dump${path ? ` ${path}` : ''}`);
  console.log(reply.text ?? '');
}

// ---------------------------------------------------------------------------

switch (sub) {
  case 'q': await runQuery(); process.exit(0);
  case 'search': await runSearch(); process.exit(0);
  case 'errors': await runErrors(); process.exit(0);
  case 'stats': await runStats(); process.exit(0);
  case 'dump': await runDump(); process.exit(0);
  default: await follow(); // stays alive on the push feed
}
