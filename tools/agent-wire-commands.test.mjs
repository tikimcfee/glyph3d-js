// agent-wire-commands.test.mjs — behavior lock for the live-ingress verbs in
// app/commands/handlers/agentCommands.js:
//
//   bun tools/agent-wire-commands.test.mjs
//
// Locks:
//   - agent.meta <id> <json>: ensures the lane (type from meta.harness), merges meta,
//     rebakes the nameplate
//   - agent.kimi-wire <id> <b64line>: raw wire lines → shared dialect → tool/message
//     sheets (debounced batch), provenance (model/title/cwd) forwarded to the lane
//
// Headless: the 2d-canvas stub stands in for the DOM; AgentBooks runs scene-only.

import './headless-canvas.mjs';
import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };

const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { encodeBase64 } = await import('../packages/glyph3d-core/src/utils/encoding.js');
const { default: registerAgentCommands } = await import('../app/commands/handlers/agentCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handlers = {};
registerAgentCommands({ register: (name, fn) => { handlers[name] = fn; } });
const books = new AgentBooks({ scene: new THREE.Scene(), atlas: null, registry: null });
const ctx = { agentBooks: books, sessionProvider: null };

// ── agent.meta ──
{
    const r = handlers['agent.meta'](['abc123', JSON.stringify({ harness: 'claude', slug: 'crispy-seeking-taco', model: 'glm-4.7', cwd: '/home/ivan/dev/glyph3d-js' })], ctx);
    ok(r.text.startsWith('OK'), `agent.meta OK (got "${r.text}")`);
    const lane = books.lanes.get('abc123');
    ok(!!lane, 'agent.meta ensured the lane');
    ok(lane.agentType === 'claude', `lane type from meta.harness (got "${lane.agentType}")`);
    ok(lane.meta?.slug === 'crispy-seeking-taco' && lane.meta?.model === 'glm-4.7', 'meta merged onto the lane');
    ok(lane.label.label.includes('crispy-seeking-taco') && lane.label.label.includes('glm-4.7'),
        `nameplate rebaked with provenance (got "${lane.label.label}")`);
    const bad = handlers['agent.meta'](['abc123', 'not json'], ctx);
    ok(bad.text.startsWith('ERR'), 'agent.meta rejects malformed json');
}

// ── agent.kimi-wire ──
{
    // Spy the sink: live paging builds CodeGrid cards, which need a real atlas/GPU —
    // unavailable headless. The handler's contract is the RECORDS it sinks (and the meta
    // it forwards); sheet paging itself is AgentBooks' own tested behavior.
    const sunk = [];
    const realActivity = books.activity.bind(books);
    books.activity = (id, type, rec) => { sunk.push({ id, type, rec }); };

    const wire = (obj) => encodeBase64(JSON.stringify(obj));
    const id = 'deadbeef';
    const lines = [
        { type: 'llm.request', model: 'k3', modelAlias: 'kimi-code/k3', provider: 'kimi', time: 1 },
        { type: 'turn.prompt', input: [{ type: 'text', text: 'fix the pairing bug' }], time: 2 },
        { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 't1', name: 'Bash', args: { command: 'ls' }, display: { cwd: '/home/ivan/dev/glyph3d-js' } }, time: 3 },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't1', result: { output: 'a\nb\nc' } }, time: 4 },
        { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'done fixing' } }, time: 5 },
    ];
    for (const l of lines) {
        const r = handlers['agent.kimi-wire']([id, wire(l)], ctx);
        ok(r.text.startsWith('OK'), `kimi-wire line OK (got "${r.text}")`);
    }
    await sleep(10);   // the sink is a 0ms debounce — let the batch flush
    books.activity = realActivity;

    const lane = books.lanes.get(id);
    ok(!!lane && lane.agentType === 'kimi', 'kimi-wire ensured a kimi lane');
    ok(sunk.length === 2, `tool + message records sunk (got ${sunk.length})`);
    const tool = sunk.find((s) => s.rec.action === 'bash');
    ok(!!tool && tool.id === id && tool.type === 'kimi', 'tool record normalized via the registry');
    ok(!!tool && (tool.rec.detail || tool.rec.result || tool.rec.meta),
        'tool record carries the in-batch late result (debounced sink saw call+result paired)');
    ok(sunk.some((s) => s.rec.action === 'say'), 'content.part sunk as a say record');
    ok(lane.meta?.model === 'k3' && lane.meta?.title === 'fix the pairing bug' && lane.meta?.cwd === '/home/ivan/dev/glyph3d-js',
        `live provenance forwarded (model=${lane.meta?.model} title=${lane.meta?.title})`);
    ok(lane.label.label.includes('k3') && lane.label.label.includes('fix the pairing bug'),
        `nameplate shows live provenance (got "${lane.label.label}")`);
    const bad = handlers['agent.kimi-wire']([id, '!!!notb64!!!'], ctx);
    ok(bad.text.startsWith('OK') && bad.text.includes('dropped'), 'malformed wire line drops quietly');
}

console.log(`\nagent-wire-commands: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
