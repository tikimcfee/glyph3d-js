#!/usr/bin/env bun
// seed-history.mjs — pull each live terminal's tmux scrollback and push it into the
// 3D terminal's depth-history ring, so the session's mega-history shows receding in
// space. Drives the running browser via the command bus (terminal.depth.seed), so it
// works on whatever display is connected to the relay.
//
//   bun tools/seed-history.mjs [lines=300] [id ...]
//
// With no ids, seeds every terminal `terminal.list` reports. The depth ring is
// in-memory (lost on reload); tmux is the durable source — so just RE-RUN this after
// a hard-reload to restore the history. Only the most-recent _depthMax lines render
// (default 80), but a generous capture keeps the freshest band full.
//
// Terminals live on the `glyphd` tmux socket as sessions `glyph-<id>` (CLAUDE.md).
// The relay is on :8080 by default — CLI global flags go BEFORE the subcommand.

import { $ } from 'bun';

const argv = process.argv.slice(2);
const lines = (argv[0] && /^\d+$/.test(argv[0])) ? Number(argv.shift()) : 300;
const SOCKET = 'glyphd';

async function terminalIds() {
    if (argv.length) return argv;
    const out = await $`./glyph3d-cli terminal.list`.text();
    // rows look like:  "  term-2: 143x33 at (...)"
    return [...out.matchAll(/^\s*([\w-]+):\s+\d+x\d+/gm)].map((m) => m[1]);
}

const ids = await terminalIds();
if (!ids.length) { console.log('seed-history: no terminals to seed'); process.exit(0); }

for (const id of ids) {
    const session = `glyph-${id}`;
    let text;
    try {
        // -S -<lines>  : start that many rows into scrollback
        // -E -1        : end one row ABOVE the visible screen (pure scrollback, no
        //               duplication of the live grid)
        text = await $`tmux -L ${SOCKET} capture-pane -p -t ${session} -S ${-lines} -E -1`.text();
    } catch (e) {
        console.log(`  ✗ ${id}: capture-pane failed (no session '${session}'?)`);
        continue;
    }
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    try {
        const res = await $`./glyph3d-cli terminal.depth.seed ${id} ${b64}`.text();
        console.log(`  ${id}: ${res.trim().split('\n').pop()}`);
    } catch (e) {
        console.log(`  ✗ ${id}: seed command failed — is the relay up + a display connected?`);
    }
}
