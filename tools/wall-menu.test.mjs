// wall-menu.test.mjs — the wall's right-click menu, headless: who a right-click belongs to
// (contextPolicy: first → ours; again while ours is open → the browser's; Shift → the browser's;
// a mouse-reporting terminal's body → the program, Shift → ours; inputs and DOM chrome → the
// browser's; the menu key's own event → ours), the same policy as WallMenu routes real events on a
// stand-in wall (default prevented or not, the verb it runs), what each menu lists and the verbs
// its rows run, where it sits (flipped at the view's edges), the knobs, and the wall.menu /
// wall.select all / wall.fit verbs.
// Run: bun test tools/wall-menu.test.mjs
import { test, expect } from 'bun:test';
import { contextPolicy, isSecondaryPress, menuItems, placeMenu, parseSizes } from '../wall/contextMenu.js';
import { WALL_CONFIG, checkConfig } from '../wall/wallConfig.js';
import { KNOBS, searchSettings } from '../wall/wallSettings.js';

// WallMenu reads e.target as a DOM Element; a few stand-in elements are enough.
class FakeElement {
    constructor(attrs = {}, parent = null) { this.attrs = attrs; this.parent = parent; this.dataset = {}; for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; }
    closest(sel) {
        for (let el = this; el; el = el.parent) if (sel.split(',').some((s) => el._matches(s.trim()))) return el;
        return null;
    }
    _matches(s) {
        if (/^[a-z]+$/.test(s)) return this.attrs.tag === s;
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
        return !!m && m[1] in this.attrs && (m[2] === undefined || this.attrs[m[1]] === m[2]);
    }
}
globalThis.Element = FakeElement;
const { default: WallMenu } = await import('../wall/WallMenu.js');

const base = { shiftKey: false, editable: false, chrome: false, menuOpen: false, keyboard: false, mouseReporting: false };
const term = (part = 'body') => ({ kind: 'terminal', id: 't1', part });

test('the event policy: first right-click ours, again while open native, Shift native', () => {
    expect(contextPolicy({ ...base, target: term() }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: term('title') }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: { kind: 'group', id: 'g-1' } }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: { kind: 'canvas' } }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: term(), menuOpen: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: { kind: 'canvas' }, menuOpen: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: term(), shiftKey: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: { kind: 'canvas' }, shiftKey: true }).verdict).toBe('native');
});

test('the event policy: a mouse-reporting terminal body is the program\'s; Shift reaches ours; its title is ours', () => {
    expect(contextPolicy({ ...base, target: term(), mouseReporting: true }).verdict).toBe('program');
    expect(contextPolicy({ ...base, target: term(), mouseReporting: true, shiftKey: true }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: term('title'), mouseReporting: true }).verdict).toBe('ours');
    expect(contextPolicy({ ...base, target: term('edge'), mouseReporting: true, shiftKey: true }).verdict).toBe('native');
    // and the native menu still comes on a second right-click
    expect(contextPolicy({ ...base, target: term(), mouseReporting: true, menuOpen: true }).verdict).toBe('native');
});

test('the event policy: inputs, editable fields and DOM chrome keep the browser menu; the menu key is ours', () => {
    expect(contextPolicy({ ...base, target: null, editable: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: null, chrome: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: null }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: null, editable: true, menuOpen: true }).verdict).toBe('native');
    expect(contextPolicy({ ...base, target: null, keyboard: true, shiftKey: true, menuOpen: true }).verdict).toBe('ours');
});

test('a secondary press: the right button, or Ctrl+click on macOS only', () => {
    expect(isSecondaryPress({ button: 2, ctrlKey: false }, false)).toBe(true);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, true)).toBe(true);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, false)).toBe(false);
    expect(isSecondaryPress({ button: 0, ctrlKey: false }, true)).toBe(false);
});

