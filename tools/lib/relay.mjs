// relay.mjs — the one JS controller dial for tests that must stay in JS (a real page in
// Playwright, a simulated display or sensor). Everything that only runs verbs and renders
// replies is `glyph3d-cli`; this module is what a JS harness shares instead of
// hand-rolling the socket.
//
//   const relay = await dialRelay(8099);
//   const { text, data } = await relay.request('log.stats');
//   relay.close();
//
// Handshake: WebSocket upgrade carries `Sec-WebSocket-Protocol: glyph3d, g3d-token.<hex>`
// read from the per-uid 0600 runtime token file (`relay-<port>.token`), then send "ping" →
// "OK: connected as ctrl-N" → "pong". A reply is the next frame that isn't a pushed event
// ({"event": …} without "response").

import { lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ text: string|null, data: any }} RelayReply
 * @typedef {{
 *   hello: string,
 *   request: (line: string, ms?: number) => Promise<RelayReply>,
 *   close: () => void,
 * }} RelayClient
 */

/**
 * Return the per-uid runtime directory holding `relay-<port>.token`, matching `cli/auth*.go`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function relayTokenDir(env = process.env) {
  const override = (env.G3D_RELAY_TOKEN_DIR || '').trim();
  if (override) return override;
  if (process.platform === 'win32') return path.join(os.tmpdir(), 'glyph3d-relay');
  const uid = process.getuid();
  if (process.platform === 'linux') {
    const runDir = `/run/user/${uid}`;
    try {
      const st = lstatSync(runDir);
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0) {
        return path.join(runDir, 'g3d');
      }
    } catch { /* fall back to /tmp/g3d-<uid> */ }
  }
  return `/tmp/g3d-${uid}`;
}

/**
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function relayTokenPath(port, env = process.env) {
  return path.join(relayTokenDir(env), `relay-${port}.token`);
}

/**
 * Read the capability token for a local relay on `port` (or `$G3D_RELAY_TOKEN` when set).
 * Returns `null` when no token file exists yet; throws if permissions/ownership are unsafe.
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function readRelayToken(port, env = process.env) {
  const fromEnv = (env.G3D_RELAY_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return null;
  const dir = relayTokenDir(env);
  const file = relayTokenPath(Number(port), env);
  let dfi, ffi;
  try {
    dfi = lstatSync(dir);
    ffi = lstatSync(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid();
    if (!dfi.isDirectory() || dfi.isSymbolicLink() || dfi.uid !== uid || (dfi.mode & 0o077) !== 0) {
      throw new Error(`unsafe relay runtime dir ${dir}`);
    }
    if (!ffi.isFile() || ffi.isSymbolicLink() || ffi.uid !== uid || (ffi.mode & 0o077) !== 0) {
      throw new Error(`unsafe relay token file ${file}`);
    }
  }
  const tok = readFileSync(file, 'utf8').trim();
  return tok || null;
}

/**
 * Build the `Sec-WebSocket-Protocol` list carrying `token` (never in a query string).
 * @param {string|null|undefined} token
 * @returns {string[]}
 */
export function relayProtocols(token) {
  const clean = typeof token === 'string' ? token.trim() : '';
  return clean ? ['glyph3d', `g3d-token.${clean}`] : ['glyph3d'];
}

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
 * @param {{ handshakeMs?: number, token?: string|null }} [opts]
 * @returns {Promise<RelayClient>}
 */
export function dialRelay(port, { handshakeMs = 5000, token = undefined } = {}) {
  const url = `ws://localhost:${port}`;
  const tok = token !== undefined ? token : readRelayToken(port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, relayProtocols(tok));
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
