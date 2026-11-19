import { checkConfig } from './wallConfig.js';
import { searchSettings, SECTIONS } from './wallSettings.js';
import { AGENT_SIDES } from './wallAgentView.js';
import { busStatus, busAttachable, gomuxScreenId } from './WallBus.js';
import {
    normalizeRelayHost,
    parseRelayEndpoint,
    parseRelayTokenInput,
} from '@glyph3d/core/services/orchestration/WebSocketBridge.js';

/**
 * The wall's own verbs — hide, show, close, select, group, the sidebar, the termd status window, the
 * knobs. The title-bar buttons, the sidebar, the status window and the topbar's termd chip, the
 * palette, the selection button and the chords all run these (through
 * `wall.run`), and the CLI reaches them over the relay like any verb (`./glyph3d-cli --port N
 * wall.list`). A handler that's refused (an unknown terminal or group, a bad number) answers ERR with
 * why; nothing is half-done.
 *
 *   wall.list                                  every terminal and group: shown, hidden, grouped
 *   wall.hide <id…> · wall.show <id…>          off the canvas (still running) · back at its spot
 *   wall.reveal <id>                           show it, focus it, frame it
 *   wall.spawn [x y]                           a new terminal (its window's top-left at world x y)
 *   wall.fit                                   ease the camera to fit every shown terminal
 *   wall.close <id>                            kill it (its program in termd) and forget it
 *   wall.rename <id> [name…]                   empty gives back the shell's title
 *   wall.select [<id…>|all|none] · wall.select.add <id…> · wall.select.toggle <id>
 *   wall.copy [id]                             a terminal's selected text (default: the focused one's) to the clipboard
 *   wall.paste [id] [selection]                the clipboard — or the wall's selection clipboard — into a terminal
 *                                              (a terminal's selection itself: the core terminal.selection)
 *   wall.group [<id…>]                         a new group of these (default: the selection)
 *   wall.group.add <gid> <id…> · wall.group.remove <id…> · wall.ungroup <gid>
 *   wall.group.layout <gid> tile [columns] [gap] | freeform
 *   wall.group.columns <gid> <n|+n|-n> · wall.group.gap <gid> <n>
 *   wall.group.rename <gid> [name…] · wall.group.move <gid> <dx> <dy> · wall.group.frame <gid>
 *   wall.sidebar [toggle|open|close|left|right|float [x y]] · wall.sidebar.collapse <gid> [toggle|on|off]
 *   wall.status [toggle|open|close|left|right|float [x y]]   the termd status window
 *   wall.status.dismiss                        put away the termd-lost notice
 *   wall.config [<knob> [value|default]]       read or set a knob (remembered per relay); default hands it back
 *   wall.config.find <words…>                  the knobs whose label, key, description or section hold every word
 *   wall.snap [toggle|on|off] · wall.grid [toggle|on|off]   snapping to the grid · drawing it
 *   wall.settings [toggle|open|close|left|right|float [x y]] · wall.settings.collapse <section> [toggle|on|off]
 *   wall.help [toggle|open|close|left|right|float [x y]]   the keys, gestures and verbs
 *   wall.fullscreen [toggle|on|off] [id] · wall.fullscreen.text <bigger|smaller|reset>
 *   wall.split <right|down> [id] · wall.pane <left|right|up|down> · wall.group.bars <gid> [toggle|on|off]
 *   wall.menu terminal <id> [x y] | group <gid> [x y] | canvas [x y] | close
 *                                              the right-click menu, at canvas px (default: on the
 *                                              terminal, under the header, the view's centre)
 *   wall.bus                                   the gomuxai agents the relay sees, by host, with status
 *                                              and the terminal attached to each
 *   wall.attach <name[@host]>                  attach to an agent: reveal its terminal, else open one
 *                                              running `agent attach` (WallBus.js)
 *
 * termd's state itself comes from the relay (`./glyph3d-cli termd.status` answers page-less); the
 * status verbs only show it.
 *
 * @param {import('@glyph3d/core/services/orchestration/CommandRouter.js').default} router
 * @param {import('./TerminalWall.js').default} wall
 */
