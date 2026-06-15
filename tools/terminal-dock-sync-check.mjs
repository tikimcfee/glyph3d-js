// terminal-dock-sync-check.mjs — proves the Terminals-panel activation guard is timing-proof.
//
// dockview fires onDidActivePanelChange for activations WE initiate (a panel added active as a
// terminal re-adopts on restore; an attention→tab raise) AS WELL AS real user tab clicks — and it
// can fire them on a later microtask. A boolean "are we mid-sync" flag races that async event and
// leaks the programmatic activation through as a user click, which flies the camera + hijacks focus
// on launch. wireTerminalDock matches by IDENTITY instead. This harness drives a mock dockview whose
// activation events fire ASYNCHRONOUSLY (the failure mode) and asserts: our activations stay silent,
// real user clicks fire.
//
//   bun tools/terminal-dock-sync-check.mjs

import { wireTerminalDock } from '../app/client/terminalDockSync.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const flush = () => new Promise((r) => setTimeout(r, 5)); // let async activation events drain

// Mock dockview group api. The crux: activation events fire on a TIMER (async), exactly the race a
// boolean guard loses. `_userActivate` simulates a real tab click — dockview fires the event, but
// the helper never initiated it (nothing recorded), so it must be treated as user intent.
function makeApi() {
  const panels = new Map();
  let active = null;
  const listeners = [];
  const fireAsync = (p) => setTimeout(() => { for (const l of [...listeners]) l(p); }, 0);
  const mkPanel = (id) => {
    const p = { id, api: null };
    p.api = {
      get isActive() { return active === id; },
      setActive() { active = id; fireAsync(p); },
      close() { panels.delete(id); if (active === id) active = null; },
    };
    return p;
  };
  return {
    get panels() { return [...panels.values()]; },
    getPanel: (id) => panels.get(id) || null,
    addPanel: ({ id, inactive }) => {
      const p = mkPanel(id);
      panels.set(id, p);
      if (!inactive) { active = id; fireAsync(p); }
      return p;
    },
    onDidActivePanelChange: (cb) => {
      listeners.push(cb);
      return { dispose() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } };
    },
    _userActivate: (id) => { active = id; const p = panels.get(id); if (p) fireAsync(p); },
  };
}

let primary = null;
const calls = [];
const client = {
  router: { execute: (c) => calls.push(c) },
  ctx: { attentionManager: { get: (slot) => (slot === 'primary' && primary ? { id: primary } : null) } },
};
let termIds = [];
const api = makeApi();
const dock = wireTerminalDock(api, { getClient: () => client, listTerminalIds: () => termIds });

// ---- 1. restore re-adopt: 3 terminals appear, primary unset. First panel lands active (a group
// must have one); its activation event fires async — and must NOT fire focus/camera. ----
termIds = ['term-19', 'term-31', 'term-1'];
dock.syncPanels();
await flush();
ok(calls.length === 0, 'restore re-adopt: async add-active fired NO terminal.focus / camera.focus');
ok(api.getPanel('term-19') && api.getPanel('term-1'), 'restore re-adopt: all panels added');

// ---- 2. user clicks a tab (not initiated by us) → takes focus + frames it ----
calls.length = 0;
api._userActivate('term-31');
await flush();
ok(calls.includes('terminal.focus term-31'), 'user click: terminal.focus fired');
ok(calls.includes('camera.focus term-31'), 'user click: camera.focus fired (loose framing path)');

// ---- 3. attention → tab raise (we call setActive): its async event must stay silent ----
calls.length = 0;
primary = 'term-1';
dock.syncActive();
await flush();
ok(calls.length === 0, 'attention sync: programmatic setActive fired NO verb');

// ---- 4. echo: activating the tab that's ALREADY primary fires nothing ----
calls.length = 0;
primary = 'term-19';
api._userActivate('term-19');
await flush();
ok(calls.length === 0, 'echo: activating the already-primary tab is a no-op');

console.log(failures === 0 ? '\nPASS — programmatic activations stay silent across async events' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
