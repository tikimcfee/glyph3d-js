/**
 * gomux.* commands — the gomuxai agent tree (GomuxHub): every agent the orchestrator runs,
 * as a book at the hub desk, helpers in their parent's team desk.
 *
 *   gomux.list               the tree, depth-first in spawn order: status · detail · book
 *   gomux.status <name>      one agent's node (status, the tool in flight, a pending prompt)
 *   gomux.refresh            pull the tree from the relay now (pushes keep it current)
 *   gomux.attach <name>      the agent's live tmux screen as a terminal, seated beside its book
 *   gomux.detach <name>      close that terminal (the agent's session is untouched)
 *
 *   agent.waiting            the agents gomuxai reports waiting on you, oldest first
 *   agent.say <name> <text>  answer an agent: gomuxai's `agent send` (typed in at its prompt,
 *                            held while it's busy, refused at a dialog) — through the relay
 *   agent.approve <name> [--expect <tool>]   yes to its permission prompt, for the tool the
 *                            display shows pending (--expect overrides); unknown → refused
 *   agent.deny <name>        no to its permission prompt (approve / deny: the agent in focus when
 *                            no name is given — the plane prefix's y / n)
 *   agent.reply <name> [text] the CommandBar opened as `agent.say <name> …` (a printable key on a
 *                            focused agent screen runs it: the reply line)
 *
 * The answer verbs run gomuxai's own commands through the relay (cli/agentinput.go) — never a
 * tmux client, never keys of ours — and only when Settings ▸ gomuxai `gomux.input` is on (off by
 * default: it reverses the hub's read-only rule, docs/planes/DESIGN.md §8 question 1). They are the
 * PERSON's verbs: an identified caller (an agent) is refused — it has gomuxai's `agent` itself.
 * Nothing here starts or stops an agent. The screen is a client-less view of the agent's pane
 * (cli/gomux.go attachGomuxAgent): keys typed at it go nowhere. Dock it like any terminal
 * (`dock.lock gx-<name>`); releasing it returns it to its seat by the book. Framing an agent's book
 * is the ordinary camera verb on its lane: `camera.focus agent:book:<name>`.
 */
/** @import { AppContext } from '../../client/CommandProvider.jsx' */

import { waitForTerminal } from './terminalCommands.js';
import { getSetting } from '../../client/settings.js';

const noHub = { text: 'ERR: no gomuxai hub (needs the relay)', data: null };

const ago = (iso) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/**
 * The live agents gomuxai reports WAITING (on a person): name, what for, the tool and its input if a
 * permission prompt is pending, seconds since the status moved. One reading for agent.waiting and the
 * HUD's waiting line.
 * @param {Object} hub GomuxHub @returns {Array<{name:string, detail:string, tool:string, toolInput:string, since:number|null}>}
 */
