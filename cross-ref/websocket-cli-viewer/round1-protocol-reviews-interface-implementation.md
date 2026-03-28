# Round 1: protocol reviews interface, implementation

## Alignment

**All three agents agree on the core architecture**: the CLI is a thin transport that sends string commands over WebSocket, and all command intelligence lives in the browser-side CommandRouter. Interface states this explicitly in section 10 ("The CLI itself is thin by design. The intelligence lives in the CommandRouter and command handlers on the browser side.") and implementation echoes it in section 4 ("The CLI is a thin transport layer -- all intelligence lives in the browser-side CommandRouter."). My protocol analysis confirms this by documenting the wire format where controllers send flat strings and receive structured `{response, data}` JSON.

**Command naming**: Interface's hybrid approach (section 2.2, Option C) aligns with my protocol analysis of the existing dot-namespace convention. Implementation's command names (`grid.create`, `grid.remove`, `grid.settext`, `grid.setposition`, `grid.setscale`) match my proposed names exactly for `grid.create`, `grid.remove`, and `grid.settext`. The position/scale commands differ only in naming (`grid.position` vs `grid.setposition`).

**Registration protocol**: All three agents correctly identify the relay's first-message-as-registration behavior in `ws-relay.mjs` lines 85-93. Implementation's detailed walkthrough of the `ping`-as-first-message trick (section 2.1) is consistent with my protocol flow diagrams showing the registration ack preceding the command response.

**Context bag mutation**: Both my protocol analysis (section 7) and implementation's analysis (section 3.1) identify that `ctx.getGrids()` returns the viewer's mutable array by reference, making `grids.push(grid)` a valid mutation path. Implementation verified this against `GitHubRepoViewer.js` line 855-857.

**`\n` escape handling**: Both my protocol analysis (section 2.2, note about parser not interpreting `\n`) and implementation (section 6.7) identify that `CommandRouter.parse()` does NOT convert `\n` escape sequences to actual newlines. Both recommend handling this in the command handler with `.replace(/\\n/g, '\n')`.

## Gaps

### What protocol covered that others missed

1. **Request ID correlation**. My section 1.8 item 8 identifies that there are no explicit request IDs in the protocol. If a CLI sends two commands rapidly, responses are correlated only by order. Neither interface nor implementation addresses this. The `_pendingResolve` single-slot pattern in `CliConnection.mjs` inherently serializes requests, which works but is fragile -- if an unexpected message arrives (e.g., a relay event broadcast), it could resolve the wrong promise.

2. **Relay-level vs application-level error distinction**. My section 4.3 documents that relay errors arrive as plain strings (`"ERR: no display connected..."`) while application errors arrive as JSON `{"response": "ERR: ...", "data": null}`. Implementation's `CliConnection` handles both via try/catch on `JSON.parse`, but neither agent explicitly calls out this dual-format as a design concern that the CLI must handle.

3. **Batch command over the wire**. My protocol analysis proposes a `batch` wire command (section 2.7) that leverages the existing `CommandRouter.executeBatch()` method (confirmed at `CommandRouter.js` line 149). Neither interface nor implementation proposes exposing batch over the wire. Interface mentions compound shortcuts decomposed client-side (section 6.1), and implementation does not address batching at all.

4. **Display-to-controller response format asymmetry**. My section 1.4 documents that the relay strips the `to` field and sends different formats depending on whether `data` is present (JSON with data vs plain string without). This is confirmed at `ws-relay.mjs` lines 120-125. Neither other agent documents this behavior, which affects how `CliConnection` must parse responses.

### What interface covered that protocol missed

1. **Three operating modes** (one-shot, REPL, pipe). My protocol analysis focuses on wire format but does not discuss CLI invocation patterns. Interface's section 1.2 provides a complete taxonomy with detection logic (`stdin.isTTY`, `--repl`, `--pipe` flags).

