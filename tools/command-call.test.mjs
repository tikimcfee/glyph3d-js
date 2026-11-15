// command-call.test.mjs — the `call` bundle hatch, on a bare CommandRouter, headless. `call` is the
// router's own verb (CommandRouter._call), so every app the CLI can reach answers it: a router with
// nothing else registered has it. A bundle decodes to the same [name, ...args] vector a typed line
// produces and re-dispatches; this locks that it round-trips a corpus of gnarly inputs
// BYTE-IDENTICAL — the guard for the CLI's one-shot bundles (cli/client.go). It also asserts the
// naive plain-line path genuinely corrupts the spaced/quoted inputs (the teeth): if the bus ever
// becomes quote-proof, that assertion says this test no longer tests what it thinks. Plus the
// object form, arg coercion, the sender riding through, and every refusal.
// Run: bun test tools/command-call.test.mjs
import { test, expect } from 'bun:test';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';

const CORPUS = [
    ['plain',           'analyzed'],
    ['spaces',          'rg -n TODO src/'],
    ['dquotes-pipe',    'rg -n "TODO|FIXME" src/'],
    ['squotes',         "grep -E 'foo|bar' ."],
    ['backslash',       'find . -name \\*.js'],
    ['win-path',        'C:\\Users\\someone\\x'],
    ['tab',             'col1\tcol2'],
    ['newline',         'line1\nline2'],
    ['json-blob',       '{"mode":"newspaper","n":3}'],
    ['looks-like-flag', '--mode'],
    ['unicode-emoji',   'café ☕ 日本語 — slug 🐌'],
    ['empty',           ''],
    ['embedded-quotes', 'he said "hi" then \\ left'],
    ['git-commit',      'git commit -m "fix: pipe | and quotes"'],
    ['multiline-task',  'Map the system.\nReport file:line refs.'],
    ['path-with-space', 'my notes/draft file.md'],
    ['kitchen-sink',    'awk \'{print $1}\' | sed "s/x/y/" > /tmp/o\tand'],
];
/** Inputs whose text has a space, quote or backslash: the plain line MUST corrupt these. */
const MUST_CORRUPT_NAIVE = ['spaces', 'dquotes-pipe', 'backslash', 'json-blob', 'git-commit', 'empty'];

const enc = new TextEncoder();
const b64 = (s) => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const bundle = (spec) => 'call ' + b64(JSON.stringify(spec));

/** A bare router with one probe verb that echoes the args (and sender) it received. */
function probeRouter() {
    const router = new CommandRouter({});
    router.register('probe', (args, ctx) => ({ text: 'OK', data: { got: args, sender: ctx.sender } }));
    return router;
}

test('a bare router answers call: the hatch is the router\'s own verb', () => {
    expect(new CommandRouter({}).commands.has('call')).toBe(true);
});

test('the bundle round-trips every corpus input byte-identical; the naive line corrupts the gnarly ones', async () => {
    const router = probeRouter();
    for (const [name, text] of CORPUS) {
        const viaBundle = await router.execute(bundle(['probe', text]));
        expect({ name, got: viaBundle.data?.got }).toEqual({ name, got: [text] });
        const naive = await router.execute('probe ' + text);
        const survived = Array.isArray(naive.data?.got) && naive.data.got.length === 1 && naive.data.got[0] === text;
        if (MUST_CORRUPT_NAIVE.includes(name)) expect({ name, survived }).toEqual({ name, survived: false });
        if (name === 'plain') expect(survived).toBe(true);   // the hatch is for gnarly args, not every line
    }
});

test('the object form, several args, non-string args coerced, the sender carried through', async () => {
    const router = probeRouter();
    const r = await router.execute(bundle({ cmd: 'probe', args: ['a b', 3, true, null] }), { sender: 'ctrl-7' });
    expect(r.data).toEqual({ got: ['a b', '3', 'true', 'null'], sender: 'ctrl-7' });
});

test('refusals: no payload, not base64 JSON, a bad shape, no name, call wrapping call', async () => {
    const router = probeRouter();
    const text = async (line) => (await router.execute(line)).text;
    expect(await text('call')).toMatch(/^ERR: usage: call/);
    expect(await text('call !!!notbase64')).toMatch(/^ERR: call payload must be base64-encoded JSON/);
    expect(await text(bundle({ args: ['x'] }))).toBe('ERR: call payload must be [name, ...args] or {cmd, args}');
    expect(await text(bundle([]))).toBe('ERR: call payload has no command name');
    expect(await text(bundle(['CALL', 'x']))).toBe('ERR: call cannot wrap call');
});