/** A stand-in wall for WallMenu: a canvas, a hit test, a menu the verbs open and close. */
function standIn({ hit = null, reporting = false } = {}) {
    const canvas = new FakeElement({ tag: 'canvas' });
    const ran = [];
    const wall = {
        menu: null, focusedId: 't1', ran,
        viewport: { canvas, view: { w: 800, h: 600 }, toWorld: (x, y) => ({ x, y: -y }), toScreenBox: () => ({ left: 100, top: 50 }), getBoundingClientRect: null },
        hit: () => hit,
        isShown: () => true,
        terminalRect: () => ({}),
        mouseReporting: () => reporting,
        run(cmd) { ran.push(cmd); if (cmd[0] === 'wall.menu') wall.menu = cmd[1] === 'close' ? null : { target: cmd[1] }; return Promise.resolve({ text: 'OK' }); },
    };
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20 });
    return { wall, canvas, menu: new WallMenu(/** @type {any} */ (wall)) };
}
/** A contextmenu event on `target`; records whether its default was prevented. */
const ctx = (target, o = {}) => ({ target, clientX: 110, clientY: 220, shiftKey: false, button: 2, ctrlKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...o });

test('WallMenu: a right-click on a terminal opens ours there (prevented); again lets the browser menu through and closes ours', () => {
    const { wall, canvas, menu } = standIn({ hit: { id: 't1', part: 'body' } });
    const first = ctx(canvas);
    menu._onContext(first);
    expect(first.prevented).toBe(true);
    expect(wall.ran.at(-1)).toEqual(['wall.menu', 'terminal', 't1', '100', '200']);
    menu._onDown({ target: canvas, button: 2, ctrlKey: false });   // the second right-click's press keeps it open…
    expect(wall.menu).not.toBe(null);
    const again = ctx(canvas);
    menu._onContext(again);                                          // …and its contextmenu is the browser's
    expect(again.prevented).toBe(false);
    expect(wall.ran.at(-1)).toEqual(['wall.menu', 'close']);
    expect(wall.menu).toBe(null);
});

test('WallMenu: Shift, chrome and inputs pass; a reporting body is the program\'s; a group header and the canvas open theirs', () => {
    let s = standIn({ hit: { id: 't1', part: 'body' } });
    const shift = ctx(s.canvas, { shiftKey: true });
    s.menu._onContext(shift);
    expect(shift.prevented).toBe(false);
    expect(s.wall.ran).toEqual([]);

    const sidebar = new FakeElement({ 'data-sidebar': '' });
    const input = new FakeElement({ tag: 'input' }, new FakeElement({ 'data-wall-menu': '' }));
    for (const t of [new FakeElement({}, sidebar), input]) { const e = ctx(t); s.menu._onContext(e); expect(e.prevented).toBe(false); }
    expect(s.wall.ran).toEqual([]);

    s = standIn({ hit: { id: 't1', part: 'body' }, reporting: true });
    const prog = ctx(s.canvas);
    s.menu._onContext(prog);
    expect(prog.prevented).toBe(true);                // the program's click: neither menu covers its screen
    expect(s.wall.ran).toEqual([]);
    const ours = ctx(s.canvas, { shiftKey: true });
    s.menu._onContext(ours);
    expect(ours.prevented).toBe(true);
    expect(s.wall.ran.at(-1)[1]).toBe('terminal');

    s = standIn({ hit: { group: 'g-1', part: 'header' } });
    s.menu._onContext(ctx(s.canvas));
    expect(s.wall.ran.at(-1)).toEqual(['wall.menu', 'group', 'g-1', '100', '200']);
    s = standIn({ hit: null });
    s.menu._onContext(ctx(s.canvas));
    expect(s.wall.ran.at(-1)).toEqual(['wall.menu', 'canvas', '100', '200']);
    s = standIn();
    const label = new FakeElement({ 'data-map-label': 't7' });
    s.menu._onContext(ctx(label));
    expect(s.wall.ran.at(-1)).toEqual(['wall.menu', 'terminal', 't7', '100', '200']);
});

