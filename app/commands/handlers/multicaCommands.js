/**
 * multica.* commands — bind a Multica board onto the field.
 *
 * Multica runs agents as teammates: each has a name, a runtime, and a history of
 * tasks; work is issues, and a pipeline is a parent issue whose sub-issues carry a
 * 1-based `stage` acting as an ordered barrier. Those map onto what we already have
 * — an agent is a book, an issue is a page, a chat is an attached input — so these
 * verbs are a binding, not a new subsystem. The events land on `agent.*` through
 * MulticaBridge.
 *
 *   multica.login      <url> <email> [code]      dev auth — mails/logs a code, then exchanges it
 *   multica.connect    <url> <token> <workspaceId> [slug]   bind client + socket + bridge
 *   multica.disconnect                            drop the stream (books stay — they're history)
 *   multica.status                                connection, book count, unmapped event tally
 *   multica.agents                                the board's agents and their books
 *   multica.issues     [status]                   issues, optionally filtered
 *   multica.pipeline   <identifier|id>            a parent's sub-issues as a stage ladder
 *   multica.say        <agent> <text...>          send input to an agent's chat
 *
 * The backend is a plain HTTP origin — `tools/multica-up.sh` brings one up locally
 * from source (postgres + backend only, no Multica frontend).
 */

import { MulticaClient, MulticaSocket, MulticaBridge } from '@glyph3d/multica';

/** The one live binding. A second connect replaces it rather than stacking streams. */
let session = null;

/** @returns {{text: string, data: null}} */
const notConnected = () => ({ text: 'ERR: not connected — multica.connect <url> <token> <workspaceId>', data: null });

/**
 * @param {import('@glyph3d/core/services/orchestration/CommandRouter.js').default} router
 */
