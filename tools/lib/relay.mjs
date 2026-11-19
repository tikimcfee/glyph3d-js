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

import { execFileSync } from 'node:child_process';
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

// A token rides in a Sec-WebSocket-Protocol entry, so it must be an RFC 7230 token.
const TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * True if a URL query string carries a `token` parameter (case-insensitive, `&` or `;` separated).
 * @param {string} search
 * @returns {boolean}
 */
function hasQueryToken(search) {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (!q) return false;
  for (const seg of q.split(/[&;]/)) {
    if (!seg) continue;
    const eq = seg.indexOf('=');
    const rawKey = eq >= 0 ? seg.slice(0, eq) : seg;
    let key = rawKey;
    try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { /* keep rawKey */ }
    if (key.trim().toLowerCase() === 'token') return true;
  }
  return false;
}

/**
 * Parse a relay capability token from a raw token string or a `#token=<val>` URL/fragment.
 * Throws on `?token=` query strings, tokenless URLs, or non-RFC-7230 characters (never echoes raw input).
 * @param {string} raw
 * @returns {string}
 */
function parseRelayTokenValue(raw) {
  if (typeof raw !== 'string') throw new Error('invalid relay token');
  const s = raw.trim();
  if (!s) throw new Error('empty relay token');

  const hashIdx = s.indexOf('#');
  const beforeHash = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
  const qIdx = beforeHash.indexOf('?');
  if (qIdx >= 0 && hasQueryToken(beforeHash.slice(qIdx))) {
    throw new Error('relay token must not be passed in URL query string; use #token= fragment');
  }

  if (s.includes('://')) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error('invalid relay token URL');
    }
    if (hasQueryToken(u.search)) {
      throw new Error('relay token must not be passed in URL query string; use #token= fragment');
    }
    const frag = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
    const tok = (new URLSearchParams(frag).get('token') || '').trim();
    if (!tok) {
      throw new Error('URL carries no #token= fragment');
    }
    if (!TOKEN_CHARS.test(tok)) {
      throw new Error('invalid relay token characters');
    }
    return tok;
  }

  if (hashIdx >= 0) {
    const params = new URLSearchParams(s.slice(hashIdx + 1));
    if (!params.has('token')) {
      throw new Error('fragment carries no #token= value');
    }
    const tok = (params.get('token') || '').trim();
    if (!tok || !TOKEN_CHARS.test(tok)) {
      throw new Error('invalid relay token characters');
    }
    return tok;
  }

  if (!TOKEN_CHARS.test(s)) {
    throw new Error('invalid relay token characters');
  }
  return s;
}

/** @type {Map<number, string>} */
const _pwDirCache = new Map();

/**
 * Resolve `<pw_dir>` for `uid` directly from the OS user database (ignoring `$HOME`, which Bun's
 * `os.userInfo().homedir` consults before `getpwuid`), matching Go `user.LookupId` in `cli/auth_unix.go`.
 * @param {number} uid
 * @returns {string}
 */
function lookupPasswdHomeByUid(uid) {
  const cached = _pwDirCache.get(uid);
  if (cached !== undefined) return cached;
  let found = '';
  if (process.platform === 'darwin') {
    try {
      const line = execFileSync('/usr/bin/id', ['-P'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const parts = line.split(':');
      if (parts.length >= 9 && Number(parts[2]) === uid && parts[8].trim()) {
        found = parts[8].trim();
      }
    } catch { /* fall through */ }
  }
  if (!found) {
    try {
      for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(':');
        if (parts.length >= 6 && Number(parts[2]) === uid && parts[5].trim()) {
          found = parts[5].trim();
          break;
        }
      }
    } catch { /* fall through */ }
  }
  if (!found && process.platform !== 'darwin') {
    try {
      const line = execFileSync('getent', ['passwd', String(uid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const parts = line.split(':');
      if (parts.length >= 6 && Number(parts[2]) === uid && parts[5].trim()) {
        found = parts[5].trim();
      }
    } catch { /* fall through */ }
  }
  _pwDirCache.set(uid, found);
  return found;
}

/**
 * Return the per-uid runtime directory holding `relay-<port>.token`, matching `cli/auth_unix.go`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function relayTokenDir(env = process.env) {
  if (process.platform === 'win32') throw new Error('glyph3d relay is unsupported on Windows');
  const override = (env.G3D_RELAY_TOKEN_DIR || '').trim();
  if (override) return override;
  const uid = process.getuid();
  if (process.platform === 'linux') {
    const runDir = `/run/user/${uid}`;
    try {
      const st = lstatSync(runDir);
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0) {
        return path.join(runDir, 'g3d');
      }
    } catch { /* fall back to ~/.local/state/g3d/run */ }
  }
  let home = lookupPasswdHomeByUid(uid);
  if (!home) {
    try {
      home = (os.userInfo().homedir || '').trim();
    } catch {
      home = '';
    }
  }
  if (!home) {
    home = (env.HOME || '').trim();
  }
  if (!home) {
    throw new Error(`cannot resolve home directory for uid ${uid}`);
  }
  return path.join(home, '.local', 'state', 'g3d', 'run');
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
 * Returns `null` when no token file exists yet; throws if permissions/ownership/shape are unsafe.
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function readRelayToken(port, env = process.env) {
  if (process.platform === 'win32') throw new Error('glyph3d relay is unsupported on Windows');
  const fromEnv = (env.G3D_RELAY_TOKEN || '').trim();
  if (fromEnv) return parseRelayTokenValue(fromEnv);
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return null;
  const dir = relayTokenDir(env);
  const file = path.join(dir, `relay-${Number(port)}.token`);
  let dfi, ffi;
  try {
    dfi = lstatSync(dir);
    ffi = lstatSync(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const uid = process.getuid();
  if (!dfi.isDirectory() || dfi.isSymbolicLink() || dfi.uid !== uid || (dfi.mode & 0o077) !== 0) {
    throw new Error(`unsafe relay runtime dir ${dir}`);
  }
  if (!ffi.isFile() || ffi.isSymbolicLink() || ffi.uid !== uid || (ffi.mode & 0o077) !== 0) {
    throw new Error(`unsafe relay token file ${file}`);
  }
  const tok = readFileSync(file, 'utf8').trim();
  if (!tok || !TOKEN_CHARS.test(tok)) {
    throw new Error(`invalid relay token in ${file}`);
  }
  return tok;
}

/**
 * Build the `Sec-WebSocket-Protocol` list carrying `token` (never in a query string).
 * @param {string|null|undefined} token
 * @returns {string[]}
 */
export function relayProtocols(token) {
  if (token == null) return ['glyph3d'];
  if (typeof token !== 'string') throw new Error('invalid relay token');
  const clean = token.trim();
  if (!clean) return ['glyph3d'];
  if (!TOKEN_CHARS.test(clean)) throw new Error('invalid relay token characters');
  return ['glyph3d', `g3d-token.${clean}`];
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
  if (process.platform === 'win32') throw new Error('glyph3d relay is unsupported on Windows');
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