test('WallMenu: a primary press outside closes it, inside does not; the menu key opens it and its own contextmenu stays ours', () => {
    const { wall, canvas, menu } = standIn({ hit: { id: 't1', part: 'body' } });
    menu._onContext(ctx(canvas));
    menu._onDown({ target: new FakeElement({}, new FakeElement({ 'data-wall-menu': '' })), button: 0, ctrlKey: false });
    expect(wall.menu).not.toBe(null);
    menu._onDown({ target: canvas, button: 0, ctrlKey: false });
    expect(wall.menu).toBe(null);

    menu.openByKey();
    expect(wall.ran.at(-1)).toEqual(['wall.menu', 'terminal', 't1', '112', '62']);
    const keyEvent = ctx(canvas, { shiftKey: true, button: 0 });
    menu._onContext(keyEvent);
    expect(keyEvent.prevented).toBe(true);
    expect(wall.menu).not.toBe(null);                  // not taken as the second right-click
    const again = ctx(canvas);
    menu._onContext(again);
    expect(again.prevented).toBe(false);
});

const snap = {
    focusedId: null, selection: ['t2'],
    sidebar: { open: false }, statusWindow: { open: true }, settingsPanel: { open: false },
    config: { ...WALL_CONFIG, snap: true, gridShow: false },
    terminals: [
        { id: 't1', name: 'zsh', named: false, cols: 80, rows: 24, hidden: false, group: null },
        { id: 't2', name: 'logs', named: true, cols: 120, rows: 36, hidden: false, group: null },
        { id: 't3', name: 'build', named: false, cols: 80, rows: 24, hidden: false, group: 'g-1' },
        { id: 't4', name: 'old', named: false, cols: 80, rows: 24, hidden: true, group: 'g-1' },
    ],
    groups: [{ id: 'g-1', name: 'group 1', named: false, layout: 'tile', columns: 2, gap: 2, members: ['t3', 't4'] }],
};
const byId = (items) => Object.fromEntries(items.filter((i) => i.kind !== 'sep').map((i) => [i.id, i]));

test('a terminal\'s menu: frame, focus, rename, selection, group, size, redraw, Option as Alt, hide, held close', () => {
    const items = byId(menuItems({ kind: 'terminal', id: 't1', part: 'body' }, snap, WALL_CONFIG));
    expect(Object.keys(items)).toEqual(['frame', 'focus', 'rename', 'select', 'group', 'add-to', 'size', 'redraw', 'option-as-alt', 'hide', 'close']);
    expect(items.frame.verb).toEqual(['wall.reveal', 't1']);
    expect(items.focus.verb).toEqual(['terminal.focus', 't1']);
    expect(items.rename).toMatchObject({ kind: 'rename', verb: ['wall.rename', 't1'], value: '', placeholder: 'zsh' });
    expect(items.select.verb).toEqual(['wall.select.toggle', 't1']);
    expect(items.group.verb).toEqual(['wall.group', 't2', 't1']);
    expect(items['add-to'].options[0].verb).toEqual(['wall.group.add', 'g-1', 't1']);
    expect(items.size.options.map((o) => [o.label, o.on])).toEqual([['80×24', true], ['120×36', false], ['160×48', false]]);
    expect(items.size.options[1].verb).toEqual(['terminal.resize', 't1', '120', '36']);
    expect(items.size.detail).toBeUndefined();   // its size is an offer: marked, not repeated
    const odd = { ...snap, terminals: snap.terminals.map((t) => (t.id === 't1' ? { ...t, cols: 100, rows: 30 } : t)) };
    expect(byId(menuItems({ kind: 'terminal', id: 't1', part: 'body' }, odd, WALL_CONFIG)).size.detail).toBe('100×30');
    expect(items.redraw.verb).toEqual(['terminal.refresh', 't1']);
    expect(items['option-as-alt'].options.map((o) => [o.verb.at(-1), !!o.on])).toEqual([['auto', true], ['true', false], ['false', false]]);
    expect(items.hide.verb).toEqual(['wall.hide', 't1']);
    expect(items.close).toMatchObject({ kind: 'hold', verb: ['wall.close', 't1'] });

    const grouped = byId(menuItems({ kind: 'terminal', id: 't3', part: 'title' }, { ...snap, focusedId: 't3', selection: [] }, WALL_CONFIG));
    expect(grouped.focus).toBeUndefined();
    expect(grouped.leave.verb).toEqual(['wall.group.remove', 't3']);
    expect(grouped.group).toBeUndefined();
    expect(grouped['add-to']).toBeUndefined();
    expect(menuItems({ kind: 'terminal', id: 't4', part: 'body' }, snap, WALL_CONFIG)).toEqual([]);   // hidden: gone
    expect(menuItems({ kind: 'terminal', id: 'nope', part: 'body' }, snap, WALL_CONFIG)).toEqual([]);
    expect(byId(menuItems({ kind: 'terminal', id: 't1', part: 'body' }, snap, { ...WALL_CONFIG, menuSizes: '' })).size).toBeUndefined();
});

