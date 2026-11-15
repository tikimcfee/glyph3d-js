// wall-settings.test.mjs — the wall's knob schema (wall/wallSettings.js) and its verbs, headless: every
// WALL_CONFIG knob has a section, a label, a type and a description (and nothing else does), values are
// checked by type (bool, colour, number with its bounds, enum) and refused naming the knob, the search
// filters by label, key, description and section title (every word somewhere; empty sections go; the
// hits are where the words are), and on a real TerminalWall built without a page: wall.snap / wall.grid
// toggle their knobs, wall.config remembers what's dialled per relay and `default` forgets it, a
// remembered value that no longer passes is dropped, wall.config.find answers from the same search, and
// wall.settings opens, docks and folds the panel. Run: bun test tools/wall-settings.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
globalThis.location ??= /** @type {any} */ ({ hostname: 'localhost' });
const { WALL_CONFIG, checkConfig } = await import('../wall/wallConfig.js');
const { KNOBS, SECTIONS, searchSettings, hitsIn } = await import('../wall/wallSettings.js');
const { default: TerminalWall } = await import('../wall/TerminalWall.js');
const { dockLayout, DOCK_WIDTHS } = await import('../wall/Panel.jsx');

beforeEach(() => mem.clear());

test('every knob is described — a section, a label, a type, a sentence — and its default passes its own check', () => {
    expect(Object.keys(KNOBS).sort()).toEqual(Object.keys(WALL_CONFIG).sort());
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const [key, def] of Object.entries(KNOBS)) {
        expect(sections.has(def.section)).toBe(true);
        expect(def.label.length).toBeGreaterThan(0);
        expect(def.description.length).toBeGreaterThan(20);
        expect(['bool', 'number', 'color', 'enum', 'text']).toContain(def.type);
        expect(checkConfig(key, WALL_CONFIG[key])).toEqual(WALL_CONFIG[key]);
        expect(checkConfig(key, String(WALL_CONFIG[key]))).toEqual(WALL_CONFIG[key]);   // as a verb sends it
    }
    for (const s of SECTIONS) expect(Object.values(KNOBS).some((d) => d.section === s.id)).toBe(true);
});

