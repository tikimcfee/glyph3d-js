# Round 2: implementation reviews interface, protocol (inverse)

## Evolved Understanding

After two rounds of cross-referencing, my understanding has shifted in three areas:

**1. The `\n` escape problem is worse than I described.** In my Phase 0 (section 6.7), I wrote that `CommandRouter.parse()` "does NOT handle `\n` escape sequences" and proposed a simple `.replace(/\\n/g, '\n')` in the handler. Interface's Round 1 review (section "Tensions", item on `\n` handling) correctly identified that this fix is wrong. The parser at `CommandRouter.js` lines 77-84 consumes the backslash (`escaped = true`, then `current += ch` appends the literal next character). So input `"Hello\nWorld"` becomes `HellonWorld` -- the backslash is eaten, only `n` remains. My proposed `replace(/\\n/g, '\n')` would never match because there is no literal `\n` two-character sequence left in the string. The correct fix is either (a) modify `CommandRouter.parse()` to interpret `\n`/`\t` escape sequences in the `if (escaped)` branch, or (b) have the CLI pre-process `\n` into actual newline characters before sending over the wire. I now favor option (a) because it fixes the problem for all clients (CLI, websocat, future GUIs), not just our CLI.

**2. Command naming is settled.** Protocol's Round 1 review proposed `grid.create`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale` (dropping the `set` prefix to match existing `grid.color`, `grid.visibility`). Interface's Round 1 review agreed to adopt `grid.create` over `grid.new`, and accepted `grid.settext`/`grid.setposition`. There is still a minor split: protocol says `grid.text` and `grid.position` (noun-as-setter pattern matching `grid.color`), while interface says `grid.settext` and `grid.setposition`. I now agree with protocol's position -- the `set` prefix is inconsistent with the existing command set where `grid.color` is already a setter without a `set` prefix. Final names: `grid.create`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale`.

**3. `grid.create` argument order is resolved.** My Phase 0 used `<text> [name]` (text first, name optional). Protocol used `<name> <text>` (name required, text second). Interface used `<text> [x y z]` (no name at all). In Round 1, I argued for text-first because it enables `grid.create "Hello"` without a name. Protocol argued name-first matches `loadFileAsync(filename, content)`. Interface accepted implementation's text-first. After reflection, I maintain text-first is correct for the CLI use case. The most common invocation is quick content creation where a name is irrelevant. The `loadFileAsync` API signature is an internal detail that should not leak into the user-facing command syntax.

## Convergence

All three agents now agree on these points after two rounds:

**1. No relay changes.** `ws-relay.mjs` handles controller registration, command forwarding, and response routing correctly. No modifications needed. (Protocol section 1.7, interface section 9, implementation section 7.)

**2. CLI sends raw strings, relay wraps in JSON.** Controllers send flat command strings like `grid.create "Hello"`. The relay at `ws-relay.mjs` lines 96-111 wraps them as `{"from":"ctrl-0","cmd":"grid.create \"Hello\""}` before forwarding to the display. The CLI never sends JSON envelopes. Interface acknowledged this correction in Round 1 after protocol and implementation both identified the error in interface's Phase 0 section 7.5.

**3. `ping` as first message for clean registration.** The relay's first-message-falls-through behavior (line 85-98) means any string triggers both registration and command processing. Sending `ping` exploits the relay-level handler at line 100 (`ws.send('pong'); return;`) to get a clean registration without a spurious command forwarded to the display. Interface accepted this in Round 1, abandoning the `CONTROLLER` proposal.

**4. Thin CLI, smart browser.** All command intelligence lives in `CommandRouter` and its registered handlers. The CLI is a formatted pipe: readline input -> WebSocket send -> receive response -> print. No command parsing, no validation, no state beyond the WebSocket connection.

**5. Three new files, one modified file.** The implementation scope is:
- New: `examples/github-viewer/cli/glyph-cli.mjs` (entry point)
- New: `examples/github-viewer/cli/CliConnection.mjs` (WebSocket client)
- New: `package.json` script entry (`"cli"`)
- Modified: `examples/github-viewer/websocket/commands/gridCommands.js` (add CRUD commands + CodeGrid import)

**6. `CliConnection` single-pending-resolve pattern.** The `_pendingResolve` single-slot design serializes requests, which is correct for a CLI where the user types one command at a time. Protocol identified the lack of request IDs (Phase 0 section 1.8 item 8) but all agents agree this is not a problem for v1 -- the serial send-wait-receive loop makes ID correlation unnecessary.

**7. Dual response format handling.** The relay sends JSON `{"response":"...", "data":{...}}` when `data` is present, but plain strings when `data` is null (confirmed at `ws-relay.mjs` lines 120-125). `CliConnection` handles both via try/catch on `JSON.parse`. All three agents converged on this in Round 1.

## Remaining Tensions

**1. Command naming: `grid.text` vs `grid.settext` (and `grid.position` vs `grid.setposition`).**

