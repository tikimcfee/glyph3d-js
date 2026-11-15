/**
 * Terminal commands — the CONTROL plane for terminal viewports. The byte DATA plane
 * is separate: OUTPUT arrives as binary frames (WebSocketBridge.onBinaryFrame →
 * grid.writeBytes → the headless VT emulator); INPUT enters via grid.sendInput/sendKey/paste/sendMouse
 * and leaves through the grid's onInput hook as a terminal.key / terminal.paste / terminal.mouse /
 * terminal.bytes push to the owning adapter.
 * These verbs manage lifecycle + layout.
 *
 * Control verbs:
 *   terminal.spawn  [cols] [rows] [-- cmd…]  (ask relay to fork an adapter running cmd, default
 *                                             a shell; once it lands the host shows it and gives
 *                                             it the keys)
 *   terminal.create <id> [cols] [rows] [--scale N]
 *   terminal.resize <id> <cols> <rows>       (grid + emulator + adapter PTY in lockstep)
 *   terminal.ping   <id>                     (liveness probe → re-adopt trigger)
 *   terminal.close  <id>                     (dispose display grid only)
 *   terminal.kill   <id>                     (full teardown: the program in termd + the grid)
 *   terminal.focus  <id>                     (the keyboard target, as the host defines it)
 *   terminal.mouse  <id> <press|release|move> <button> <col> <row> [mods…]
 *                                            (a pointer event for the program: termd encodes it in
 *                                             its mouse modes)
 *   terminal.selection <id> [clear | cells … | word <col> <row> | line <row>]
 *                                            (the text selection: read it, make it, clear it)
 *   terminal.list · terminal.move <id> <x> <y> <z> · terminal.scale <id> <factor>
 *
 * Grids render fixed-size cell grids via TerminalGrid, writing directly to GPU
 * attribute arrays (no GlyphCollection deferred queue).
 *
 * Any application runs these verbs: its context is a TerminalContext, and its `terminalHost`
 * (TerminalHost.js) answers what differs per application — where a terminal lands, what focus
 * means, what persists its view. The IDE (app/client/terminalHost.js) and the wall
 * (wall/TerminalWall.js) each install one.
 */

import TerminalGrid from '../../collections/TerminalGrid.js';
import { encodeBase64 } from '../../utils/encoding.js';
import { createLogger } from '../../utils/Logger.js';
/** @import { TerminalContext } from './TerminalHost.js' */
/** @import CommandRouter from '../orchestration/CommandRouter.js' */
/** @import WebSocketBridge from '../orchestration/WebSocketBridge.js' */

const log = createLogger('terminal');

/** Wheel travel (CSS px) per line of termd scrollback. */
const WHEEL_PX_PER_LINE = 30;

/**
 * Lines of termd scrollback a wheel delta asks for: wheel up (dy < 0) → + lines, back into
 * history; ~30 px a line, at least one line in the wheel's direction. The argument to
 * `terminal.scroll <id> <lines>`.
 * @param {number} dy - wheel deltaY, CSS px
 * @returns {number}
 */
export function terminalWheelLines(dy) {
    const lines = -Math.round(dy / WHEEL_PX_PER_LINE);
    return lines !== 0 ? lines : (dy > 0 ? -1 : 1);
}

/**
 * Terminal OUTPUT data plane: binary frames (type 1) carry raw VT bytes plus the size they were
 * written at → the terminal's emulator (grid.writeBytes). Aligns the grid to the size THIS content was
 * drawn at BEFORE parsing it: size and redraw ride one ordered channel (cli/attach_unix.go), so a
 * resize can never race ahead of its redraw and address a row that doesn't exist.
 * @param {WebSocketBridge} bridge
 * @param {TerminalContext} ctx
 */
export function routeTerminalOutput(bridge, ctx) {
    bridge.onBinaryFrame(1, (id, bytes, cols, rows) => {
        const grid = ctx.terminals?.get(id);
        if (!grid) return;
        if (cols > 0 && rows > 0 && (grid.cols !== cols || grid.rows !== rows)) grid.resize(cols, rows);
        grid.writeBytes(bytes);
    });
}

/**
 * Await a terminal's arrival in the registry — the "added and ready" callback for
 * terminal.spawn. The registry fires its change listeners synchronously on register,
 * and terminal.create wires the grid + input BEFORE registering, so the awaited
 * terminal is fully manipulable when this resolves. One-shot: the listener removes
 * itself on arrival or timeout, so a never-created terminal can't leak it.
 * @param {Object} registry - SceneRegistry (get/addChangeListener/removeChangeListener)
 * @param {string} id
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>} true when the terminal arrived, false on timeout
 */
