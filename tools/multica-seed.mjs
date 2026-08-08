// multica-seed.mjs — stand up a demonstrable board, then print the verbs to drive it.
//
//   bun tools/multica-seed.mjs [--url http://localhost:8099] [--email you@local]
//
// The point is one pass: after `tools/multica-up.sh up`, this authenticates, makes a
// workspace, binds whatever runtime the daemon registered, creates a few agents and a
// staged pipeline, and ends by printing the exact `multica.connect` line to paste into
// the app's command bar. Re-running is safe — it reuses an existing workspace and
// agents rather than piling up duplicates.
//
// Requires a paired daemon for the runtime (`multica daemon start` against this
// backend); without one the backend refuses to create agents at all, and this says so
// rather than failing obscurely.

import { MulticaClient } from '../packages/glyph3d-multica/src/index.js';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
};

const url = arg('url', process.env.MULTICA_URL || 'http://localhost:8099');
const email = arg('email', process.env.MULTICA_EMAIL || 'pilot@glyph3d.local');
const code = arg('code', process.env.MULTICA_DEV_VERIFICATION_CODE || '123456');
const slug = arg('slug', 'glyph3d-pilot');

const say = (...a) => console.log(...a);

const client = new MulticaClient({ baseUrl: url });

// -- auth ---------------------------------------------------------------------
await client.sendCode(email);
const { token } = await client.verifyCode(email, code);
say(`✓ authenticated as ${email}`);

// -- workspace ----------------------------------------------------------------
let workspace = (await client.listWorkspaces()).find(w => w.slug === slug);
if (!workspace) {
    workspace = await client.createWorkspace({ name: 'Glyph3D Pilot', slug, issue_prefix: 'GLY' });
    say(`✓ created workspace ${workspace.slug}`);
} else {
    say(`✓ reusing workspace ${workspace.slug}`);
}
client.setWorkspace(workspace.id);

// -- runtime ------------------------------------------------------------------
const runtimes = await client.listRuntimes();
if (!runtimes.length) {
    say('');
    say('✗ no runtime registered — the backend will refuse to create agents.');
    say('  Pair a daemon first, then re-run:');
    say(`    multica config set server_url ${url}`);
    say(`    multica config set workspace_id ${workspace.id}`);
    say('    multica daemon start');
    process.exit(1);
}
say(`✓ ${runtimes.length} runtime(s): ${runtimes.map(r => `${r.name} [${r.provider}]`).join(', ')}`);

// -- agents -------------------------------------------------------------------
const ROLES = [
    ['Cartographer', 'maps the shape of a codebase'],
    ['Surveyor', 'reads APIs and reports their surface'],
    ['Archivist', 'writes things down so they stay written down'],
];
const existing = await client.listAgents();
const agents = [];
// Spread the roles across whatever CLIs this box actually has, round-robin. With one
// runtime that's the old behavior; with several it seeds a genuinely mixed board, which
// is the interesting case — `multica.board runtime` then gives a column per CLI.
for (const [i, [name, description]] of ROLES.entries()) {
    const runtime = runtimes[i % runtimes.length];
    const found = existing.find(a => a.name === name);
    agents.push(found || await client.createAgent({
        name, description, instructions: `You are ${name}. ${description}.`,
        runtime_id: runtime.id, visibility: 'workspace',
    }));
}
say(`✓ ${agents.length} agents: ${agents.map(a => a.name).join(', ')}`);

// -- a staged pipeline --------------------------------------------------------
// stage is 1-based, and siblings sharing one are a barrier group: the parent advances
// only when the whole stage finishes. That ladder is the thing worth rendering.
const tag = new Date().toISOString().slice(11, 19);
const parent = await client.createIssue({
    title: `Render the board in 3D (${tag})`,
    description: 'Parent pipeline seeded by multica-seed.',
    status: 'in_progress', priority: 'high', allow_duplicate: true,
});
const LADDER = [
    [1, 'Survey the API surface', 'Surveyor'],
    [1, 'Map the entity types', 'Cartographer'],
    [2, 'Build the client', 'Cartographer'],
    [3, 'Wire the renderer', 'Archivist'],
];
for (const [stage, title, who] of LADDER) {
    const agent = agents.find(a => a.name === who);
    await client.createIssue({
        title, parent_issue_id: parent.id, stage,
        status: 'todo', priority: 'medium',
        assignee_type: 'agent', assignee_id: agent.id,
        allow_duplicate: true,
    });
}
say(`✓ pipeline ${parent.identifier} with ${LADDER.length} staged sub-issues`);

// -- the hand-off -------------------------------------------------------------
say('');
say('─'.repeat(72));
say('Paste into the command bar (or ./glyph3d-cli):');
say('');
say(`  multica.connect ${url} ${token} ${workspace.id} ${workspace.slug}`);
say(runtimes.length > 1 ? '  multica.board runtime      # a column per CLI' : '  multica.board');
say(`  multica.pipeline ${parent.identifier}`);
say(`  multica.attach ${agents[0].name}`);
say('');
say('Then type into the floating field and press Enter. Shift+Enter for a newline,');
say('↑/↓ to recall, Esc to release the keyboard.');
say('');
say('Headless equivalents:');
say(`  MULTICA_URL=${url} MULTICA_TOKEN=${token} MULTICA_WORKSPACE=${workspace.id} \\`);
say('    bun tools/multica-flow.test.mjs');
say('─'.repeat(72));
