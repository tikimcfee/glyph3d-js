# Round 2: protocol reviews implementation, interface (inverse)

## Evolved Understanding

After reading all three Round 1 cross-references, several of my Phase 0 assumptions have been confirmed, one was refined, and one new issue surfaced that none of us caught cleanly in Phase 0.

**Confirmed**: My wire format documentation (Phase 0 sections 1.3-1.4) was independently validated by both agents. Implementation's `CliConnection.send()` sends raw strings (correct), and implementation's Round 1 review explicitly flagged interface's JSON-envelope approach as the "single most critical alignment point." All three Round 1 outputs converge on this: controllers send raw strings, relay wraps them in `{from, cmd}` JSON. This is now triple-confirmed against `ws-relay.mjs` lines 96-111.

**Confirmed**: My `batch` wire command proposal (Phase 0 section 2.7) was endorsed by both interface (Round 1: "Implement the `batch` command... design is sound") and implementation (Round 1: "This is significant because multi-step operations would require three round-trips without it"). The `CommandRouter.executeBatch()` method at `CommandRouter.js` line 149 is the hook.

**Refined**: My Phase 0 section 2.2 recommended `grid.create <filename> "<content>"` (filename-first). Implementation proposed `grid.create <text> [name]` (text-first, name optional). After Round 1 discussion, implementation's argument order is better for the Hello demo case -- `grid.create "Hello"` with no filename is the minimum friction path. I concede this point. However, I note that the `grid.create <name> "<content>"` order was also endorsed by implementation's own Round 1 review ("use protocol's order... because it matches `loadFileAsync()` and avoids the ambiguity"). This is a genuine 50/50 call; I now favor text-first for demo ergonomics, with the name as optional second argument.

**New issue surfaced**: Interface's Round 1 review (section "Tensions", `\n` handling) discovered that `CommandRouter.parse()` at lines 76-85 of `CommandRouter.js` consumes the backslash in `\n` and keeps the literal `n`, producing `HellonWorld` instead of `Hello\nWorld`. This means my Phase 0 recommendation of `.replace(/\\n/g, '\n')` in the command handler is wrong -- by the time the handler sees the text, the backslash is already gone. Both my Phase 0 and implementation's Phase 0 missed this. Interface correctly identified two fixes: either modify the parser's escape handling (add `if (ch === 'n') current += '\n'` at line 78), or have the CLI pre-process `\n` into actual newline characters before sending over the wire. This is the highest-risk bug for the Hello demo with multi-line content.

**Broken assumption**: My Phase 0 section 2.2 stated "The parser strips quotes and handles `\\` -> `\`, but it does NOT interpret `\n` as newline." This was imprecise. The parser does not produce `\n` (two characters) -- it produces `n` (one character). The backslash is consumed, not preserved. My recommendation to handle `\n` in the command handler was based on the wrong assumption that the two-character sequence `\n` would survive parsing.

## Convergence

After two rounds, all three agents are in full agreement on these points:

1. **CLI sends raw strings, not JSON.** The relay at `ws-relay.mjs` lines 96-111 wraps controller messages in `{from, cmd}` envelopes. The CLI's `ws.send()` call must pass the command string verbatim. Interface's Round 1 acknowledged this error ("My `CONTROLLER` recommendation was wrong").

2. **Use `ping` as first message for registration.** The relay processes the first message as both registration and command. Sending `ping` triggers registration (any non-`DISPLAY` string does), and `ping` is handled at relay line 100 without forwarding to display. Clean two-message response: `"OK: connected as ctrl-N"` then `"pong"`. All three Round 1 reviews endorse this.

3. **No relay changes needed.** `ws-relay.mjs` is sufficient as-is for the Hello demo and full grid CRUD.

4. **Command names**: `grid.create`, `grid.remove`, `grid.text` or `grid.settext`, `grid.position` or `grid.setposition`, `grid.scale` or `grid.setscale`. The `grid.create` vs `grid.new` debate is settled -- `grid.create` wins unanimously.

5. **The CLI is a thin transport layer.** All intelligence lives in the browser-side CommandRouter. The CLI sends readline input (minus local flags) as raw WebSocket strings and prints responses.