test('a group header\'s menu: frame, rename, layout, columns, select, hide all (shown members), ungroup', () => {
    const items = byId(menuItems({ kind: 'group', id: 'g-1' }, snap, WALL_CONFIG));
    expect(Object.keys(items)).toEqual(['frame', 'rename', 'layout', 'columns', 'select', 'hide-all', 'ungroup']);
    expect(items.layout.options.map((o) => [o.verb, !!o.on])).toEqual([[['wall.group.layout', 'g-1', 'tile'], true], [['wall.group.layout', 'g-1', 'freeform'], false]]);
    expect(items.columns.options.map((o) => o.verb)).toEqual([['wall.group.columns', 'g-1', '-1'], ['wall.group.columns', 'g-1', '+1']]);
    expect(items['hide-all'].verb).toEqual(['wall.hide', 't3']);
    expect(items.ungroup.verb).toEqual(['wall.ungroup', 'g-1']);
    const free = byId(menuItems({ kind: 'group', id: 'g-1' }, { ...snap, groups: [{ ...snap.groups[0], layout: 'freeform' }] }, WALL_CONFIG));
    expect(free.columns).toBeUndefined();
    expect(menuItems({ kind: 'group', id: 'g-9' }, snap, WALL_CONFIG)).toEqual([]);
});

test('the canvas menu: a new terminal at the point, fit all, select all, snap, grid, the sidebar, the status window, the settings', () => {
    const items = byId(menuItems({ kind: 'canvas', world: { x: 12.3456, y: -40 } }, snap, WALL_CONFIG));
    expect(Object.keys(items)).toEqual(['spawn', 'fit', 'select-all', 'snap', 'grid', 'sidebar', 'status', 'settings']);
    expect(items.snap.options.map((o) => [o.verb, !!o.on])).toEqual([[['wall.snap', 'on'], true], [['wall.snap', 'off'], false]]);
    expect(items.grid.options.map((o) => [o.label, o.verb, !!o.on])).toEqual([['show', ['wall.grid', 'on'], false], ['hide', ['wall.grid', 'off'], true]]);
    expect(items.settings).toMatchObject({ label: 'settings…', verb: ['wall.settings', 'open'] });
    expect(items.spawn.verb).toEqual(['wall.spawn', '12.35', '-40']);
    expect(items.fit.verb).toEqual(['wall.fit']);
    expect(items['select-all'].verb).toEqual(['wall.select', 'all']);
    expect(items.sidebar.verb).toEqual(['wall.sidebar', 'open']);
    expect(items.status).toMatchObject({ label: 'close the status window', verb: ['wall.status', 'close'] });
    const empty = byId(menuItems({ kind: 'canvas' }, { ...snap, terminals: [] }, WALL_CONFIG));
    expect(Object.keys(empty)).toEqual(['spawn', 'snap', 'grid', 'sidebar', 'status', 'settings']);
});

test('the menu sits at the point, flips at the right and bottom edges, and stays in the view', () => {
    const view = { w: 800, h: 600 }, size = { w: 200, h: 300 };
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ x: 100, y: 100 });
    expect(placeMenu({ x: 700, y: 100 }, size, view)).toEqual({ x: 500, y: 100 });
    expect(placeMenu({ x: 100, y: 500 }, size, view)).toEqual({ x: 100, y: 200 });
    expect(placeMenu({ x: 150, y: 200 }, size, { w: 300, h: 400 })).toEqual({ x: 96, y: 96 });   // neither side fits: kept in
    expect(placeMenu({ x: 10, y: 10 }, { w: 900, h: 100 }, view)).toEqual({ x: 4, y: 10 });
});

