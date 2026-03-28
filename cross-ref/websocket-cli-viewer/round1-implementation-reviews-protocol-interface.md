# Round 1: implementation reviews protocol, interface

## Alignment

**Protocol and implementation agree on the relay's existing capabilities.** Both documents correctly identify that `ws-relay.mjs` lines 85-93 auto-register controllers on first message, that the first message falls through to command processing, and that `ping`/`whoami` are handled relay-side (lines 100-104). Protocol section 1.2 and implementation section 2.1 describe the same registration flow with matching specifics.

**All three agents agree no relay changes are needed.** Protocol section 1.7 ("What Works"), implementation section 7 ("No changes needed: ws-relay.mjs"), and interface section 9 all conclude the relay protocol is sufficient for grid CRUD.

**Protocol and implementation agree on the context bag gap.** Protocol section 1.8 item 9 identifies that `buildContext()` in `websocket/index.js` lacks grid mutation methods. Implementation section 3.1 identifies the same gap and notes that `getGrids()` returns a mutable array reference, so `ctx.getGrids().push(grid)` works without adding a dedicated `addGrid()` method. Protocol section 7 proposes explicit `addGrid()`/`removeGrid()` methods on the context bag -- this is a tension (see below).

**Protocol and implementation agree on the `\n` escape problem.** Protocol section 2.2 notes "The parser strips quotes and handles `\\` -> `\`, but it does NOT interpret `\n` as newline. The command handler must do that." Implementation section 6.7 reaches the same conclusion and proposes `.replace(/\\n/g, '\n')` in the handler.

**Interface and implementation agree the CLI should be thin.** Interface section 10 ("The CLI itself is thin by design. The intelligence lives in the CommandRouter and command handlers on the browser side. The CLI is a formatted pipe with readline.") matches implementation section 4 ("There is very little to share between CLI and browser... The CLI is a thin transport layer").

## Gaps

### What implementation covered that others missed

1. **Exact import paths.** Implementation section 3.6 (line 798) works out that `gridCommands.js` needs `import CodeGrid from '../../../../src/collections/CodeGrid.js'`. Neither protocol nor interface mention this. Getting this wrong means a runtime module resolution error in the browser.

2. **CodeGrid constructor scene-add subtlety.** Implementation section 3.2 documents that `GlyphCollection` constructor calls `this.scene.add(this.group)`, then `CodeGrid` reparents it via `this.add(this._collection.group)`. This means `ctx.scene.add(grid)` is required for the collection's group to be visible. Protocol's `grid.create` flow diagram (section 3.1) shows `scene.add(grid)` but does not explain WHY it is needed at the Object3D hierarchy level.

3. **`grid.setscale` command.** Implementation includes `grid.setscale` (section 3.6). Protocol mentions `grid.scale` (section 2.6). Interface does not include any scale command in its table (section 8).

4. **`ping` as registration trick.** Implementation section 2.1 discovers that sending `ping` as the first message cleanly separates registration from command execution -- the relay assigns controller role, sends the ack, then handles `ping` -> `pong` without forwarding to display. Neither protocol nor interface identify this technique.

### What protocol covered that implementation missed

1. **Batch command.** Protocol section 2.7 specifies a `batch` command leveraging the existing `CommandRouter.executeBatch()` method (confirmed at `CommandRouter.js` line 149). Implementation does not mention batching at all. This is significant because multi-step operations (create + position + color) would require three round-trips without it.

2. **Request ID correlation.** Protocol section 1.8 item 8 identifies the lack of explicit request IDs. If the CLI sends two commands rapidly, responses arrive in order but there is no explicit correlation. Implementation's `_pendingResolve` single-slot design (one pending response at a time) sidesteps this by serializing sends, but this is not explicitly documented as a design choice.

3. **Relay-level vs application-level error distinction.** Protocol section 4.3 distinguishes plain-string relay errors from JSON-wrapped application errors. Implementation's `CliConnection` handles both via try/catch on JSON parse (line 724-728), but does not document why both formats exist.

4. **Large content limits.** Protocol section 5.1 analyzes WebSocket payload limits (100 MiB default for `ws`, ~800KB for 10k-line file). Implementation does not discuss content size constraints.

### What interface covered that implementation missed

1. **Three operating modes.** Interface section 1.2 defines one-shot, REPL, and pipe modes with clear activation logic (TTY detection, `--pipe` flag, arguments present). Implementation has REPL and pipe-via-stdin but no explicit one-shot mode (`node cli.js grid.list` that sends a single command and exits).