Protocol's Round 1 explicitly recommends dropping the `set` prefix: "Use `grid.text` to match existing noun-as-setter pattern (`grid.color`, `grid.visibility`)." Interface's Round 1 explicitly adopts the `set` prefix: "adopt `grid.settext` and `grid.setposition`."

The existing commands in `gridCommands.js` at lines 12, 48, 84, 105: `grid.list`, `grid.info`, `grid.color`, `grid.visibility`. None use a `set` prefix. `grid.color` IS a setter (it takes `<index> <r> <g> <b>` and mutates). `grid.visibility` IS a setter (takes `<index> <bool>` and mutates). Following this pattern, `grid.text` and `grid.position` should also omit `set`.

Interface's argument that `grid.text` is ambiguous (getter or setter?) applies equally to `grid.color` -- yet `grid.color` works fine as a setter in practice because the argument count disambiguates. With args, it is a setter; without, it could be a getter (though none currently are).

My position: use `grid.text`, `grid.position`, `grid.scale` (no `set` prefix) for consistency with `grid.color` and `grid.visibility`. This is a minor naming disagreement -- either works, but inconsistency within the command set is worse than either choice.

**2. Context bag mutation: explicit helpers vs direct array mutation.**

Protocol proposes `ctx.addGrid(grid)` / `ctx.removeGrid(index)` in `buildContext()` at `websocket/index.js`. I proposed direct `ctx.getGrids().push(grid)` + `ctx.scene.add(grid)` in each handler. Interface adopted protocol's approach in Round 1.

The trade-off is real: explicit helpers centralize the add-to-array + add-to-scene logic (preventing bugs if a handler forgets one step), but add a layer of indirection for what is currently a 2-line operation in 2 handlers. For the initial 5 commands, either works. If more mutating commands appear, helpers prevent bugs. I now lean toward protocol's approach -- the cost is 10 lines in `buildContext()` and the benefit is correctness by construction.

**3. `\n` fix location: parser vs handler vs CLI pre-processing.**

