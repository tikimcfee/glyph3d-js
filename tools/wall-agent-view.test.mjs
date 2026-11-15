// wall-agent-view.test.mjs — headless unit + integration tests for the wall's Agent View companion:
//   1. Action categorization, subset filtering & row/body formatting across gomuxai's EVENTS.md
//      kinds and toolRegistry actions (file reads vs image reads, noise off by default, numbered
//      file snapshots, abandoned branch dimming).
//   2. World-space attachment on all 4 sides (right, left, top, bottom), header-drag quadrant
//      picking, and zoom-invariant WallGroups tiling + camera footprint math with zero overlap.
//   3. Session pairing (pwd over cwd, live over ended, gx-<name> workgroup, manual pin / subagent).
//   4. Live stream folding (add + in-place update, provisional Stop-hook pruning on re-follow),
//      write-time terminal scrollback anchor stamping, protocol terminal_line override, jump-to-line
//      via `terminal.scroll <id> to <offset>` / `live`, alt-screen refusal, and all `wall.agent*` verbs.
// Run: bun test tools/wall-agent-view.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
globalThis.location ??= /** @type {any} */ ({ hostname: 'localhost' });

const { eventRecord } = await import('../packages/glyph3d-core/src/collections/agentEvents.js');
const {
    AGENT_SIDES,
    CATEGORY_IDS,
    CATEGORY_GROUPS_TREE,
    DEFAULT_FILTERS,
    categoryHue,
    categoriesOfRecord,
    expandCategoryTokens,
    applyFilterChange,
    groupSelectionState,
    describeActiveFilter,
    matchesFilter,
    matchesSubset,
    summarizeEventRow,
    formatExpandedEvent,
    agentViewRect,
    footprintTileMetrics,
    pickAgentSide,
    matchTerminalSession,
    computeJumpOffset,
} = await import('../wall/wallAgentView.js');
const { overlaps, unionRect, BAR_ROOM } = await import('../wall/wallLayout.js');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const { chordFor } = await import('../wall/wallKeymap.js');
const { default: TerminalWall } = await import('../wall/TerminalWall.js');
const { default: WallGroups } = await import('../wall/WallGroups.js');

beforeEach(() => mem.clear());

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(id, at, kind, body, extra = {}) {
    return {
        type: 'event',
        op: extra.op || 'add',
        id,
        seq: extra.seq ?? 1,
        at,
        line: extra.line ?? 1,
        ts: '2026-11-14T22:00:00Z',
        turn: extra.turn ?? { id: 'turn-1', index: 1 },
        kind,
        [kind]: body,
        ...extra,
    };
}

