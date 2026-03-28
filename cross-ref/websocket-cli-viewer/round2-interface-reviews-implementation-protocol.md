# Round 2: interface reviews implementation, protocol (inverse)

## Evolved Understanding

After reading all three Round 1 cross-references, several of my Phase 0 assumptions have been corrected or refined:

**Broken assumptions:**

1. **My wire protocol model was wrong.** My Phase 0 section 7.5 showed the CLI sending JSON envelopes `{"from":"cli-1","cmd":"..."}`. All three Round 1 reviews flag this as the single most critical error. The relay at `ws-relay.mjs` lines 96-111 expects controllers to send raw strings; it wraps them in JSON envelopes before forwarding to the display. If the CLI sent JSON, the relay would double-wrap it and the CommandRouter would try to parse a JSON blob as a command name. Implementation's `CliConnection.send()` correctly does `this.ws.send(cmd)` with a bare string.

2. **My `CONTROLLER` registration was wrong.** My Phase 0 section 9 proposed sending `CONTROLLER` as the first message. Implementation identified that the relay only special-cases `DISPLAY` (line 70); everything else triggers controller registration AND falls through to command processing. Sending `CONTROLLER` would generate a spurious `ERR: unknown command 'CONTROLLER'` from the display. Implementation's `ping` trick is correct -- `ping` is handled relay-side at line 100 without forwarding to the display.

3. **My registration ack format was wrong.** My Phase 0 showed `{"ok":true}` as the relay's response to controller registration. The actual ack is a plain string `"OK: connected as ctrl-N"` (line 90). I confused the display ack (`{"ok":true,"role":"display",...}`) with the controller ack.

4. **`grid.new` naming was the outlier.** Both protocol and implementation independently chose `grid.create`. My `grid.new` breaks consistency with the existing command vocabulary. Resolved: use `grid.create`.

**Confirmed assumptions:**

1. The CLI is a thin formatted pipe. All three agents converged on this independently.
2. The relay needs no modifications. Universal agreement.
3. The `{response, data}` dual-format return from the browser is the canonical response shape.
4. Stderr/stdout separation matters for piping -- protocol's Round 1 adopted my recommendation, implementation's Round 1 acknowledged the gap.

**New insight from Round 1:**

Interface's own Round 1 analysis (my prior work) discovered a `\n` escape bug that neither protocol nor implementation had correctly identified. The `CommandRouter.parse()` at line 77-80 consumes backslashes and appends the next character literally: `\n` in input becomes the single character `n`, not the two-character sequence `\n`. This means the `.replace(/\\n/g, '\n')` fix proposed by both protocol and implementation would NOT work in the handler -- the backslash is already consumed by the parser. The fix must be either in the parser itself (adding escape sequence interpretation at line 77-80) or as CLI-side preprocessing before sending over the wire.

## Convergence

These items are now settled across all three agents after two rounds of review:

1. **Raw strings on the wire.** Controllers send flat command strings. The relay wraps them in `{from, cmd}` JSON for the display. The CLI never sends JSON envelopes.

2. **`ping` for registration.** Send `ping` as the first message. Relay assigns controller role, sends `OK: connected as ctrl-N`, then handles `ping` -> `pong` without forwarding to display. CLI discards the `pong`.