Three options surfaced across rounds:
- (a) Fix `CommandRouter.parse()` lines 77-80 to interpret `\n` -> newline, `\t` -> tab in the `if (escaped)` branch. (Interface's Round 1 recommendation.)
- (b) Pre-process in the CLI before sending: `cmd.replace(/\\n/g, '\n')`. (Partial -- only fixes CLI, not websocat or other clients.)
- (c) Pre-process in the `grid.create`/`grid.text` handlers. (My Phase 0 suggestion -- but as interface proved, `replace(/\\n/g, '\n')` would not match because the parser already consumed the backslash.)

Option (a) is the only correct fix. It changes `CommandRouter.parse()` at line 77-80 from:
```javascript
if (escaped) {
    current += ch;
    escaped = false;
    continue;
}
```
to:
```javascript
if (escaped) {
    if (ch === 'n') current += '\n';
    else if (ch === 't') current += '\t';
    else current += ch;
    escaped = false;
    continue;
}
```

This is a 2-line addition that fixes the problem for all clients. Protocol has not explicitly addressed this after interface raised it. I agree with interface that this is the right fix.

**4. One-shot mode.**

Interface defined one-shot mode (Phase 0 section 1.2): `node cli.js grid.list` sends a single command, prints the response, exits. Protocol's Round 1 recommends adding it. My Phase 0 only had REPL and pipe modes.

Adding one-shot is ~10 lines in `glyph-cli.mjs`: detect `process.argv[3+]`, join as command string, connect, send, print, close, exit. This is worth including from the start because it enables scripting (`node cli.js grid.list --json | jq`). I agree it should be in v1.

**5. Batch command: wire-level vs defer.**

Protocol proposes a `batch` wire command (Phase 0 section 2.7) leveraging `CommandRouter.executeBatch()` at line 149. Interface proposed CLI-side batch (read file, send commands sequentially). In Round 1, protocol recommended adding the wire-level batch; I recommended it as "should add."

For the Hello demo scope, batch is not needed. But it is low-cost to add (the `executeBatch()` method already exists) and eliminates multi-round-trip overhead for create+position+color sequences. My position: include it in v1 if time allows, defer otherwise. It is not blocking for the Hello demo.

## Synthesis

Here is the concrete, buildable plan for a CLI that can send "Hello" to the viewer, incorporating all three perspectives:

### Files to create

**`examples/github-viewer/cli/CliConnection.mjs`** -- WebSocket client. Connects to relay, sends `ping` for clean registration, handles dual-format responses (JSON and plain string), single `_pendingResolve` slot for serial command execution, configurable timeout. Approximately 80 lines. Based on my Phase 0 section 6.3 code with the `pong` discard logic.

**`examples/github-viewer/cli/glyph-cli.mjs`** -- Entry point. Three modes:
1. One-shot: `node glyph-cli.mjs [url] <command...>` -- connect, send, print, exit. (From interface.)
2. REPL: `node glyph-cli.mjs [url]` with TTY stdin -- readline loop with `glyph>` prompt. (From implementation.)
3. Pipe: non-TTY stdin -- read lines, send sequentially, exit. (From implementation.)

Connection banners go to stderr, command responses to stdout (from interface section 4.5). Exit codes: 0 success, 1 command error, 2 connection error (from interface section 4.4). REPL meta-commands use dot prefix: `.exit`, `.quit`, `.json on/off` (from interface section 5.4). Approximately 60 lines.

### Files to modify

**`examples/github-viewer/websocket/commands/gridCommands.js`** -- Add `import CodeGrid from '../../../../src/collections/CodeGrid.js'` at top. Register 5 new commands:

| Command | Args | Handler behavior |
|---------|------|-----------------|
| `grid.create` | `<text> [name]` | `new CodeGrid(scene, atlas)`, `loadText(text)`, `scene.add(grid)`, push to grids array |
| `grid.remove` | `<index>` | `grid.dispose()`, `scene.remove(grid)`, `grids.splice(idx, 1)` |
| `grid.text` | `<index> <text>` | `grid.loadText(text)` (clears + rebuilds) |
| `grid.position` | `<index> <x> <y> <z>` | `grid.position.set(x, y, z)` |
| `grid.scale` | `<index> <factor>` | `grid.scale.setScalar(factor)` |

All handlers follow the existing validation pattern in `gridCommands.js`: check arg count, validate index bounds, return `{text: "ERR: usage: ...", data: null}` on failure, `{text: "OK: ...", data: {...}}` on success.

**`examples/github-viewer/websocket/CommandRouter.js`** -- Fix `\n` escape handling in `parse()` at lines 77-80. Add `if (ch === 'n') current += '\n'; else if (ch === 't') current += '\t';` in the `if (escaped)` branch.

**`examples/github-viewer/websocket/index.js`** -- Add `addGrid(grid)` and `removeGrid(index)` to the context bag returned by `buildContext()`. `addGrid` does `viewer.grids.push(grid); viewer.scene.add(grid)`. `removeGrid` does `grid.dispose(); viewer.scene.remove(grid); viewer.grids.splice(index, 1)`.

**`package.json`** -- Add `"cli": "node examples/github-viewer/cli/glyph-cli.mjs"` to scripts.

### Wire protocol for the Hello demo

```
# Terminal 1: npm run serve (HTTP on 8000)
# Terminal 2: npm run ws (relay on 8765)
# Terminal 3: browser at http://localhost:8000/examples/github-viewer/
#             (enable WebSocket in settings)
# Terminal 4:

$ node examples/github-viewer/cli/glyph-cli.mjs grid.create "Hello"
OK: created grid #0 (5 glyphs)

# Wire trace:
# CLI -> Relay:   "ping"
# Relay -> CLI:   "OK: connected as ctrl-0"
# Relay -> CLI:   "pong"
# CLI -> Relay:   "grid.create \"Hello\""
# Relay -> Display: {"from":"ctrl-0","cmd":"grid.create \"Hello\""}
# Display -> Relay: {"to":"ctrl-0","response":"OK: created grid #0 (5 glyphs)","data":{"index":0,"glyphs":5}}
# Relay -> CLI:   {"response":"OK: created grid #0 (5 glyphs)","data":{"index":0,"glyphs":5}}
```

The browser renders 5 GPU-instanced glyph quads (H, e, l, l, o) at the origin via `CodeGrid.loadText("Hello")` -> `GlyphCollection.flush()` -> `GlyphRenderer.renderBatch()`.

### Deferred to phase 2

- Tab completion (`CommandCompleter.mjs` seeded from `help` response)
- Watch mode (`--watch` + `fs.watch`)
- `grid.load` (CLI-local file reading)
- Wire-level `batch` command
- Aliasing in REPL
- Structured error codes (`error.code` field)

## Dissent

**I disagree with interface's Round 1 recommendation to use `grid.settext` and `grid.setposition`.**

The existing command set has 4 registered commands in `gridCommands.js`: `grid.list` (read), `grid.info` (read), `grid.color` (write), `grid.visibility` (write). The two write commands use bare nouns without a `set` prefix. Adding `grid.settext` and `grid.setposition` alongside `grid.color` and `grid.visibility` creates an inconsistency where some setters have `set` and others do not. A user who learns `grid.color <index> <r> <g> <b>` would naturally try `grid.text <index> <content>`, not `grid.settext <index> <content>`.

Protocol agrees with me on this (Round 1 "Recommendations" section: "Standardize on `grid.create`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale`"). Interface is the outlier. The consistency argument is strong enough that I would push for the no-prefix naming even if it means a longer discussion, because command naming is a surface that users interact with directly and inconsistency creates friction.

**I maintain that `grid.create <text> [name]` (text-first) is correct despite protocol's `<name> <text>` recommendation.**

Protocol argues name-first matches `CodeGrid.loadFileAsync(filename, content)`. But the CLI command surface should optimize for the common case, not mirror internal API signatures. The most frequent invocation during development and demos will be `grid.create "Hello"` or `grid.create "some quick text"` without a name. Requiring a name as the first argument adds friction to the most common path. The auto-generated fallback name (`cli-grid-${Date.now()}`) works fine for unnamed grids. Interface's Round 1 also accepted text-first. This is a 2-to-1 consensus.
