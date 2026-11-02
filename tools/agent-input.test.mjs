// agent-input.test.mjs — answering agents from the display (slice 1b; gomuxCommands.js agent.say /
// agent.approve / agent.deny over the relay's agent/* RPCs, cli/agentinput.go — its Go test runs the
// fake `agent` binary).
//
//   bun tools/agent-input.test.mjs
//
// Locks, through the real CommandRouter:
//   - with Settings ▸ gomuxai `gomux.input` OFF (its default) every answer is refused and NOTHING
//     reaches the relay
//   - on: agent.say sends {name, text} (the rest of the line, as typed); agent.deny {name}
//   - agent.approve takes the tool gomuxai reports pending (the hub tree's waiting node) as
//     --expect; --expect overrides; no pending tool known → refused, nothing sent (never blind)
//   - gomuxai's refusal (exit code + its words) is the ERR line; a relay error is an ERR line
//   - the person's verbs: an identified caller (an agent) is refused; an unknown agent is refused

// The settings store is localStorage: an in-memory one for the test (set before the module loads).
const store = new Map();
globalThis.localStorage ??= {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
globalThis.window.dispatchEvent ??= () => {};
const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: registerGomuxCommands } = await import('../app/commands/handlers/gomuxCommands.js');
const { setSetting, getSetting } = await import('../app/client/settings.js');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const quiet = async (fn) => { const i = console.info; console.info = () => {}; try { return await fn(); } finally { console.info = i; } };

const sent = [];
let answerWith = () => ({ ok: true, code: 0, output: 'sent (typed in at its prompt)' });
const bridge = {
    connected: true,
    async rpcRequest(method, params) { sent.push({ method, params }); const r = answerWith(method, params); if (r instanceof Error) throw r; return r; },
};
const hub = { snapshot: { agents: [
    { name: 'helper-1', live: true, status: 'idle' },
    { name: 'helper-2', live: true, status: 'waiting', tool: 'Bash', toolInput: 'make test', statusAt: new Date().toISOString() },
] } };
const ctx = { gomuxHub: hub, wsbridge: bridge, sender: null, caller: null, cid: 0, execute: null };
const router = new CommandRouter(ctx);
registerGomuxCommands(router);
const run = (line, caller = null) => quiet(() => router.execute(line, caller ? { caller } : {}));

ok(getSetting('gomux.input') === false, 'gomux.input is born OFF');
for (const line of [['agent.say', 'helper-1', 'hi'], ['agent.approve', 'helper-2'], ['agent.deny', 'helper-2']]) {
    const r = await run(line);
    ok(r.text.startsWith('ERR') && /gomux\.input/.test(r.text), `off: ${line[0]} refused (${r.text})`);
}
ok(sent.length === 0, 'off: nothing reached the relay');