2. **Exit codes.** Interface section 4.4 defines exit codes 0-3 for scripting integration. Implementation does not define exit codes beyond `process.exit(1)` for connection failure.

3. **Stderr/stdout separation.** Interface section 4.5 specifies that command responses go to stdout, connection messages to stderr. Implementation mixes both on stdout (`console.log(ack)` on line 609).

4. **Tab completion from `help` command.** Interface section 5.3 describes fetching the command list on connect and populating readline's completer. Implementation section 4 mentions this as a possibility but defers it.

5. **REPL meta-commands with dot prefix.** Interface section 5.4 defines `.exit`, `.json on/off`, `.connect`, `.status`, etc. Implementation uses bare `quit`/`exit` which could collide with future relay commands.

6. **Watch mode.** Interface section 6.4 proposes `grid.load 0 ./src/index.js --watch` using `fs.watch`. Neither protocol nor implementation mention file watching.

## Tensions

### 1. Command naming: `grid.create` vs `grid.new`

**Protocol** (section 2.1) uses `grid.create`. **Implementation** (section 3.2) uses `grid.create`. **Interface** (sections 3.1, 8) uses `grid.new`. This must be resolved before implementation. The existing codebase uses `grid.list`, `grid.info`, `grid.color`, `grid.visibility` -- all use full verbs. `create` is more consistent with REST/CRUD vocabulary. `new` is shorter but reads as an adjective. Recommendation: use `grid.create`.

Similarly: **protocol** uses `grid.settext`, **implementation** uses `grid.settext`, but **interface** uses `grid.text`. And **protocol** uses `grid.position`, **implementation** uses `grid.setposition`, **interface** uses `grid.move`. The `set` prefix is more explicit about mutation (vs query). Recommendation: use `grid.settext` and `grid.setposition` (matching implementation), since `grid.position` alone is ambiguous (getter or setter?).

### 2. Context bag mutation: explicit methods vs direct array mutation

**Protocol** section 7 proposes adding `addGrid(grid)` and `removeGrid(index)` to the context bag in `buildContext()`, encapsulating `viewer.grids.push()`, `scene.add()`, `grid.dispose()`, and `grids.splice()`.

**Implementation** section 3.2 uses `ctx.getGrids().push(grid)` and `ctx.scene.add(grid)` directly, bypassing any encapsulation.

The protocol approach is better. Direct mutation of `getGrids()` return value works because it returns by reference, but it couples command handlers to the internal array structure. If the viewer ever changes `grids` from an array to a Map or adds event listeners on grid add/remove, every handler breaks. Adding `ctx.addGrid(grid)` and `ctx.removeGrid(index)` to `buildContext()` in `websocket/index.js` (line 21-53) costs 10 lines and future-proofs all CRUD handlers.

### 3. CLI registration: `ping` trick vs `CONTROLLER` string

**Implementation** sends `ping` as the first message to separate registration from command execution. **Interface** section 9 recommends sending `CONTROLLER` as the first message for clarity. The current relay (`ws-relay.mjs` line 70) only special-cases `DISPLAY` -- any other string becomes both a registration trigger and a command. `CONTROLLER` would be forwarded to the display as a command, which the CommandRouter does not know how to handle, returning an error. The `ping` approach is correct because `ping` is handled relay-side (line 100) and never reaches the display. Interface's `CONTROLLER` suggestion would generate a spurious `ERR: unknown command 'CONTROLLER'` at the display.

### 4. Wire protocol trace in interface is wrong

Interface section 7.5 shows the CLI sending structured JSON `{"from":"cli-1","cmd":"grid.new \"Hello\""}` directly. But the actual relay protocol (confirmed in `ws-relay.mjs` lines 96-111) expects controllers to send **raw strings**, not JSON. The relay wraps raw strings into JSON envelopes before forwarding to the display. Controllers never send JSON -- they send flat command strings like `grid.create "Hello"`. The interface's wire trace is incorrect and would cause the relay to forward the literal JSON string as a command, which the CommandRouter would fail to parse.

### 5. `grid.create` argument order: text-first vs name-first

**Protocol** section 2.2: `grid.create <filename> "<content>"` -- filename first, then quoted content.
**Implementation** section 3.2: `grid.create <text> [name]` -- text first, name optional.
**Interface** section 3.1: `grid.new "<text>" [x y z]` -- text first, optional position.

