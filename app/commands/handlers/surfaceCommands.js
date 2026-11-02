/**
 * Agent surface commands — the terminals and desktops an AGENT made (client/AgentSurfaces.js):
 * an identified caller's terminal.spawn / terminal.create / desktop.start is its own, seated at
 * its plane desk `gomux/<name>`, kept there across reloads, marked (never stopped) when it ends.
 *
 *   agent.surfaces [name]   one agent's surfaces (live? where held, its residence, owner ended?);
 *                           bare: every agent that owns any (the caller's own first, if it does)
 */

import { agentSurfacesOf, ownerDesk } from '../../client/AgentSurfaces.js';

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerSurfaceCommands(router) {
    router.register('agent.surfaces', (args, ctx) => {
        const s = agentSurfacesOf(ctx);
        const name = args[0] ? String(args[0]) : null;
        if (!name) {
            const owners = s.owners().sort((a, b) => (a === ctx.caller ? -1 : b === ctx.caller ? 1 : a.localeCompare(b)));
            return owners.length
                ? { text: `OK: ${owners.length} agent(s) own surfaces:\n${owners.map((o) => `  ${o}  ${s.list(o).length} at ${ownerDesk(o)}`).join('\n')}`, data: { owners } }
                : { text: 'OK: no agent owns a surface', data: { owners: [] } };
        }
        const list = s.list(name);
        const rows = list.map((x) => `  ${x.id}  ${x.kind}${x.live ? '' : ' (not live)'}  at ${x.desk ?? '—'}${x.residence && x.residence !== x.desk ? ` (lives at ${x.residence})` : ''}${x.ownerEnded ? '  · owner ended' : ''}`);
        return { text: `OK: ${name} owns ${list.length} surface(s)${list.length ? `\n${rows.join('\n')}` : ''}`, data: { owner: name, surfaces: list } };
    }, { description: "The terminals and desktops an agent made — where they sit (its desk gomux/<name>), live or not, and whether it has ended", usage: '[name]', returns: '{ owner, surfaces:[{id, kind, live, desk, residence, ownerEnded}] } | { owners }' });
}
