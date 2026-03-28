# Round 1: interface reviews protocol, implementation

## Alignment

### Command naming and dot-namespace convention
All three analyses converge on dot-separated command names (`grid.create`, `camera.move`). My phase 0 section 2.2 recommended Option C (hybrid: dot-namespace primary, flags for CLI enrichment). Protocol section 2.1 follows the same naming pattern. Implementation section 3.1 registers commands using the same scheme. There is no disagreement on this fundamental design decision.

### Relay protocol is sufficient as-is
My phase 0 section 9 ("Controller Registration Protocol") concluded the relay needs no modification. Protocol section 1.7 ("What Works") and Implementation section 7 ("Summary of Files to Create/Modify, No changes needed: ws-relay.mjs") agree. Confirmed by reading the actual `ws-relay.mjs` -- the relay at line 86-93 auto-registers controllers and at line 111 forwards `{from, cmd}` to the display. The existing code handles everything needed.

### Thin CLI, smart browser
My phase 0 section 10 states "The CLI itself is thin by design. The intelligence lives in the CommandRouter." Implementation section 4 ("Shared Code") says "The design intentionally keeps them decoupled" and "No parsing, no command knowledge" on the CLI side. Protocol section 3.1 shows the full handler logic living in the browser. All three agents agree the CLI is a formatted pipe.

### Response format: `{text, data}` dual return
My section 4 (Output Modes) describes human-readable text and `--json` for structured data. Protocol section 1.4 documents the `{response, data}` envelope. Implementation section 2.1 parses this in `CliConnection`. The response format is consistent across all three analyses and matches the actual `WebSocketBridge._handleMessage` at lines 338-354 of `WebSocketBridge.js`.

### Error detection via `ERR:` prefix
My section 4.4 (Exit Codes) relies on `ERR:` prefix detection. Protocol section 4.1-4.3 documents the full error classification using the same prefix convention. Implementation does not explicitly address exit codes but uses `console.error` for errors. The detection mechanism is aligned.

## Gaps

### What I covered that others missed

**Three operating modes (one-shot, REPL, pipe)**. My section 1.2 defines three distinct modes with different behaviors. Implementation section 2.3 covers piped mode as an afterthought (a brief `!stdin.isTTY` check) and does not define one-shot mode (single command + exit from CLI args). Neither protocol nor implementation addresses `process.argv` command execution like `node cli.js grid.list`.

**REPL meta-commands**. My section 5.4 defines `.help`, `.exit`, `.json on/off`, `.connect`, `.batch`, `.history`, `.alias`. Implementation's REPL only handles `quit`/`exit` and a bare `.json` toggle. Protocol does not address REPL-local commands at all.

**Tab completion**. My section 5.3 specifies fetching the command list from the relay on connect and populating readline's completer. Implementation section 4 mentions this briefly with a code snippet but defers it to "phase 2" via a `CommandCompleter.mjs` file. Protocol does not address it.

**Stderr vs stdout separation**. My section 4.5 specifies that command responses go to stdout and connection messages/prompts go to stderr. Implementation writes everything to stdout (`console.log` for both connection ack and command responses). This matters for piping: `g3d grid.list --json | jq` would break if connection banners pollute stdout.

**Exit codes**. My section 4.4 defines codes 0-3. Neither protocol nor implementation defines exit codes.

**Watch mode** (`--watch` for file monitoring). My section 6.4. Not mentioned by others.

**Aliasing in REPL**. My section 6.5. Not mentioned by others.

### What protocol covered that I missed

**Request ID correlation**. Protocol section 1.8 item 8 identifies the lack of explicit request IDs. If a CLI sends two commands rapidly, responses are only correlated by ordering. I did not address this -- my phase 0 implicitly assumed sequential send-wait-receive. This is a real gap: the implementation's `_pendingResolve` (a single slot) would drop responses if two sends overlap.