export default function registerMulticaCommands(router) {

    router.register('multica.login', async (args) => {
        const [url, email, code] = args;
        if (!url || !email) return { text: 'ERR: usage: multica.login <url> <email> [code]', data: null };
        const client = new MulticaClient({ baseUrl: url });
        if (!code) {
            await client.sendCode(email);
            return { text: `OK: code sent to ${email} — re-run with it: multica.login ${url} ${email} <code>`, data: null };
        }
        const { token, user } = await client.verifyCode(email, code);
        const workspaces = await (async () => {
            client.setToken(token);
            return client.listWorkspaces();
        })();
        const lines = workspaces.map(w => `  ${w.id}  ${w.name} (${w.slug})`);
        return {
            text: [`OK: ${user?.email || email}`, `token: ${token}`, 'workspaces:', ...lines].join('\n'),
            data: { token, user, workspaces },
        };
    }, {
        description: 'Authenticate against a Multica backend (dev code flow)',
        usage: '<url> <email> [code]',
        returns: '{ token, user, workspaces }',
    });

    router.register('multica.connect', async (args) => {
        const [url, token, workspaceId, slug] = args;
        if (!url || !token || !workspaceId) {
            return { text: 'ERR: usage: multica.connect <url> <token> <workspaceId> [slug]', data: null };
        }
        // A second connect replaces the first rather than stacking two live streams.
        if (session) {
            session.bridge.stop();
            session.socket.close();
        }

        const client = new MulticaClient({ baseUrl: url, token, workspaceId });
        const socket = new MulticaSocket({
            baseUrl: url, token, workspaceSlug: slug || null,
            identity: { platform: 'glyph3d' },
            warn: (m) => console.warn(m),
        });
        const bridge = new MulticaBridge({
            client, socket,
            execute: (input) => router.execute(input),
            warn: (m) => console.warn(m),
        });

        socket.connect();
        const counts = await bridge.start();
        session = { client, socket, bridge, url, workspaceId };

        return {
            text: `OK: multica ${url} — ${counts.agents} agent book(s), ${counts.issues} issue line(s)`,
            data: counts,
        };
    }, {
        description: 'Bind a Multica workspace: agents become books, issues become their pages',
        usage: '<url> <token> <workspaceId> [slug]',
        returns: '{ agents, issues }',
    });

    router.register('multica.disconnect', () => {
        if (!session) return notConnected();
        session.bridge.stop();
        session.socket.close();
        const { url } = session;
        session = null;
        return { text: `OK: disconnected from ${url}`, data: null };
    }, {
        description: 'Drop the Multica stream (books remain on the field)',
        returns: 'null',
    });

    router.register('multica.status', () => {
        if (!session) return { text: 'multica: not connected', data: { connected: false } };
        const { socket, bridge, url, workspaceId } = session;
        const unmapped = [...bridge.unhandled.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        const lines = [
            `multica: ${url}`,
            `workspace: ${workspaceId}`,
            `socket: ${socket.authenticated ? 'authenticated' : 'connecting'}`,
            `books: ${bridge.books.size}`,
        ];
        if (unmapped.length) lines.push(`unmapped events: ${unmapped.map(([t, n]) => `${t}×${n}`).join(', ')}`);
        return {
            text: lines.join('\n'),
            data: {
                connected: true, url, workspaceId,
                authenticated: socket.authenticated,
                books: bridge.books.size,
                unhandled: Object.fromEntries(bridge.unhandled),
            },
        };
    }, {
        description: 'Multica connection state, book count, and unmapped event tally',
        returns: '{ connected, authenticated, books, unhandled }',
    });

    router.register('multica.agents', async () => {
        if (!session) return notConnected();
        const agents = await session.client.listAgents();
        const lines = agents.map(a => {
            const book = session.bridge.books.get(a.id) || '—';
            return `  ${book}  ${a.name}  ${a.status || 'unknown'}`;
        });
        return { text: [`${agents.length} agent(s):`, ...lines].join('\n'), data: agents };
    }, {
        description: 'List the board\'s agents and the books they are bound to',
        returns: 'MulticaAgent[]',
    });

    router.register('multica.issues', async (args) => {
        if (!session) return notConnected();
        const [status] = args;
        const issues = await session.client.listIssues(status ? { status } : undefined);
        const lines = issues.map(i =>
            `  ${i.identifier}  ${i.status.padEnd(11)} ${i.stage == null ? '   ' : `s${i.stage} `} ${i.title}`);
        return { text: [`${issues.length} issue(s):`, ...lines].join('\n'), data: issues };
    }, {
        description: 'List issues, optionally filtered by status',
        usage: '[status]',
        returns: 'MulticaIssue[]',
    });

    router.register('multica.pipeline', async (args) => {
        if (!session) return notConnected();
        const [ref] = args;
        if (!ref) return { text: 'ERR: usage: multica.pipeline <identifier|id>', data: null };

        // Accept the human identifier ("GLY-1") as well as the UUID — the identifier is
        // what's on screen, and making the operator go look up a UUID is the kind of
        // friction that stops a verb from being used.
        let parent = null;
        if (/^[0-9a-f-]{36}$/i.test(ref)) {
            parent = await session.client.getIssue(ref);
        } else {
            const all = await session.client.listIssues();
            parent = all.find(i => i.identifier?.toLowerCase() === ref.toLowerCase()) || null;
        }
        if (!parent) return { text: `ERR: no issue '${ref}'`, data: null };

        const children = await session.client.listChildren(parent.id);
        // Stage is the barrier: siblings sharing one advance together, and the parent
        // only wakes when the whole group is done. Group by it so the ladder is visible.
        const stages = new Map();
        for (const c of children) {
            const key = c.stage == null ? 'unstaged' : c.stage;
            if (!stages.has(key)) stages.set(key, []);
            stages.get(key).push(c);
        }
        const ordered = [...stages.entries()].sort((a, b) =>
            (a[0] === 'unstaged' ? Infinity : a[0]) - (b[0] === 'unstaged' ? Infinity : b[0]));

        const lines = [`${parent.identifier}  ${parent.title}  [${parent.status}]`];
        for (const [stage, group] of ordered) {
            const done = group.filter(c => c.status === 'done').length;
            lines.push(`  stage ${stage}  (${done}/${group.length} done)`);
            for (const c of group) lines.push(`    ${c.identifier}  ${c.status.padEnd(11)} ${c.title}`);
        }
        return { text: lines.join('\n'), data: { parent, stages: ordered } };
    }, {
        description: 'Show a parent issue\'s sub-issues as a stage ladder (the pipeline)',
        usage: '<identifier|id>',
        returns: '{ parent, stages }',
    });

    router.register('multica.say', async (args) => {
        if (!session) return notConnected();
        const [agentRef, ...rest] = args;
        const text = rest.join(' ');
        if (!agentRef || !text) return { text: 'ERR: usage: multica.say <agent> <text...>', data: null };

        const agents = await session.client.listAgents();
        const agent = agents.find(a =>
            a.id === agentRef || a.name.toLowerCase() === agentRef.toLowerCase()
            || session.bridge.books.get(a.id) === agentRef);
        if (!agent) return { text: `ERR: no agent '${agentRef}'`, data: null };

        const out = await session.client.request('POST', '/api/chat/thread', {
            agent_id: agent.id,
            content: text,
        });
        return { text: `OK: sent to ${agent.name}`, data: out };
    }, {
        description: 'Send chat input to a Multica agent',
        usage: '<agent> <text...>',
        returns: 'the created thread/message',
    });
}