Protocol's filename-first approach matches `CodeGrid.loadFileAsync(filename, content)` at the API level. But for CLI ergonomics, text-first is better because the filename is often unnecessary for quick demos. The implementation's approach is more practical: `grid.create "Hello"` works without a filename, `grid.create "Hello" myfile.js` adds one. However, protocol's approach enables the common pattern of `grid.create README.md "# Title\nContent"` which reads more naturally for file-like grids.

Recommendation: use protocol's order `grid.create <name> "<content>"` because it matches `loadFileAsync()` and avoids the ambiguity of "is the second argument a name or more text?"

### 6. `grid.settext` text joining

Implementation section 3.4, line 419: `const text = args.slice(1).join(' ')`. This joins remaining arguments with spaces, which silently corrupts text if the user forgets quotes. For example, `grid.settext 0 Hello World` would produce `"Hello World"` instead of two separate words. This is actually fine -- it is a reasonable fallback. But it conflicts with protocol section 2.4 which expects a single quoted argument `grid.settext <index> "<content>"`. The CommandRouter parser already handles quotes, so `grid.settext 0 "Hello World"` produces `args = ["0", "Hello World"]`. The `join(' ')` fallback handles the unquoted case gracefully. This is correct as-is.

## Recommendations

### Must change

1. **Resolve command names.** Use: `grid.create`, `grid.remove`, `grid.settext`, `grid.setposition`, `grid.setscale`. Update all three documents to match.

2. **Add `addGrid`/`removeGrid` to `buildContext()`.** In `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/websocket/index.js`, add to the return object at line 22-53:
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

3. **Use `ping` registration, not `CONTROLLER`.** Interface section 9's recommendation is broken with the current relay. The implementation's `ping` approach is the correct pattern.

4. **Fix interface wire trace.** Section 7.5 must show the CLI sending raw strings, not JSON envelopes. The relay adds the envelope.

5. **Add `\n` unescaping in `grid.create` and `grid.settext` handlers.** Both protocol and implementation identify this need. Add `.replace(/\\n/g, '\n').replace(/\\t/g, '\t')` in the handler before passing to `loadText()`.

### Should add

6. **Implement the `batch` command.** Protocol section 2.7's design is sound and `CommandRouter.executeBatch()` already exists (line 149). Register a `batch` command handler that parses a JSON array and calls `executeBatch()`. This eliminates multi-step round-trips.

7. **Add one-shot mode to the CLI.** Interface section 1.2's design: if `process.argv` has a command after the URL, send it, print the response, exit. This costs ~10 lines and enables `node cli.js grid.list` for scripting.

8. **Separate stdout/stderr.** Use `process.stderr.write` for connection messages, `console.log` (stdout) for command responses only.

9. **Use dot-prefixed REPL meta-commands.** Interface's `.exit`, `.json` pattern avoids collision with relay commands. Worth adopting from the start.

### Correct as-is, preserve

10. **Implementation's `CliConnection` design** -- single `_pendingResolve` slot with timeout. Simple, correct for serial command execution. No need for request ID correlation in v1.

11. **Implementation's handler code** for `grid.create`, `grid.remove`, `grid.settext`, `grid.setposition`, `grid.setscale` in `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/websocket/commands/gridCommands.js`. The validation patterns, error messages, and return shapes match the existing handlers (`grid.list`, `grid.info`, etc.) exactly.

12. **Protocol's error classification** (section 4.1). The `ERR:` prefix convention is consistent with existing code and sufficient for v1. No need for structured error codes yet.

13. **Protocol's batch semantics** -- no rollback, continue on failure, report partial success. This matches the non-transactional nature of Three.js scene mutations.

## Key Insight

The interface agent's wire protocol understanding is inverted -- it describes the CLI sending structured JSON envelopes (`{"from":"cli-1","cmd":"..."}`) when in fact controllers send raw strings and the relay adds the envelope (confirmed at `ws-relay.mjs` lines 96-111). This is not just a documentation error; if the CLI is built to interface's spec, every command will fail because the relay will forward the literal JSON string as a command name, and the CommandRouter will try to look up `{"from":"cli-1","cmd":"grid.new \"Hello\""}` as a command. The implementation agent's `CliConnection.send()` correctly calls `this.ws.send(cmd)` with raw strings (line 767), and protocol's section 1.3 correctly documents that controllers send flat string commands. This is the single most critical alignment point: the CLI must send raw command strings, not JSON, and any CLI design that wraps commands in JSON envelopes before sending will break silently against the existing relay.