setSetting(ctx, 'gomux.input', true);
{
    const r = await run(['agent.say', 'helper-1', 'look', 'at', 'src/x.js:3']);
    ok(r.text.startsWith('OK') && sent.at(-1)?.method === 'agent/say' && sent.at(-1).params.text === 'look at src/x.js:3' && sent.at(-1).params.name === 'helper-1',
        `say sends the rest of the line (${JSON.stringify(sent.at(-1))})`);
    const n = sent.length;
    const a = await run(['agent.approve', 'helper-2']);
    ok(a.text.startsWith('OK') && sent.at(-1)?.method === 'agent/approve' && sent.at(-1).params.expect === 'Bash', `approve expects the pending tool (${JSON.stringify(sent.at(-1))})`);
    await run(['agent.approve', 'helper-2', '--expect', 'Write']);
    ok(sent.at(-1).params.expect === 'Write', '--expect overrides');
    const blind = await run(['agent.approve', 'helper-1']);
    ok(blind.text.startsWith('ERR') && /no pending tool/.test(blind.text) && sent.length === n + 2, `no pending tool known: refused, nothing sent (${blind.text})`);
    await run(['agent.deny', 'helper-2']);
    ok(sent.at(-1)?.method === 'agent/deny' && sent.at(-1).params.name === 'helper-2', 'deny sends {name}');

    answerWith = () => ({ ok: false, code: 5, output: 'pending prompt is not Bash' });
    const refused = await run(['agent.approve', 'helper-2']);
    ok(refused.text === 'ERR: gomuxai refused (exit 5): pending prompt is not Bash', `gomuxai's refusal is the ERR line (${refused.text})`);
    answerWith = () => new Error('gomuxai disabled (--no-gomuxai)');
    const e = await run(['agent.deny', 'helper-2']);
    ok(e.text.startsWith('ERR') && /gomuxai disabled/.test(e.text), `a relay error is the ERR line (${e.text})`);
    answerWith = () => ({ ok: true, code: 0, output: 'sent' });

    const m = sent.length;
    const agent = await run(['agent.say', 'helper-1', 'hi'], 'helper-9');
    ok(agent.text.startsWith('ERR') && /person's verb/.test(agent.text) && sent.length === m, `an identified caller is refused (${agent.text})`);
    const who = await run(['agent.say', 'nobody', 'hi']);
    ok(who.text.startsWith('ERR') && /no gomuxai agent/.test(who.text) && sent.length === m, `an unknown agent is refused (${who.text})`);
    const empty = await run(['agent.say', 'helper-1']);
    ok(empty.text.startsWith('ERR') && /usage/.test(empty.text), 'say with no text: usage');
}
// the agent in focus (approve / deny with no name — the plane prefix's y / n) and the reply line
{
    hub.screenId = (n) => `gx-${n}`;
    hub.screenAgent = (id) => (id.startsWith('gx-') ? id.slice(3) : null);
    ctx.attentionManager = { get: (slot) => (slot === 'primary' ? { id: 'gx-helper-2' } : null) };
    await run(['agent.approve']);
    ok(sent.at(-1)?.method === 'agent/approve' && sent.at(-1).params.name === 'helper-2' && sent.at(-1).params.expect === 'Bash', `approve with no name: the agent whose screen is in focus (${JSON.stringify(sent.at(-1))})`);
    ctx.attentionManager = { get: (slot) => (slot === 'primary' ? { id: 'agent:book:helper-2' } : null) };
    await run(['agent.deny']);
    ok(sent.at(-1)?.method === 'agent/deny' && sent.at(-1).params.name === 'helper-2', 'deny with no name: the agent whose book is in focus');
    ctx.attentionManager = { get: () => null };
    const none = await run(['agent.deny']);
    ok(none.text.startsWith('ERR') && /no agent in focus/.test(none.text), 'no name and nothing in focus: usage');
    const drafts = [];
    ctx.deixis = { draft: (s) => { drafts.push(s); return 1; } };
    await run(['agent.reply', 'helper-1', 'k']);
    ok(drafts.at(-1) === 'agent.say helper-1 k', `agent.reply drafts the reply line (${drafts.at(-1)})`);

    // the keyboard tier: a printable key on a focused agent screen opens the reply line
    const { installKeyboardRouter } = await import('../app/client/keyboardRouter.js');
    const listeners = {};
    const doc = { activeElement: null, addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener() {} };
    const ran = [];
    let replyOn = true;
    const off = installKeyboardRouter({
        am: { get: (slot) => (slot === 'key' ? { id: 'gx-helper-1', entity: { type: 'terminal' } } : null), onChange() { return () => {}; }, subscribe() { return () => {}; } },
        exec: (c) => ran.push(c), gestureEnv: {}, document: doc,
        replyAgentFor: (id) => (replyOn && id.startsWith('gx-') ? id.slice(3) : null),
    });
    const key = (k, mods = {}) => { let claimed = false; listeners.keydown({ key: k, ...mods, preventDefault() { claimed = true; }, stopImmediatePropagation() {} }); return claimed; };
    ok(key('w') && JSON.stringify(ran.at(-1)) === JSON.stringify(['agent.reply', 'helper-1', 'w']), `a key on a focused agent screen opens its reply line (${JSON.stringify(ran.at(-1))})`);
    const n0 = ran.length;
    key('c', { ctrlKey: true });
    ok(!ran.slice(n0).some((c) => Array.isArray(c) && c[0] === 'agent.reply'), 'a chord is not a reply');
    replyOn = false;
    key('w');
    ok(!ran.slice(n0).some((c) => Array.isArray(c) && c[0] === 'agent.reply'), 'answering off: the key is not taken for a reply');
    off?.();
}
setSetting(ctx, 'gomux.input', false);

console.log(`${fails ? 'FAIL' : 'ok'} agent-input: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