2. **Exit codes**. Interface's section 4.4 defines exit codes 0-3 for scripting integration. My analysis does not address process exit semantics.

3. **Tab completion seeded from `help` response**. Interface section 5.3 describes fetching command metadata on connect for readline completion. Neither protocol nor implementation covers this in detail (implementation mentions it briefly in section 4).

4. **REPL meta-commands with dot prefix**. Interface section 5.4 defines `.help`, `.exit`, `.json on/off`, `.connect`, `.batch` as local-only commands. This avoids collision with relay commands like `status`. Implementation uses bare `quit`/`exit` which could theoretically collide with future relay commands.

5. **Watch mode** (`--watch` flag, section 6.4). A CLI-only feature using `fs.watch` to auto-reload file content into a grid. Neither protocol nor implementation considers this.

6. **Stderr/stdout separation** (section 4.5). Interface explicitly specifies that only command responses go to stdout, everything else to stderr. This enables clean piping. Implementation uses `console.log` for both connection messages and responses, mixing them on stdout.

### What implementation covered that protocol missed

1. **CodeGrid constructor subtlety**. Implementation section 3.2 documents that `GlyphCollection` constructor does `this.scene.add(this.group)` and then CodeGrid reparents it. This means `ctx.scene.add(grid)` is required for visibility. My protocol analysis's `buildContext` extension (section 7) includes `scene.add(grid)` in `addGrid()` but does not explain why.

2. **`grid.dispose()` cascade**. Implementation section 5.4 traces the full disposal chain: CodeGrid -> GlyphCollection -> GlyphRenderer -> GPU buffers, plus background plane disposal. My protocol analysis's `removeGrid()` calls `grid.dispose()` but does not verify the chain.

3. **`loadText()` vs `loadFileAsync()` choice**. Implementation section 5.1 identifies that synchronous `loadText()` is sufficient for CLI-created content, while `loadFileAsync()` uses workers. My protocol analysis section 2.2 recommends `loadFileAsync()` which is unnecessary overhead for small CLI-sent strings.

4. **Actual import paths**. Implementation section 6.4 traces the exact relative import path from `gridCommands.js` to `CodeGrid.js`: `../../../../src/collections/CodeGrid.js`. My protocol analysis does not address imports.

## Tensions

### 1. Command naming: `grid.create` vs `grid.new`

Interface uses `grid.new` throughout (sections 3.1, 6.1, 7.2, 8). Protocol and implementation both use `grid.create`. This is a real conflict that must be resolved before coding. The existing codebase uses verb-style names: `grid.list`, `grid.info`, `grid.color`, `grid.visibility`. Both `new` and `create` are verbs, but `create` is more consistent with CRUD terminology and avoids collision with JavaScript's `new` keyword in mental model. The existing `grid.color` and `grid.visibility` set properties, while `grid.new`/`grid.create` constructs an object -- `create` better signals that distinction.

**Verdict**: Use `grid.create`.

### 2. Command naming: `grid.position` vs `grid.setposition` vs `grid.move`

Protocol uses `grid.position` (section 2.5). Implementation uses `grid.setposition` (section 3.5). Interface uses `grid.move` (section 8). The existing commands use bare nouns for property setters: `grid.color` (not `grid.setcolor`), `grid.visibility` (not `grid.setvisibility`). For consistency with the existing pattern, `grid.position` is correct. But there is already `camera.move` in the existing command set, which is a different operation (camera movement is animated/physics-based, grid position is instant). Using `grid.position` as a setter mirrors `grid.color` as a setter.

**Verdict**: Use `grid.position` to match existing noun-as-setter pattern (`grid.color`, `grid.visibility`).

### 3. Command naming: `grid.settext` vs `grid.text`

Protocol uses `grid.settext` (section 2.4). Interface uses `grid.text` (section 3.2). Implementation uses `grid.settext` (section 3.4). Following the same noun-as-setter pattern: `grid.text` is more consistent. However, `grid.text` could be ambiguous (is it a getter or setter?). The existing `grid.info` is read-only, `grid.color` is write-only. There is no precedent for a command that could be either. Since `grid.info` already shows text metadata, `grid.text` as a setter is unambiguous in context.

