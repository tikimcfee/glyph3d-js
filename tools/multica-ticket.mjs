// multica-ticket.mjs — file a real feature as a staged pipeline and hand it to a team.
//
//   bun tools/multica-ticket.mjs                     file the built-in search/preview spec
//   bun tools/multica-ticket.mjs --file spec.json    file your own
//   bun tools/multica-ticket.mjs --dry-run           print what it would create
//   bun tools/multica-ticket.mjs --assign            also move stage 1 to in_progress
//
// Env: MULTICA_URL, MULTICA_TOKEN, MULTICA_WORKSPACE
//
// A spec is `{ title, description, stages: [{ stage, title, role, description }] }`.
// `role` names the agent by display name; unknown roles round-robin across whatever
// agents exist, so a spec is portable across workspaces.
//
// Stage numbers are 1-based and siblings sharing one form a barrier group — the parent
// only advances when the whole group finishes. That is Multica's own semantics, not
// something layered on here, which is why a pipeline is worth rendering as depth.

import { readFileSync } from 'node:fs';
import { MulticaClient } from '../packages/glyph3d-multica/src/index.js';

const has = (f) => process.argv.includes(`--${f}`);
const arg = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i > -1 ? process.argv[i + 1] : d; };

const url = arg('url', process.env.MULTICA_URL || 'http://localhost:8099');
const token = arg('token', process.env.MULTICA_TOKEN);
const workspaceId = arg('workspace', process.env.MULTICA_WORKSPACE);

/**
 * The built-in spec: tree-wide search with instant preview.
 *
 * Grounded in what the repo actually has today — `app/client/palette/` + fzf rank the
 * command palette and the file finder, `file.open` loads a grid, and `search.clear` is
 * the ONLY search verb that exists, so query/next/preview are genuinely absent. The
 * index angle is real too: `compute/GlyphTrie.js` already sits beside the layout kernel.
 */
const DEFAULT_SPEC = {
    title: 'Tree-wide search with instant preview',
    description: [
        'Search a loaded source tree and preview hits instantly, the way the VSCode',
        'quick-open/search pane does — type, walk results, see content without committing',
        'to opening a file.',
        '',
        'We already have most of the input half: the command palette and file finder rank',
        'through app/client/palette/ + fzf, and file.open loads a path as a CodeGrid. What',
        'is missing is CONTENT search: search.clear is currently the only search.* verb.',
        '',
        'Open question worth answering before building: whether the index can ride the',
        'existing layout bake rather than being a second store. compute/GlyphTrie.js sits',
        'beside the layout kernel already, and the bake is the one place that has seen',
        'every glyph of every loaded file.',
        '',
        'Done means: search.query <text> returns ranked hits across the loaded tree,',
        'search.next/prev walk them, each walk previews the hit in place without a full',
        'file.open, and the whole thing is driven by verbs so the CLI and the UI share it.',
    ].join('\n'),
    stages: [
        {
            stage: 1, role: 'Surveyor',
            title: 'Audit the existing find/palette surface',
            description: 'Inventory app/client/palette/rank.js, CommandBar.jsx, the fzf usage, and every file.*/search.* verb. Report what ranking already exists and what a content search would reuse vs duplicate.',
        },
        {
            stage: 1, role: 'Cartographer',
            title: 'Audit the layout bake for index reuse',
            description: 'Read compute/GlyphTrie.js, GlyphLayoutKernel.js and the bake path. Answer: can a content index ride the existing bake, and what would incremental update on edit cost?',
        },
        {
            stage: 2, role: 'Cartographer',
            title: 'Design the index + the search verb surface',
            description: 'From the two audits: propose the index shape (trie vs inverted vs bake-resident), and the verb surface — search.query / search.next / search.prev / search.preview. Verbs first: the CLI and the UI must share one path.',
        },
        {
            stage: 3, role: 'Cartographer',
            title: 'Build the index and search.query',
            description: 'Implement the index build over a loaded tree plus incremental update on edit, and search.query returning ranked hits. Include a headless test over a large tree.',
        },
        {
            stage: 3, role: 'Archivist',
            title: 'Build instant preview on hit',
            description: 'Implement search.next/prev + preview: frame the hit in place with its highlight range, without a full file.open. Reuse CodeGrid framing and the highlight ranges that already exist.',
        },
        {
            stage: 4, role: 'Surveyor',
            title: 'Verify: correctness and perf on a large tree',
            description: 'Lock the verb surface with tests, and measure query latency and index build time against a large tree. Report numbers, not adjectives.',
        },
    ],
};

const spec = has('file') ? JSON.parse(readFileSync(arg('file'), 'utf8')) : DEFAULT_SPEC;

if (has('dry-run')) {
    console.log(`${spec.title}\n`);
    for (const s of spec.stages) console.log(`  stage ${s.stage}  ${s.role.padEnd(14)} ${s.title}`);
    process.exit(0);
}

if (!token || !workspaceId) {
    console.error('multica-ticket: need MULTICA_URL, MULTICA_TOKEN and MULTICA_WORKSPACE (tools/multica-seed.mjs prints them)');
    process.exit(2);
}

const client = new MulticaClient({ baseUrl: url, token, workspaceId });

const agents = await client.listAgents();
if (!agents.length) {
    console.error('multica-ticket: no agents — run tools/multica-seed.mjs first');
    process.exit(1);
}
const byName = new Map(agents.map(a => [a.name.toLowerCase(), a]));

// allow_duplicate throughout: the backend 409s a same-titled active issue, and filing
// the same ticket twice on purpose (a second run, a second team) is legitimate here.
const parent = await client.createIssue({
    title: spec.title,
    description: spec.description,
    status: 'in_progress',
    priority: 'high',
    allow_duplicate: true,
});
console.log(`▸ ${parent.identifier}  ${parent.title}`);

let i = 0;
const created = [];
for (const s of spec.stages) {
    // An unknown role must not drop the work — round-robin rather than skip.
    const agent = byName.get(String(s.role).toLowerCase()) || agents[i % agents.length];
    i += 1;
    const issue = await client.createIssue({
        title: s.title,
        description: s.description,
        parent_issue_id: parent.id,
        stage: s.stage,
        status: 'todo',
        priority: 'medium',
        assignee_type: 'agent',
        assignee_id: agent.id,
        allow_duplicate: true,
    });
    created.push({ ...issue, role: agent.name });
    console.log(`    stage ${s.stage}  ${issue.identifier}  ${agent.name.padEnd(14)} ${issue.title}`);
}

// Barrier groups, printed so the shape is legible before anything runs.
const groups = new Map();
for (const c of created) groups.set(c.stage, (groups.get(c.stage) || 0) + 1);
console.log(`\n  ${groups.size} stages: ${[...groups.entries()].map(([s, n]) => `stage ${s}=${n}`).join(', ')}`);
console.log('  (siblings in a stage are one barrier group — the parent advances when the group finishes)');

if (has('assign')) {
    // Moving stage 1 to in_progress is what actually wakes the assignees.
    for (const c of created.filter(c => c.stage === 1)) {
        await client.updateIssue(c.id, { status: 'in_progress' });
        console.log(`  → ${c.identifier} in_progress (${c.role})`);
    }
}

console.log(`\nWatch it:  bun tools/multica-watch.mjs --board runtime`);
console.log(`Inspect:   multica.pipeline ${parent.identifier}`);