3. **Command names.** `grid.create`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale`. (See Remaining Tensions below for the `set` prefix question.)

4. **No relay changes.** `ws-relay.mjs` is sufficient as-is.

5. **Context bag needs grid mutation.** Whether via explicit `addGrid()`/`removeGrid()` methods or direct `getGrids().push()` + `scene.add()`, the command handlers need write access to the grid array and scene. All agents agree on the operations; the encapsulation level is a minor tension.

6. **`CliConnection` architecture.** Implementation's single-`_pendingResolve` slot with timeout is correct for serial command execution. No request ID correlation needed in v1.

7. **CLI outputs.** stdout for command responses only, stderr for connection banners/prompts/errors. Exit codes: 0 success, 1 command error, 2 connection error, 3 usage error.

8. **Three operating modes.** One-shot (args on command line), REPL (interactive TTY), pipe (stdin not a TTY). One-shot was missing from implementation's Phase 0 but acknowledged as needed in all Round 1 reviews.

9. **REPL meta-commands use dot prefix.** `.exit`, `.json on/off`, `.help` -- avoids collision with relay commands. Adopted from my Phase 0 by both other agents.

10. **`batch` wire command.** Leverages existing `CommandRouter.executeBatch()` (line 149). Register it as a browser-side command. Non-transactional (continue on failure, report partial success). Eliminates multi-round-trip overhead for compound operations like create + position + color.

## Remaining Tensions

### 1. Command naming: `set` prefix or not

Protocol's Round 1 verdict: drop `set` prefix. Use `grid.text`, `grid.position`, `grid.scale` to match existing `grid.color`, `grid.visibility` pattern.

Implementation's Round 1 verdict: use `grid.settext`, `grid.setposition`, `grid.setscale` for explicitness about mutation.

My Round 1 adopted `grid.settext` and `grid.setposition`, agreeing with implementation.

The existing commands ARE inconsistent themselves: `grid.color` and `grid.visibility` are setters despite having no `set` prefix. Adding `set` to new commands creates a split convention. But dropping `set` makes `grid.text` ambiguous (is it a getter that returns the text content, or a setter?).

**Resolution proposal:** Follow protocol's verdict. Drop `set` prefix. The existing `grid.color <index> <r> <g> <b>` is clearly a setter because it takes value arguments. `grid.text <index> <content>` follows the same pattern. If a getter is ever needed, it can use `grid.info` (which already exists and shows metadata). Consistency with the existing 4 commands outweighs explicitness for the 3 new ones.

### 2. `grid.create` argument order: text-first vs name-first

Protocol: `grid.create <filename> "<content>"` -- name required, content required.
Implementation: `grid.create <text> [name]` -- text required, name optional.
Interface: `grid.create "<text>"` -- text only, no name argument.

For the Hello demo, `grid.create "Hello"` is the simplest possible invocation. Requiring a filename adds friction for throwaway grids. But protocol makes a valid point that `loadFileAsync(filename, content)` takes filename first at the API level.

**Resolution proposal:** Use implementation's order: `grid.create <text> [name]`. Text is the essential argument. Name defaults to auto-generated `cli-grid-<timestamp>`. This optimizes for the most common case (quick creation) while allowing naming when needed. The API-level argument order of `loadFileAsync` is an internal detail the user never sees.

### 3. `\n` escape handling: parser fix vs CLI preprocessing

Three options identified across all analyses:

**A. Fix the parser** (`CommandRouter.parse()` line 77-80): Add escape sequence interpretation so `\n` becomes a real newline during parsing. This is the cleanest fix but changes parser behavior for ALL commands, including existing ones.

**B. CLI preprocessing**: The CLI replaces `\n` with actual newline characters before sending over the wire. The WebSocket message contains real newlines, so the parser never sees escape sequences. But this means `websocat` users must send real newlines (harder to type).

**C. Handler-level fix**: Have `grid.create` and `grid.text` handlers interpret escape sequences in their text argument. But as my Round 1 identified, this does NOT work because the parser already consumed the backslash -- the handler receives `n`, not `\n`.

**Resolution proposal:** Option A. Fix the parser. Add `\n` -> newline, `\t` -> tab interpretation at line 77-80. This is a 4-line change, benefits all current and future commands, and matches what users expect from a shell-like parser. The risk of breaking existing commands is minimal -- existing commands do not use backslash-escaped arguments.

### 4. Context bag encapsulation: helper methods vs direct mutation

Protocol proposes `ctx.addGrid(grid)` and `ctx.removeGrid(index)` in `buildContext()`.
Implementation uses `ctx.getGrids().push(grid)` and `ctx.scene.add(grid)` directly.

For 2-3 CRUD commands, direct mutation works. But `addGrid` is 3 lines that encapsulate two operations (push + scene.add) that must always happen together. The cost is trivial and prevents the bug where a handler does one but not the other.

**Resolution proposal:** Add the helper methods. They cost 10 lines in `websocket/index.js` and every handler becomes shorter and more correct by construction.

### 5. `loadText()` vs `loadFileAsync()` for grid creation

Implementation uses sync `loadText()`. Protocol recommends async `loadFileAsync()`.

For "Hello" (5 glyphs), `loadText()` is fine. For a 10k-line file piped via CLI, `loadText()` blocks the main thread during buffer building. Since `_handleMessage` is already async and the handler can return a Promise, using `loadFileAsync()` is free and prevents frame drops for large content.

**Resolution proposal:** Use `loadFileAsync()` for `grid.create` since it handles both small and large content gracefully. Use `loadText()` only if `loadFileAsync()` is not available (e.g., no worker pool).

## Synthesis

Here is the concrete, buildable plan for a CLI that sends "Hello" to the viewer:

### Files to create (2 files)

1. **`examples/github-viewer/cli/CliConnection.mjs`** -- WebSocket client class. Implementation's code from Phase 0 section 6.3 is near-production. Key behaviors:
   - `connect()`: opens WebSocket, sends `ping`, waits for `OK: connected as ctrl-N`, discards `pong`
   - `send(cmd, timeout)`: sends raw string, returns `Promise<{text, data}>` via single `_pendingResolve` slot
   - `close()`: closes WebSocket

2. **`examples/github-viewer/cli/glyph-cli.mjs`** -- Entry point. Three modes:
   - **One-shot**: `process.argv[2+]` contains a command (skip URL arg if it starts with `ws://`). Connect, send, print response to stdout, exit with code 0/1/2.
   - **REPL**: `stdin.isTTY` is true, no command in argv. `readline/promises` with `glyph> ` prompt. Dot-prefixed meta-commands: `.exit`, `.json on/off`, `.help`.
   - **Pipe**: `stdin.isTTY` is false. Read all stdin, split on newlines, execute sequentially, exit.
   - Connection banners to stderr. Command responses to stdout.