/** Build a headless TerminalWall with fake grids and a programmable JSON-RPC + push bridge. */
function makeHeadlessWall({ port = 8199, terminals = { t1: [116, 58, 0, 0] } } = {}) {
    const registryMap = new Map();
    const wall = new TerminalWall({
        scene: {},
        camera: /** @type {any} */ ({
            isOrthographicCamera: true,
            zoom: 4,
            position: { x: 0, y: 0 },
            left: -200, right: 200, top: 150, bottom: -150,
            updateProjectionMatrix() {},
        }),
        gl: { domElement: { clientWidth: 1280, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) } },
        atlas: null,
        registry: {
            get: (id) => registryMap.get(id) ?? null,
            addChangeListener() {},
            removeChangeListener() {},
        },
        relayPort: port,
    });
    wall.viewport.setView(1280, 800);
    wall.groups = new WallGroups(wall, { atlas: null, scene: null });

    for (const [id, [w, h, x = 0, y = 0]] of Object.entries(terminals)) {
        const grid = {
            terminalId: id,
            cols: 80,
            rows: 24,
            windowTitle: id,
            hasSelection: false,
            scrolledRows: 0,
            cursorRow: 0,
            altScreen: false,
            cellStride: { x: w / 80, y: h / 24 },
            position: { x, y, z: 0, set(nx, ny, nz = 0) { this.x = nx; this.y = ny; this.z = nz; } },
            scale: { x: 1, y: 1, z: 1 },
            parent: { isScene: true },
            getLocalBounds: () => ({ min: { x: 0, y: -h }, max: { x: w, y: 0 } }),
            readText: () => [`prompt in ${id}`],
            setBorderFlag() {},
            setCursorFocused() {},
            selectionText: () => '',
            paste: () => true,
        };
        wall.ctx.terminals.set(id, /** @type {any} */ (grid));
        wall.order.push(id);
        registryMap.set(id, { id, grid, meta: { owner: `ctrl-${id}` } });
    }

    const pushed = [];
    const rpcListeners = new Set();
    const rpcHandlers = new Map();
    const bridge = {
        connected: true,
        push(target, msg) { pushed.push({ target, msg }); },
        onRpcNotification(fn) {
            rpcListeners.add(fn);
            return () => rpcListeners.delete(fn);
        },
        async rpcRequest(method, params) {
            const fn = rpcHandlers.get(method);
            if (!fn) throw new Error(`unhandled RPC ${method}`);
            return await fn(params);
        },
    };
    wall.bridge = /** @type {any} */ (bridge);
    wall.ctx.wsbridge = /** @type {any} */ (bridge);
    wall.termd.attach(/** @type {any} */ (bridge));
    wall.agents.start(/** @type {any} */ (bridge));

    const notify = (method, params) => {
        for (const fn of [...rpcListeners]) fn(method, params);
    };

    return { wall, bridge, pushed, rpcHandlers, notify };
}

// ── 1. categorization, subset filtering & formatting ─────────────────────────

