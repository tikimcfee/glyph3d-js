// Vite plugin: a browser-console sink for the dev loop.
//
// The keystone runs in a WebGPU Firefox the agent can't see into. This plugin
// adds a POST /__log endpoint that appends to keystone/console.log, plus injects
// a tiny client shim that patches console.* + window.onerror to forward there.
// The agent reads keystone/console.log to see what actually happened in-browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(here, 'console.log');

const CLIENT = `
(() => {
  const send = (level, args) => {
    try {
      const text = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      navigator.sendBeacon('/__log', JSON.stringify({ level, text, t: Date.now() }));
    } catch {}
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { send(level, args); orig(...args); };
  }
  window.addEventListener('error', (e) => send('uncaught', [e.message, e.filename + ':' + e.lineno, e.error?.stack || '']));
  window.addEventListener('unhandledrejection', (e) => send('unhandled', [e.reason?.stack || String(e.reason)]));
})();
`;

export function consoleCapture() {
  return {
    name: 'keystone-console-capture',
    // Dev-server only — never inject the /__log beacon into a production build
    // (the served binary has no such endpoint; it'd just fire silent 404s).
    apply: 'serve',
    configureServer(server) {
      // Truncate on server (re)start so each run is a clean slate.
      fs.writeFileSync(LOG, `=== keystone console — ${new Date().toISOString()} ===\n`);
      server.middlewares.use('/__log', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { level, text, t } = JSON.parse(body);
            const ts = new Date(t).toISOString().slice(11, 23);
            fs.appendFileSync(LOG, `[${ts}] [${level}] ${text}\n`);
          } catch {}
          res.statusCode = 204;
          res.end();
        });
      });
    },
    transformIndexHtml() {
      return [{ tag: 'script', children: CLIENT, injectTo: 'head-prepend' }];
    },
  };
}