### Files to modify (2 files)

3. **`examples/github-viewer/websocket/commands/gridCommands.js`** -- Add 5 commands:
   - `grid.create <text> [name]` -- Creates CodeGrid, calls `loadFileAsync()`, pushes to grids, adds to scene. Returns `{index, name, glyphs, lines}`.
   - `grid.remove <index>` -- Calls `dispose()`, removes from scene, splices from array.
   - `grid.text <index> <content>` -- Calls `loadText()` on existing grid.
   - `grid.position <index> <x> <y> <z>` -- Sets `grid.position.set(x, y, z)`.
   - `grid.scale <index> <factor>` -- Sets `grid.scale.setScalar(factor)`.
   - Import: `import CodeGrid from '../../../../src/collections/CodeGrid.js'` at top.

4. **`examples/github-viewer/websocket/index.js`** -- Add to `buildContext()`:
   ```javascript
   addGrid(grid) {
       viewer.grids.push(grid);
       viewer.scene.add(grid);
   },
   removeGrid(index) {
       const grid = viewer.grids[index];
       if (!grid) return null;
       grid.dispose();
       viewer.scene.remove(grid);
       viewer.grids.splice(index, 1);
       return grid;
   },
   ```

### Optional file to modify (1 file)

5. **`examples/github-viewer/websocket/CommandRouter.js`** line 77-80 -- Fix escape sequences in parser:
   ```javascript
   if (escaped) {
       if (ch === 'n') current += '\n';
       else if (ch === 't') current += '\t';
       else if (ch === 'r') current += '\r';
       else current += ch;
       escaped = false;
       continue;
   }
   ```
   This enables multi-line grid creation: `grid.create "Hello\nWorld"`.

### Optional: `batch` command (1 registration)

