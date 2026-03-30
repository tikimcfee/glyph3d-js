#!/usr/bin/env node
/**
 * agent-hook.mjs — CLI hook for pushing agent output to the 3D viewer.
 *
 * Usage:
 *   # One-shot text update
 *   node agent-hook.mjs --agent "protocol" --text "Phase 0 complete"
 *
 *   # Pipe stdin as content
 *   echo "analysis results here" | node agent-hook.mjs --agent "protocol"
 *
 *   # Set color alongside text
 *   node agent-hook.mjs --agent "protocol" --text "DONE" --color "0.3,1.0,0.5"
 *
 *   # Read from file
 *   node agent-hook.mjs --agent "transport" --file ./analysis.md
 *
 *   # Close a window
 *   node agent-hook.mjs --agent "protocol" --close
 *
 *   # Close all agent windows
 *   node agent-hook.mjs --close-all
 *
 * Flags:
 *   --agent <label>    Agent identifier (required unless --close-all)
 *   --text <string>    Text content to display
 *   --file <path>      Read content from file
 *   --color <r,g,b>    Set text color (0-1 floats, comma-separated)
 *   --position <x,y,z> Set grid position
 *   --append           Append to existing content instead of replacing
 *   --close            Close this agent's window
 *   --close-all        Close all agent windows
 *   --host <url>       WebSocket relay URL (default ws://localhost:8765)
 *   --port <n>         Shorthand for ws://localhost:<n>
 *   --max-lines <n>    Max lines to retain when appending (default 80)
 *
 * Environment:
 *   GLYPH_WS_URL       Default WebSocket URL (overridden by --host/--port)
 */

import { readFileSync } from 'fs';
import { stdin } from 'process';
import AgentWindowManager from './AgentWindowManager.mjs';

// ---- Parse arguments ----
const argv = process.argv.slice(2);
const opts = {
    agent: null,
    text: null,
    file: null,
    color: null,
    position: null,
    append: false,
    close: false,
    closeAll: false,
    host: process.env.GLYPH_WS_URL || 'ws://localhost:8765',
    maxLines: 80,
};

for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
        case '--agent': opts.agent = argv[++i]; break;
        case '--text': opts.text = argv[++i]; break;
        case '--file': opts.file = argv[++i]; break;
        case '--color': opts.color = argv[++i]; break;
        case '--position': opts.position = argv[++i]; break;
        case '--append': opts.append = true; break;
        case '--close': opts.close = true; break;
        case '--close-all': opts.closeAll = true; break;
        case '--host': opts.host = argv[++i]; break;
        case '--port': opts.host = `ws://localhost:${argv[++i]}`; break;
        case '--max-lines': opts.maxLines = parseInt(argv[++i]); break;
        case '--help':
            console.log(`agent-hook.mjs — push agent output to 3D viewer

  --agent <label>      Agent identifier (required)
  --text <string>      Text content to display
  --file <path>        Read content from file
  --color <r,g,b>      Set text color (0-1 floats)
  --position <x,y,z>   Set grid position
  --append             Append instead of replace
  --close              Close this agent's window
  --close-all          Close all agent windows
  --host <url>         WebSocket URL (default ws://localhost:8765)
  --port <n>           Shorthand for ws://localhost:<n>
  --max-lines <n>      Max lines when appending (default 80)`);
            process.exit(0);
        // no default — ignore unknown flags
    }
}

// ---- Validate ----
if (!opts.closeAll && !opts.agent) {
    console.error('Error: --agent <label> is required (or use --close-all)');
    process.exit(1);
}

// ---- Read content from sources ----
async function getContent() {
    // Explicit --text flag
    if (opts.text) return opts.text;

    // File
    if (opts.file) {
        try {
            return readFileSync(opts.file, 'utf-8');
        } catch (err) {
            console.error(`Error reading file: ${err.message}`);
            process.exit(1);
        }
    }

    // Stdin (only if piped, not TTY)
    if (!stdin.isTTY) {
        return new Promise((resolve) => {
            let data = '';
            stdin.on('data', (chunk) => { data += chunk; });
            stdin.on('end', () => resolve(data));
        });
    }

    return null;
}

// ---- Main ----
async function main() {
    const mgr = new AgentWindowManager(opts.host);

    try {
        process.stderr.write(`Connecting to ${opts.host}...\n`);
        await mgr.connect();
        process.stderr.write('Connected.\n');
    } catch (err) {
        console.error(`Failed to connect: ${err.message}`);
        console.error('Ensure relay is running (npm run ws) and viewer is open.');
        process.exit(2);
    }

    try {
        // Close all windows
        if (opts.closeAll) {
            await mgr.closeAll();
            process.stderr.write('All agent windows closed.\n');
            await mgr.disconnect({ cleanup: false });
            process.exit(0);
        }

        // Get or create the window (finds existing grids from prior invocations)
        const win = await mgr.ensureWindow(opts.agent);

        // Close single window
        if (opts.close) {
            await win.close();
            process.stderr.write(`Window "${opts.agent}" closed.\n`);
            await mgr.disconnect({ cleanup: false });
            process.exit(0);
        }

        // Get content
        const content = await getContent();
        if (content !== null) {
            if (opts.append) {
                await win.append(content, { maxLines: opts.maxLines });
            } else {
                await win.write(content);
            }
            process.stderr.write(`Content sent to "${opts.agent}" (${content.length} chars).\n`);
        }

        // Set color
        if (opts.color) {
            const [r, g, b] = opts.color.split(',').map(Number);
            await win.setColor(r, g, b);
        }

        // Set position
        if (opts.position) {
            const [x, y, z] = opts.position.split(',').map(Number);
            await win.setPosition(x, y, z);
        }

        // Disconnect without cleanup (leave grids in the viewer)
        await mgr.disconnect({ cleanup: false });
        process.exit(0);

    } catch (err) {
        console.error(`Error: ${err.message}`);
        await mgr.disconnect({ cleanup: false });
        process.exit(1);
    }
}

main();