export function waitingAgents(hub) {
    const now = Date.now();
    return (hub?.snapshot?.agents || [])
        .filter((a) => a.live && a.status === 'waiting')
        .map((a) => ({
            name: a.name, detail: a.detail || '', tool: a.tool || '', toolInput: a.toolInput || '',
            since: a.statusAt ? Math.max(0, Math.round((now - Date.parse(a.statusAt)) / 1000)) : null,
        }));
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
/** An agent's status as gomuxai words it: `ended (quit)` for an end (`agent statuses`). */
function statusWords(a) {
    const status = a.live ? (a.status || 'unknown') : 'ended';
    const reason = a.endReason || (a.live ? '' : 'closed');
    return status === 'ended' && reason ? `ended (${reason})` : status;
}

export default function registerGomuxCommands(router) {
    router.register('gomux.list', (_args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        if (!hub.snapshot) return { text: 'gomuxai: no tree yet (relay offline, or no stores found)', data: { agents: [] } };
        const rows = hub.rows();
        const lines = rows.map(({ depth, agent: a, shown, hidden, book }) => {
            const status = statusWords(a);
            const bits = [status.padEnd(16), (a.detail || '').slice(0, 72)];
            // past: outside the history window (the hub doesn't show it); hidden: agent.hide / its group's rule
            const tags = [!shown && 'past', hidden && 'hidden', book && `book:${book}`, a.attached && 'tmux'].filter(Boolean).join(' ');
            return `${'  '.repeat(depth)}${a.name.padEnd(Math.max(1, 22 - depth * 2))} ${bits.join(' ')}${tags ? `  [${tags}]` : ''}  ${ago(a.statusAt || a.createdAt)}`;
        });
        return {
            text: `gomuxai (${rows.length} agent${rows.length === 1 ? '' : 's'}, ${hub.snapshot.dirs.length} store${hub.snapshot.dirs.length === 1 ? '' : 's'})\n` + (lines.join('\n') || '(none)'),
            data: { gen: hub.snapshot.gen, dirs: hub.snapshot.dirs,
                    agents: rows.map(({ depth, agent, shown, hidden, book }) => ({ ...agent, depth, shown, hidden, book })) },
        };
    }, { description: 'The gomuxai agent tree: status, detail, and whether each agent has a book', returns: '{ gen, dirs, agents:[{name,parent,status,detail,live,attached,depth,shown,hidden,book}] }' });

    router.register('gomux.status', (args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        const [name] = args;
        if (!name) return { text: 'ERR: usage: gomux.status <name>', data: null };
        const a = hub.snapshot?.agents.find((x) => x.name === name);
        if (!a) return { text: `ERR: no gomuxai agent '${name}'`, data: null };
        const lines = [
            `${a.name}  ${statusWords(a)}${a.attached ? '  (tmux ' + a.session + ')' : ''}`,
            a.parent ? `parent   ${a.parent}` : 'parent   (a person)',
            `backend  ${a.backend}${a.harness ? ' · ' + a.harness : ''}`,
            a.cwd && `cwd      ${a.cwd}`,
            a.detail && `detail   ${a.detail}`,
            a.tool && `tool     ${a.tool}`,
            a.toolInput && `pending  ${a.toolInput}`,
            `book     ${hub.phase(a.name) ?? '(none)'}`,
        ].filter(Boolean);
        return { text: lines.join('\n'), data: { ...a, book: hub.phase(a.name) } };
    }, { description: "One gomuxai agent's node — status, the tool in flight, a pending permission prompt", usage: '<name>' });

    router.register('agent.waiting', (_args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        const waiting = waitingAgents(hub);
        if (!waiting.length) return { text: 'OK: nobody is waiting on you', data: { waiting: [] } };
        const lines = waiting.map((w) => `  ${w.name}  ${w.since != null ? `${w.since}s  ` : ''}${w.detail || 'needs you'}${w.toolInput ? `  — ${w.toolInput}` : ''}`);
        return { text: `OK: ${waiting.length} waiting on you\n${lines.join('\n')}`, data: { waiting } };
    }, { description: 'The agents gomuxai reports waiting on you — what for, since when', returns: '{ waiting:[{name, detail, tool, toolInput, since}] }' });

    // ── answering (slice 1b): gomuxai's own send / approve / deny, through the relay ──
    /** Run one answer through the relay, or say why not. @returns {Promise<{text:string, data:any}>} */
    const answer = async (ctx, method, params, what) => {
        if (getSetting('gomux.input') !== true) {
            return { text: "ERR: answering agents is off — Settings ▸ gomuxai 'gomux.input' (it lets the display send to agents through gomuxai)", data: null };
        }
        if (ctx.caller) return { text: `ERR: ${what} is the person's verb — '${ctx.caller}' answers with gomuxai's agent CLI itself`, data: null };
        const bridge = ctx.wsbridge;
        if (!bridge?.connected) return { text: 'ERR: not connected to the relay', data: null };
        let r;
        try { r = await bridge.rpcRequest(method, params); }
        catch (e) { return { text: `ERR: ${what}: ${e?.message || e}`, data: null }; }
        console.info(`[gomux] ${what} ${params.name}: ${r.ok ? 'ok' : `exit ${r.code}`} — ${r.output}`);
        return r.ok
            ? { text: `OK: ${r.output || `${what} ${params.name}`}`, data: { ...params, ...r } }
            : { text: `ERR: gomuxai refused (exit ${r.code}): ${r.output}`, data: { ...params, ...r } };
    };
    const known = (ctx, name) => ctx.gomuxHub?.snapshot?.agents.find((x) => x.name === name) ?? null;
    /** The agent in focus: its screen (gx-<name>) or its book (agent:book:<name>) holds primary. */
    const focusedAgent = (ctx) => {
        const id = ctx.attentionManager?.get?.('primary')?.id;
        if (!id) return null;
        const screen = ctx.gomuxHub?.screenAgent?.(id);
        if (screen) return screen;
        const m = /^agent:book:(.+)$/.exec(id);
        return m && known(ctx, m[1]) ? m[1] : null;
    };

    router.register('agent.say', async (args, ctx) => {
        const [name, ...rest] = args;
        const text = rest.join(' ');
        if (!name || !text.trim()) return { text: 'ERR: usage: agent.say <name> <text>', data: null };
        if (ctx.gomuxHub && !known(ctx, name) && !name.includes('@')) return { text: `ERR: no gomuxai agent '${name}'`, data: null };
        return answer(ctx, 'agent/say', { name, text }, 'agent.say');
    }, { description: "Answer an agent: gomuxai's `agent send` — typed in at its prompt, held while it's busy, refused at a dialog (needs gomux.input on)", usage: '<name> <text>', returns: '{ name, text, ok, code, output }' });

    router.register('agent.reply', (args, ctx) => {
        const [name, ...rest] = args;
        if (!name) return { text: 'ERR: usage: agent.reply <name> [text]', data: null };
        if (!ctx.deixis) return { text: 'ERR: no CommandBar on this display', data: null };
        const told = ctx.deixis.draft(`agent.say ${name} ${rest.join(' ')}`);
        return { text: `OK: replying to ${name}${told ? '' : ' (no CommandBar to receive it)'}`, data: { name, told } };
    }, { description: 'Open the CommandBar as `agent.say <name> …` — the reply line (a key on a focused agent screen runs it)', usage: '<name> [text]', returns: '{ name, told }' });

    router.register('agent.approve', async (args, ctx) => {
        const name = args[0] && args[0] !== '--expect' ? args[0] : focusedAgent(ctx);
        if (!name) return { text: 'ERR: usage: agent.approve [name] [--expect <tool>] — no name, and no agent in focus', data: null };
        const i = args.indexOf('--expect');
        const pending = waitingAgents(ctx.gomuxHub).find((w) => w.name === name);
        const expect = i >= 0 ? String(args[i + 1] ?? '') : (pending?.tool || '');
        if (!expect) return { text: `ERR: refused — no pending tool known for '${name}' (gomuxai doesn't report it waiting on a permission prompt); look (gomux.status ${name}) and pass --expect <tool>`, data: null };
        return answer(ctx, 'agent/approve', { name, expect }, 'agent.approve');
    }, { description: "Yes to an agent's permission prompt — for the tool the display shows pending (--expect overrides); never blind (needs gomux.input on)", usage: '[name] [--expect <tool>]', returns: '{ name, expect, ok, code, output }' });

    router.register('agent.deny', async (args, ctx) => {
        const name = args[0] || focusedAgent(ctx);
        if (!name) return { text: 'ERR: usage: agent.deny [name] — no name, and no agent in focus', data: null };
        return answer(ctx, 'agent/deny', { name }, 'agent.deny');
    }, { description: "No to an agent's permission prompt — the agent in focus when none is named (needs gomux.input on)", usage: '[name]', returns: '{ name, ok, code, output }' });

    router.register('gomux.attach', async (args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        const [name] = args;
        if (!name) return { text: 'ERR: usage: gomux.attach <name>', data: null };
        const bridge = ctx.wsbridge;
        if (!bridge?.connected) return { text: 'ERR: not connected to the relay', data: null };
        const a = hub.snapshot?.agents.find((x) => x.name === name);
        if (!a) return { text: `ERR: no gomuxai agent '${name}'`, data: null };
        if (!a.attached) return { text: `ERR: '${name}' has no live tmux session (${a.live ? a.status : 'cleaned up'})`, data: null };

        let id = hub.screenId(name);
        if (!ctx.registry?.get(id)) {
            const ackPromise = bridge.waitForEvent('gomux.attaching', 5000);
            bridge.send(JSON.stringify({ relay: 'gomux.attach', name }));
            const ack = await ackPromise;
            if (!ack) return { text: `ERR: no answer from the relay for '${name}' (an old relay without gomux.attach?)`, data: null };
            if (ack.error) return { text: `ERR: ${ack.error}`, data: null };
            id = ack.id;
            if (!(await waitForTerminal(ctx.registry, id))) {
                return { text: `OK: '${name}' screen '${id}' is spawning — the adapter hasn't connected yet`, data: { id, seated: false } };
            }
        }
        const seated = hub.seatScreen(name, id);
        return {
            text: `OK: ${name}'s screen is terminal '${id}' (read-only)${seated === 'book' ? ', riding beside its book' : seated ? ` (held at '${seated}')` : ''}`,
            data: { id, seated: seated || null },
        };
    }, { description: "The agent's live tmux screen as a read-only terminal, seated beside its book", usage: '<name>', returns: '{ id, seated }' });

    router.register('gomux.detach', async (args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        const [name] = args;
        if (!name) return { text: 'ERR: usage: gomux.detach <name>', data: null };
        const id = hub.screenId(name);
        if (!ctx.registry?.get(id)) return { text: `ERR: '${name}' has no screen open`, data: null };
        hub.declineScreen(name);   // closed on purpose: autoScreens won't reopen it
        return ctx.execute(['terminal.kill', id]);
    }, { description: "Close an agent's screen terminal (the agent's own session is untouched)", usage: '<name>' });

    router.register('gomux.refresh', async (_args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        await hub.refresh();
        return { text: `OK: gomuxai tree gen ${hub.snapshot?.gen ?? '-'} · ${hub.snapshot?.agents.length ?? 0} agents`, data: { gen: hub.snapshot?.gen ?? null } };
    }, { description: 'Pull the gomuxai tree from the relay now' });
}
