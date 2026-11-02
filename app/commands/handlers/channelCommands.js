/**
 * Team channel commands — a team's messages as one scroll document pinned at its desk
 * (client/TeamChannels.js): every message that crossed between the team's agents and the person.
 *
 *   team.channel <name> [show|hide]   stand the team's channel up at gomux/<name> (default), or take it away
 *   team.channel <name> rows <±n>     scroll it by rows (the wheel's grammar; − up, + down)
 *   team.channel                      the teams whose channels are shown
 */

import { teamChannelsOf, channelId } from '../../client/TeamChannels.js';

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerChannelCommands(router) {
    router.register('team.channel', (args, ctx) => {
        const tc = teamChannelsOf(ctx);
        const [name, op = 'show', n] = args.map(String);
        if (!args.length) {
            const teams = [...tc.byTeam.keys()];
            return { text: teams.length ? `OK: channels shown: ${teams.join(', ')}` : 'OK: no team channel shown', data: { teams } };
        }
        if (op === 'hide') return tc.hide(name) ? { text: `OK: ${channelId(name)} taken away`, data: { team: name } } : { text: `ERR: no channel shown for '${name}'`, data: null };
        if (op === 'rows') {
            const d = Number(n);
            if (!Number.isFinite(d)) return { text: 'ERR: usage: team.channel <name> rows <±n>', data: null };
            const r = tc.scrollRows(name, d);
            return r ? { text: `OK: ${channelId(name)} ${r.following ? 'live' : 'held'} · row ${r.top}`, data: { team: name, ...r } } : { text: `ERR: no channel shown for '${name}'`, data: null };
        }
        if (op !== 'show') return { text: 'ERR: usage: team.channel <name> [show|hide|rows <±n>]', data: null };
        const doc = tc.show(name);
        if (!doc) return { text: `ERR: no team '${name}' (a gomuxai agent with an open book)`, data: null };
        const desk = ctx.holding?.holderOf?.(channelId(name))?.carrelName ?? null;
        const count = tc.byTeam.get(name).keys.length;
        return { text: `OK: ${channelId(name)} — ${count} message(s) among ${tc.members(name).join(', ')}${desk ? ` · at ${desk}` : ' · (its desk gomux/' + name + ' isn\'t standing — loose)'}`, data: { id: channelId(name), team: name, desk, messages: count, members: tc.members(name) } };
    }, { description: "A team's channel — every message between its agents and you, one scroll pinned at its desk", usage: '<name> [show|hide|rows <±n>]' });
}