test('categorizes every EVENTS.md kind and distinguishes text file reads from image reads and noise', () => {
    const promptPlain = eventRecord(makeEvent('e1', 10, 'prompt', { origin: 'human', text: 'check wall layout' }));
    const promptWithImg = eventRecord(makeEvent('e2', 20, 'prompt', { origin: 'human', text: 'see screenshot', images: [{ media_type: 'image/png' }] }));
    const thinkRec = eventRecord(makeEvent('e3', 30, 'think', { text: 'checking invariants\nline 2', redacted: false }));
    const sayRec = eventRecord(makeEvent('e4', 40, 'say', { text: 'All good.', final: true }));
    const fileRead = eventRecord(makeEvent('e5', 50, 'tool', {
        name: 'Read', action: 'read', target: 'wall/TerminalWall.js',
        meta: { range: [10, 40] },
        file: { text: 'line ten\nline eleven\n', start: 10, total: 900 },
        result: { status: 'ok', output: '' },
    }));
    const imgRead = eventRecord(makeEvent('e6', 60, 'tool', {
        name: 'Read', action: 'read', target: 'docs/diagram.png',
        meta: { bytes: 43008 },
        result: { status: 'ok', output: '' },
    }));
    const editRec = eventRecord(makeEvent('e7', 70, 'tool', {
        name: 'Edit', action: 'edit', target: 'wall/WallGroups.js',
        meta: { added: 14, removed: 3 },
        result: { status: 'ok', output: '' },
    }));
    const bashRec = eventRecord(makeEvent('e8', 80, 'tool', {
        name: 'Bash', action: 'bash', detail: 'bun test tools/wall-*.test.mjs',
        result: { status: 'ok', output: '111 pass\n0 fail' },
    }));
    const grepRec = eventRecord(makeEvent('e9', 90, 'tool', {
        name: 'Grep', action: 'grep', target: 'wall/', detail: 'windowRect',
        result: { status: 'ok', output: 'wall/TerminalWall.js:393' },
    }));
    const noiseRec = eventRecord(makeEvent('e10', 100, 'tool', {
        name: 'TodoWrite', action: 'noise', detail: '3 items',
        result: { status: 'ok', output: '' },
    }));

    expect(categoriesOfRecord(promptPlain)).toEqual(['prompt']);
    expect(categoriesOfRecord(promptWithImg)).toEqual(['prompt']);
    expect(categoriesOfRecord(thinkRec)).toEqual(['think']);
    expect(categoriesOfRecord(sayRec)).toEqual(['say']);
    expect(categoriesOfRecord(fileRead)).toEqual(['read']);
    expect(categoriesOfRecord(imgRead)).toEqual(['image']);
    expect(categoriesOfRecord(editRec)).toEqual(['edit']);
    expect(categoriesOfRecord(bashRec)).toEqual(['run']);
    expect(categoriesOfRecord(grepRec)).toEqual(['search']);
    expect(categoriesOfRecord(noiseRec)).toEqual(['noise']);

    // Default filters show standard categories and hide noise.
    const all = [promptPlain, promptWithImg, thinkRec, sayRec, fileRead, imgRead, editRec, bashRec, grepRec, noiseRec];
    expect(all.filter((r) => matchesFilter(r, DEFAULT_FILTERS)).map((r) => r.id))
        .toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);

    // Subset filters: `only tools`, `only image`, `only reads`.
    const onlyTools = applyFilterChange(DEFAULT_FILTERS, 'only', ['tools']);
    expect(all.filter((r) => matchesFilter(r, onlyTools)).map((r) => r.id))
        .toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);

    const onlyImages = applyFilterChange(DEFAULT_FILTERS, 'only', ['image']);
    expect(all.filter((r) => matchesFilter(r, onlyImages)).map((r) => r.id))
        .toEqual(['e6']);

    const onlyReads = applyFilterChange(DEFAULT_FILTERS, 'only', ['reads']);
    expect(all.filter((r) => matchesFilter(r, onlyReads)).map((r) => r.id))
        .toEqual(['e5', 'e6']);

    expect(() => expandCategoryTokens(['bogus'])).toThrow(/unknown action category 'bogus'/);

    // Row summaries + numbered file expansion.
    expect(summarizeEventRow(fileRead)).toMatchObject({ tag: 'read', summary: 'wall/TerminalWall.js', stat: 'L10–40' });
    expect(summarizeEventRow(imgRead)).toMatchObject({ tag: 'image', summary: 'docs/diagram.png', stat: '42KB' });
    expect(summarizeEventRow(editRec)).toMatchObject({ tag: 'edit', summary: 'wall/WallGroups.js', stat: '+14 −3' });
    expect(summarizeEventRow(sayRec, { abandoned: true })).toMatchObject({ tag: 'say', stat: 'final', abandoned: true });

    const expanded = formatExpandedEvent(fileRead);
    expect(expanded.body).toBe('10 │ line ten\n11 │ line eleven');
    expect(matchesSubset(imgRead, ['reads'])).toBe(true);
    expect(matchesSubset(bashRec, ['reads'])).toBe(false);

    // Explicit hierarchical category tree covers every category id exactly once, with valid hex hues.
    const seenInTree = [];
    for (const g of CATEGORY_GROUPS_TREE) {
        for (const sub of g.subgroups) seenInTree.push(...sub.categories);
        seenInTree.push(...g.directCategories);
    }
    expect(seenInTree).toEqual([...CATEGORY_IDS]);
    for (const cid of CATEGORY_IDS) {
        expect(categoryHue(cid)).toMatch(/^#[0-9a-f]{6}$/i);
    }

    // Group selection states & filter summary labels for the collapsible dropdown trigger.
    expect(describeActiveFilter(DEFAULT_FILTERS)).toBe('all actions');
    expect(describeActiveFilter(applyFilterChange(DEFAULT_FILTERS, 'on', ['noise']))).toBe('all + noise');
    expect(describeActiveFilter(onlyTools)).toBe('tool calls');
    expect(describeActiveFilter(onlyReads)).toBe('file & img reads');
    expect(describeActiveFilter(onlyImages)).toBe('image reads');
    expect(describeActiveFilter(applyFilterChange(DEFAULT_FILTERS, 'only', ['conversation']))).toBe('conversation');
    expect(describeActiveFilter(applyFilterChange(DEFAULT_FILTERS, 'only', ['edit', 'run']))).toBe('edit + run');
    expect(groupSelectionState(DEFAULT_FILTERS, ['prompt', 'think', 'say'])).toBe('all');
    expect(groupSelectionState(DEFAULT_FILTERS, ['system', 'noise'])).toBe('some');
    expect(groupSelectionState(onlyReads, ['prompt', 'think', 'say'])).toBe('none');
});