**`grid.settext` as separate from `grid.text`**. Protocol section 2.4 uses `grid.settext` while I used `grid.text`. The naming is a minor difference but the protocol agent's reasoning is sound: `settext` follows a setter pattern consistent with `grid.setposition` and `grid.setscale`.

**`grid.scale` and `grid.setposition` commands**. Protocol sections 2.5-2.6 define these. I mentioned `grid.move` for positioning but did not define `grid.scale`. Implementation covers both `grid.setposition` and `grid.setscale`.

**Batch command on the wire**. Protocol section 2.7 defines a `batch` command that executes multiple commands in a single round-trip, referencing `CommandRouter.executeBatch()`. My phase 0 section 6.3 mentions batch file execution but as a CLI-side concept (reading a file and sending commands sequentially), not as a wire-level batch. The protocol approach is better -- it avoids N round-trips.

**Context bag `addGrid`/`removeGrid` helpers**. Protocol section 7 proposes explicit mutation methods on the context bag. My phase 0 mentions this need in section 8 but does not specify the API. Implementation section 3.1 takes a third approach: directly calling `ctx.getGrids().push(grid)` and `ctx.scene.add(grid)` without dedicated helpers. The protocol approach is cleaner.

### What implementation covered that I missed

**`ping` as first message for clean registration**. Implementation section 2.1 (revised `connect()`) identifies that the relay processes the first message as both registration and command, then proposes sending `ping` to cleanly separate registration from commands. This is a subtle protocol detail I did not address. My phase 0 section 7.5 shows `CONTROLLER` as the first message, but the actual relay code at `ws-relay.mjs` line 70 only checks for `DISPLAY` -- anything else becomes both registration trigger and command. The `ping` approach (relay handles it at line 100 without forwarding to display) is the correct workaround.

**CodeGrid constructor subtlety**. Implementation section 3.2 notes that `GlyphCollection` constructor adds its group to the scene, then `CodeGrid` reparents it. This matters for the `grid.create` handler -- `ctx.scene.add(grid)` is required or the collection group is orphaned. Neither protocol nor I identified this.

**`grid.settext` joining remaining args with spaces**. Implementation section 3.4 does `args.slice(1).join(' ')` for unquoted multi-word text. This is correct because the CommandRouter parser splits on spaces outside quotes. If a user sends `grid.settext 0 hello world` (no quotes), joining args preserves the intent. Protocol assumes quoted strings only.

## Tensions

### Command naming: `grid.new`/`grid.text` vs `grid.create`/`grid.settext`

My phase 0 uses `grid.new` and `grid.text`. Protocol uses `grid.create` and `grid.settext`. Implementation uses `grid.create` and `grid.settext`.

The protocol and implementation agree on `grid.create`/`grid.settext`. My `grid.new` is shorter but breaks the existing naming pattern. Looking at the registered commands in `gridCommands.js` (lines 12, 48, 84, 105): `grid.list`, `grid.info`, `grid.color`, `grid.visibility` -- these are noun-based, not verb-prefixed. `grid.create` follows this convention better than `grid.new`. Similarly, `grid.settext` is consistent with `grid.setposition` and `grid.setscale` (setter pattern), while my `grid.text` is ambiguous (get or set?).

Resolution: adopt `grid.create` and `grid.settext`.

### Command naming: `grid.move` vs `grid.position` vs `grid.setposition`

My phase 0 section 8 lists `grid.move`. Protocol section 2.5 uses `grid.position`. Implementation section 3.5 uses `grid.setposition`.

`grid.move` implies relative movement (delta). `grid.position` and `grid.setposition` imply absolute positioning. The implementation is an absolute setter (`grids[idx].position.set(x, y, z)`), so `grid.setposition` or `grid.position` is correct. `grid.move` is misleading.

Resolution: adopt `grid.setposition` (consistent with `grid.settext`, `grid.setscale`).

### CLI first-message protocol: `CONTROLLER` vs raw command vs `ping`

My phase 0 section 9 recommends sending `CONTROLLER` as the first message. Protocol section 1.2 says the first message is the command itself. Implementation proposes sending `ping`.

