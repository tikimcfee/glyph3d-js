#!/usr/bin/env node
/**
 * glyph-cli -- WebSocket CLI controller for glyph3d-js viewer.
 *
 * Modes:
 *   One-shot:  node glyph-cli.mjs [--host url] <command...>
 *   REPL:      node glyph-cli.mjs [--host url]
 *   Pipe:      echo "grid.list" | node glyph-cli.mjs
 *
 * Flags:
 *   --host <url>   WebSocket URL (default ws://localhost:8765)
 *   --port <n>     Shorthand for ws://localhost:<n>
 *   --json         Output JSON data instead of TUI text
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import CliConnection from './CliConnection.mjs';

// ---- Parse CLI flags ----
const argv = process.argv.slice(2);
let url = 'ws://localhost:8765';
let jsonMode = false;
const commandArgs = [];

for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) { url = argv[++i]; continue; }
    if (argv[i] === '--port' && argv[i + 1]) { url = `ws://localhost:${argv[++i]}`; continue; }
    if (argv[i] === '--json') { jsonMode = true; continue; }
    if (argv[i] === '--help') {
        console.log(`glyph-cli -- WebSocket CLI for glyph3d-js viewer

Usage:
  node glyph-cli.mjs [flags] [command...]

Flags:
  --host <url>   WebSocket URL (default ws://localhost:8765)
  --port <n>     Shorthand for ws://localhost:<n>
  --json         Output JSON data instead of TUI text

Modes:
  With command args:   one-shot (send, print, exit)
  No args + TTY:       interactive REPL
  Piped stdin:         pipe mode (one command per line)

Examples:
  node glyph-cli.mjs grid.create "Hello"
  node glyph-cli.mjs --json grid.list
  echo 'status' | node glyph-cli.mjs`);
        process.exit(0);
    }
    commandArgs.push(argv[i]);
}

// ---- Connect ----
const conn = new CliConnection(url);

process.stderr.write(`Connecting to ${url}...\n`);
try {
    const ack = await conn.connect();
    process.stderr.write(`${ack}\n`);
} catch (err) {
    process.stderr.write(`Failed: ${err.message}\n`);
    process.stderr.write('Ensure relay is running (npm run ws) and viewer is open.\n');
    process.exit(2);
}

/**
 * Encode text content to base64 for commands that take content args.
 * grid.create <text> [name] → grid.create <b64> [name]
 * grid.text <index> <text>  → grid.text <index> <b64>
 */
function encodeContentArgs(cmd) {
    const match = cmd.match(/^(grid\.create)\s+(.+)$/);
    if (match) {
        // Split: first arg is text (possibly quoted), rest is optional name
        const rest = match[2];
        let text, name;
        if (rest.startsWith('"')) {
            const endQuote = rest.indexOf('"', 1);
            if (endQuote > 0) {
                text = rest.slice(1, endQuote);
                name = rest.slice(endQuote + 1).trim() || null;
            } else {
                text = rest.slice(1);
                name = null;
            }
        } else {
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx > 0) {
                text = rest.slice(0, spaceIdx);
                name = rest.slice(spaceIdx + 1).trim();
            } else {
                text = rest;
                name = null;
            }
        }
        const b64 = Buffer.from(text).toString('base64');
        return name ? `grid.create ${b64} ${name}` : `grid.create ${b64}`;
    }

    const matchText = cmd.match(/^(grid\.text)\s+(\d+)\s+(.+)$/);
    if (matchText) {
        const idx = matchText[2];
        let text = matchText[3];
        if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
        const b64 = Buffer.from(text).toString('base64');
        return `grid.text ${idx} ${b64}`;
    }

    return cmd;
}

/**
 * Send a command and print the result.
 * @returns {boolean} true if command succeeded
 */
async function execAndPrint(cmd) {
    cmd = encodeContentArgs(cmd);
    try {
        const result = await conn.send(cmd);
        if (jsonMode && result.data !== null) {
            stdout.write(JSON.stringify(result.data, null, 2) + '\n');
        } else {
            stdout.write(result.text + '\n');
        }
        return !result.text.startsWith('ERR:');
    } catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        return false;
    }
}

// ---- One-shot mode ----
if (commandArgs.length > 0) {
    // Re-quote args with spaces (shell strips quotes before we see them)
    const cmd = commandArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
    const ok = await execAndPrint(cmd);
    conn.close();
    process.exit(ok ? 0 : 1);
}

// ---- Pipe mode ----
if (!stdin.isTTY) {
    let input = '';
    stdin.on('data', (chunk) => { input += chunk; });
    stdin.on('end', async () => {
        let allOk = true;
        for (const line of input.split('\n')) {
            const cmd = line.trim();
            if (!cmd || cmd.startsWith('#')) continue;
            const ok = await execAndPrint(cmd);
            if (!ok) allOk = false;
        }
        conn.close();
        process.exit(allOk ? 0 : 1);
    });
} else {
    // ---- REPL mode ----
    process.stderr.write('Type commands (help for list, .exit to quit)\n\n');
    const rl = createInterface({ input: stdin, output: stdout, prompt: 'glyph> ' });
    rl.prompt();

    rl.on('line', async (line) => {
        const cmd = line.trim();
        if (!cmd) { rl.prompt(); return; }

        // REPL meta-commands (dot-prefixed)
        if (cmd === '.exit' || cmd === '.quit') {
            conn.close();
            rl.close();
            return;
        }
        if (cmd === '.json on') { jsonMode = true; process.stderr.write('Output: JSON\n'); rl.prompt(); return; }
        if (cmd === '.json off') { jsonMode = false; process.stderr.write('Output: text\n'); rl.prompt(); return; }
        if (cmd === '.help') {
            process.stderr.write(`REPL commands:
  .exit / .quit    Exit
  .json on/off     Toggle JSON output
  .help            This help
All other input is sent to the viewer.\n`);
            rl.prompt();
            return;
        }

        await execAndPrint(cmd);
        rl.prompt();
    });

    rl.on('close', () => { conn.close(); process.exit(0); });
}
