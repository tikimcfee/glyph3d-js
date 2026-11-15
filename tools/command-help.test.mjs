// command-help.test.mjs — `help`, the router's own verb (CommandRouter._help), headless on a bare
// router: every app has it (the "unknown command … Try 'help'" error is true everywhere), bare help
// maps the namespaces it holds, `help <verb>` is that verb's card, `help <namespace>` its table, the
// dot is optional, and a miss says so. Run: bun test tools/command-help.test.mjs
import { test, expect } from 'bun:test';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';

function router() {
    const r = new CommandRouter({});
    const noop = () => 'OK';
    r.register('grid.list', noop, { description: 'List grids', returns: '{ grids }' });
    r.register('grid.layout', noop, { description: 'Lay a grid out', usage: '<id> --mode <m>' });
    r.register('wall.hide', noop, { description: 'Hide a terminal', usage: '<id>' });
    return r;
}

test('a bare router answers help, and its unknown-command error points there', async () => {
    const r = new CommandRouter({});
    expect(r.commands.has('help')).toBe(true);
    expect((await r.execute('nope.nothing')).text).toBe("ERR: unknown command 'nope.nothing'. Try 'help'.");
    expect((await r.execute('help')).text).toContain('COMMAND BUS');
});

test('bare help maps the namespaces by weight and lists the single-word verbs', async () => {
    const { text, data } = await router().execute('help');
    expect(data.namespaces).toEqual({ grid: 2, wall: 1 });
    expect(data.solo).toEqual(['call', 'help']);
    expect(data.count).toBe(5);
    expect(text).toContain('5 verbs · 2 namespaces');
    expect(text.indexOf('grid 2')).toBeLessThan(text.indexOf('wall 1'));
});

test('help <verb> is its card, with usage and returns; the dot is optional', async () => {
    const r = router();
    const card = await r.execute('help grid.list');
    expect(card.data.commands.map((c) => c.name)).toEqual(['grid.list']);
    expect(card.text).toContain('returns  { grids }');
    expect((await r.execute('help grid list')).text).toBe(card.text);
    expect((await r.execute('help grid.layout')).text).toContain('usage    grid.layout <id> --mode <m>');
});

test('help <namespace> is its table; a miss says so', async () => {
    const r = router();
    const ns = await r.execute('help grid');
    expect(ns.data.commands.map((c) => c.name)).toEqual(['grid.layout', 'grid.list']);
    expect(ns.text).toContain('COMMANDS: grid*');
    expect((await r.execute('help zzz')).text).toBe("No commands matching 'zzz' — bare help maps the namespaces");
});