// ── 2. geometry, side picking & WallGroups footprint tiling ──────────────────

test('agentViewRect, pickAgentSide and WallGroups tile footprints across all 4 sides without overlap', () => {
    const body = { minX: 100, maxX: 216, minY: -58, maxY: 0 };
    const dims = { width: 76, height: 44, gap: 1.5 };

    for (const side of AGENT_SIDES) {
        const ar = agentViewRect(body, BAR_ROOM, side, dims);
        const win = { ...body, maxY: body.maxY + BAR_ROOM };
        expect(overlaps(ar, win)).toBe(false);

        const m = footprintTileMetrics(body, side, dims);
        const full = unionRect([win, ar]);
        expect(full.minX).toBeCloseTo(m.tileBox.minX, 6);
        expect(full.maxX).toBeCloseTo(m.tileBox.maxX, 6);
        expect(full.minY).toBeCloseTo(m.tileBox.minY, 6);
        expect(full.maxY).toBeCloseTo(m.tileBox.maxY, 6);
    }

    const win = { minX: 0, maxX: 120, minY: -60, maxY: 10 };   // center = (60, -25)
    expect(pickAgentSide(win, { x: 140, y: -25 })).toBe('right');
    expect(pickAgentSide(win, { x: -20, y: -25 })).toBe('left');
    expect(pickAgentSide(win, { x: 60, y: 30 })).toBe('top');
    expect(pickAgentSide(win, { x: 60, y: -80 })).toBe('bottom');

    // Tiled group with 4 terminals, each wearing an Agent View on a DIFFERENT side!
    const { wall } = makeHeadlessWall({
        terminals: {
            a: [100, 50, 0, 0],
            b: [100, 50, 200, 0],
            c: [100, 50, 0, -120],
            d: [100, 50, 200, -120],
        },
    });
    wall.names = /** @type {any} */ ({ barHeight: () => BAR_ROOM });

    wall.agents.setSide('a', 'right');
    wall.agents.setSide('b', 'left');
    wall.agents.setSide('c', 'top');
    wall.agents.setSide('d', 'bottom');

    const gid = wall.groups.create(['a', 'b', 'c', 'd'], { layout: 'tile', columns: 2, gap: 4 });
    const footprints = ['a', 'b', 'c', 'd'].map((id) => wall.footprintRect(id, 4));
    for (let i = 0; i < footprints.length; i++) {
        for (let j = i + 1; j < footprints.length; j++) {
            expect(overlaps(footprints[i], footprints[j])).toBe(false);
        }
    }

    // Group backdrop encloses every terminal window AND every attached Agent View.
    const frame = wall.groups.frameRect(gid, 4);
    const allUnion = unionRect(footprints);
    expect(frame.minX).toBeLessThanOrEqual(allUnion.minX - WALL_CONFIG.groupPad + 1e-6);
    expect(frame.maxX).toBeGreaterThanOrEqual(allUnion.maxX + WALL_CONFIG.groupPad - 1e-6);
    expect(frame.minY).toBeLessThanOrEqual(allUnion.minY - WALL_CONFIG.groupPad + 1e-6);
    expect(frame.maxY).toBeGreaterThanOrEqual(allUnion.maxY + WALL_CONFIG.groupPad - 1e-6);
});

// ── 3. session pairing ───────────────────────────────────────────────────────

