import { checkConfig } from './wallConfig.js';

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
 *   wall.close <id>                            kill it (its program in termd) and forget it
 *   wall.rename <id> [name…]                   empty gives back the shell's title
 *   wall.select [<id…>|none] · wall.select.add <id…> · wall.select.toggle <id>
 *   wall.group [<id…>]                         a new group of these (default: the selection)
 *   wall.group.add <gid> <id…> · wall.group.remove <id…> · wall.ungroup <gid>
 *   wall.group.layout <gid> tile [columns] [gap] | freeform
 *   wall.group.columns <gid> <n|+n|-n> · wall.group.gap <gid> <n>
 *   wall.group.rename <gid> [name…] · wall.group.move <gid> <dx> <dy> · wall.group.frame <gid>
 *   wall.sidebar [toggle|open|close|left|right|float [x y]] · wall.sidebar.collapse <gid> [toggle|on|off]
 *   wall.status [toggle|open|close|left|right|float [x y]]   the termd status window
 *   wall.status.dismiss                        put away the termd-lost notice
 *   wall.config [<knob> [value]]
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
    verb('wall.close', '<id>', 'Kill a terminal — its program in termd — and forget it', async (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        return wall.kill(id);
    });
    verb('wall.rename', '<id> [name…]', "Name a terminal; empty gives back its shell's title", (args) => {
        const [id] = terminalIds(args.slice(0, 1));
        wall.rename(id, args.slice(1).join(' '));
        return OK(`${id} is "${wall.nameOf(id)}"`, { id, name: wall.nameOf(id) });
    });

    verb('wall.select', '[<id…>|none]', 'Select exactly these terminals (none clears)', (args) => {
        const ids = args.length === 1 && args[0] === 'none' ? [] : terminalIds(args, 0);
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
    verb('wall.group.layout', '<gid> tile [columns] [gap] | freeform', "Set a group's layout", (args) => {
        const [gid, layout, cols, gap] = args;
        if (layout !== 'tile' && layout !== 'freeform') throw new Error(`a layout is 'tile' or 'freeform', not '${layout}'`);
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

    verb('wall.sidebar', '[toggle|open|close|left|right|float [x y]]', 'Open, close or place the sidebar', (args) => {
        const [what = 'toggle', x, y] = args;
        const s = wall.store.sidebar();
        if (what === 'toggle') wall.setSidebar({ open: !s.open });
        else if (what === 'open' || what === 'close') wall.setSidebar({ open: what === 'open' });
        else if (what === 'left' || what === 'right') wall.setSidebar({ open: true, side: what });
        else if (what === 'float') {
            const patch = { open: true, side: 'float' };
            if (x != null) patch.float = { x: numArg(x, 'x'), y: numArg(y, 'y') };
            wall.setSidebar(patch);
        } else throw new Error(`the sidebar takes toggle|open|close|left|right|float, not '${what}'`);
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
        const [what = 'toggle', x, y] = args;
        const s = wall.store.statusWindow();
        if (what === 'toggle') wall.setStatusWindow({ open: !s.open });
        else if (what === 'open' || what === 'close') wall.setStatusWindow({ open: what === 'open' });
        else if (what === 'left' || what === 'right') wall.setStatusWindow({ open: true, side: what });
        else if (what === 'float') {
            const patch = { open: true, side: 'float' };
            if (x != null) patch.float = { x: numArg(x, 'x'), y: numArg(y, 'y') };
            wall.setStatusWindow(patch);
        } else throw new Error(`the status window takes toggle|open|close|left|right|float, not '${what}'`);
        const now = wall.store.statusWindow();
        return OK(`status window ${now.open ? `open, ${now.side}` : 'closed'} · termd ${wall.termd.state}`, { window: now, termd: wall.termd.state });
    });
    verb('wall.status.dismiss', '', 'Put away the termd-lost notice', () => {
        return wall.termd.dismissLost() ? OK('dismissed the termd-lost notice') : OK('no termd-lost notice to dismiss');
    });

    verb('wall.config', '[<knob> [value]]', "Read or set the wall's knobs", (args) => {
        const [key, value] = args;
        if (!key) return { text: Object.entries(wall.config).map(([k, v]) => `${k} ${v}`).join('\n'), data: { ...wall.config } };
        const v = value == null ? (checkConfig(key, wall.config[key]), wall.config[key]) : wall.setConfig(key, checkConfig(key, value));
        return OK(`${key} ${v}`, { [key]: v });
    });
}
