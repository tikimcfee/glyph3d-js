// logstore — end-to-end over the relay's in-memory SQLite log store: page records flow
// over the structured wire format into the relay, and the relay-resident verbs answer
// on a raw controller socket.
//
// NEEDS the dev relay on :8080 (tools/dev.sh). When it isn't there — or the page can't
// take the display slot (another browser holds it) — the test SKIPS LOUDLY and passes,
// so the runner never reds a missing dev loop. A skip means NOTHING was exercised; the
// skip line says so.
//
// Covers when live: page→relay ingest (a grid.list dispatch record lands with scope
// 'command'), log.search (FTS + --scope/--limit), log.query (SELECT gate), log.stats.
// Does NOT cover: log.follow push, log.dump, repeat-coalescing, --since windows —
// those are exercised by hand via tools/buslog.mjs (see tools/CHECKS.md).

const RELAY_PORT = 8080;

// Raw controller dial — handshake is: send "ping" → "OK: connected as ctrl-N" → "pong".
function dialRelay(port, handshakeMs = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const inbox = [];
    const waiters = [];
    const take = () => new Promise((res) => { inbox.length ? res(inbox.shift()) : waiters.push(res); });
    const fail = (why) => { try { ws.close(); } catch { /* already closed */ } reject(new Error(why)); };
    const timer = setTimeout(() => fail('relay handshake timeout'), handshakeMs);
    ws.onmessage = (e) => { const raw = String(e.data); const w = waiters.shift(); w ? w(raw) : inbox.push(raw); };
    ws.onerror = () => { clearTimeout(timer); fail(`no relay answering on ws://localhost:${port}`); };
    ws.onopen = async () => {
      ws.send('ping');
      const hello = await take(); // 'OK: connected as ctrl-N'
      const pong = await take();  // 'pong'
      clearTimeout(timer);
      if (!hello.startsWith('OK:') || pong !== 'pong') return fail(`unexpected handshake: ${hello} / ${pong}`);
      resolve({
        async request(cmd, ms = 8000) {
          ws.send(cmd);
          const raw = await Promise.race([
            take(),
            new Promise((_, rj) => setTimeout(() => rj(new Error(`no reply to '${cmd}' in ${ms}ms`)), ms)),
          ]);
          try { const m = JSON.parse(raw); return { text: m.response ?? null, data: m.data ?? null }; }
          catch { return { text: raw, data: null }; }
        },
        close: () => ws.close(),
      });
    };
  });
}

export default async ({ app, assert, url }) => {
  assert.ok(app.booted, 'booted');

  // (a) relay probe — skip loudly when the dev loop isn't up.
  let ctrl;
  try { ctrl = await dialRelay(RELAY_PORT); }
  catch (e) {
    console.log(`      ⤷ SKIP logstore: ${e.message} — start tools/dev.sh; this run exercised NOTHING`);
    return;
  }

  try {
    // (b) re-open the page WITH the relay (resolveRelay honors ?relay) so its records ingest.
    const target = `${url}${url.includes('?') ? '&' : '?'}relay=${RELAY_PORT}`;
    await app.page.goto(target, { waitUntil: 'load', timeout: 30000 });
    await app.page.waitForFunction(() => !!window.__glyphClient, { timeout: 20000 });
    await app.waitFor(4000); // boot settle + relay dial
    const attached = await app.evalPage('!!(window.__glyphClient && window.__glyphClient.bridge && window.__glyphClient.bridge.connected)');
    if (!attached) {
      console.log('      ⤷ SKIP logstore: page could not hold the display slot (another browser attached to :8080?) — ingest NOT exercised');
      return;
    }

    // (c) a known dispatch → a structured record with scope 'command' in the store.
    const r = await app.cmd('grid.list');
    assert.ok(!r.error, `grid.list ran (${r.error || 'ok'})`);
    await app.waitFor(1500); // page → relay flush + ingest

    const search = await ctrl.request('log.search grid.list --scope command --limit 10');
    const entries = search.data?.entries ?? [];
    assert.atLeast(entries.length, 1, `log.search grid.list --scope command hits (${search.text})`);
    assert.ok(entries.every((e) => e.scope === 'command'), 'every hit carries scope=command');
    assert.ok(
      entries.every((e) => typeof e.ts === 'number' && typeof e.level === 'string' && typeof e.msg === 'string'),
      'entries are structured {ts:number, level:string, msg:string}',
    );

    const q = await ctrl.request('log.query SELECT count(*) FROM logs');
    const n = Number(q.data?.rows?.[0]?.[0]);
    assert.ok(Number.isFinite(n) && n > 0,
      `log.query count(*) is positive (got ${q.data ? JSON.stringify(q.data.rows) : q.text})`);

    const stats = await ctrl.request('log.stats');
    assert.atLeast(Number(stats.data?.rows ?? 0), 1, 'log.stats reports rows > 0');

    assert.noErrors(app);
  } finally {
    ctrl.close();
  }
};
