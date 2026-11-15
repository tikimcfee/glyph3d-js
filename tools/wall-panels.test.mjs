// wall-panels.test.mjs — the wall's two side panels (the sidebar and the termd status window) and the
// knobs they read: where each docks (one edge holds both side by side, the sidebar at the edge; the
// topbar and hint clear whatever is docked), and the status window's knobs living in WALL_CONFIG
// (wall.config checks them). Run: bun test tools/wall-panels.test.mjs
import { test, expect } from 'bun:test';
import { dockLayout, DOCK_WIDTHS } from '../wall/dockLayout.js';
import { WALL_CONFIG, LINE_STYLE_KNOBS, checkConfig } from '../wall/wallConfig.js';
import { GLYPH_LINE_DEFAULTS } from '../packages/glyph3d-core/src/core/glyphMaterial.js';
import { noticeFor } from '../wall/StatusWindow.jsx';
import TermdStatus from '../packages/glyph3d-core/src/services/terminal/TermdStatus.js';

const panel = (open, side) => ({ open, side });
const EDGE = 12;

test('nothing docked: the chrome keeps its edge gap', () => {
    const d = dockLayout({ sidebar: panel(false, 'right'), statusWindow: panel(true, 'float') });
    expect(d.inset).toEqual({ left: EDGE, right: EDGE });
});

test('one panel per edge: each sits at its edge, the chrome clears it', () => {
    const d = dockLayout({ sidebar: panel(true, 'left'), statusWindow: panel(true, 'right') });
    expect(d.sidebar).toBe(0);
    expect(d.status).toBe(0);
    expect(d.inset).toEqual({ left: DOCK_WIDTHS.sidebar + EDGE, right: DOCK_WIDTHS.status + EDGE });
});

test('both on one edge: the sidebar keeps the edge, the status window sits beside it, the chrome clears both', () => {
    for (const side of ['left', 'right']) {
        const d = dockLayout({ sidebar: panel(true, side), statusWindow: panel(true, side) });
        expect(d.sidebar).toBe(0);
        expect(d.status).toBe(DOCK_WIDTHS.sidebar);
        expect(d.inset[side]).toBe(DOCK_WIDTHS.sidebar + DOCK_WIDTHS.status + EDGE);
        expect(d.inset[side === 'left' ? 'right' : 'left']).toBe(EDGE);
    }
});

test('a closed or floating panel takes no edge', () => {
    const d = dockLayout({ sidebar: panel(false, 'right'), statusWindow: panel(true, 'right') });
    expect(d.status).toBe(0);
    expect(d.inset.right).toBe(DOCK_WIDTHS.status + EDGE);
    const f = dockLayout({ sidebar: panel(true, 'float'), statusWindow: panel(true, 'right') });
    expect(f.status).toBe(0);
});

test("the status window's knobs are the wall's: born in WALL_CONFIG, checked by wall.config", () => {
    expect(WALL_CONFIG.restartNoticeMs).toBe(400);
    expect(WALL_CONFIG.errorsShown).toBe(3);
    expect(checkConfig('restartNoticeMs', '250')).toBe(250);
    expect(checkConfig('errorsShown', '5')).toBe(5);
    expect(() => checkConfig('errorsShown', '1.5')).toThrow(/whole number/);
    expect(() => checkConfig('restartNoticeMs', '-1')).toThrow(/≥ 0/);
    expect(() => checkConfig('closeHoldMs', 'soon')).toThrow(/closeHoldMs/);
});

test("the cell's line and dim knobs are the wall's: born from the glyph shader's defaults, checked by wall.config", () => {
    expect(LINE_STYLE_KNOBS).toEqual(['lineThickness', 'underlineRaise', 'curlyAmplitude', 'dimAlpha']);
    for (const k of LINE_STYLE_KNOBS) expect(WALL_CONFIG[k]).toBe(GLYPH_LINE_DEFAULTS[k]);
    expect(checkConfig('dimAlpha', '0.3')).toBe(0.3);
    expect(checkConfig('lineThickness', '2')).toBe(2);
    expect(checkConfig('underlineRaise', '-0.02')).toBe(-0.02);
    expect(() => checkConfig('dimAlpha', '2')).toThrow(/dimAlpha takes a number ≤ 1/);
    expect(() => checkConfig('lineThickness', '0')).toThrow(/lineThickness takes a number > 0/);
    expect(() => checkConfig('underlineRaise', '3')).toThrow(/underlineRaise takes a number ≤ 1/);
    expect(() => checkConfig('curlyAmplitude', '-1')).toThrow(/curlyAmplitude takes a number ≥ 0/);
});

test("a brain without the key and paste ops says typing can't reach it", () => {
    const t = new TermdStatus();
    const relay = (state, lacks) => ({ state, since: 0, ns: 'n', bundled: '', lacks });
    t.update({ relay: relay('ok', ['key', 'paste']), status: { daemon: { version: 'g3d-termd/0.1.0' }, terminals: [] } });
    expect(t.lacks).toEqual(['key', 'paste']);
    const n = noticeFor(t, 0, 0, WALL_CONFIG);
    expect(n?.kind).toBe('lacks');
    expect(n.text).toContain('key or paste');
    expect(n.text).toContain('g3d upgrade');
    // A current brain, or none answering: no such notice.
    t.update({ relay: relay('ok', []), status: { daemon: {}, terminals: [] } });
    expect(noticeFor(t, 0, 0, WALL_CONFIG)).toBe(null);
    t.update({ relay: relay('restarting', ['key']), status: null });
    expect(t.lacks).toEqual([]);
});

test('the help docks after the settings on a shared edge; floating or closed it takes none', () => {
    const d = dockLayout({ sidebar: panel(true, 'right'), statusWindow: panel(false, 'right'), settingsPanel: panel(true, 'right'), helpPanel: panel(true, 'right') });
    expect(d.settings).toBe(DOCK_WIDTHS.sidebar);
    expect(d.help).toBe(DOCK_WIDTHS.sidebar + DOCK_WIDTHS.settings);
    expect(d.inset.right).toBe(DOCK_WIDTHS.sidebar + DOCK_WIDTHS.settings + DOCK_WIDTHS.help + EDGE);
    expect(dockLayout({ sidebar: panel(false, 'right'), statusWindow: panel(false, 'right'), helpPanel: panel(true, 'float') }).inset.right).toBe(EDGE);
});