6. **Wire `batch` command should be added.** Leverages existing `CommandRouter.executeBatch()`. No rollback on failure, continue-and-report semantics.

7. **`addGrid()`/`removeGrid()` context bag methods.** Both implementation (Round 1) and interface (Round 1) endorsed my Phase 0 section 7 proposal. Implementation initially used direct `getGrids().push()` but agreed centralized methods are better. Add to `buildContext()` in `examples/github-viewer/websocket/index.js`.

8. **Stderr/stdout separation.** Connection banners to stderr, command responses to stdout. Interface proposed it, implementation and protocol Round 1 endorsed it.

9. **Exit codes 0-3.** Interface's scheme (0=success, 1=command error, 2=connection error, 3=usage error) adopted by all.

10. **Dot-prefixed REPL meta-commands.** `.exit`, `.json on/off`, `.help` -- avoids collision with relay command namespace.

## Remaining Tensions

### 1. Command naming: `grid.settext` vs `grid.text`, `grid.setposition` vs `grid.position`

This is the one naming question that did not fully converge. My Phase 0 and implementation use `grid.settext`/`grid.setposition`/`grid.setscale` (explicit setter prefix). Interface uses `grid.text`/`grid.move`. My Round 1 recommended `grid.position` and `grid.text` (matching the existing `grid.color`/`grid.visibility` noun-as-setter pattern). Implementation's Round 1 recommended `grid.settext`/`grid.setposition` (explicit setter to avoid getter/setter ambiguity). Interface's Round 1 conceded to `grid.create`/`grid.settext` but then also said "adopt `grid.setposition`".

The existing commands are inconsistent: `grid.color` is a setter with no prefix, `grid.visibility` is a setter with no prefix, but there is no `grid.getcolor` or `grid.getvisibility`. The `grid.info` command is the read-all query. So the pattern is: nouns are setters, `info` is the getter.

This is a minor bikeshed. Both conventions work. The `set` prefix is more explicit and prevents future collision if getter variants are ever added. I'll defer to the majority: `grid.settext`, `grid.setposition`, `grid.setscale`.

### 2. `grid.create` argument order

My Phase 0: `grid.create <filename> "<content>"`. Implementation Phase 0: `grid.create <text> [name]`. Interface Phase 0: `grid.new "<text>" [x y z]`.

Implementation's Round 1 actually endorsed MY order ("use protocol's order `grid.create <name> "<content>"` because it matches `loadFileAsync()` and avoids the ambiguity"). But interface's Round 1 endorsed implementation's order ("adopt implementation's `grid.create <text> [name]` ordering"). So we have a circular disagreement.

The real question: is the filename/name mandatory or optional? For the Hello demo, mandatory filename is friction. For real usage (visualizing code files), the filename is semantically important -- it labels the grid and appears in `grid.list` output.

Practical resolution: `grid.create "<content>" [name]`. Text is required and comes first. Name is optional, defaults to `grid-N`. This matches implementation's design and works for both `grid.create "Hello"` and `grid.create "function add(a,b) { return a+b; }" utils.js`.

### 3. `\n` escape handling: parser fix vs CLI pre-processing

Interface's Round 1 identified the real bug: `CommandRouter.parse()` at `CommandRouter.js` lines 76-85 consumes the backslash and keeps the literal next character, so `\n` becomes `n`, not a newline.

Two fixes were proposed:

