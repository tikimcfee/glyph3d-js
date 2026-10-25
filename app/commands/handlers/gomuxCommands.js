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
 * Read-only: these verbs never type into, start, or stop an agent. The screen is a
 * read-only tmux client on the agent's session (cli/gomux.go attachGomuxAgent): keys typed
 * at it go nowhere, and it never resizes the agent's window. Dock it like any terminal
 * (`dock.lock gx-<name>`); releasing it returns it to its seat by the book. Framing an agent's book
 * is the ordinary camera verb on its lane: `camera.focus agent:book:<name>`.
 */
/** @import { AppContext } from '../../client/CommandProvider.jsx' */

import { waitForTerminal } from './terminalCommands.js';

const noHub = { text: 'ERR: no gomuxai hub (needs the relay)', data: null };

const ago = (iso) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerGomuxCommands(router) {
    router.register('gomux.list', (_args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        if (!hub.snapshot) return { text: 'gomuxai: no tree yet (relay offline, or no stores found)', data: { agents: [] } };
        const rows = hub.rows();
        const lines = rows.map(({ depth, agent: a, shown, book }) => {
            const status = a.live ? (a.status || 'unknown') : 'exited';
            const bits = [status.padEnd(10), (a.detail || '').slice(0, 72)];
            const tags = [!shown && 'hidden', book && `book:${book}`, a.attached && 'tmux'].filter(Boolean).join(' ');
            return `${'  '.repeat(depth)}${a.name.padEnd(Math.max(1, 22 - depth * 2))} ${bits.join(' ')}${tags ? `  [${tags}]` : ''}  ${ago(a.statusAt || a.createdAt)}`;
        });
        return {
            text: `gomuxai (${rows.length} agent${rows.length === 1 ? '' : 's'}, ${hub.snapshot.dirs.length} store${hub.snapshot.dirs.length === 1 ? '' : 's'})\n` + (lines.join('\n') || '(none)'),
            data: { gen: hub.snapshot.gen, dirs: hub.snapshot.dirs,
                    agents: rows.map(({ depth, agent, shown, book }) => ({ ...agent, depth, shown, book })) },
        };
    }, { description: 'The gomuxai agent tree: status, detail, and whether each agent has a book', returns: '{ gen, dirs, agents:[{name,parent,status,detail,live,attached,depth,shown,book}] }' });

    router.register('gomux.status', (args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        const [name] = args;
        if (!name) return { text: 'ERR: usage: gomux.status <name>', data: null };
        const a = hub.snapshot?.agents.find((x) => x.name === name);
        if (!a) return { text: `ERR: no gomuxai agent '${name}'`, data: null };
        const lines = [
            `${a.name}  ${a.live ? (a.status || 'unknown') : 'exited'}${a.attached ? '  (tmux ' + a.session + ')' : ''}`,
            a.parent ? `parent   ${a.parent}` : 'parent   (a person)',
            `backend  ${a.backend}${a.harness ? ' · ' + a.harness : ''}`,
            a.cwd && `cwd      ${a.cwd}`,
            a.detail && `detail   ${a.detail}`,
            a.tool && `tool     ${a.tool}`,
            a.toolInput && `pending  ${a.toolInput}`,
            `book     ${hub.lanes.get(a.name)?.phase ?? '(none)'}`,
        ].filter(Boolean);
        return { text: lines.join('\n'), data: { ...a, book: hub.lanes.get(a.name)?.phase ?? null } };
    }, { description: "One gomuxai agent's node — status, the tool in flight, a pending permission prompt", usage: '<name>' });

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
            text: `OK: ${name}'s screen is terminal '${id}' (read-only)${seated ? `, seated beside its book at '${seated}'` : ''}`,
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
        return router.execute(['terminal.kill', id]);
    }, { description: "Close an agent's screen terminal (the agent's own session is untouched)", usage: '<name>' });

    router.register('gomux.refresh', async (_args, ctx) => {
        const hub = ctx.gomuxHub;
        if (!hub) return noHub;
        await hub.refresh();
        return { text: `OK: gomuxai tree gen ${hub.snapshot?.gen ?? '-'} · ${hub.snapshot?.agents.length ?? 0} agents`, data: { gen: hub.snapshot?.gen ?? null } };
    }, { description: 'Pull the gomuxai tree from the relay now' });
}