**Verdict**: Use `grid.text` for consistency with `grid.color`.

### 4. Registration protocol: interface contradicts relay behavior

Interface section 9 proposes the CLI sends `CONTROLLER` as its first message, with the relay optionally logging it. But the actual relay (`ws-relay.mjs` line 70) checks if the first message is `"DISPLAY"` -- anything else triggers controller registration. Sending `CONTROLLER` would work (it is not `"DISPLAY"`), but it would also be forwarded as a command to the display, which would return an error like `"ERR: unknown command 'CONTROLLER'"`.

Implementation correctly identifies this problem and proposes `ping` as the first message (section 2.1, lines 143-192), since `ping` is handled at `ws-relay.mjs` line 100 without forwarding to the display. This is the correct approach.

Interface's wire protocol trace (section 7.5) shows `CLI -> Relay: CONTROLLER` followed by `Relay -> CLI: {"ok":true}` -- this is wrong. The relay sends `"OK: connected as ctrl-N"` as a plain string (line 90), not `{"ok":true}` JSON. The `{"ok":true}` response is only sent to the display role (line 79-83). Interface appears to have confused the display registration ack with the controller registration ack.

### 5. Context bag: `addGrid()`/`removeGrid()` vs direct array mutation

My protocol analysis (section 7) proposes adding `addGrid(grid)` and `removeGrid(index)` methods to the context bag in `buildContext()`. Implementation does NOT modify the context bag -- it calls `ctx.getGrids().push(grid)` and `ctx.scene.add(grid)` directly in the command handler (section 3.2, line 829-830). Both approaches work, but implementation's approach is simpler and avoids modifying `websocket/index.js`. The trade-off: with direct mutation, every grid-mutating handler must remember to both push to the array AND add to the scene. With context methods, that logic is centralized.

For a demo with 2-3 mutating commands, direct mutation is fine. If the command set grows, centralized methods prevent bugs.

### 6. `loadText()` vs `loadFileAsync()` for grid creation

My protocol analysis section 2.2 specifies `await grid.loadFileAsync(filename, content)` for the `grid.create` handler. Implementation section 3.2 uses synchronous `grid.loadText(text)`. The difference matters: `loadFileAsync` uses the worker pool for buffer building, while `loadText` runs on the main thread. For the Hello demo (5 glyphs), main-thread is fine. For a 10,000-line file sent via `grid.create`, blocking the main thread during buffer building could cause a visible frame drop.

Implementation's choice is correct for the demo scope. For production, the handler should use `loadFileAsync` with `await`, since `_handleMessage` is already `async`.

### 7. Interface proposes CLI sends JSON envelopes; relay expects raw strings

Interface section 7.5 shows `CLI -> Relay: {"from":"cli-1","cmd":"grid.new \"Hello\""}` -- the CLI sending a JSON envelope. But `ws-relay.mjs` lines 96-111 show the relay treats controller messages as raw string commands, wrapping them in `{from, cmd}` JSON before forwarding to the display. The relay does: `sendJSON(display, { from: clientId, cmd })` where `cmd = raw.trim()`. If the CLI sends a JSON string, the relay would wrap it again: `{"from":"ctrl-0","cmd":"{\"from\":\"cli-1\",\"cmd\":\"grid.new \\\"Hello\\\"\"}"}` -- double-wrapped and broken.

Implementation correctly sends raw strings (section 6.5, step 2: "WebSocket sends raw string `grid.create \"Hello\"`").

This is the most critical factual error in the interface analysis. The CLI must send raw command strings, not JSON envelopes. The relay handles the JSON wrapping.

## Recommendations

### Preserve as-is