The actual relay code at `ws-relay.mjs` lines 70-93: only `DISPLAY` is a magic string. Any other first message triggers controller registration AND falls through to command processing. Sending `CONTROLLER` would register the CLI and then try to execute `CONTROLLER` as a command on the display -- which would produce `ERR: unknown command 'controller'`. Sending `ping` works because line 100 handles it before forwarding to display.

Resolution: use `ping` as the first message. My `CONTROLLER` recommendation was wrong.

### Registration ack handling

My phase 0 section 7.5 shows a two-message registration: CLI sends `CONTROLLER`, relay responds `{"ok":true}`. The actual relay sends a plain string `OK: connected as ctrl-N` (line 90). Protocol section 1.2 documents this correctly. Implementation handles it correctly in `CliConnection.connect()`.

Resolution: follow protocol and implementation. The ack is a plain string, not JSON.

### `grid.create` argument order: text-first vs filename-first

My phase 0 section 3.1 uses `grid.new <text> [x y z]` -- text first, optional position. Protocol section 2.2 uses `grid.create <filename> "<content>"` -- filename first, then content. Implementation section 3.2 uses `grid.create <text> [name]` -- text first, optional name.

This is a real UX conflict. For the hello demo, the minimum case is creating a grid with text. Protocol's `filename` requirement adds friction for quick testing -- the user must always provide a name even for throwaway grids. Implementation makes the name optional (`cli-${Date.now()}` fallback), which is better for quick iteration. My approach skips the name entirely.

Resolution: adopt implementation's `grid.create <text> [name]` ordering. Text is the only required argument. Name is optional with an auto-generated fallback.

### Batch: wire-level vs CLI-level

My section 6.3 defines batch as a CLI feature (read commands from file, send sequentially). Protocol section 2.7 defines `batch` as a wire command that executes multiple commands in a single round-trip on the browser side, referencing `CommandRouter.executeBatch()`. Implementation does not mention batch at all.

These are complementary, not contradictory. The CLI can offer both: `.batch <file>` as a REPL meta-command (reads file, sends commands one by one) and the wire-level `batch` command for atomic multi-command execution. But the wire-level batch requires checking if `CommandRouter.executeBatch()` actually exists.

### Response delivery: data-present vs data-absent

Protocol section 1.4 and the actual relay code at `ws-relay.mjs` lines 121-125:

```javascript
if (msg.data) {
    sendJSON(targetWs, { response, data: msg.data });
} else {
    targetWs.send(response);
}
```

When `data` is present, the controller receives JSON. When `data` is null/absent, the controller receives a plain string. Implementation handles this in `CliConnection` by trying `JSON.parse` and falling back to plain text (line 724-728). My phase 0 does not explicitly address this dual-format delivery, though my section 4.2 handles it implicitly by checking for `data: null`.

The tension: `grid.color` returns `data: { index, color }` (non-null), so the relay sends JSON. But `camera.reset` might return `data: null`, causing the relay to send a plain string. The CLI must handle both formats for every command. Implementation does this correctly. Protocol documents it clearly. My phase 0 understates the complexity.

### `\n` handling in text content

Protocol section 2.2 states: "The parser strips quotes and handles `\\` -> `\`, but it does NOT interpret `\n` as newline. The command handler must do that." Implementation section 6.7 confirms this and proposes `args[0].replace(/\\n/g, '\n')` in the handler.

