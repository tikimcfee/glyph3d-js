#!/usr/bin/env bash
# dev.sh — glyph3d dev-loop helper.
#
# Owns the two long-running dev servers so refreshes are one command:
#   - Vite     (the r3f IDE client)         on :5173
#   - the relay (glyph3d-cli serve, Go)     on :8080
#
# Why this exists: editing CommandProvider / command handlers / the router (or
# adding a new client module) needs a FULL Vite refresh — those are built once
# per page load, so Vite's HMR happily serves the STALE module and your change
# silently doesn't take. The fix is always: clear node_modules/.vite, restart
# Vite, hard-reload the browser. This script does the first two; you do the third.
#
# Kills are BY PORT (via ss), never by process-name pattern — a pattern kill
# self-matches this script's own command line and nukes the wrong thing.
#
# Usage:
#   tools/dev.sh vite      clear .vite cache + (re)start Vite     [after editing JS/JSX]
#   tools/dev.sh relay     rebuild Go (make) + (re)start relay    [after editing cli/*.go]  (kills live terminals!)
#   tools/dev.sh refresh   relay then vite (the whole loop)
#   tools/dev.sh status    what's listening, with pids
#   tools/dev.sh stop      stop both
#
# After `vite`/`refresh`: HARD-RELOAD the browser (Ctrl+Shift+R).
#
# Env overrides: GLYPH_APP_DIR (default app), VITE_PORT (5173),
#                RELAY_PORT (8080), GLYPH_LOG_DIR (/tmp/glyph3d).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${GLYPH_APP_DIR:-$ROOT/app}"   # THE app: the r3f IDE (panel system + HUD overlay + command bar)
# Exported so the child processes actually see them: vite.config.js reads
# process.env.VITE_PORT (strictPort — it fails loudly rather than drifting), and
# the relay takes its port as a flag below.
export VITE_PORT="${VITE_PORT:-5173}"
export RELAY_PORT="${RELAY_PORT:-8080}"
LOG_DIR="${GLYPH_LOG_DIR:-/tmp/glyph3d}"
mkdir -p "$LOG_DIR"
VITE_LOG="$LOG_DIR/vite.log"
RELAY_LOG="$LOG_DIR/relay.log"

# pid_on_port PORT -> the listening pid (empty if none). Filters by source port
# directly so nothing but a real listener on that port can match. ss on Linux;
# macOS has no ss, so lsof answers the same question there.
pid_on_port() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2 || true
  else
    lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n1 || true
  fi
}

kill_port() {
  local port="$1" name="$2" pid
  pid="$(pid_on_port "$port")"
  if [ -z "$pid" ]; then
    echo "  $name: not running on :$port"
    return
  fi
  echo "  $name: stopping pid $pid on :$port"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8; do
    [ -z "$(pid_on_port "$port")" ] && return
    sleep 0.5
  done
  echo "  $name: didn't exit, sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

start_vite() {
  echo "→ vite: clear cache + (re)start on :$VITE_PORT"
  kill_port "$VITE_PORT" vite
  rm -rf "$APP_DIR/node_modules/.vite"
  ( cd "$APP_DIR" && nohup bun run dev >"$VITE_LOG" 2>&1 & )
  sleep 2
  if [ -n "$(pid_on_port "$VITE_PORT")" ]; then
    echo "  vite up → http://localhost:$VITE_PORT/   (log: $VITE_LOG)"
    echo "  ⤷ HARD-RELOAD the browser now (Ctrl+Shift+R)"
  else
    echo "  ✗ vite failed to start — last lines of $VITE_LOG:"; tail -n6 "$VITE_LOG"
    return 1
  fi
}

start_relay() {
  echo "→ relay: rebuild Go + (re)start on :$RELAY_PORT   (note: this kills live terminals)"
  ( cd "$ROOT" && make )
  kill_port "$RELAY_PORT" relay
  # Flags BEFORE the positional project dir. The binary now permutes (cli/args.go),
  # but this ordering is also correct for any binary that doesn't: Go's flag package
  # stops at the first non-flag token, so `serve "$ROOT" --port N` used to drop the
  # port silently and bind the 8080 default — RELAY_PORT looked honored and wasn't.
  ( cd "$ROOT" && nohup ./glyph3d-cli serve --port "$RELAY_PORT" "$ROOT" >"$RELAY_LOG" 2>&1 & )
  # The relay retries the bind for ~5s if a just-killed predecessor still holds the
  # port (relay.go listenAndServe), so poll the window before declaring failure —
  # otherwise a relay that's simply waiting reads as a false "✗ failed to start".
  for _ in $(seq 1 14); do
    if [ -n "$(pid_on_port "$RELAY_PORT")" ]; then
      echo "  relay up → http://localhost:$RELAY_PORT/   (log: $RELAY_LOG)"
      return 0
    fi
    sleep 0.5
  done
  echo "  ✗ relay failed to start — last lines of $RELAY_LOG:"; tail -n6 "$RELAY_LOG"
  return 1
}

status() {
  local vp rp
  vp="$(pid_on_port "$VITE_PORT")"
  rp="$(pid_on_port "$RELAY_PORT")"
  [ -n "$vp" ] && echo "vite  :$VITE_PORT  up (pid $vp)" || echo "vite  :$VITE_PORT  down"
  [ -n "$rp" ] && echo "relay :$RELAY_PORT  up (pid $rp)" || echo "relay :$RELAY_PORT  down"
  echo "logs  $LOG_DIR/{vite,relay}.log"
  echo "      structured app logs: bun tools/buslog.mjs  (live follow / search / q / errors / stats)"
}

case "${1:-refresh}" in
  vite)        start_vite ;;
  relay)       start_relay ;;
  refresh|all) start_relay; start_vite ;;
  status)      status ;;
  stop)        kill_port "$VITE_PORT" vite; kill_port "$RELAY_PORT" relay ;;
  *) echo "usage: tools/dev.sh {vite|relay|refresh|status|stop}" >&2; exit 2 ;;
esac