test('values are checked by type and refused naming the knob', () => {
    expect(checkConfig('snap', 'off')).toBe(false);
    expect(checkConfig('gridShow', 'true')).toBe(true);
    expect(() => checkConfig('snap', 'sometimes')).toThrow(/snap is on or off/);
    expect(checkConfig('background', '#A0B1C2')).toBe('#a0b1c2');
    expect(() => checkConfig('background', 'red')).toThrow(/background takes a colour as #rrggbb/);
    expect(() => checkConfig('gridMinor', '0')).toThrow(/gridMinor takes a number > 0/);
    expect(checkConfig('gridMinor', '0.5')).toBe(0.5);
    expect(checkConfig('gridMinor', '1e6')).toBe(1e6);   // wide: only what breaks is refused
    expect(() => checkConfig('gridMajorEvery', '2.5')).toThrow(/whole number/);
    expect(() => checkConfig('gridMajorEvery', '0')).toThrow(/≥ 1/);
    expect(() => checkConfig('gridLinePx', 'thin')).toThrow(/gridLinePx takes a number/);
    expect(() => checkConfig('groupLayout', 'grid')).toThrow(/groupLayout is tile, freeform/);
    expect(checkConfig('fontFamily', 'cousine')).toBe('cousine');
    expect(() => checkConfig('fontFamily', 'helvetica')).toThrow(/fontFamily is cousine, monaspace-neon, monaspace-argon, not 'helvetica'/);
    expect(checkConfig('boldIsBright', 'on')).toBe(true);
    expect(() => checkConfig('nope', '1')).toThrow(/unknown wall knob 'nope'/);
});

test('search: words match label, key, description or section title; empty sections go; hits mark the words', () => {
    const keys = (q) => searchSettings(q).flatMap((g) => g.items.map((it) => it.key));
    const sections = (q) => searchSettings(q).map((g) => g.section.id);
    expect(keys('')).toEqual(Object.keys(KNOBS).filter((k) => SECTIONS.some((s) => s.id === KNOBS[k].section)));
    expect(keys('snap')).toContain('snap');                      // label / key
    expect(sections('snap')).toEqual(['canvas']);                // only sections with a match show
    expect(keys('colour').sort()).toEqual(['background', 'boldIsBright', 'gridMajorColor', 'gridMinorColor']);   // description
    expect(keys('font')).toEqual(['fontFamily', 'lineThickness', 'underlineRaise']);   // label, and descriptions that say "font"
    expect(sections('font family')).toEqual(['text']);
    expect(keys('GROUPS')).toEqual(Object.keys(KNOBS).filter((k) => KNOBS[k].section === 'groups'));   // the section's title, any case
    expect(keys('major colour')).toEqual(['gridMajorColor']);    // every word, anywhere
    expect(keys('closehold')).toEqual(['closeHoldMs']);          // the key
    expect(searchSettings('zebra')).toEqual([]);
    const g = searchSettings('grid line').find((x) => x.section.id === 'canvas');
    const width = g.items.find((it) => it.key === 'gridLinePx');
    expect(width.hits.label).toEqual([[0, 4]]);                  // "Line width"
    expect(width.hits.key).toEqual([[0, 8]]);                    // "gridLine…": both words, touching, as one mark
    expect(hitsIn('aaa', ['a', 'aa'])).toEqual([[0, 3]]);        // overlapping hits merge
});

/** A TerminalWall built without a page: its router, store and knobs are real. */
const makeWall = (port = 9) => new TerminalWall({
    scene: {}, camera: /** @type {any} */ ({ isOrthographicCamera: true, zoom: 4, position: { x: 0, y: 0 } }),
    gl: { domElement: {} }, atlas: null, registry: {}, relayPort: port,
});

test('wall.snap / wall.grid flip their knobs; wall.config remembers per relay and `default` forgets', async () => {
    const w = makeWall();
    expect((await w.router.execute(['wall.snap'])).text).toBe('OK: snap off');
    expect((await w.router.execute(['wall.snap', 'on'])).text).toBe('OK: snap on');
    expect((await w.router.execute(['wall.grid', 'off'])).text).toBe('OK: grid hidden');
    expect((await w.router.execute(['wall.grid', 'maybe'])).text).toMatch(/^ERR: takes toggle\|on\|off/);
    expect((await w.router.execute(['wall.config', 'background', '#203040'])).text).toBe('OK: background #203040');
    expect((await w.router.execute(['wall.config', 'gridMinor', '-2'])).text).toMatch(/^ERR: gridMinor/);

    const again = makeWall();                                    // a reload: the same relay's store
    expect(again.config).toMatchObject({ snap: true, gridShow: false, background: '#203040', gridMinor: WALL_CONFIG.gridMinor });
    expect(again.snapshot().dialled.sort()).toEqual(['background', 'gridShow', 'snap']);
    expect(makeWall(10).config.background).toBe(WALL_CONFIG.background);   // another relay: its own

    expect((await again.router.execute(['wall.config', 'background', 'default'])).text).toBe(`OK: background ${WALL_CONFIG.background}`);
    expect(again.snapshot().dialled).not.toContain('background');
    expect(makeWall().config.background).toBe(WALL_CONFIG.background);
});

test('a remembered value that no longer passes is dropped, loudly, and the knob is born again', () => {
    mem.set('glyph3d.wall.relay-9.config', JSON.stringify({ gridMinor: 0, snap: false, gone: 1 }));
    const warn = console.warn;
    const said = [];
    console.warn = (m) => said.push(m);
    try {
        const w = makeWall();
        expect(w.config.gridMinor).toBe(WALL_CONFIG.gridMinor);
        expect(w.config.snap).toBe(false);
        expect(JSON.parse(mem.get('glyph3d.wall.relay-9.config'))).toEqual({ snap: false });
        expect(said.join('\n')).toMatch(/gridMinor[\s\S]*gone/);
    } finally { console.warn = warn; }
});

test('wall.config.find answers from the panel\'s search; wall.settings opens, docks and folds the panel', async () => {
    const w = makeWall();
    const found = await w.router.execute(['wall.config.find', 'major']);
    // gridMinPx by its description ("…snapping steps to the major lines").
    expect(found.data.sections).toEqual([{ id: 'canvas', keys: ['gridMajorEvery', 'gridMinPx', 'gridMajorColor'] }]);
    expect((await w.router.execute(['wall.config.find', 'zebra'])).text).toMatch(/no knob matches/);

    expect((await w.router.execute(['wall.settings'])).text).toBe('OK: settings open, float');
    expect((await w.router.execute(['wall.settings', 'right'])).text).toBe('OK: settings open, right');
    expect((await w.router.execute(['wall.settings.collapse', 'groups'])).text).toBe('OK: groups folded');
    expect((await w.router.execute(['wall.settings.collapse', 'nope'])).text).toMatch(/^ERR: no section 'nope'/);
    const s = w.snapshot();
    expect(s.settingsPanel).toMatchObject({ open: true, side: 'right', collapsed: ['groups'] });
    expect(makeWall().snapshot().settingsPanel).toMatchObject({ open: true, side: 'right', collapsed: ['groups'] });
    // Docked beside the status window on its edge: the topbar clears all three.
    const d = dockLayout({ sidebar: { open: true, side: 'right' }, statusWindow: { open: true, side: 'right' }, settingsPanel: s.settingsPanel });
    expect(d.settings).toBe(DOCK_WIDTHS.sidebar + DOCK_WIDTHS.status);
    expect(d.inset.right).toBe(DOCK_WIDTHS.sidebar + DOCK_WIDTHS.status + DOCK_WIDTHS.settings + 12);
    expect((await w.router.execute(['wall.settings', 'close'])).text).toBe('OK: settings closed');
});