export default function registerWallCommands(router, wall) {
    const OK = (text, data = null) => ({ text: `OK: ${text}`, data });
    const ERR = (text) => ({ text: `ERR: ${text}`, data: null });
    /** Run `fn`; a throw (or a rejection) is the verb's ERR (the refusal says why). */
    const verb = (name, usage, description, fn) => router.register(name, (args) => {
        try {
            const r = fn(args);
            return r instanceof Promise ? r.catch((e) => ERR(e.message)) : r;
        } catch (e) { return ERR(e.message); }
    }, { usage, description });
    const terminalIds = (args, min = 1) => {
        if (args.length < min) throw new Error('name a terminal');
        for (const id of args) if (!wall.terminal(id)) throw new Error(`no terminal '${id}'`);
        return args;
    };
    const intArg = (s, what) => {
        const n = Number(s);
        if (!Number.isInteger(n)) throw new Error(`${what} takes a whole number, not '${s}'`);
        return n;
    };
    const numArg = (s, what) => {
        const n = Number(s);
        if (s == null || !Number.isFinite(n)) throw new Error(`${what} takes a number, not '${s}'`);
        return n;
    };

    verb('wall.list', '', 'Every terminal and group on the wall: shown, hidden, grouped', () => {
        const s = wall.snapshot();
        const line = (t) => `  ${t.id}${t.hidden ? ' (hidden)' : ''} ${JSON.stringify(t.name)}`;
        const out = [];
        for (const g of s.groups) {
            out.push(`${g.id} ${JSON.stringify(g.name)} ${g.layout === 'tile' ? `tile ${g.columns} cols, gap ${g.gap}` : 'freeform'}`);
            for (const id of g.members) { const t = s.terminals.find((x) => x.id === id); if (t) out.push(line(t)); }
        }
        const loose = s.terminals.filter((t) => !t.group);
        if (loose.length) { out.push('ungrouped'); for (const t of loose) out.push(line(t)); }
        return { text: out.join('\n') || '(no terminals)', data: { terminals: s.terminals, groups: s.groups, selection: s.selection } };
    });

    verb('wall.hide', '<id…>', 'Take terminals off the canvas; they keep running', (args) => {
        for (const id of terminalIds(args)) wall.hide(id);
        return OK(`hid ${args.join(', ')}`, { ids: args });
    });
    verb('wall.show', '<id…>', 'Bring hidden terminals back, at their own spots', (args) => {
        for (const id of terminalIds(args)) wall.show(id);
        return OK(`showed ${args.join(', ')}`, { ids: args });
    });
    verb('wall.reveal', '<id>', 'Show a terminal (if hidden), focus it and frame it', (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        wall.show(id);
        wall.focus(id, { frame: true });
        return OK(`revealed ${id}`, { id });
    });
    verb('wall.spawn', '[x y]', "A new terminal, focused and framed; at x y (world) its window's top-left corner", async (args) => {
        const at = args.length ? { x: numArg(args[0], 'x'), y: numArg(args[1], 'y') } : null;
        const r = await wall.spawn({ at });
        if (!r.ok) throw new Error(r.reason || 'the spawn did not land');
        return OK(`spawned ${r.id}${at ? ` at (${at.x}, ${at.y})` : ''}`, { id: r.id, at });
    });
    verb('wall.fullscreen', '[toggle|on|off] [id|gid]', 'Put a group (when focused in one with 2+ panes) or terminal fullscreen, or back on the canvas', (args) => {
        const [what = 'toggle', named] = args;
        const fs = wall.fullscreen;
        if (what === 'off') {
            fs.exit();
        } else if (what === 'on' || what === 'toggle') {
            if (!named) {
                if (what === 'toggle' && fs.active) fs.exit();
                else {
                    if (!wall.focusedId) throw new Error('nothing focused to put fullscreen: focus one, or name a terminal or group');
                    if (!fs.enterDefault(wall.focusedId)) throw new Error(`'${wall.focusedId}' is hidden`);
                }
            } else if (wall.store.group(named)) {
                if (what === 'toggle' && fs.groupId === named) fs.exit();
                else if (!fs.enterGroup(named)) throw new Error(`group '${named}' has no shown member to put fullscreen`);
            } else {
                const [id] = terminalIds([named]);
                if (what === 'toggle' && fs.id === id) fs.exit();
                else if (!fs.enter(id)) throw new Error(`terminal '${id}' is hidden`);
            }
        } else throw new Error(`fullscreen takes toggle|on|off, not '${what}'`);
        return OK(fs.active ? `fullscreen ${fs.target}: ${fs.state.linePx.toFixed(1)} px a row` : 'fullscreen off', { fullscreen: fs.state });
    });
    verb('wall.fullscreen.pane', '[toggle|on|off] [id]', 'Fullscreen a single pane alone (zooming out of Group Fullscreen and back on toggle)', (args) => {
        const [what = 'toggle', named] = args;
        const id = named ? terminalIds([named])[0] : null;
        const fs = wall.fullscreen;
        if (what === 'off') {
            if (fs.mode === 'single' && fs.state?.returnGroup && wall.store.group(fs.state.returnGroup)) fs.togglePane();
            else fs.exit();
        } else if (what === 'toggle') {
            if (!fs.active && !id && !wall.focusedId) throw new Error('no terminal to put fullscreen: focus one, or name it');
            if (!fs.active) {
                const target = id ?? wall.focusedId;
                if (!fs.enter(target)) throw new Error(`terminal '${target}' is hidden`);
            } else fs.togglePane(id);
        } else if (what === 'on') {
            const target = id ?? wall.focusedId;
            if (!target) throw new Error('no terminal to put fullscreen: focus one, or name it');
            const rg = fs.mode === 'group' ? fs.groupId : (fs.state?.returnGroup ?? null);
            if (!fs.enter(target, { returnGroup: rg && wall.store.groupOf(target) === rg ? rg : null })) {
                throw new Error(`terminal '${target}' is hidden`);
            }
        } else throw new Error(`fullscreen.pane takes toggle|on|off, not '${what}'`);
        return OK(fs.active ? `fullscreen ${fs.target}: ${fs.state.linePx.toFixed(1)} px a row` : 'fullscreen off', { fullscreen: fs.state });
    });
    verb('wall.fullscreen.text', '<bigger|smaller|reset>', "The fullscreen terminal's text size: it re-wraps, and the size is remembered for it (reset: the canvas's size)", (args) => {
        const dir = { bigger: 1, smaller: -1, reset: 0 }[args[0]];
        if (dir === undefined) throw new Error(`fullscreen text takes bigger|smaller|reset, not '${args[0] ?? ''}'`);
        const px = wall.fullscreen.text(/** @type {-1|0|1} */ (dir));
        if (px == null) throw new Error('no terminal is fullscreen');
        return OK(`fullscreen text ${px.toFixed(1)} px a row`, { linePx: px });
    });
    verb('wall.fit', '', 'Ease the camera to fit every shown terminal', () => {
        if (!wall.shownOrder().length) throw new Error('no shown terminal to fit');
        wall.fitAll();
        return OK(`fitting ${wall.shownOrder().length} terminal(s)`);
    });
    verb('wall.close', '<id>', 'Kill a terminal — its program in termd — and forget it', async (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        return wall.kill(id);
    });
    verb('wall.rename', '<id> [name…]', "Name a terminal; empty gives back its shell's title", (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        wall.rename(id, args.slice(1).join(' '));
        return OK(`${id} is "${wall.nameOf(id)}"`, { id, name: wall.nameOf(id) });
    });

    verb('wall.select', '[<id…>|all|none]', 'Select exactly these terminals (all: every shown one; none clears)', (args) => {
        const one = args.length === 1 ? args[0] : null;
        const ids = one === 'none' ? [] : one === 'all' ? wall.shownOrder() : terminalIds(args, 0);
        wall.select(ids);
        return OK(`selected ${ids.length}`, { selection: [...wall.selection] });
    });
    verb('wall.select.add', '<id…>', 'Add terminals to the selection', (args) => {
        wall.select([...wall.selection, ...terminalIds(args)]);
        return OK(`selected ${wall.selection.size}`, { selection: [...wall.selection] });
    });
    verb('wall.select.toggle', '<id>', 'Add a terminal to the selection, or take it out', (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const next = new Set(wall.selection);
        if (next.has(id)) next.delete(id); else next.add(id);
        wall.select([...next]);
        return OK(`selected ${wall.selection.size}`, { selection: [...wall.selection] });
    });

    /** The terminal a text verb names, else the focused one. */
    const textTarget = (args) => {
        const id = args[0] ?? wall.focusedId;
        if (!id) throw new Error('no terminal named, and none is focused');
        if (!wall.terminal(id)) throw new Error(`no terminal '${id}'`);
        return id;
    };
    verb('wall.copy', '[id]', "Copy a terminal's selected text (default: the focused terminal's) to the system clipboard", async (args) => {
        const id = textTarget(args);
        const text = wall.terminal(id).selectionText();
        if (!text) throw new Error(`nothing is selected in ${id}`);
        try { await wall.writeClipboard(text); } catch (e) { wall.notify(`copy: ${e.message}`); throw e; }
        return OK(`copied ${[...text].length} characters from ${id}`, { id, text });
    });
    verb('wall.paste', '[id] [selection]', "Paste into a terminal (default: the focused one) as the paste chord does: the system clipboard, or with `selection` the wall's selection clipboard (what a middle-click pastes)", async (args) => {
        const fromSelection = args[args.length - 1] === 'selection';
        const id = textTarget(fromSelection ? args.slice(0, -1) : args);
        let text;
        if (fromSelection) text = wall.selectionClipboard;
        else {
            try { text = await wall.readClipboard(); } catch (e) { wall.notify(`paste: ${e.message}`); throw e; }
        }
        if (!text) throw new Error(fromSelection ? 'the selection clipboard is empty (select some text first)' : 'the clipboard holds no text');
        if (!wall.terminal(id).paste(text)) throw new Error(`${id} has no input route (no adapter owns it)`);
        return OK(`pasted ${[...text].length} characters into ${id}${fromSelection ? ' from the selection clipboard' : ''}`, { id, length: text.length });
    });

    verb('wall.group', '[<id…>]', 'Gather terminals (default: the selection) into a new group', (args) => {
        const ids = args.length ? terminalIds(args) : [...wall.selection];
        if (!ids.length) throw new Error('nothing selected — lasso some terminals (Shift+drag) or name them');
        const gid = wall.groups.create(ids);
        wall.select([]);
        return OK(`${gid} "${wall.groups.nameOf(gid)}" gathers ${ids.join(', ')}`, { gid, members: ids });
    });
    verb('wall.group.add', '<gid> <id…>', 'Add terminals to a group', (args) => {
        const [gid, ...ids] = args;
        wall.groups.add(gid, terminalIds(ids));
        return OK(`${gid} has ${wall.groups.get(gid).members.length}`, { gid });
    });
    verb('wall.group.remove', '<id…>', 'Take terminals out of their group; they stay where they are', (args) => {
        wall.groups.remove(terminalIds(args));
        return OK(`took ${args.join(', ')} out`, { ids: args });
    });
    verb('wall.ungroup', '<gid>', 'Dissolve a group; its terminals stay where they are', (args) => {
        if (!args[0]) throw new Error('name a group');
        wall.groups.ungroup(args[0]);
        return OK(`dissolved ${args[0]}`, { gid: args[0] });
    });
    verb('wall.group.layout', '<gid> tile [columns] [gap] | freeform | split [columns]', "Set a group's layout (split: one rect cut into panes, rows of columns)", (args) => {
        const [gid, layout, cols, gap] = args;
        if (layout !== 'tile' && layout !== 'freeform' && layout !== 'split') throw new Error(`a layout is 'tile', 'freeform' or 'split', not '${layout}'`);
        wall.groups.setLayout(gid, layout, {
            columns: cols != null ? intArg(cols, 'columns') : undefined,
            gap: gap != null ? numArg(gap, 'gap') : undefined,
        });
        return OK(`${gid} is ${layout}`, { gid, group: wall.groups.get(gid) });
    });
    verb('wall.group.columns', '<gid> <n|+n|-n>', "Set a tiled group's columns (+n / -n steps)", (args) => {
        const [gid, n] = args;
        const g = wall.groups.get(gid);
        const cols = /^[+-]/.test(n ?? '') ? g.columns + intArg(n, 'columns') : intArg(n, 'columns');
        wall.groups.setColumns(gid, Math.max(1, Math.min(cols, Math.max(1, g.members.length))));
        return OK(`${gid} tiles in ${wall.groups.get(gid).columns}`, { gid, columns: wall.groups.get(gid).columns });
    });
    verb('wall.split', '<right|down> [id]', 'Split a terminal (default: the focused one): a new terminal takes the half to its right or below', async (args) => {
        const [dir, named] = args;
        if (dir !== 'right' && dir !== 'down') throw new Error(`a split goes right or down, not '${dir ?? ''}'`);
        const id = named ? terminalIds([named])[0] : wall.focusedId;
        const born = await wall.split(dir, id);
        return OK(`split ${id} ${dir}: ${born}`, { id: born, gid: wall.groups.groupOf(born) });
    });
    verb('wall.pane', '<left|right|up|down>', "Focus the pane (or the nearest window) next to the focused terminal that way", (args) => {
        const [dir] = args;
        if (!['left', 'right', 'up', 'down'].includes(dir)) throw new Error(`a pane is left, right, up or down, not '${dir ?? ''}'`);
        const to = wall.focusPane(dir);
        return OK(to ? `focused ${to}` : `nothing ${dir} of ${wall.focusedId ?? 'nothing'}`, { id: to });
    });
    verb('wall.focus.history', '<back|forward>', 'Step back or forward through previously focused terminals', (args) => {
        const dir = { back: -1, forward: 1 }[args[0]];
        if (!dir) throw new Error(`focus history takes back or forward, not '${args[0] ?? ''}'`);
        const to = wall.stepFocusHistory(/** @type {-1|1} */ (dir));
        return OK(to ? `focused ${to}` : `no ${args[0]} terminal in focus history`, { id: to });
    });
    verb('wall.group.bars', '<gid> [toggle|on|off]', "Show or hide a split's pane title bars", (args) => {
        const [gid, how = 'toggle'] = args;
        if (how !== 'toggle' && how !== 'on' && how !== 'off') throw new Error(`bars take toggle|on|off, not '${how}'`);
        const g = wall.groups.get(gid);
        const on = how === 'toggle' ? !g.split?.bars : how === 'on';
        wall.groups.setBars(gid, on);
        return OK(`${gid} bars ${on ? 'shown' : 'hidden'}`, { gid, bars: on });
    });
    verb('wall.group.gap', '<gid> <n>', "Set a tiled group's gap (world units)", (args) => {
        wall.groups.setGap(args[0], numArg(args[1], 'gap'));
        return OK(`${args[0]} gap ${args[1]}`, { gid: args[0] });
    });
    verb('wall.group.rename', '<gid> [name…]', 'Name a group; empty gives back "group N"', (args) => {
        const [gid, ...name] = args;
        wall.groups.rename(gid, name.join(' '));
        return OK(`${gid} is "${wall.groups.nameOf(gid)}"`, { gid, name: wall.groups.nameOf(gid) });
    });
    verb('wall.group.move', '<gid> <dx> <dy>', 'Move a whole group by (dx, dy) world units', (args) => {
        wall.groups.move(args[0], numArg(args[1], 'dx'), numArg(args[2], 'dy'));
        return OK(`moved ${args[0]}`, { gid: args[0] });
    });
    verb('wall.group.frame', '<gid>', "Ease the camera to fit a group's shown members", (args) => {
        if (!wall.frameGroup(args[0])) throw new Error(`group '${args[0]}' has no shown member to frame`);
        return OK(`framed ${args[0]}`, { gid: args[0] });
    });

    /**
     * Open, close, dock or float a panel: `toggle|open|close|left|right|float [x y]`.
     * @param {string} name - how the refusal names it
     * @param {() => { open: boolean }} get @param {(patch: object) => void} set
     */
    const placePanel = (name, get, set, [what = 'toggle', x, y]) => {
        if (what === 'toggle') set({ open: !get().open });
        else if (what === 'open' || what === 'close') set({ open: what === 'open' });
        else if (what === 'left' || what === 'right') set({ open: true, side: what });
        else if (what === 'float') {
            const patch = { open: true, side: 'float' };
            if (x != null) patch.float = { x: numArg(x, 'x'), y: numArg(y, 'y') };
            set(patch);
        } else throw new Error(`the ${name} takes toggle|open|close|left|right|float, not '${what}'`);
    };

    verb('wall.sidebar', '[toggle|open|close|left|right|float [x y]]', 'Open, close or place the sidebar', (args) => {
        placePanel('sidebar', () => wall.store.sidebar(), (p) => wall.setSidebar(p), args);
        return OK(`sidebar ${wall.store.sidebar().open ? `open, ${wall.store.sidebar().side}` : 'closed'}`, { sidebar: wall.store.sidebar() });
    });
    verb('wall.sidebar.collapse', '<gid> [toggle|on|off]', "Fold or unfold a group's members in the sidebar", (args) => {
        const [gid, how = 'toggle'] = args;
        wall.groups.get(gid);
        const set = new Set(wall.store.sidebar().collapsed);
        const on = how === 'toggle' ? !set.has(gid) : how === 'on' ? true : how === 'off' ? false : null;
        if (on == null) throw new Error(`collapse takes toggle|on|off, not '${how}'`);
        if (on) set.add(gid); else set.delete(gid);
        wall.setSidebar({ collapsed: [...set] });
        return OK(`${gid} ${on ? 'folded' : 'unfolded'}`, { gid, collapsed: on });
    });

    verb('wall.status', '[toggle|open|close|left|right|float [x y]]', "Open, close or place the termd status window", (args) => {
        placePanel('status window', () => wall.store.statusWindow(), (p) => wall.setStatusWindow(p), args);
        const now = wall.store.statusWindow();
        return OK(`status window ${now.open ? `open, ${now.side}` : 'closed'} · termd ${wall.termd.state}`, { window: now, termd: wall.termd.state });
    });
    verb('wall.status.dismiss', '', 'Put away the termd-lost notice', () => {
        return wall.termd.dismissLost() ? OK('dismissed the termd-lost notice') : OK('no termd-lost notice to dismiss');
    });

    verb('wall.menu', 'terminal <id> [x y] | group <gid> [x y] | canvas [x y] | close', 'Open the right-click menu on a terminal, a group or the canvas (at canvas px), or close it', (args) => {
        const [kind, ...rest] = args;
        if (kind === 'close') { wall.closeMenu(); return OK('menu closed'); }
        if (kind !== 'terminal' && kind !== 'group' && kind !== 'canvas') throw new Error(`the menu opens on terminal|group|canvas (or close), not '${kind}'`);
        const id = kind === 'canvas' ? null : rest.shift();
        if (kind !== 'canvas' && !id) throw new Error(`name a ${kind}`);
        let at;
        if (rest.length) at = { x: numArg(rest[0], 'x'), y: numArg(rest[1], 'y') };
        else if (kind === 'terminal') {
            if (!wall.isShown(id)) throw new Error(wall.terminal(id) ? `terminal '${id}' is hidden` : `no terminal '${id}'`);
            const b = wall.viewport.toScreenBox(wall.terminalRect(id));
            at = { x: Math.round(b.left + 12), y: Math.round(b.top + 12) };
        } else if (kind === 'group') {
            const h = wall.groups.headerRect(id, wall.viewport.zoom);
            if (!h) throw new Error(`group '${id}' has no header on the canvas`);
            const b = wall.viewport.toScreenBox(h);
            at = { x: Math.round(b.left), y: Math.round(b.bottom) };
        } else at = { x: Math.round(wall.viewport.view.w / 2), y: Math.round(wall.viewport.view.h / 2) };
        /** @type {import('./contextMenu.js').MenuTarget} */
        const target = kind === 'terminal' ? { kind, id, part: 'body' } : kind === 'group' ? { kind, id } : { kind: 'canvas' };
        wall.openMenu(target, at);
        return OK(`menu on ${kind}${id ? ` ${id}` : ''} at (${at.x}, ${at.y})`, { menu: wall.menu });
    });

    verb('wall.config', '[<knob> [value…|default]]', "Read or set the wall's knobs", (args) => {
        const [key, ...rest] = args;
        const value = rest.length ? rest.join(' ') : null;   // a list knob (menuSizes) may come as several args
        if (!key) return { text: Object.entries(wall.config).map(([k, v]) => `${k} ${v}`).join('\n'), data: { ...wall.config } };
        const v = value == null ? (checkConfig(key, wall.config[key]), wall.config[key])
            : value === 'default' ? (checkConfig(key, wall.config[key]), wall.resetConfig(key))
                : wall.setConfig(key, checkConfig(key, value));
        return OK(`${key} ${v}`, { [key]: v });
    });

    // ── the canvas: snapping, the grid, the settings panel ──────────────────
    /** A knob that's on or off, flipped or set by `toggle|on|off`. */
    const onOff = (key, how = 'toggle') => {
        if (how !== 'toggle' && how !== 'on' && how !== 'off') throw new Error(`takes toggle|on|off, not '${how}'`);
        return wall.setConfig(key, how === 'toggle' ? !wall.config[key] : how === 'on');
    };
    verb('wall.snap', '[toggle|on|off]', 'Snap moves and resizes to the grid, or not', (args) => {
        const on = onOff('snap', args[0]);
        return OK(`snap ${on ? 'on' : 'off'}`, { snap: on });
    });
    verb('wall.grid', '[toggle|on|off]', 'Draw the drafting grid on the canvas, or not', (args) => {
        const on = onOff('gridShow', args[0]);
        return OK(`grid ${on ? 'shown' : 'hidden'}`, { gridShow: on });
    });
    verb('wall.config.find', '<words…>', "The knobs whose label, key, description or section hold every word", (args) => {
        const found = searchSettings(args.join(' '));
        const out = [];
        for (const g of found) {
            out.push(g.section.title);
            for (const it of g.items) out.push(`  ${it.key} ${wall.config[it.key]}  — ${it.def.label}`);
        }
        return { text: out.join('\n') || `(no knob matches '${args.join(' ')}')`, data: { sections: found.map((g) => ({ id: g.section.id, keys: g.items.map((it) => it.key) })) } };
    });
    verb('wall.settings', '[toggle|open|close|left|right|float [x y]]', 'Open, close or place the settings panel', (args) => {
        placePanel('settings panel', () => wall.store.settingsPanel(), (p) => wall.setSettingsPanel(p), args);
        const now = wall.store.settingsPanel();
        return OK(`settings ${now.open ? `open, ${now.side}` : 'closed'}`, { panel: now });
    });
    verb('wall.help', '[toggle|open|close|left|right|float [x y]]', "Open, close or place the help: the wall's keys, gestures and verbs", (args) => {
        placePanel('help', () => wall.store.helpPanel(), (p) => wall.setHelpPanel(p), args);
        const now = wall.store.helpPanel();
        return OK(`help ${now.open ? `open, ${now.side}` : 'closed'}`, { panel: now });
    });
    verb('wall.settings.collapse', '<section> [toggle|on|off]', 'Fold or unfold a section of the settings panel', (args) => {
        const [id, how = 'toggle'] = args;
        if (!SECTIONS.some((x) => x.id === id)) throw new Error(`no section '${id}' (sections: ${SECTIONS.map((x) => x.id).join(', ')})`);
        const set = new Set(wall.store.settingsPanel().collapsed);
        const on = how === 'toggle' ? !set.has(id) : how === 'on' ? true : how === 'off' ? false : null;
        if (on == null) throw new Error(`collapse takes toggle|on|off, not '${how}'`);
        if (on) set.add(id); else set.delete(id);
        wall.setSettingsPanel({ collapsed: [...set] });
        return OK(`${id} ${on ? 'folded' : 'unfolded'}`, { section: id, collapsed: on });
    });

    // ── the gomuxai agents (WallBus.js) ──────────────────────────────────────
    const attachedTerms = (a, isLocal) => {
        const ids = new Set(wall.store.attachedTo(a.target).filter((id) => wall.terminal(id)));
        if (isLocal) {
            for (const id of wall.store.attachedTo(a.name)) if (wall.terminal(id)) ids.add(id);
            const gx = gomuxScreenId(a.name);
            if (wall.terminal(gx)) ids.add(gx);
        }
        return [...ids];
    };
    verb('wall.bus', '', 'The gomuxai agents the relay sees, by host, with their status and the terminal attached to each', () => {
        const hosts = wall.bus.hosts();
        if (!wall.bus.snapshot) throw new Error(`no gomuxai agents: ${wall.bus.reason}`);
        const localHost = wall.bus.snapshot.host || '';
        const out = [];
        for (const h of hosts) {
            const isLocal = h.host === '' || h.host === localHost;
            out.push(h.host || 'this host');
            for (const a of h.agents) {
                const on = attachedTerms(a, isLocal);
                const status = busStatus(a.status).word + (a.endReason ? ` (${a.endReason})` : '');
                const notes = [a.detail, !busAttachable(a) ? 'no live session' : null, on.length ? `on ${on.join(', ')}` : null].filter(Boolean);
                out.push(`  ${a.target} ${status}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
            }
        }
        return {
            text: out.join('\n') || '(no live agents)',
            data: { hosts: hosts.map((h) => {
                const isLocal = h.host === '' || h.host === localHost;
                return { host: h.host, agents: h.agents.map((a) => ({ target: a.target, status: a.status ?? null, attachable: busAttachable(a), terminals: attachedTerms(a, isLocal) })) };
            }) },
        };
    });
    verb('wall.attach', '<name[@host]>', "Attach to a gomuxai agent: reveal its terminal, else attach directly to its local termd session (or ssh on another host)", async (args) => {
        if (!args[0]) throw new Error('name an agent: name, or name@host for one on another host');
        let r;
        // A refusal (no live session, an attach that didn't land) shows on the wall: the sidebar's and
        // the palette's clicks have nowhere else to say it.
        try { r = await wall.attach(args[0]); } catch (e) { wall.notify(`attach: ${e.message}`); throw e; }
        return OK(r.existing ? `revealed ${r.id}, attached to ${args[0]}` : `${r.id} attaches to ${args[0]}`, { id: r.id, target: args[0], existing: r.existing });
    });

    // ── agent views (WallAgentViews.js, AgentViewOverlay.jsx) ────────────────
    const AGENT_MODES = new Set(['toggle', 'open', 'close', 'on', 'off', ...AGENT_SIDES]);
    verb('wall.agent', '[id] [toggle|open|close|right|left|top|bottom]', "Open, close or place a terminal's Agent View transcript companion (default: the focused terminal)", (args) => {
        let [first, second] = args;
        let id = first;
        let how = second ?? 'toggle';
        if (!first || (AGENT_MODES.has(first) && !wall.terminal(first))) {
            id = wall.focusedId;
            how = first || 'toggle';
        }
        if (!id) throw new Error('no terminal named, and none is focused');
        const r = wall.agents.setOpen(id, /** @type {any} */ (how));
        return OK(`agent view on ${id}: ${r.open ? `open (${r.side})` : 'closed'}`, { id, ...r });
    });
    verb('wall.agent.side', '<id> <right|left|top|bottom>', "Attach a terminal's Agent View to right, left, top or bottom", (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = wall.agents.setSide(id, /** @type {any} */ (args[1]));
        return OK(`agent view on ${id}: ${r.side}`, { id, ...r });
    });
    verb('wall.agent.session', '<id> [auto|<session>]', "Pair a terminal's Agent View with an agent session (or auto-match its directory)", (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = wall.agents.setSession(id, args[1] ?? 'auto');
        return OK(`agent view on ${id}: session ${r.resolved ?? r.pinned}`, r);
    });
    verb('wall.agent.filter', '<id> <reset|all|only|on|off|toggle> [category…]', "Filter visible event categories in a terminal's Agent View (e.g. only tools, only read image, reset)", (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const rawMode = (args[1] || 'reset').toLowerCase();
        const mode = rawMode === 'all' ? 'reset' : rawMode;
        const r = wall.agents.setFilter(id, /** @type {any} */ (mode), args.slice(2));
        return OK(`agent view filter on ${id} updated`, r);
    });
    verb('wall.agent.expand', '<id> [all|<category…>]', 'Expand all visible events or a category subset (e.g. tools, reads, read, image, edit, run, think, say)', (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = wall.agents.setBulkExpanded(id, true, args.slice(1));
        return OK(`expanded ${r.changed} event(s) on ${id}`, r);
    });
    verb('wall.agent.collapse', '<id> [all|<category…>]', 'Collapse all expanded events or a category subset', (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = wall.agents.setBulkExpanded(id, false, args.slice(1));
        return OK(`collapsed ${r.changed} event(s) on ${id}`, r);
    });
    verb('wall.agent.show', '<id> <eventId> [toggle|on|off|full]', 'Expand or collapse a single event row (`full` shows uncapped file/output lines)', (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const [, eventId, how = 'toggle'] = args;
        if (how === 'full') {
            wall.agents.toggleEvent(id, eventId, 'on');
            wall.agents.showFullBody(id, eventId);
            return OK(`expanded full body of ${eventId} on ${id}`, { id, eventId, expanded: true, full: true });
        }
        if (how !== 'toggle' && how !== 'on' && how !== 'off') throw new Error(`show takes toggle|on|off|full, not '${how}'`);
        const r = wall.agents.toggleEvent(id, eventId, how);
        return OK(`${r.expanded ? 'expanded' : 'collapsed'} ${eventId} on ${id}`, r);
    });
    verb('wall.agent.jump', '<id> [<eventId>|live]', "Jump the attached terminal's scrollback view to where an event occurred (or `live` for offset 0)", async (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = await wall.agents.jump(id, args[1] ?? 'live');
        return OK(r.live ? `${id} scrolled to live` : `${id} jumped to ${r.eventId} (offset ${r.offset})`, r);
    });
    verb('wall.agent.earlier', '<id>', "Load an earlier window of transcript events into a terminal's Agent View", async (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        const r = await wall.agents.loadEarlier(id);
        return OK(`loaded ${r.loaded} earlier event(s) on ${id}`, r);
    });
    verb('wall.token', '<token | url#token=…>', 'Set the relay capability token and reconnect without reloading the page', (args) => {
        const bridge = wall.bridge;
        if (!bridge) throw new Error('the wall is not running');
        const raw = typeof args[0] === 'string' ? args[0].trim() : '';
        if (!raw) throw new Error('wall.token takes a token or a URL carrying #token=…');
        let tok;
        if (raw.includes('://')) {
            const ep = parseRelayEndpoint(raw, { defaultHost: bridge.host });
            if (!ep.ok || !ep.token) {
                throw new Error('wall.token takes a token or a valid URL carrying #token=…');
            }
            const bridgeHost = normalizeRelayHost(bridge.host);
            if (ep.host !== bridgeHost || ep.port !== bridge.port) {
                throw new Error(`URL targets ${ep.host}:${ep.port}, but relay is ${bridgeHost}:${bridge.port}`);
            }
            tok = ep.token;
        } else {
            tok = parseRelayTokenInput(raw);
            if (!tok) throw new Error('wall.token takes a token or a URL carrying #token=…');
        }
        wall.setRelayToken(tok);
        return OK('relay token updated; reconnecting', { hasToken: true });
    });
}