test('the menu\'s knobs: described in the settings schema; menuHint a switch, menuSizes a line of COLSxROWS sizes', () => {
    expect(KNOBS.menuHint).toMatchObject({ section: 'menu', type: 'bool' });
    expect(KNOBS.menuSizes).toMatchObject({ section: 'menu', type: 'text' });
    expect(KNOBS.menuSizes.description).toMatch(/right-click menu offers/);
    expect(searchSettings('right-click').flatMap((g) => g.items.map((it) => it.key))).toEqual(['menuHint', 'menuSizes']);
    expect(WALL_CONFIG.menuHint).toBe(true);
    expect(checkConfig('menuHint', 'false')).toBe(false);
    expect(checkConfig('menuHint', 'on')).toBe(true);
    expect(() => checkConfig('menuHint', 'maybe')).toThrow(/menuHint is on or off/);
    expect(checkConfig('menuSizes', ' 80x24   100×30 ')).toBe('80x24 100×30');
    expect(parseSizes('80x24 100×30')).toEqual([{ cols: 80, rows: 24 }, { cols: 100, rows: 30 }]);
    expect(checkConfig('menuSizes', '')).toBe('');
    expect(() => checkConfig('menuSizes', '80x24 big')).toThrow(/^menuSizes: sizes are COLSxROWS.*not 'big'/);
    expect(() => checkConfig('menuSizes', '0x24')).toThrow(/COLSxROWS/);
});

test('the verbs: wall.menu opens and closes (refusing a hidden terminal), wall.select all, wall.fit', async () => {
    const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
    const { default: registerWallCommands } = await import('../wall/wallCommands.js');
    const hidden = new Set(['t2']);
    const wall = {
        menu: null, selection: new Set(), fits: 0,
        viewport: { view: { w: 800, h: 600 }, zoom: 1, toScreenBox: () => ({ left: 100, top: 50, bottom: 70 }) },
        terminal: (id) => (['t1', 't2'].includes(id) ? {} : undefined),
        isShown: (id) => ['t1', 't2'].includes(id) && !hidden.has(id),
        shownOrder: () => ['t1'],
        terminalRect: () => ({}),
        groups: { headerRect: (gid) => (gid === 'g-1' ? {} : null) },
        openMenu(target, at) { this.menu = { target, at }; },
        closeMenu() { this.menu = null; },
        select(ids) { this.selection = new Set(ids); },
        fitAll() { this.fits++; },
    };
    const router = new CommandRouter({});
    registerWallCommands(router, /** @type {any} */ (wall));
    let r = await router.execute(['wall.menu', 'terminal', 't1']);
    expect(r.text).toStartWith('OK');
    expect(wall.menu).toEqual({ target: { kind: 'terminal', id: 't1', part: 'body' }, at: { x: 112, y: 62 } });
    r = await router.execute(['wall.menu', 'canvas']);
    expect(wall.menu).toEqual({ target: { kind: 'canvas' }, at: { x: 400, y: 300 } });
    r = await router.execute(['wall.menu', 'group', 'g-1', '5', '6']);
    expect(wall.menu.at).toEqual({ x: 5, y: 6 });
    expect((await router.execute(['wall.menu', 'terminal', 't2'])).text).toMatch(/ERR: terminal 't2' is hidden/);
    expect((await router.execute(['wall.menu', 'terminal', 'zz'])).text).toMatch(/ERR: no terminal 'zz'/);
    expect((await router.execute(['wall.menu', 'nowhere'])).text).toMatch(/ERR: the menu opens on terminal\|group\|canvas/);
    expect((await router.execute(['wall.menu', 'close'])).text).toStartWith('OK');
    expect(wall.menu).toBe(null);
    await router.execute(['wall.select', 'all']);
    expect([...wall.selection]).toEqual(['t1']);
    expect((await router.execute(['wall.fit'])).text).toStartWith('OK');
    expect(wall.fits).toBe(1);
    expect((await router.execute(['wall.spawn', 'x'])).text).toMatch(/ERR: x takes a number/);
});
