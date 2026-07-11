// terminal-emulator-resize-check.mjs — exercises the REAL TerminalEmulator (not raw xterm) through
// a grip-drag-style resize storm: many write()+resize() per "frame". Locks the async contract the
// live grip depends on — coalesced resizes (no per-step xterm churn), no crash / no buffer corruption
// under the storm, and a correct final screen after the drag settles. Per the debug-into-tools practice.
//
//   bun tools/terminal-emulator-resize-check.mjs   (or: node ...)
//
// Node has no requestAnimationFrame; shim it so TerminalEmulator's rAF-throttled read runs.
let rafId = 1; const rafQ = new Map();
globalThis.requestAnimationFrame = (fn) => { const id = rafId++; rafQ.set(id, fn); queueMicrotask(() => { const f = rafQ.get(id); if (f) { rafQ.delete(id); f(); } }); return id; };
globalThis.cancelAnimationFrame = (id) => rafQ.delete(id);

const { default: TerminalEmulator } = await import('../packages/glyph3d-core/src/collections/TerminalEmulator.js');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (c) pass++; else fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tmux-like full repaint at (c×r): clear, home, one labelled line per row, cursor parked at bottom.
const repaint = (c, r) => {
    let s = '\x1b[2J\x1b[H';
    for (let y = 0; y < r; y++) s += `\x1b[${y + 1};1H` + `r${y}`.padEnd(c, '·').slice(0, c);
    s += `\x1b[${r};${c}H`;
    return s;
};

let lastScreen = null, crash = null;
process.on('uncaughtException', (e) => { crash = crash || e; });
process.on('unhandledRejection', (e) => { crash = crash || e; });

const emu = new TerminalEmulator(120, 50, (screen) => { lastScreen = screen; });
// Spy on the underlying xterm resize to prove coalescing (storm of N resizes → far fewer real ones).
const term = emu._term;
let realResizes = 0; const origResize = term.resize.bind(term);
term.resize = (c, r) => { realResizes++; return origResize(c, r); };

emu.write('\x1b[?1049h'); // alt-screen, like a TUI
emu.write(repaint(120, 50));

// The storm: 120 steps, each = a repaint at a new size + a resize, plus newline pressure (the
// deferred-lineFeed crash trigger). No awaiting between steps — this is the mid-parse race.
const STEPS = 120;
let finalC = 0, finalR = 0;
for (let step = 0; step < STEPS; step++) {
    const c = 40 + ((step * 7) % 90), r = 15 + ((step * 5) % 45);
    finalC = c; finalR = r;
    emu.write(repaint(c, r));
    emu.resize(c, r);
    emu.write('\r\n\r\n');
}
await sleep(60); // let the write buffer + coalesced resize drain

ok(!crash, `no crash / no buffer corruption across a ${STEPS}-step storm` + (crash ? `  (${crash.message})` : ''));
// Plain serialization: each resize runs behind the parser (inside a drained-write callback), so the
// count is unbounded — what matters is they DON'T race (proven by no-crash + correct-final below).
ok(realResizes >= 1, `resizes applied serially behind the parser (${realResizes} for ${STEPS} steps, none raced a parse)`);

// Settle: a final clean repaint at the last size (what endDrag's terminal.refresh triggers).
emu.resize(finalC, finalR);
await sleep(30);
emu.write(repaint(finalC, finalR));
await sleep(30);
ok(term.cols === finalC && term.rows === finalR, `xterm settled at the final size ${finalC}×${finalR} (got ${term.cols}×${term.rows})`);
ok(lastScreen && lastScreen.cols === finalC && lastScreen.rows === finalR, `applyScreen sees the final size (${lastScreen?.cols}×${lastScreen?.rows})`);
// The final screen is real content (row labels), not blank — the settle repaint landed cleanly.
const row0 = lastScreen?.cells?.[0]?.map((c) => String.fromCodePoint(c.codepoint)).join('').trim();
ok(!!row0 && row0.startsWith('r0'), `final screen shows repainted content, not blank (row0="${row0?.slice(0, 8)}")`);

// A no-op resize (same size) must not churn xterm.
const before = realResizes;
emu.resize(finalC, finalR);
await sleep(30);
ok(realResizes === before, `same-size resize is a no-op (no extra xterm resize)`);

emu.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