test('matchTerminalSession pairs by pin, gx-<name> workgroup, then pwd/cwd preferring live & newest', () => {
    const sessions = [
        { session_id: 'ended-1', harness: 'claude', cwd: '/repo/app', status: 'ended', mtime: '2026-11-14T22:50:00Z' },
        { session_id: 'live-older', harness: 'claude', cwd: '/repo/app', status: 'idle', mtime: '2026-11-14T21:00:00Z' },
        { session_id: 'live-newer', harness: 'claude', cwd: '/repo/app', status: 'processing', mtime: '2026-11-14T22:10:00Z' },
        { session_id: 'sub-child', harness: 'claude', cwd: '/repo/app', status: 'processing', mtime: '2026-11-14T22:55:00Z', parent_session: { session_id: 'live-newer' } },
        { session_id: 'wg-sess', harness: 'claude', cwd: '/workgroups/alpha', status: 'idle', mtime: '2026-11-14T20:00:00Z', workgroup: { name: 'alpha' } },
    ];

    // Auto-match ignores subagents (`parent_session`) and prefers live over ended, newest mtime first.
    expect(matchTerminalSession({ id: 't1', pwd: '/repo/app/', cwd: '/home/me' }, sessions)?.session_id).toBe('live-newer');
    // Workgroup terminal convention `gx-<name>`.
    expect(matchTerminalSession({ id: 'gx-alpha', cwd: '/tmp' }, sessions)?.session_id).toBe('wg-sess');
    // Explicit pin can select a subagent or exact session id / prefix.
    expect(matchTerminalSession({ id: 't1', pwd: '/repo/app' }, sessions, 'sub-child')?.session_id).toBe('sub-child');
    expect(matchTerminalSession({ id: 't1', pwd: '/repo/app' }, sessions, 'ended')?.session_id).toBe('ended-1');
});

// ── 4. end-to-end stream folding, live scrollback anchors & router verbs ─────

