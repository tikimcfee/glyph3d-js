# Authentication and trust boundaries

Single-operator Unix security model across the terminal daemon (`g3d-termd`), the Go relay
(`cli/auth.go`), the browser apps (`app/`, `wall/`), and remote hosts.

**Platform boundary.** Linux and macOS only. `GOOS=windows` cross-compiles cleanly for `make all`,
and fails loud immediately at runtime (`newRelayAuth`, `checkSecureRuntimeDir`,
`checkSecureTokenFile`, `dialTermd`, and `tools/lib/relay.mjs`).

## Threat model

- **Trusted:** local processes running under the operator's `uid` (the `tmux` model). Any process
  of the same `uid` already holds the operator's files, shells, and private runtime directories:
  - **Relay capability tokens (`relay-<port>.token`, mode `0600`):** `$G3D_RELAY_TOKEN_DIR` (test
    isolation), else `/run/user/<uid>/g3d` on Linux when owned by `<uid>` with mode `0700`, else
    `<pw_dir>/.local/state/g3d/run` (mode `0700`, `<pw_dir>` resolved from the OS user database by
    UID, falling back to `$HOME`) — opened and published via FD-pinned `openat` (`O_NOFOLLOW`) so
    other UIDs can neither squat `/tmp` nor race symlinks.
  - **Dev and log-dump files (`tools/dev.sh`, `log.dump`):** `<pw_dir>/.local/state/g3d/logs`
    (`0700` directory, `0600` regular files; never shared `/tmp/glyph3d`).
  - **Terminal daemon sockets (`termd-<ns>.sock`):** `$G3D_TERMD_DIR` → `/run/user/<uid>/g3d` →
    `/tmp/g3d-<uid>` (`docs/termd/PROTOCOL.md`, fitting macOS 104-byte `SUN_LEN`).
- **Not trusted:**
  - **Other local `uid`s:** refused at `g3d-termd` **and** every `termd` client (`cli/termd.go`,
    `g3d`) by `0700` directory owner/symlink checks, `0600` socket mode, and kernel peer-UID
    verification (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` / `getpeereid` on macOS); refused at the
    relay because they cannot read or plant the `0600` token file inside the `0700` runtime dir.
  - **LAN, Wi-Fi, and network peers (secure-or-nothing):** `serve` binds loopback (`127.0.0.1`) by
    default (empty or `[]` `--listen` also normalizes to loopback, never wildcard). Non-loopback
    `--listen` (`0.0.0.0`, `::`, LAN/Wi-Fi IPs, non-loopback hostnames) is **refused** unless TLS
    (`--tls-cert` + `--tls-key`, serving `https://` / `wss://`) is configured — with the sole
    plaintext exception of Tailscale WireGuard interface IPs (`100.64.0.0/10` and
    `fd7a:115c:a1e0::/48` verified on an `UP` local interface, where WireGuard encrypts the link).
    There is no `--insecure-ws` break-glass flag. Likewise, `--origin` allows `http://` **only** on
    loopback (`localhost`, `127.0.0.1`, `[::1]`) or Tailscale IPs (`100.64.0.0/10`,
    `fd7a:115c:a1e0::/48`), requiring `https://` for all other hosts (a forwarded port over SSH
    stays loopback: `ssh -L 9000:localhost:8080 box` → `serve --origin http://localhost:9000`).
  - **Arbitrary web pages and DNS rebinding in the operator's browser:** blocked at HTTP and
    WebSocket entry by strict `Host` + port validation, an `Origin` allowlist, pre-auth HTTP
    timeouts (`ReadHeaderTimeout` / `IdleTimeout`), and a per-start capability token.
- **Remote hosts (invent no crypto):**
  - The terminal daemon's Unix socket is never exposed over TCP.
  - Cross-host interactive terminals ride `ssh` (`ssh -t <host> …`, as `wall.attach` does).
  - Cross-host agent operations stay on the `gomuxai` bus (TLS, per-host nkeys, trusted-peers
    list, and remote-ops allowlist).

## Relay authentication (`cli/auth.go`)

Every `serve` start mints a fresh 256-bit (`crypto/rand`, 64-hex) capability token and publishes it
atomically as mode `0600` via FD-pinned `openat` at `<runtime-dir>/relay-<port>.token` once the TCP
listener is bound. On `SIGHUP`, `SIGINT`, `SIGTERM`, or server exit, cleanup unlinks the file only
when `(dev, ino)` and token contents still match that server's publication.

Every WebSocket upgrade — `DISPLAY`, `CONTROLLER`, `SOURCE`, and all `fs/*`, `lsp/*`, `gomux/*`,
and `agentEvents/*` JSON-RPC riding the display socket — must pass before `Upgrade`:

1. **No query-string secrets:** any `token` query parameter (case-insensitive, `&` or `;`
   separated, across HTTP static and WebSocket upgrade routes) is refused (`400 Bad Request`).
2. **Strict `Host` + port check:** `Host` must name loopback (`localhost`, `127.0.0.1`, `[::1]`) or
   the configured `--listen` IP on the relay's bound port (applied to static HTTP too, defeating
   DNS rebinding), or match the `host:port` of an explicit `--origin` (supporting default `80`/`443`
   port elision).