6. Register `batch` command in a new file or in `gridCommands.js`:
   ```javascript
   router.register('batch', async (args, ctx) => {
       const commands = JSON.parse(args.join(' '));
       const results = await router.executeBatch(commands);
       const succeeded = results.filter(r => !r.text.startsWith('ERR:')).length;
       return {
           text: `OK: batch completed (${succeeded}/${results.length} succeeded)`,
           data: { results, succeeded, failed: results.length - succeeded }
       };
   }, { description: 'Execute multiple commands in one round-trip', usage: '<json-array>' });
   ```

### Hello demo session (exact commands)

```bash
# Terminal 1: HTTP server
npm run serve

# Terminal 2: WebSocket relay
npm run ws

# Terminal 3: Open browser to http://localhost:8000/examples/github-viewer/
# Enable WebSocket in viewer settings

# Terminal 4: CLI one-shot
node examples/github-viewer/cli/glyph-cli.mjs 'grid.create "Hello"'
# stdout: OK: created grid #0 "cli-grid-1711561234567" (5 glyphs)

# Terminal 4: CLI REPL
node examples/github-viewer/cli/glyph-cli.mjs
# stderr: Connecting to ws://localhost:8765...
# stderr: OK: connected as ctrl-0
glyph> grid.create "Hello, World!"
OK: created grid #0 "cli-grid-1711561234567" (13 glyphs)
glyph> grid.position 0 0 10 0
OK: grid #0 position = (0, 10, 0)
glyph> grid.color 0 0 1 0.5
OK: grid #0 color set to (0, 1, 0.5)
glyph> camera.fitall
OK: fitting all grids in view
glyph> .exit
```

### Wire trace for `grid.create "Hello"`

```
CLI  -> Relay:  ping                                    (raw string)
Relay -> CLI:   OK: connected as ctrl-0                 (raw string)
Relay -> CLI:   pong                                    (raw string, discarded)

CLI  -> Relay:  grid.create "Hello"                     (raw string)
Relay -> Display: {"from":"ctrl-0","cmd":"grid.create \"Hello\""}  (JSON envelope)
Display -> Relay: {"to":"ctrl-0","response":"OK: created grid #0 ...","data":{"index":0,...}}
Relay -> CLI:   {"response":"OK: created grid #0 ...","data":{"index":0,...}}  (JSON, has data)
```

## Dissent

### I still believe the CLI should have a short alias

Both protocol and implementation treat the CLI as `node examples/github-viewer/cli/glyph-cli.mjs` -- a 50-character invocation. My Phase 0 proposed `g3d` or `glyph-ctl` as short aliases via `package.json` `bin` field. Neither agent adopted this. For a tool meant to be typed repeatedly in a terminal, invocation ergonomics matter. At minimum, the `package.json` should have:

```json
"scripts": {
    "cli": "node examples/github-viewer/cli/glyph-cli.mjs"
}
```

so `npm run cli -- grid.create "Hello"` works. Implementation actually proposed this in Phase 0 section 1 but it was not carried forward into the Round 1 recommendations. This should be included.

### Tab completion should not be deferred

Implementation defers tab completion to "phase 2". Protocol does not mention it. My Phase 0 section 5.3 proposes fetching the command list from `help` on connect and populating readline's completer. This is 10 lines of code (implementation's own Phase 0 section 4 shows the exact snippet) and dramatically improves REPL discoverability. For a CLI whose entire value proposition is controlling a remote viewer, not knowing what commands are available is a non-starter. The `help` command already returns structured data with command names. The completer just filters that list. This should ship in v1, not v2.

### The `grid.create` argument-order debate is overweighted

Three agents spent significant analysis on whether text or name comes first. For the Hello demo, it does not matter -- `grid.create "Hello"` works regardless because there is only one argument. The debate only matters when both arguments are provided, and even then the CommandRouter parser handles quoted strings unambiguously. The real question is whether name should be required or optional. All agents now agree it should be optional. The ordering of `<text> [name]` vs `<name> <text>` is a bikeshed compared to the `\n` parser bug, which actually blocks multi-line content and affects every text-bearing command.
