// agent-waiting.test.mjs — the ONE reading of "who is waiting on you" (gomuxCommands.waitingAgents),
// behind agent.waiting and the HUD's waiting line.
//
//   bun tools/agent-waiting.test.mjs
//
// Locks: only LIVE agents whose gomuxai status is 'waiting' count (an ended agent that last waited,
// a processing one, an idle one don't); what for (detail, a pending tool and its input) rides along;
// seconds since the status moved; an absent hub reads as nobody.

import { waitingAgents } from '../app/commands/handlers/gomuxCommands.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const t = new Date(Date.now() - 42_000).toISOString();
const hub = { snapshot: { agents: [
    { name: 'a', live: true, status: 'waiting', detail: 'approve Bash', tool: 'Bash', toolInput: 'rm -rf build', statusAt: t },
    { name: 'b', live: true, status: 'processing' },
    { name: 'c', live: false, status: 'waiting', detail: 'stale' },
    { name: 'd', live: true, status: 'waiting' },
    { name: 'e', live: true, status: 'idle' },
] } };
const w = waitingAgents(hub);
ok(w.map((x) => x.name).join() === 'a,d', `only live waiting agents (got ${w.map((x) => x.name).join()})`);
ok(w[0].detail === 'approve Bash' && w[0].tool === 'Bash' && w[0].toolInput === 'rm -rf build', 'what it waits for rides along');
ok(w[0].since >= 41 && w[0].since <= 44, `seconds since the status moved (${w[0].since})`);
ok(w[1].since === null && w[1].detail === '', 'no statusAt → since null; no detail → empty');
ok(waitingAgents(null).length === 0 && waitingAgents({}).length === 0, 'no hub, no snapshot → nobody');

console.log(`${fails ? 'FAIL' : 'ok'} agent-waiting: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