3. **`Origin` allowlist (`403`):** whenever `Origin` is present (browsers always send it, including
   `"null"` for opaque/sandboxed frames), it must match the relay's served origin, a loopback Vite
   dev origin (`:5173`, `:5180`), or an explicit `serve --origin <scheme://host[:port]>` (`http://`
   on loopback/Tailscale IPs only; `https://` otherwise).
4. **Constant-time token match (`401`):** carried either as `Authorization: Bearer <token>` (the CLI
   reading `$G3D_RELAY_TOKEN` or `<runtime-dir>/relay-<port>.token`; forked `attach` adapters, which
   receive the relay's token strictly in `cmd.Env` without leaking into `g3d-termd`) or as WebSocket
   subprotocol `Sec-WebSocket-Protocol: glyph3d, g3d-token.<token>` (`WebSocketBridge` and JS
   harnesses; the relay echoes only `glyph3d`, never the secret, and ambiguous headers fail closed).

**Secret handling & redaction.** Neither `glyph3d-cli serve` nor `tools/dev.sh` auto-prints
`#token=` URLs on startup; operators retrieve tokens explicitly on demand via `glyph3d-cli [--port
N] token` or `glyph3d-cli [--port N] url <base-url>` (and pass remote CLI tokens via
`G3D_RELAY_TOKEN`, never `--host …#token=` in world-readable `argv`). Both `app/` and `wall/` scrub
`#token=` from `window.location.hash` at tick 0 before async WASM/font boot via
`history.replaceState`, validate RFC 7230 `TOKEN_CHARS` (ignoring malformed `#token=` fragments
without poisoning storage or wiping active auth), and cache tokens solely in tab-scoped
`sessionStorage` (never `localStorage`) keyed by normalized `host:port`
(`g3d.relayToken.<host>:<port>`). Endpoint switching (`relay.connect`) isolates tokens across hosts
and ports, resolves `?relay=<port>` page URLs to the relay port, and refuses cross-endpoint
`relay.token` URLs. Command-bus dispatch telemetry (`CommandRouter`), `ErrorTracker`,
`consoleForwarder` / SQLite `LogStore`, and IDE `CommandBar` history redact `relay.token`,
`wall.token`, `relay.connect` secrets, `#token=`, and `g3d-token.*` before recording or forwarding.

**Restarts.** By default every start mints a fresh token and removes its file on exit, so an open
page must be handed the new one (`#token=` or `relay.token` / `wall.token`, reconciled in place
without reload). `serve --keep-token` is the loopback dev opt-in (`tools/dev.sh`): a start adopts a
valid `0600` 64-hex `relay-<port>.token` left by a previous run on that port and preserves it on
exit so an open tab reconnects across rebuilds; `--keep-token` is strictly refused for any
non-loopback `--listen`.

Gates: `cli/auth_test.go`, `tools/relay-auth.test.mjs`, `tools/termd-relay-check.mjs`,
`tools/wall-e2e.mjs`.
