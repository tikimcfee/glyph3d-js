// terminal-spawn-dock-check.mjs — proves terminal.spawn AWAITS its own terminal and then
// docks + focuses it, with per-spawn promise pairing (no shared intent state).
//
// The flow: terminal.spawn sends the relay message, awaits the relay's `terminal.spawning`
// ack for the id (WebSocketBridge.waitForEvent — one-shot, FIFO, self-cleaning on timeout),
// awaits the terminal's arrival in the registry (the "added and ready" callback — the
// registry fires change listeners synchronously on register, after the grid is fully wired),
// then composes `dock.lock <id>` + `dock.spotlight <id>` (pin into the focus pane) +
// `terminal.focus <id>` through the router. A restore-time re-adopt (terminal.create with
// no spawn) never docks or steals focus.
//
// Runs the REAL spawn + create handlers (real TerminalGrid, real CommandRouter, real
// WebSocketBridge) headlessly; dock.lock/terminal.focus are mocked at the router to record
// the composition, and the relay is simulated by feeding acks into bridge._handleMessage.
//
//   bun tools/terminal-spawn-dock-check.mjs

// WebSocketBridge + ErrorTracker touch `window` at import/construct time — stub before importing.
globalThis.window = { location: { hostname: 'localhost' }, addEventListener() {}, removeEventListener() {} };

await import('./headless-canvas.mjs');
const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const THREE = await import('three');
const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: WebSocketBridge } = await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: registerTerminalCommands } = await import('../app/commands/handlers/terminalCommands.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const flush = () => new Promise((r) => setTimeout(r, 5)); // let promise continuations drain

const ctx = { scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: new SceneRegistry() };
const router = new CommandRouter(ctx);
registerTerminalCommands(router);

// Mock the composed verbs — record what spawn fires.
const calls = [];
router.register('dock.lock', (args) => { calls.push(`dock.lock ${args[0]}`); return { text: 'OK', data: null }; });
router.register('dock.spotlight', (args) => { calls.push(`dock.spotlight ${args[0]}`); return { text: 'OK', data: { spotlit: true } }; });
router.register('terminal.focus', (args) => { calls.push(`terminal.focus ${args[0]}`); return { text: 'OK', data: null }; });

// Real bridge, no socket: capture outgoing relay messages, feed replies in by hand.
const bridge = new WebSocketBridge(router, { autoConnect: false, showStatus: false });
bridge.connected = true;
const sent = [];
bridge.send = (raw) => sent.push(JSON.parse(raw));
ctx.wsbridge = bridge;
const relayAck = (id) => bridge._handleMessage(JSON.stringify({ event: 'terminal.spawning', id }));

// ---- 1. waitForEvent: ack resolves the waiter with its payload; timeout resolves null ----
{
  const p = bridge.waitForEvent('terminal.spawning', 1000);
  relayAck('term-1');
  const ack = await p;
  ok(ack?.id === 'term-1', 'waitForEvent: ack resolves the waiter with the event payload');
  ok((await bridge.waitForEvent('never.fires', 20)) === null, 'waitForEvent: timeout resolves null (waiter self-cleans)');
}

// ---- 2. end-to-end: spawn awaits ack → awaits create → locks + pins + focuses ----
{
  calls.length = 0; sent.length = 0;
  const p = router.execute('terminal.spawn');
  await flush();
  ok(sent.length === 1 && sent[0].relay === 'terminal.spawn', 'spawn: relay message sent');
  relayAck('term-7');                                     // relay: adapter forked
  await flush();
  ok(calls.length === 0, 'spawn: no dock/spotlight/focus before the terminal exists');
  await router.execute('terminal.create term-7 10 4');    // adapter: grid created
  const r = await p;
  ok(calls[0] === 'dock.lock term-7' && calls[1] === 'dock.spotlight term-7' && calls[2] === 'terminal.focus term-7',
    `spawn: fired dock.lock then dock.spotlight then terminal.focus (got: ${calls.join(', ') || 'nothing'})`);
  ok(r.text.includes('term-7') && r.data?.pinned === true && r.data?.focused === true,
    `spawn: result reports the pinned + focused terminal ("${r.text}")`);
}

// ---- 3. restore-time re-adopt (terminal.create with no spawn) → no dock, no focus ----
{
  calls.length = 0;
  await router.execute('terminal.create term-19 10 4');
  ok(calls.length === 0, 'restore create (no spawn): fired NO dock.lock / terminal.focus');
}

// ---- 4. parallel spawns pair with their OWN acks, even when creates land out of order ----
{
  calls.length = 0; sent.length = 0;
  const p1 = router.execute('terminal.spawn');
  const p2 = router.execute('terminal.spawn');
  await flush();
  ok(sent.length === 2, 'parallel spawns: both relay messages sent');
  relayAck('term-8');   // FIFO: first ack pairs with the first spawn…
  relayAck('term-9');
  await flush();
  await router.execute('terminal.create term-9 10 4');    // …but the SECOND terminal arrives first
  await router.execute('terminal.create term-8 10 4');
  const [r1, r2] = await Promise.all([p1, p2]);
  ok(r1.data?.id === 'term-8' && r2.data?.id === 'term-9',
    `parallel spawns: each paired with its own id (got ${r1.data?.id} / ${r2.data?.id})`);
  // The two continuations interleave on the microtask queue (router.execute is async),
  // so assert the CONTRACT, not a global order: every verb fired, and per terminal the
  // order lock < spotlight < focus holds.
  const idx = (v, id) => calls.indexOf(`${v} ${id}`);
  const ordered = (id) => idx('dock.lock', id) !== -1 && idx('dock.lock', id) < idx('dock.spotlight', id) && idx('dock.spotlight', id) < idx('terminal.focus', id);
  ok(calls.length === 6 && ordered('term-8') && ordered('term-9'),
    `parallel spawns: each locked + pinned + focused its OWN terminal (got: ${calls.join(', ')})`);
}

console.log(failures === 0 ? '\nPASS — spawn awaits its terminal, then docks + focuses it; restores stay neutral' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