**Option A: Fix the parser** (interface's recommendation). Add escape sequence interpretation at line 78:
```javascript
if (escaped) {
    if (ch === 'n') current += '\n';
    else if (ch === 't') current += '\t';
    else current += ch;
    escaped = false;
    continue;
}
```

**Option B: CLI pre-processes** before sending. The CLI replaces `\\n` with actual `\n` in the string before `ws.send()`. The WebSocket message contains real newline characters. The parser never sees escape sequences.

Option A is better because it fixes the problem for ALL clients (websocat, future GUIs, other controllers), not just our CLI. Option B makes the CLI smarter than it should be and creates inconsistency between raw WebSocket testing (websocat) and CLI usage.

However, Option A changes `CommandRouter.parse()` behavior for ALL existing commands, not just grid CRUD. If any existing handler depends on `\` being consumed and the next character kept literally, Option A would break it. The risk is low -- backslash escaping in `grid.color 0 1 0 0` or `camera.move 0 50 100` never uses backslashes -- but it should be verified against all registered commands.

### 4. `loadText()` vs `loadFileAsync()` for grid creation

My Phase 0 recommended `loadFileAsync()` (worker path). Implementation recommended synchronous `loadText()`. My Round 1 acknowledged that `loadText()` is correct for the Hello demo (5 glyphs). Implementation's Round 1 did not revisit this.

For the demo: `loadText()` is fine. For a production `grid.create` command that might receive a 10,000-line file: `loadFileAsync()` is better because `_handleMessage` is already async, so `await grid.loadFileAsync(name, content)` costs nothing architecturally and avoids blocking the main thread during buffer building.

Resolution: use `loadText()` for v1 with a code comment noting the async upgrade path. When large content support matters, switch to `loadFileAsync()`.

### 5. One-shot mode detection

Interface defined three modes (one-shot, REPL, pipe). Implementation only has REPL and pipe. All Round 1 reviews agree one-shot should be added. The remaining question: how to detect it.

Interface says: if `process.argv` has arguments beyond the URL, treat them as a command. Implementation's CLI takes the URL as `process.argv[2]`. So one-shot would be `process.argv[3+]` joined as the command.

But this creates ambiguity: `node cli.js ws://localhost:8765 grid.list` vs `node cli.js grid.list`. The first has an explicit URL; the second relies on the default. Detection: if `process.argv[2]` starts with `ws://` or `wss://`, it is the URL and `argv[3+]` is the command. Otherwise, `argv[2+]` is the command and the URL defaults to `ws://localhost:8765`.

This is a minor implementation detail, not a design tension. Just noting it needs handling.

## Synthesis

The buildable plan for a CLI that sends "Hello" to the viewer, incorporating all three perspectives across two rounds:

### Files to create

1. **`examples/github-viewer/cli/glyph-cli.mjs`** -- Main CLI entry point (~80 lines)
   - Detect one-shot vs REPL vs pipe mode
   - Connect via `CliConnection`, print ack to stderr
   - One-shot: send command from argv, print response to stdout, exit with code 0/1
   - REPL: readline with `glyph>` prompt, dot-prefixed meta-commands (`.exit`, `.json`)
   - Pipe: read stdin lines, send sequentially, print responses

2. **`examples/github-viewer/cli/CliConnection.mjs`** -- WebSocket client (~60 lines)
   - `connect()`: open WebSocket, send `ping`, wait for `"OK: connected as ctrl-N"`, discard `"pong"`
   - `send(cmd, timeout)`: single `_pendingResolve` slot, try `JSON.parse` on response, fall back to plain text
   - `close()`: clean shutdown

### Files to modify

3. **`examples/github-viewer/websocket/commands/gridCommands.js`** -- Add CRUD commands
   - `grid.create` handler: `args[0]` = text (required), `args[1]` = name (optional). Creates `CodeGrid(ctx.scene, ctx.atlas)`, calls `grid.loadText(text)`, calls `ctx.addGrid(grid)`. Returns `{index, name, glyphs, lines}`.
   - `grid.remove` handler: validates index, calls `ctx.removeGrid(index)`. Returns `{removedIndex, name}`.
   - `grid.settext` handler: validates index, `args.slice(1).join(' ')` for unquoted fallback, calls `grid.loadText(text)`. Returns `{index, glyphs, lines}`.
   - `grid.setposition` handler: validates index and x/y/z, calls `grid.position.set(x, y, z)`. Returns `{index, position}`.
   - `grid.setscale` handler: validates index and scale, calls `grid.scale.setScalar(s)`. Returns `{index, scale}`.
   - Import at top: `import CodeGrid from '../../../../src/collections/CodeGrid.js';`

4. **`examples/github-viewer/websocket/index.js`** -- Extend `buildContext()` (~10 lines)
   - Add `addGrid(grid)`: `viewer.grids.push(grid); viewer.scene.add(grid);`
   - Add `removeGrid(index)`: validate, `grid.dispose(); viewer.scene.remove(grid); viewer.grids.splice(index, 1);`

5. **`examples/github-viewer/websocket/commands/gridCommands.js`** or new `batchCommand.js` -- Register `batch` command
   - Parse `args[0]` as JSON array of command strings
   - Call `router.executeBatch(commands)`
   - Return `{results, succeeded, failed}`

6. **`CommandRouter.js` line 78** -- Fix `\n` escape handling in `parse()`
   - Add: `if (ch === 'n') current += '\n'; else if (ch === 't') current += '\t'; else current += ch;`
   - This is a one-line change in the escape branch

7. **`package.json`** -- Add npm script
   - `"cli": "node examples/github-viewer/cli/glyph-cli.mjs"`

### The Hello demo session

```bash
$ node examples/github-viewer/cli/glyph-cli.mjs
OK: connected as ctrl-0        # (printed to stderr)
glyph> grid.create "Hello"
OK: created grid #0 "grid-0" (5 glyphs)
glyph> grid.list
#   filename    glyphs  lines  position
──────────────────────────────────────
0   grid-0      5       1      0,0,0
OK: 1 grid
glyph> .exit
```

One-shot equivalent:
```bash
$ node examples/github-viewer/cli/glyph-cli.mjs 'grid.create "Hello"'
OK: created grid #0 "grid-0" (5 glyphs)
```

### Wire trace for `grid.create "Hello"`

```
CLI  -> Relay:   ping                              # first message, triggers registration
Relay -> CLI:    OK: connected as ctrl-0            # plain string ack
Relay -> CLI:    pong                               # ping response, discarded by CLI

CLI  -> Relay:   grid.create "Hello"                # raw string command
Relay -> Display: {"from":"ctrl-0","cmd":"grid.create \"Hello\""}
Display -> Relay: {"to":"ctrl-0","response":"OK: created grid #0 \"grid-0\" (5 glyphs)","data":{"index":0,"name":"grid-0","glyphs":5,"lines":1}}
Relay -> CLI:    {"response":"OK: created grid #0 \"grid-0\" (5 glyphs)","data":{"index":0,"name":"grid-0","glyphs":5,"lines":1}}
```

### Execution order

1. Fix `CommandRouter.parse()` escape handling (unblocks multi-line content)
2. Add `addGrid`/`removeGrid` to `buildContext()` (unblocks command handlers)
3. Add `grid.create` handler in `gridCommands.js` (minimum for Hello demo)
4. Create `CliConnection.mjs` and `glyph-cli.mjs` (the CLI itself)
5. Test Hello demo end-to-end
6. Add remaining handlers (`grid.remove`, `grid.settext`, `grid.setposition`, `grid.setscale`)
7. Add `batch` command
8. Add one-shot mode, exit codes, stderr separation, dot-prefixed meta-commands

## Dissent

### I maintain that `batch` should be a Day 1 feature, not deferred

Interface's Round 1 mentions batch as a "should add" item. Implementation does not mention it at all. But the most common real-world operation -- creating a grid with position and color -- requires three sequential commands and three round-trips without `batch`. The `CommandRouter.executeBatch()` method already exists at `CommandRouter.js` line 149. Registering a `batch` command handler is ~10 lines. The cost is trivial; the benefit is eliminating the most obvious UX friction in multi-step workflows. Deferring it means the CLI ships with a known three-round-trip penalty for the most common operation.

### I disagree with the `set` prefix convention

Both implementation and interface Round 1 converged on `grid.settext`, `grid.setposition`, `grid.setscale`. The existing commands use bare nouns: `grid.color` (not `grid.setcolor`), `grid.visibility` (not `grid.setvisibility`). Adding `set` prefixes to new commands creates an inconsistent API surface: some setters have `set`, others do not. A user typing `grid.set<TAB>` gets three completions, but `grid.color` and `grid.visibility` are invisible to that prefix search. Either ALL setters should use `set` (rename `grid.color` to `grid.setcolor`) or NONE should. Since we are not renaming existing commands, consistency demands bare nouns: `grid.text`, `grid.position`, `grid.scale`. The "ambiguity between getter and setter" concern is moot because `grid.info` is already the universal getter -- there is no `grid.gettext` or `grid.getcolor` to confuse with.

This is a minority position. If the majority prefers `set` prefixes, the system works either way. But I want the inconsistency on the record.