export function waitForTerminal(registry, id, timeoutMs = 15000) {
    if (registry.get(id)) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (arrived) => {
            clearTimeout(timer);
            registry.removeChangeListener(onChange);
            resolve(arrived);
        };
        const onChange = () => { if (registry.get(id)) done(true); };
        const timer = setTimeout(() => done(false), timeoutMs);
        registry.addChangeListener(onChange);
    });
}

/**
 * Lazily initialise the terminal registry map on ctx.
 * @param {TerminalContext} ctx - command context
 * @returns {Map<string, TerminalGrid>}
 */
function getTerminals(ctx) {
    if (!ctx.terminals) {
        ctx.terminals = new Map();
    }
    return ctx.terminals;
}

/**
 * A grid's input as the push its owning adapter reads: a key event (`terminal.key`), a paste
 * (`terminal.paste`) and a pointer event (`terminal.mouse`), which the adapter hands to termd's
 * `key`, `paste` and `mouse` ops, or raw bytes (`terminal.bytes`, base64), written to the program
 * as given. JSON pushes: input is sparse; the binary lane is the high-volume OUTPUT direction's.
 * @param {{bytes?: string, key?: Object, paste?: string, mouse?: Object}} input - TerminalGrid.onInput's shapes
 * @param {string} terminalId
 */
function inputPush(input, terminalId) {
    if (input.key) return { event: 'terminal.key', data: { terminalId, ...input.key } };
    if (input.mouse) return { event: 'terminal.mouse', data: { terminalId, ...input.mouse } };
    if (input.paste != null) return { event: 'terminal.paste', data: { terminalId, text: input.paste } };
    return { event: 'terminal.bytes', data: { terminalId, b64: encodeBase64(input.bytes) } };
}

/**
 * Route a grid's INPUT to its owning adapter. No owner, or no relay, leaves the grid with no
 * input route.
 * @param {TerminalContext} ctx
 * @param {TerminalGrid} grid
 * @param {string|null} owner - the adapter's controller id
 */
function bindOwner(ctx, grid, owner) {
    const bridge = ctx.wsbridge;
    grid.onInput = owner && bridge?.connected
        ? (input, termId) => bridge.push(owner, inputPush(input, termId))
        : null;
}

/**
 * The repaint HANDSHAKE: the grid + its parser are ready NOW (synchronous build), so tell the
 * owning adapter to have termd repaint the full screen into it (title included). The adapter's
 * own timed repaints race grid creation under reload contention (late-built grids miss them and
 * stay BLANK); this fires exactly when the grid exists. Idempotent: an extra repaint is harmless.
 * @param {TerminalContext} ctx @param {string} id @param {string|null} owner
 */
function requestRepaint(ctx, id, owner) {
    if (owner && ctx.wsbridge?.connected) {
        ctx.wsbridge.push(owner, { event: 'terminal.refresh', data: { terminalId: id } });
    }
}

/**
 * @param {CommandRouter} router - its context is a TerminalContext
 */