Looking at the actual `CommandRouter.parse()` in `CommandRouter.js` lines 76-85: `\\` sets `escaped = true`, then the next character is appended literally. So `\n` in the input produces `n` (the backslash is consumed, `n` is appended). This means the handler receives the literal character `n`, not the two-character sequence `\n`. The `replace(/\\n/g, '\n')` fix would NOT work because the `\` is already consumed by the parser.

This is a bug in both protocol and implementation analyses. The actual behavior: input `"Hello\nWorld"` -> parser produces `HellonWorld` (backslash consumed, `n` kept). To get a real newline, the parser itself would need to interpret `\n` as a newline during the escape phase, or the CLI would need to pre-process the string before sending.

Correct fix in `CommandRouter.parse()` at line 78:
```javascript
if (escaped) {
    if (ch === 'n') current += '\n';
    else if (ch === 't') current += '\t';
    else current += ch;
    escaped = false;
    continue;
}
```

Or the CLI pre-processes: `cmd.replace(/\\n/g, '\n')` before sending over the wire, so the actual newline character is in the WebSocket message and the parser never sees `\n`.

## Recommendations

### Adopt from protocol
1. **Command names**: Use `grid.create`, `grid.remove`, `grid.settext`, `grid.setposition`, `grid.setscale`. Drop my `grid.new`, `grid.text`, `grid.move`.
2. **Wire-level `batch` command**: Implement protocol section 2.7. Verify that `CommandRouter.executeBatch()` exists first; if not, add it.
3. **Context bag `addGrid`/`removeGrid`**: Add these to `buildContext()` in `websocket/index.js` rather than doing bare `getGrids().push()` + `scene.add()` in each handler.
4. **Error classification table** (protocol section 4.1): Document the error prefix patterns so the CLI can parse them programmatically.

### Adopt from implementation
1. **`ping` as first message**: Use this for clean registration. Do not send `CONTROLLER`.
2. **`CliConnection.mjs` architecture**: The single-pending-resolve pattern is correct for sequential command execution. The actual code in section 6.3 is close to production-ready.
3. **`grid.create <text> [name]`** argument order: Text first, name optional.
4. **`args.slice(1).join(' ')` in `grid.settext`**: Handles unquoted multi-word input gracefully.
5. **CodeGrid import path**: `../../../../src/collections/CodeGrid.js` from `gridCommands.js`. This is correct.

### Preserve as-is
1. **`ws-relay.mjs`**: No modifications needed. All three agents agree.
2. **`CommandRouter.parse()`**: The quote and backslash handling works, except for the `\n` issue (see below).
3. **`WebSocketBridge._handleMessage()`**: The `{from, cmd}` -> `router.execute()` -> `{to, response, data}` flow is correct.
4. **Existing `gridCommands.js` commands**: `grid.list`, `grid.info`, `grid.color`, `grid.visibility` are correct as-is.

### Changes needed
1. **Fix `\n` handling**: Either modify `CommandRouter.parse()` to interpret `\n` escape sequences (lines 77-80), or have the CLI pre-process escape sequences before sending. The parser currently eats the backslash and keeps the literal `n`. This blocks multi-line grid creation from the CLI.
2. **Add one-shot mode to `glyph-cli.mjs`**: Detect `process.argv[3+]` as a command, send it, print result, exit. Implementation only handles REPL and pipe modes.
3. **Stderr separation**: Connection banners and prompts should go to `process.stderr` so stdout is clean for piping. Change `console.log(ack)` to `console.error(ack)` in the CLI.
4. **Exit codes**: Add `process.exit(1)` when response starts with `ERR:`, `process.exit(2)` on connection failure (already done), `process.exit(0)` on success.
5. **`--json` flag for one-shot mode**: Print `JSON.stringify(result.data)` to stdout instead of `result.text`.

## Key Insight

The protocol and implementation agents converged on the same design independently, which validates the approach: a thin CLI sending raw strings through a relay to a browser-side CommandRouter that does all the parsing, dispatch, and response formatting. The single highest-risk item is the `\n` escape handling in `CommandRouter.parse()` -- the parser at lines 76-85 of `CommandRouter.js` consumes backslashes without interpreting escape sequences, so `\n` becomes literal `n`, silently corrupting multi-line content. This will surface the first time anyone tries to create a multi-line grid from the CLI and must be fixed before the hello demo can meaningfully work with real code content. Everything else -- command naming, wire format, registration protocol, response envelope -- is settled and correct.
