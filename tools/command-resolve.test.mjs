// command-resolve.test.mjs — behavior lock for CommandRouter name resolution.
//
//   bun tools/command-resolve.test.mjs
//
// The dot is canonical, not required: "grid list" resolves to grid.list. The rules
// under test, in precedence order:
//   1. an exactly-typed first token always wins (`select foo` runs `select`),
//   2. dot-free tokens resolve to the LONGEST registered leading chain
//      ("camera frame bounds" → camera.frame.bounds, not camera.frame + arg),
//   3. unambiguous prefix completes, typed ("worksp") or dot-joined ("grid li"),
//   4. ambiguity reports the tightest match set ("grid l" → grid.list|grid.layout,
//      not every grid.*).
// The registry below mirrors the real topology's hazards: single-token verbs that
// are namespace prefixes (select/select.grid) and 2-segment verbs with 3-segment
// children (camera.frame/camera.frame.bounds).

// The router's telemetry imports (ErrorTracker) self-install window handlers at
// module scope; a listener-sink window is all they need under bun.
globalThis.window ??= { addEventListener() {} };
const { default: CommandRouter } =
    await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want ${J(b)}`);

const router = new CommandRouter({});
for (const name of [
    'help',
    'select', 'select.grid',
    'grid.list', 'grid.layout',
    'camera.frame', 'camera.frame.bounds', 'camera.reset',
    'workspace.save',
]) {
    router.register(name, (args) => ({ text: 'OK', data: { name, args } }));
}

/** execute and return { name, args } for a hit, or the ERR text. */
async function res(input) {
    const r = await router.execute(input);
    return r.data?.name ? r.data : r.text;
}

// ── exact names are untouched ──────────────────────────────────────────────────────────
eq(await res('grid.list'), { name: 'grid.list', args: [] }, 'exact dotted name runs');
eq(await res('select grid'), { name: 'select', args: ['grid'] },
    'exact first token short-circuits — its args are never joined');
eq(await res('select.grid 1'), { name: 'select.grid', args: ['1'] },
    'the dotted spelling reaches the deeper verb under a single-token one');

// ── dot-free spelling ──────────────────────────────────────────────────────────────────
eq(await res('grid list'), { name: 'grid.list', args: [] }, 'dot-free two-token verb');
eq(await res('grid layout jellyfish 2'), { name: 'grid.layout', args: ['jellyfish', '2'] },
    'dot-free verb keeps its args');
eq(await res('camera frame bounds'), { name: 'camera.frame.bounds', args: [] },
    'longest chain wins over parent-verb-plus-arg');
eq(await res('camera frame bounds 12'), { name: 'camera.frame.bounds', args: ['12'] },
    'longest chain keeps trailing args');
eq(await res('camera frame g3'), { name: 'camera.frame', args: ['g3'] },
    'chain stops at a token that names nothing — real args are never swallowed');
eq(await res('Camera Frame'), { name: 'camera.frame', args: [] }, 'dot-free join is case-insensitive');
eq(await res(['grid', 'list']), { name: 'grid.list', args: [] }, 'array input resolves the same');
eq(await res('grid layout "jelly fish"'), { name: 'grid.layout', args: ['jelly fish'] },
    'a quoted arg stays one token through resolution');

// ── prefix completion ──────────────────────────────────────────────────────────────────
eq(await res('worksp'), { name: 'workspace.save', args: [] }, 'unambiguous typed prefix completes');
eq(await res('worksp 5'), { name: 'workspace.save', args: ['5'] }, 'typed prefix keeps args');
eq(await res('grid li'), { name: 'grid.list', args: [] }, 'unambiguous dot-joined prefix completes');
eq(await res('grid li extra'), { name: 'grid.list', args: ['extra'] }, 'dot-joined prefix keeps args');
eq(await res('camera res 1'), { name: 'camera.reset', args: ['1'] },
    'dot-free + partial last segment completes');

// ── ambiguity and misses ───────────────────────────────────────────────────────────────
{
    const r = await router.execute('grid l');
    ok(/^ERR: ambiguous/.test(r.text), 'ambiguous joined prefix errors');
    eq(r.data.matches.sort(), ['grid.layout', 'grid.list'],
        'ambiguity reports the tight dot-joined match set, not all grid.*');
}
{
    const r = await router.execute('camera');
    ok(/^ERR: ambiguous/.test(r.text), 'bare ambiguous namespace still errors');
    eq(r.data.matches.length, 3, 'bare-namespace ambiguity lists every camera.*');
}
ok(/^ERR: unknown/.test((await router.execute('zzz nope')).text), 'unknown stays unknown');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
