# Authentication and trust boundaries

Single-operator security model across the terminal daemon, the Go relay (`cli/auth.go`), the
browser apps (`app/`, `wall/`), and remote hosts.

## Threat model

- **Trusted:** local processes running under the operator's `uid` (the `tmux` model). Any process
  of the same `uid` already holds the operator's files, shells, and private runtime directory
  (`/run/user/<uid>/g3d` on Linux when owned by `<uid>` with mode `0700`, `/tmp/g3d-<uid>`
  otherwise).
- **Not trusted:**
  - **Other local `uid`s:** refused at the terminal daemon by directory mode `0700`, socket mode
    `0600`, and kernel peer-credential checks (`SO_PEERCRED` / `getpeereid`); refused at the relay
    because they cannot read the `0600` token file inside that `0700` runtime directory.
  - **LAN, Wi-Fi, and VPN / Tailscale peers:** `serve --listen` binds `127.0.0.1` by default.
    Network exposure requires an explicit `--listen <addr>`, keeps authentication mandatory, and
    notes that plain `ws://` is unencrypted on untrusted Wi-Fi (prefer a Tailscale IP or `ssh -L`;
    a forwarded port needs its address named: `ssh -L 9000:localhost:8080 box` →
    `serve --origin http://localhost:9000`).
  - **Arbitrary web pages and DNS rebinding in the operator's browser:** blocked at HTTP and
    WebSocket entry by `Host` validation, an `Origin` allowlist, and a per-start capability token.
- **Remote hosts (invent no crypto):**
  - The terminal daemon's Unix socket is never exposed over TCP.
  - Cross-host interactive terminals ride `ssh` (`ssh -t <host> …`, as `wall.attach` does).
  - Cross-host agent operations stay on the `gomuxai` bus (TLS, per-host nkeys, trusted-peers
    list, and remote-ops allowlist).

## Relay authentication (`cli/auth.go`)

Every `serve` start mints a fresh 256-bit (`crypto/rand`, 64-hex) capability token and publishes it
atomically as mode `0600` at `<runtime-dir>/relay-<port>.token` once the TCP listener is bound
(unlinked on shutdown only if the file still holds that server's token).

Every WebSocket upgrade — `DISPLAY`, `CONTROLLER`, `SOURCE`, and all `fs/*`, `lsp/*`, `gomux/*`,
and `agentEvents/*` JSON-RPC riding the display socket — must pass before `Upgrade`:

1. **No query-string secrets:** `?token=` in the request URL is refused (`400 Bad Request`).
2. **`Host` check:** `Host` must name loopback (`localhost`, `127.0.0.1`, `[::1]`) or the configured
   `--listen` interface IP, on the relay's own port (applied to static HTTP requests too, defeating
   DNS rebinding). The one way past it is naming the address: each `--origin` also passes as a
   `Host` (its host and port), which is how a port remap (`ssh -L`, `docker -p`) or a LAN hostname
   reaches the relay.
3. **`Origin` allowlist:** whenever `Origin` is present (browsers always send it, including `"null"`
   for opaque/sandboxed frames), it must match the relay's served origin, a loopback Vite dev
   origin (`:5173`, `:5180`), or an explicit `serve --origin <scheme://host[:port]>` (`403`).
4. **Constant-time token match (`401`):** carried either as `Authorization: Bearer <token>` (the CLI
   reading `$G3D_RELAY_TOKEN` or `<runtime-dir>/relay-<port>.token`; forked `attach` adapters, which
   the relay hands its own token as `G3D_RELAY_TOKEN`, overriding any it inherited) or as WebSocket subprotocol
   `Sec-WebSocket-Protocol: glyph3d, g3d-token.<token>` (`WebSocketBridge` and JS harnesses; the
   relay selects and echoes only `glyph3d`, never the secret).

Tokens are never written to relay logs. Interactive TTY starts, `glyph3d-cli [--port N] url`, and
interactive `tools/dev.sh` print `#token=<hex>` in the URL fragment; `WebSocketBridge` consumes
`#token=` on boot or `hashchange`, scrubs the address bar with `history.replaceState`, keeps the
token only in tab-scoped `sessionStorage` (never `localStorage`) under the relay's port — switching
relays (`relay.connect <port|url>`) brings that port's token, never another relay's — and reconciles
fresh tokens after a relay restart in place via `#token=` or `wall.token` / `relay.token` without
reloading the page. A relay address with no `#token=` is never taken for a token.

**Restarts.** By default every start mints a fresh token and removes its file on exit, so an open
page must be handed the new one. `serve --keep-token` is the dev loop's opt-in (`tools/dev.sh` passes
it): a start adopts the valid token (owner-checked file, 64 hex) the previous start on that port
left, and leaves the file on exit, so an open page reconnects across a rebuild by itself. The cost is
lifetime: that token stays good until the file is deleted, so the relay refuses `--keep-token`
with a non-loopback `--listen`.

Gates: `cli/auth_test.go`, `tools/relay-auth.test.mjs`, `tools/termd-relay-check.mjs`,
`tools/wall-e2e.mjs`.