1. **Relay server** (`ws-relay.mjs`): No changes needed. All three agents agree on this. The protocol is sufficient.
2. **CommandRouter parser** (`CommandRouter.js` lines 70-101): Handles quoted strings and backslash escaping correctly. All agents agree.
3. **WebSocketBridge._handleMessage** (`WebSocketBridge.js` lines 310-358): Correctly routes commands and returns structured responses.
4. **Implementation's `CliConnection.mjs`** with the `ping`-first registration pattern: Cleanly separates registration from command flow.

### Modify

1. **Command names**: Standardize on `grid.create`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale` (dropping `set` prefix for consistency with `grid.color`, `grid.visibility`).

2. **`grid.create` argument order**: Change from implementation's `<text> [name]` to protocol's `<name> <text>`. Rationale: the name/filename is short and predictable; the text content may be very long and should come last. This matches `grid.color <index> <r> <g> <b>` where the identifier comes first.

3. **Add `\n` unescaping** in `grid.create` and `grid.text` handlers:
   ```javascript
   const text = rawText.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
   ```

4. **CLI stdout/stderr separation**: Adopt interface's recommendation (section 4.5). Connection messages and errors go to `process.stderr`, command responses to `process.stdout`. Change implementation's `console.log(ack)` to `console.error(ack)` in `glyph-cli.mjs`.

5. **CLI exit codes**: Adopt interface's exit code scheme (section 4.4): 0 = success, 1 = command error, 2 = connection error, 3 = usage error.

6. **REPL local commands**: Use interface's dot-prefix convention (`.exit`, `.json`) rather than bare `quit`/`exit` to avoid future namespace collision.

### Add

1. **`batch` wire command**: Register a `batch` command in the browser-side CommandRouter that accepts a JSON array of command strings and calls `executeBatch()`. This is low cost (the method already exists at `CommandRouter.js` line 149) and eliminates multi-round-trip overhead for compound operations. Implementation in `gridCommands.js` or a new `batchCommand.js`:
   ```javascript
   router.register('batch', async (args, ctx) => {
       const commands = JSON.parse(args[0]);
       const results = await router.executeBatch(commands);
       const succeeded = results.filter(r => !r.text.startsWith('ERR:')).length;
       return {
           text: `OK: batch completed (${succeeded}/${results.length} succeeded)`,
           data: { results, succeeded, failed: results.length - succeeded }
       };
   }, { description: 'Execute multiple commands', usage: '<json-array>' });
   ```

2. **One-shot mode** in CLI: Implementation only has REPL and pipe modes. Add argument-based one-shot: `node glyph-cli.mjs grid.list` connects, sends, prints, exits. This is the most common scripting pattern.

### Remove / Defer

1. **Interface's `grid.load` CLI-local command** (section 6.2): Defer to phase 2. The Hello demo does not need local file reading.
2. **Interface's watch mode** (section 6.4): Defer. Useful but not demo-scope.
3. **Interface's aliasing** (section 6.5): Defer. REPL sugar, not core.
4. **Protocol's error envelope with `error.code`** (section 4.4): Defer. The `"ERR: "` prefix convention is sufficient.
5. **Protocol's `addGrid()`/`removeGrid()` context methods** (section 7): Defer. Direct array mutation works for the initial command set. Add centralized methods when a third mutating command appears.

## Key Insight

The most consequential finding in this cross-reference is the factual error in interface's wire protocol model. Interface assumes the CLI sends JSON envelopes (`{"from":"cli-1","cmd":"..."}`) and registers with a `CONTROLLER` string, but the relay (`ws-relay.mjs` lines 85-111) expects raw string commands from controllers and performs the JSON wrapping itself. Building the CLI against interface's model would produce double-wrapped messages that break command routing entirely. Implementation's model -- raw strings in, relay wraps, structured JSON out -- matches the actual relay code and must be the canonical reference. This also means the CLI is even thinner than interface envisions: it literally sends `readline` input as-is over the WebSocket (minus local flags), with zero serialization responsibility.
