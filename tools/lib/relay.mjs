// relay.mjs — the one JS controller dial for tests that must stay in JS (a real page in
// Playwright, a simulated display or sensor). Everything that only runs verbs and renders
// replies is `glyph3d-cli`; this module is what a JS harness shares instead of
// hand-rolling the socket.
//
//   const relay = await dialRelay(8099);
//   const { text, data } = await relay.request('log.stats');
//   relay.close();
//
// Handshake: send "ping" → "OK: connected as ctrl-N" → "pong". A reply is the next
// frame that isn't a pushed event ({"event": …} without "response").

/**
 * @typedef {{ text: string|null, data: any }} RelayReply
 * @typedef {{
 *   hello: string,
 *   request: (line: string, ms?: number) => Promise<RelayReply>,
 *   close: () => void,
 * }} RelayClient
 */

/** @param {string} raw @returns {RelayReply|null} null for a pushed event */
function parseReply(raw) {
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      if ('event' in m && !('response' in m)) return null;
      if ('response' in m || 'data' in m) return { text: m.response ?? null, data: m.data ?? null };
    }
  } catch { /* plain text */ }
  return { text: raw, data: null };
}

/**
 * Dial the relay on localhost:`port` as a controller.
 * @param {number} port
 * @param {{ handshakeMs?: number }} [opts]
 * @returns {Promise<RelayClient>}
 */
export function dialRelay(port, { handshakeMs = 5000 } = {}) {
  const url = `ws://localhost:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    /** @type {string[]} */
    const inbox = [];
    /** @type {{ resolve: (raw: string) => void, timer: any }[]} */
    const waiters = [];
    ws.onmessage = (e) => {
      const raw = String(e.data);
      const w = waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(raw); } else inbox.push(raw);
    };
    /** The next frame within `ms`; a timed-out wait leaves no waiter behind. */
    const next = (ms, what) => new Promise((res, rej) => {
      if (inbox.length) return res(/** @type {string} */ (inbox.shift()));
      const entry = {
        resolve: res,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(entry), 1);
          rej(new Error(`${what} (${url})`));
        }, ms),
      };
      waiters.push(entry);
    });
    ws.onerror = () => reject(new Error(`no relay answering on ${url}`));
    ws.onopen = async () => {
      try {
        ws.send('ping');
        const hello = await next(handshakeMs, `no handshake ack within ${handshakeMs}ms`);
        const pong = await next(handshakeMs, `no handshake pong within ${handshakeMs}ms`);
        if (!hello.startsWith('OK:') || pong !== 'pong') throw new Error(`unexpected handshake: ${hello} / ${pong}`);
        resolve({
          hello,
          async request(line, ms = 8000) {
            ws.send(line);
            const deadline = Date.now() + ms;
            for (;;) {
              const reply = parseReply(await next(Math.max(0, deadline - Date.now()), `no reply to '${line}' within ${ms}ms`));
              if (reply) return reply;
            }
          },
          close: () => ws.close(),
        });
      } catch (e) {
        ws.close();
        reject(e);
      }
    };
  });
}