test('live event folding, write-time scrollback anchors, jump-to-terminal and wall.agent* verbs', async () => {
    const { wall, pushed, rpcHandlers, notify } = makeHeadlessWall();
    const followed = [];
    const unfollowed = [];

    const initialLines = [
        JSON.stringify({ type: 'session', session_id: 'sess-1', harness: 'claude', cwd: '/srv/wall', title: 'Agent View Task' }),
        JSON.stringify(makeEvent('p1', 50, 'prompt', { origin: 'human', text: 'build agent view' })),
        // Provisional Stop-hook reply: lastAt stays at 50 per EVENTS.md!
        JSON.stringify(makeEvent('prov-1', 90, 'say', { text: 'working…', provisional: true })),
    ];
    const earlierLines = [
        JSON.stringify(makeEvent('p0', 10, 'prompt', { origin: 'human', text: 'earlier turn' })),
    ];

    rpcHandlers.set('agentSessions/list', async () => ({
        gen: 1,
        sessions: [
            { session_id: 'sess-1', harness: 'claude', cwd: '/srv/wall', status: 'processing', mtime: '2026-11-14T22:30:00Z', title: 'Agent View Task' },
        ],
    }));
    rpcHandlers.set('agentEvents/read', async (params) => {
        if (params.until === 50) return { lines: earlierLines, size: 200 };
        return { lines: initialLines, size: 200 };
    });
    rpcHandlers.set('agentEvents/follow', async (params) => {
        followed.push(params);
        return { ok: true };
    });
    rpcHandlers.set('agentEvents/unfollow', async (params) => {
        unfollowed.push(params);
        return { ok: true };
    });

    // Sync termd status so `t1` is in `/srv/wall` with 100 scrollback rows.
    notify('termd/status', {
        relay: { state: 'ok', since: 1, ns: 'dev', bundled: '1.4' },
        status: {
            terminals: [{ id: 't1', cwd: '/srv', pwd: '/srv/wall', scrollback_rows: 100, alt: false, subscribers: [{ view: 0 }] }],
        },
    });
    await wall.agents.onRelayUp();

    // Chord+A toggles the focused terminal's Agent View.
    wall.focus('t1');
    const chordA = chordFor({ code: 'KeyA', shiftKey: false }, 'canvas');
    expect(chordA).not.toBeNull();
    expect((await wall.router.execute(['wall.agent'])).text).toBe('OK: agent view on t1: open (right)');

    // Let async stream hydration + follow complete.
    await new Promise((r) => setTimeout(r, 10));

    // Provisional reply was dropped before starting follow at `from: 50`.
    expect(followed).toEqual([{ session: 'sess-1', from: 50 }]);
    let desc = wall.snapshot().agentViews[0];
    expect(desc.sessionId).toBe('sess-1');
    expect(desc.rows.map((r) => r.id)).toEqual(['p1']);

    // Simulate terminal outputting lines (scrolledRows advances by 20 → scrollbackNow = 120, cursorRow = 6)
    // right as a live tool call `t-read` arrives (`add`), then completes in place (`update`).
    const grid = wall.terminal('t1');
    grid.scrolledRows = 20;
    grid.cursorRow = 6;
    notify('agentEvents/lines', {
        session: 'sess-1',
        lines: [
            JSON.stringify(makeEvent('t-read', 110, 'tool', {
                name: 'Read', action: 'read', target: 'wall/wallLayout.js',
                result: { status: 'pending', output: '' },
            })),
        ],
    });

    desc = wall.snapshot().agentViews[0];
    expect(desc.rows.map((r) => [r.id, r.stat])).toEqual([['p1', ''], ['t-read', '…']]);

    // Update frame arrives later after 60 more lines have scrolled off (scrollbackNow = 180):
    // `t-read` updates in place AND keeps its write-time anchor (absRow = 120 + 6 = 126)!
    grid.scrolledRows = 80;
    notify('agentEvents/lines', {
        session: 'sess-1',
        lines: [
            JSON.stringify(makeEvent('t-read', 145, 'tool', {
                name: 'Read', action: 'read', target: 'wall/wallLayout.js',
                meta: { range: [1, 30] },
                file: { text: 'export const FLOW_GAP = 12;\n', start: 1, total: 252 },
                result: { status: 'ok', output: '' },
            }, { op: 'update' })),
            // Also push an event carrying an explicit protocol `terminal_line: 150`.
            JSON.stringify(makeEvent('s-reply', 170, 'say', { text: 'Done reading!', final: true }, { terminal_line: 150 })),
        ],
    });

    desc = wall.snapshot().agentViews[0];
    expect(desc.rows.map((r) => [r.id, r.stat])).toEqual([
        ['p1', ''],
        ['t-read', 'L1–30'],
        ['s-reply', 'final'],
    ]);

    // Jump to `t-read`: nowScrollback = 180, absRow = 126, desiredTop = 124 → offset = 180 - 124 = 56!
    expect(computeJumpOffset({ scrollbackRows: 120, cursorRow: 6 }, 180, 2)).toBe(56);
    const jumpRes = await wall.router.execute(['wall.agent.jump', 't1', 't-read']);
    expect(jumpRes.text).toBe('OK: t1 jumped to t-read (offset 56)');
    expect(pushed.at(-1)).toEqual({
        target: 'ctrl-t1',
        msg: { event: 'terminal.scroll', data: { terminalId: 't1', live: true, offset: 56 } },
    });

    // Jump to `s-reply` (protocol terminal_line = 150): desiredTop = 148 → offset = 180 - 148 = 32!
    const protoJump = await wall.router.execute(['wall.agent.jump', 't1', 's-reply']);
    expect(protoJump.data.offset).toBe(32);
    expect(pushed.at(-1)).toEqual({
        target: 'ctrl-t1',
        msg: { event: 'terminal.scroll', data: { terminalId: 't1', live: true, offset: 32 } },
    });

    // Return to live (`offset = 0`).
    await wall.router.execute(['wall.agent.jump', 't1', 'live']);
    expect(pushed.at(-1)).toEqual({
        target: 'ctrl-t1',
        msg: { event: 'terminal.scroll', data: { terminalId: 't1', live: true } },
    });

    // Alternate screen refuses scrollback jump with a clear notice.
    grid.altScreen = true;
    const altJump = await wall.router.execute(['wall.agent.jump', 't1', 't-read']);
    expect(altJump.text).toMatch(/^ERR: .*alternate screen/);
    expect(wall.notice).toMatch(/alternate screen/);
    grid.altScreen = false;

    // Show / hide single event, subset expand (`tools`), and collapse all.
    await wall.router.execute(['wall.agent.show', 't1', 't-read', 'on']);
    expect(wall.snapshot().agentViews[0].rows.find((r) => r.id === 't-read').detail.body).toContain('1 │ export const FLOW_GAP = 12;');

    await wall.router.execute(['wall.agent.collapse', 't1', 'all']);
    expect(wall.snapshot().agentViews[0].expandedCount).toBe(0);

    await wall.router.execute(['wall.agent.expand', 't1', 'tools']);
    expect(wall.snapshot().agentViews[0].rows.map((r) => [r.id, r.expanded])).toEqual([
        ['p1', false],
        ['t-read', true],
        ['s-reply', false],
    ]);

    // Load earlier events before byte 50 (`p0` at 10).
    const earlier = await wall.router.execute(['wall.agent.earlier', 't1']);
    expect(earlier.data.loaded).toBe(1);
    expect(wall.snapshot().agentViews[0].rows.map((r) => r.id)).toEqual(['p0', 'p1', 't-read', 's-reply']);

    // Move side + filter subset persist across a wall reload, and closing unfollows cleanly.
    await wall.router.execute(['wall.agent.side', 't1', 'left']);
    await wall.router.execute(['wall.agent.filter', 't1', 'only', 'tools']);
    const toolsSnap = wall.snapshot().agentViews[0];
    expect(toolsSnap.side).toBe('left');
    expect(toolsSnap.filterLabel).toBe('tool calls');
    expect(toolsSnap.categoryCounts).toMatchObject({ prompt: 2, read: 1, say: 1, noise: 0 });
    expect(toolsSnap.rows.map((r) => r.id)).toEqual(['t-read']);

    // Screen transform sizing snaps outer `rootEl` to whole pixels and keeps `--av-hairline >= 1px` across zooms.
    const makeFakeEl = () => {
        const props = new Map();
        return {
            style: {
                display: '',
                zIndex: '',
                width: '',
                height: '',
                transform: '',
                setProperty: (k, val) => props.set(k, val),
            },
            props,
        };
    };
    const rootEl = makeFakeEl();
    const fullEl = makeFakeEl();
    const badgeEl = makeFakeEl();
    wall.agents.registerDom('t1', /** @type {any} */ ({ rootEl, fullEl, badgeEl }));

    // Zoomed in (`zoom = 10`, `scale = 2.5`): `--av-hairline` stays `1px` (never sub-pixel `< 1px`).
    wall.viewport.camera.zoom = 10;
    wall.agents.updateScreenTransforms(wall.viewport);
    expect(rootEl.style.width).toMatch(/^\d+px$/);
    expect(rootEl.style.height).toMatch(/^\d+px$/);
    expect(fullEl.props.get('--av-hairline')).toBe('1px');

    // Zoomed out (`zoom = 2.8`, `scale = 0.7`): `--av-hairline` steps up to `2px` so scaled hairlines stay >= 1px.
    wall.viewport.camera.zoom = 2.8;
    wall.agents.updateScreenTransforms(wall.viewport);
    expect(fullEl.props.get('--av-hairline')).toBe('2px');
    wall.agents.registerDom('t1', null);

    const reloaded = makeHeadlessWall({ port: 8199 });
    expect(reloaded.wall.agents.isOpen('t1')).toBe(true);
    expect(reloaded.wall.agents.sideOf('t1')).toBe('left');

    await wall.router.execute(['wall.agent', 't1', 'close']);
    expect(wall.agents.isOpen('t1')).toBe(false);
    expect(unfollowed).toEqual([{ session: 'sess-1' }]);

    // Forgetting / pruning a terminal cleans its stored Agent View entry.
    reloaded.wall.store.forget('t1');
    expect(reloaded.wall.store.agentView('t1')).toBeNull();
});