export default function registerTerminalCommands(router) {

    // ------------------------------------------------------------------
    // terminal.spawn [cols] [rows] [-- cmd…]
    //   Ask the relay (Go server) to fork a `glyph3d-cli attach` adapter — a REAL
    //   program (cmd, default a shell) in a g3d-termd terminal, wired into a fresh
    //   TerminalGrid. The browser can't spawn a
    //   host process, so this sends a {relay:"terminal.spawn"} message the relay
    //   handles server-side; the terminal appears once the forked adapter connects
    //   and runs terminal.create + frames. (This is the "+ terminal" button's verb.)
    //   The verb then AWAITS its own terminal — the relay's `terminal.spawning` ack
    //   hands back the id, the registry's change event is the "added and ready"
    //   callback — and hands it to the host to show + focus (terminalHost.landed).
    //   Per-spawn promises, no shared state: parallel spawns each pair with their own
    //   ack, and a restore-time re-adopt (terminal.create with no spawn) never lands.
    // ------------------------------------------------------------------
    router.register('terminal.spawn', async (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge || !bridge.connected || typeof bridge.send !== 'function') {
            return { text: 'ERR: not connected to the relay — terminal.spawn needs the Go server to fork an adapter', data: null };
        }
        const msg = { relay: 'terminal.spawn' };
        const dash = args.indexOf('--');
        const sizeArgs = dash >= 0 ? args.slice(0, dash) : args;
        const cols = parseInt(sizeArgs[0], 10);
        const rows = parseInt(sizeArgs[1], 10);
        if (!isNaN(cols) && cols > 0) msg.cols = cols;
        if (!isNaN(rows) && rows > 0) msg.rows = rows;
        if (dash >= 0) {
            const argv = args.slice(dash + 1);
            if (!argv.length) return { text: 'ERR: usage: terminal.spawn [cols] [rows] [-- cmd…] (nothing after --)', data: null };
            msg.argv = argv;
        }

        // Full spawn flow: await the ack (the id), await the terminal, hand it to the host (landed).
        if (typeof bridge.waitForEvent === 'function' && ctx.registry) {
            const ackPromise = bridge.waitForEvent('terminal.spawning', 5000);
            bridge.send(JSON.stringify(msg));
            const ack = await ackPromise;
            if (!ack?.id) {
                return {
                    text: 'OK: requested terminal spawn (no ack from the relay — it will appear where new terminals land, unannounced)',
                    data: { requested: true, cols: msg.cols ?? null, rows: msg.rows ?? null },
                };
            }
            const arrived = await waitForTerminal(ctx.registry, ack.id);
            if (!arrived) {
                return {
                    text: `OK: terminal '${ack.id}' spawning — the adapter hasn't connected yet; it will appear where new terminals land`,
                    data: { requested: true, id: ack.id },
                };
            }
            const landed = await ctx.terminalHost.landed(ack.id);
            return {
                text: `OK: terminal '${ack.id}' spawned — ${landed}`,
                data: { id: ack.id, landed },
            };
        }

        // A bridge without event waiters (mocks) — fire and forget; it lands unannounced.
        bridge.send(JSON.stringify(msg));
        return {
            text: 'OK: requested terminal spawn (relay is forking an adapter)',
            data: { requested: true, cols: msg.cols ?? null, rows: msg.rows ?? null },
        };
    }, { description: 'Ask the relay to fork a terminal adapter — a real program (default a shell) in the canvas, shown and given the keys when it lands (the host decides how)', usage: '[cols] [rows] [-- cmd…]' });

    // ------------------------------------------------------------------
    // terminal.recover
    //   Re-adopt orphaned terminals — live termd terminals whose adapter died (e.g. a relay
    //   restart severed it; detach-not-kill kept the terminal + its work alive). The relay lists
    //   them, skips any that has an owner, and forks a fresh `attach <id>` at each orphan, whose
    //   subscribe repaints it. One-command recovery after any relay restart.
    // ------------------------------------------------------------------
    router.register('terminal.recover', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge || !bridge.connected || typeof bridge.send !== 'function') {
            return { text: 'ERR: not connected to the relay — terminal.recover needs the Go server', data: null };
        }
        bridge.send(JSON.stringify({ relay: 'terminal.recover' }));
        return {
            text: 'OK: requested terminal recovery (relay is re-adopting orphaned glyphd sessions)',
            data: { requested: true },
        };
    }, { description: 'Re-adopt orphaned termd terminals (after a relay restart) — one-command recovery', usage: '' });

    // ------------------------------------------------------------------
    // terminal.create <id> [cols] [rows] [--scale N]
    // ------------------------------------------------------------------
    router.register('terminal.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.create <id> [cols] [rows] [--scale N]', data: null };
        }

        // Parse --scale flag (gridScale: overall size multiplier, default 2x for readability)
        let gridScale = 2.0;
        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--scale' && args[i + 1]) {
                const s = parseFloat(args[++i]);
                if (!isNaN(s) && s > 0) gridScale = s;
            } else {
                cleanArgs.push(args[i]);
            }
        }

        const id   = cleanArgs[0];
        const cols = cleanArgs[1] ? parseInt(cleanArgs[1], 10) : 80;
        const rows = cleanArgs[2] ? parseInt(cleanArgs[2], 10) : 24;

        if (isNaN(cols) || isNaN(rows) || cols < 1 || rows < 1) {
            return { text: 'ERR: cols and rows must be positive integers', data: null };
        }

        const terminals = getTerminals(ctx);
        const owner = ctx.sender || null;
        const existing = terminals.get(id);
        if (existing) {
            // A create for a grid this display already shows is a RE-ADOPTION: the display outlived
            // the adapter that made it (a relay restart forks fresh adapters, whose controller ids
            // start over). The grid stays; whoever sent this create owns it now, so input, resize,
            // scroll and kill reach the live adapter instead of a dead (or recycled) controller id,
            // and that adapter repaints into the grid. A create from no controller (a local call)
            // has no adapter to hand the terminal to, so the owner stays.
            if (!owner) return { text: `OK: terminal '${id}' already present`, data: { id, existed: true } };
            ctx.registry.replace(id, existing, { meta: { owner } });
            bindOwner(ctx, existing, owner);
            requestRepaint(ctx, id, owner);
            return { text: `OK: terminal '${id}' re-adopted by '${owner}'`, data: { id, existed: true, owner } };
        }

        try {
            const host = ctx.terminalHost;
            const grid = new TerminalGrid(ctx.scene, ctx.atlas, {
                id,
                cols,
                rows,
                gridScale,
                title: id,
                ...host.theme(),
            });

            // The host says where a new terminal lands (the IDE: in the current view; the wall:
            // its remembered spot, else the first free slot).
            host.place(grid);

            terminals.set(id, grid);

            bindOwner(ctx, grid, owner);

            // Register in the scene registry so spatial commands, highlight, etc. work.
            // Size is NOT stored here — the host's persisted view (terminalHost.surfaces) is the one
            // decider of a terminal's cols/rows; the registry entry, the live grid, the emulator and
            // the PTY are caches told by it. (The grid carries the live dimensions for anything that
            // needs them.)
            ctx.registry.register(id, grid, {
                type: 'terminal',
                terminalId: id,
                owner,
            });

            requestRepaint(ctx, id, owner);

            const pos = grid.position;
            // Seed the persisted view — but DON'T clobber an existing/restored one. On re-adopt the
            // adapter re-creates at its startup 80×24; the host already holds the real resized size
            // and pushes it back. Only a genuinely-new terminal seeds the default.
            if (!host.surfaces.get(id)) {
                host.surfaces.set(id, { cols, rows, position: { x: pos.x, y: pos.y, z: pos.z } });
            }
            return {
                text: `OK: terminal '${id}' created (${cols}x${rows}) scale=${gridScale}`,
                data: { id, cols, rows, gridScale, position: { x: pos.x, y: pos.y, z: pos.z } },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Create a terminal grid', usage: '<id> [cols] [rows] [--scale N]' });

    // ------------------------------------------------------------------
    // terminal.ping <id>
    //   Liveness probe, DECOUPLED from output. The adapter pings periodically; an
    //   "ERR: no terminal" reply (after a display reload wiped the registry) is what
    //   triggers the adapter to re-create the grid. Output can't be the re-adopt
    //   trigger — an idle shell emits no OUTPUT frames at all.
    // ------------------------------------------------------------------
    router.register('terminal.ping', (args, ctx) => {
        const id = args[0];
        if (!id) {
            return { text: 'ERR: usage: terminal.ping <id>', data: null };
        }
        if (!getTerminals(ctx).has(id)) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }
        return { text: 'OK', data: { id, alive: true } };
    }, { description: 'Liveness probe — OK if the terminal grid exists', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.resize <id> <cols> <rows>
    // ------------------------------------------------------------------
    router.register('terminal.resize', (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: terminal.resize <id> <cols> <rows>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const cols = parseInt(args[1], 10);
        const rows = parseInt(args[2], 10);
        if (isNaN(cols) || isNaN(rows) || cols < 1 || rows < 1) {
            return { text: 'ERR: cols and rows must be positive integers', data: null };
        }
        // Verify-as-they-land: one terse record per resize, enriched with the FROM dims and the
        // host's note (the IDE: where the terminal sits in the dock) — so a live grip-drag streams
        // its steps through log.search/log.follow. No-op steps never reach here (the dragger fires
        // only on an integer step). The host's own side effects run first (the IDE: an agent's
        // screen writes the size back to the agent's pane).
        const from = `${grid.cols}x${grid.rows}`;
        const note = ctx.terminalHost.resizing(id, cols, rows);
        const where = note ? ` ${note}` : '';

        // Resize the REAL PTY (termd's resize → SIGWINCH → the program) and let the program's redraw
        // drive the rest. Its output streams back tagged with the new size (attach_unix.go: termd
        // places the resize at an exact byte), and THAT resizes the grid +
        // emulator (routeTerminalOutput) — in lockstep with the content it's about to
        // parse, never ahead of it. The tagged frame is the SINGLE writer of terminal size; we do NOT
        // resize the grid locally here. (No adapter = no stream to drive it, so fall back to a direct
        // resize rather than dropping the request — a terminal without an owner has no live PTY anyway.)
        const info = ctx.registry.get(id);
        const owner = info?.meta?.owner;
        if (owner && ctx.wsbridge?.connected) {
            ctx.wsbridge.push(owner, { event: 'terminal.resize', data: { terminalId: id, cols, rows } });
        } else {
            grid.resize(cols, rows);
        }

        log.info(`resize ${id} ${from} → ${cols}x${rows}${where}`);

        // The host's persisted view is what makes the resized size survive a reload (it re-pushes
        // it as the grid re-adopts).
        ctx.terminalHost.surfaces.set(id, { cols, rows });

        return {
            text: `OK: terminal '${id}' resized to ${cols}x${rows}`,
            data: { id, cols, rows },
        };
    }, { description: 'Resize a terminal grid', usage: '<id> <cols> <rows>' });

    // ------------------------------------------------------------------
    // terminal.refresh <id>
    //   Ask the owning adapter to repaint the FULL current screen into the byte lane
    //   (refresh-client → a redraw, no SIGWINCH / no resize). Both projections — the 3D
    //   grid and any attached 2D xterm — render it off the shared stream. This is the
    //   replay trigger when a 2D companion view attaches: it shows the CURRENT screen,
    //   not just bytes-from-now, WITHOUT resizing anything (size is owned by the 3D grid,
    //   never the panel). Idempotent — an extra repaint is harmless.
    // ------------------------------------------------------------------
    router.register('terminal.refresh', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: terminal.refresh <id>', data: null };

        const info = ctx.registry.get(id);
        if (!info) return { text: `ERR: no terminal '${id}'`, data: null };

        const owner = info?.meta?.owner;
        if (owner && ctx.wsbridge?.connected) {
            ctx.wsbridge.push(owner, { event: 'terminal.refresh', data: { terminalId: id } });
        }

        return { text: `OK: terminal '${id}' refresh requested`, data: { id } };
    }, { description: 'Repaint the terminal\'s full current screen into the byte stream', usage: '<id>' });

    // terminal.read <id> — the visible screen as plain text, straight from the
    // headless emulator (the same buffer the glyphs render from). For history
    // beyond the screen, terminal.scroll pages termd's scrollback first.
    router.register('terminal.read', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: terminal.read <id>', data: null };

        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const lines = typeof grid.readText === 'function' ? grid.readText() : [];
        return {
            text: lines.join('\n') + `\nOK: terminal '${id}' screen ${grid.cols}x${grid.rows}`,
            data: { id, cols: grid.cols, rows: grid.rows, lines },
        };
    }, { description: "Read a terminal's visible screen as plain text", usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.selection <id> [clear | cells <col0> <row0> <col1> <row1> [block] | word <col> <row> | line <row>]
    //   A terminal's text selection (TerminalGrid: terminalSelection.js): with no more, what is
    //   selected — its text (trailing blanks trimmed per line, soft wraps joined) and where it runs;
    //   otherwise select as a click would (cells between two boundaries, a word, a logical line) or
    //   clear it. Cells count from 0 at the screen's top-left; a boundary k is the left edge of column k.
    // ------------------------------------------------------------------
    router.register('terminal.selection', (args, ctx) => {
        const usage = 'ERR: usage: terminal.selection <id> [clear | cells <col0> <row0> <col1> <row1> [block] | word <col> <row> | line <row>]';
        const [id, how, ...rest] = args;
        if (!id) return { text: usage, data: null };
        const grid = getTerminals(ctx).get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };
        const n = rest.map(Number);
        const whole = (k) => n.length >= k && n.slice(0, k).every((v) => Number.isInteger(v) && v >= 0);
        if (how === 'clear' && !rest.length) grid.clearSelection();
        else if (how === 'cells' && whole(4) && (rest.length === 4 || (rest.length === 5 && rest[4] === 'block'))) grid.selectCells(n[0], n[1], n[2], n[3], { block: rest[4] === 'block' });
        else if (how === 'word' && rest.length === 2 && whole(2)) grid.selectStart(n[0] + 0.5, n[1] + 0.5, { mode: 'word' });
        else if (how === 'line' && rest.length === 1 && whole(1)) grid.selectStart(0.5, n[0] + 0.5, { mode: 'line' });
        else if (how !== undefined) return { text: usage, data: null };
        const selection = grid.selection, text = grid.selectionText();
        if (!selection) return { text: `OK: terminal '${id}' has nothing selected`, data: { id, text: '', selection: null } };
        const where = `${selection.start.col},${selection.start.row} → ${selection.end.col},${selection.end.row}${selection.block ? ' (block)' : ''}`;
        return { text: `${text}\nOK: terminal '${id}' selection ${where}, ${[...text].length} characters`, data: { id, text, selection } };
    }, { description: "A terminal's text selection: what is selected (its text and cells), or select cells, a word or a line, or clear it", usage: '<id> [clear | cells <col0> <row0> <col1> <row1> [block] | word <col> <row> | line <row>]' });

    // ------------------------------------------------------------------
    // terminal.scroll <id> <lines> [col row]   (+ = back into history, − = forward to live)
    // ------------------------------------------------------------------
    router.register('terminal.scroll', (args, ctx) => {
        const usage = 'ERR: usage: terminal.scroll <id> <lines> [col row] (+back/-forward; the pointer\'s cell, from 0)';
        if (args.length !== 2 && args.length !== 4) return { text: usage, data: null };
        const id = args[0];
        const lines = parseInt(args[1], 10);
        if (isNaN(lines)) return { text: 'ERR: lines must be an integer', data: null };
        const at = args.length === 4 ? { col: Number(args[2]), row: Number(args[3]) } : null;
        if (at && !(Number.isFinite(at.col) && Number.isFinite(at.row))) return { text: usage, data: null };

        const info = ctx.registry.get(id);
        if (!info) return { text: `ERR: no terminal '${id}'`, data: null };

        // Scrollback is termd's: the adapter moves its view (termd `view`) and the viewed rows
        // stream back as a repaint through the byte lane — the grid/emulator just mirror it (no
        // client-side scroll state). An alternate-screen app gets the wheel itself, as termd
        // `mouse` wheel notches at the pointer's cell (else the screen's centre). A pure control
        // push, like terminal.resize.
        const owner = info?.meta?.owner;
        if (owner && ctx.wsbridge?.connected) {
            ctx.wsbridge.push(owner, { event: 'terminal.scroll', data: { terminalId: id, lines, ...at } });
        }
        return { text: `OK: terminal '${id}' scroll ${lines}`, data: { id, lines, ...at } };
    }, { description: "Scroll a terminal's termd scrollback (+ back / - forward); on the alternate screen the wheel goes to the program, at the pointer's cell", usage: '<id> <lines> [col row]' });

    // ------------------------------------------------------------------
    // terminal.mouse <id> <press|release|move> <button> <col> <row> [mods…]
    // ------------------------------------------------------------------
    router.register('terminal.mouse', (args, ctx) => {
        const usage = 'ERR: usage: terminal.mouse <id> <press|release|move> <button> <col> <row> [Shift|Control|Alt|Meta…]';
        if (args.length < 5) return { text: usage, data: null };
        const [id, action, b, c, r, ...mods] = args;
        if (!['press', 'release', 'move'].includes(action)) return { text: usage, data: null };
        const col = Number(c), row = Number(r);
        if (!Number.isFinite(col) || !Number.isFinite(row)) return { text: usage, data: null };
        const button = /^\d+$/.test(b) ? Number(b) : b;   // 8..11 ride as numbers; termd checks the rest
        const grid = getTerminals(ctx).get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };
        /** @type {import('../../collections/TerminalGrid.js').TerminalMouseEvent} */
        const mouse = { action, button, col, row, ...(mods.length ? { mods } : {}) };
        if (!grid.sendMouse(mouse)) return { text: `ERR: terminal '${id}' has no input route (no adapter owns it)`, data: null };
        return { text: `OK: terminal '${id}' mouse ${action} ${b} ${col} ${row}`, data: { id, ...mouse } };
    }, { description: "A pointer event for a terminal's program: termd encodes it in the program's mouse modes and drops what they don't report", usage: '<id> <press|release|move> <button> <col> <row> [mods…]' });

    // ------------------------------------------------------------------
    // terminal.depth <id> [on|off]
    //   Toggle scrollback-into-depth: lines that scroll off the top of the live
    //   screen accumulate as a straight-back stack receding in −Z (newest in the
    //   forefront), so recent history is readable at a glance without copy-mode.
    //   On by default per terminal; omit the mode to flip current state.
    // ------------------------------------------------------------------
    router.register('terminal.depth', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: terminal.depth <id> [on|off]', data: null };

        const grid = getTerminals(ctx).get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        // `terminal.depth <id> ramp <pageRise> [pageDepth]` tunes the page layout live
        // (rise + recession PER PAGE, ×lineSpacing). pageRise=0 → flat straight-back
        // deck of pages; pageDepth sets how far each screenful steps back.
        if ((args[1] || '').toLowerCase() === 'ramp') {
            const yf = parseFloat(args[2]);
            const zf = parseFloat(args[3]);
            if (!Number.isFinite(yf) && !Number.isFinite(zf)) {
                return { text: 'ERR: usage: terminal.depth <id> ramp <pageRise> [pageDepth]', data: null };
            }
            grid.setDepthShape(Number.isFinite(yf) ? yf : null, Number.isFinite(zf) ? zf : null);
            return {
                text: `OK: terminal '${id}' pages rise=${grid._depthYFactor} depth=${grid._depthZFactor}`,
                data: { id, pageRise: grid._depthYFactor, pageDepth: grid._depthZFactor },
            };
        }

        // A bare integer (e.g. `terminal.depth term-5 1000`) sets how many history
        // lines recede in depth, and enables it. ('1'/'0' stay on/off shorthands.)
        const raw = args[1] || '';
        if (/^\d+$/.test(raw) && raw !== '1' && raw !== '0') {
            const max = parseInt(raw, 10);
            grid.setDepthMax(max);
            if (!grid.depthHistory) grid.setDepthHistory(true);
            return { text: `OK: terminal '${id}' depth-history depth=${max} (on)`, data: { id, depthMax: max, enabled: true } };
        }

        const mode = raw.toLowerCase() || 'toggle';
        let on;
        if (mode === 'on' || mode === 'true' || mode === '1') on = true;
        else if (mode === 'off' || mode === 'false' || mode === '0') on = false;
        else on = !grid.depthHistory;

        grid.setDepthHistory(on);
        return { text: `OK: terminal '${id}' depth-history ${on ? 'on' : 'off'}`, data: { id, enabled: on } };
    }, { description: 'Toggle/scale scrollback-into-depth for a terminal (on|off, or a line count)', usage: '<id> [on|off|<lines>]' });

    // ------------------------------------------------------------------
    // terminal.depth.seed <id> <scrollback>
    //   Back-fill a terminal's depth-history from external scrollback (termd
    //   capture), so the history that ALREADY exists shows receding in space —
    //   forward-capture only sees lines that scroll off from now on. Payload is the
    //   raw scrollback text (multi-line: it rides the `call` bundle), oldest→newest
    //   (capture order); the ring wants newest-first, so we reverse here. Re-run
    //   after a reload to restore (the ring is in-memory; termd is the durable source).
    //   `glyph3d-cli seed-history` drives it for every live terminal.
    // ------------------------------------------------------------------
    router.register('terminal.depth.seed', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: terminal.depth.seed <id> <scrollback>', data: null };

        const grid = getTerminals(ctx).get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const lines = (args[1] || '').split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
        lines.reverse();                                                 // → newest-first

        if (!grid.depthHistory) grid.setDepthHistory(true);
        grid.seedHistory(lines);

        const shown = Math.min(lines.length, grid._depthMax);
        return {
            text: `OK: seeded ${shown} of ${lines.length} scrollback line(s) into '${id}' (alt=${grid._altActive})`,
            data: { id, lines: lines.length, shown, alt: grid._altActive },
        };
    }, { description: "Back-fill a terminal's depth-history from scrollback (oldest→newest)", usage: '<id> <scrollback>' });

    // ------------------------------------------------------------------
    // terminal.close <id>
    // ------------------------------------------------------------------
    router.register('terminal.close', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.close <id>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        grid.dispose();
        terminals.delete(id);
        ctx.registry.unregister(id);
        ctx.terminalHost.surfaces.remove(id); // gone for real — drop its view so it doesn't persist

        return {
            text: `OK: terminal '${id}' closed`,
            data: { id },
        };
    }, { description: 'Dispose and unregister a terminal grid', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.list
    // ------------------------------------------------------------------
    router.register('terminal.list', (args, ctx) => {
        const terminals = getTerminals(ctx);
        if (terminals.size === 0) {
            return { text: 'OK: 0 terminals', data: { terminals: [], count: 0 } };
        }

        const list = [];
        for (const [id, grid] of terminals) {
            const p = grid.position;
            list.push({ id, cols: grid.cols, rows: grid.rows, position: { x: p.x, y: p.y, z: p.z } });
        }

        const lines = list.map(t =>
            `  ${t.id}: ${t.cols}x${t.rows} at (${t.position.x},${t.position.y},${t.position.z})`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} terminal(s)`,
            data: { terminals: list, count: list.length },
        };
    }, { description: 'List all terminal grids' });

    // ------------------------------------------------------------------
    // terminal.move <id> <x> <y> <z>
    // ------------------------------------------------------------------
    router.register('terminal.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: terminal.move <id> <x> <y> <z>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // A held terminal (the IDE: a docked tile, a carrel seat) lifts out where it hangs
        // first: the coords place it in its HOME frame, never the holder's.
        ctx.terminalHost.release(id);
        grid.position.set(x, y, z);

        ctx.terminalHost.surfaces.set(id, { position: { x, y, z } });

        return {
            text: `OK: terminal '${id}' moved to (${x},${y},${z})`,
            data: { id, position: { x, y, z } },
        };
    }, { description: 'Move a terminal grid in 3D space', usage: '<id> <x> <y> <z>' });

    // ------------------------------------------------------------------
    // terminal.scale <id> <factor>
    // ------------------------------------------------------------------
    router.register('terminal.scale', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: terminal.scale <id> <factor>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const factor = parseFloat(args[1]);
        if (isNaN(factor) || factor <= 0) {
            return { text: 'ERR: factor must be a positive number', data: null };
        }

        grid.setScale(factor);

        return {
            text: `OK: terminal '${id}' scale = ${factor}`,
            data: { id, scale: factor },
        };
    }, { description: 'Set the scale of a terminal grid', usage: '<id> <factor>' });

    // ------------------------------------------------------------------
    // terminal.kill <id>
    //   FULL teardown — the panel × button's verb. terminal.close only disposes
    //   the display grid; on its own it orphans the adapter process AND its termd
    //   terminal. terminal.kill instead signals the owning adapter (recorded at
    //   create time) to shut down: the adapter kills its termd terminal, exits, and
    //   sends its OWN terminal.close — the single dispose path.
    //   If there's no live owner to signal (drift: the adapter already died), we
    //   dispose locally so the canvas still clears.
    // ------------------------------------------------------------------
    router.register('terminal.kill', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.kill <id>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const owner = ctx.registry.get(id)?.meta?.owner || null;
        const bridge = ctx.wsbridge;
        const canSignal = owner && bridge && bridge.connected && typeof bridge.push === 'function';

        if (canSignal) {
            // Adapter is alive — let it end the termd terminal + itself, then dispose the
            // grid via its trailing terminal.close. One dispose path, no leaks.
            bridge.push(owner, { event: 'terminal.shutdown', data: { terminalId: id } });
            return {
                text: `OK: signaled adapter '${owner}' to shut down terminal '${id}'`,
                data: { id, owner, signaled: true },
            };
        }

        // No live owner — dispose locally (same path as terminal.close).
        grid.dispose();
        terminals.delete(id);
        ctx.registry.unregister(id);
        return {
            text: `OK: terminal '${id}' closed locally (no live adapter to signal)`,
            data: { id, signaled: false },
        };
    }, { description: 'Fully tear down a terminal: signal its adapter to kill its program in termd', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.focus <id>
    //   Make a terminal the keyboard target, as the host defines focus (the IDE:
    //   attention primary + key, the two slots a canvas click sets together).
    //   Framing the camera is a separate concern.
    // ------------------------------------------------------------------
    router.register('terminal.focus', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.focus <id>', data: null };
        }
        const id = args[0];
        if (!getTerminals(ctx).has(id)) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }
        const r = ctx.terminalHost.focus(id);
        if (!r.ok) return { text: `ERR: ${r.text || `couldn't focus terminal '${id}'`}`, data: null };
        return {
            text: `OK: focused terminal '${id}'${r.text ? ` (${r.text})` : ''}`,
            data: { id },
        };
    }, { description: 'Focus a terminal: make it the keyboard target', usage: '<id>' });
}
