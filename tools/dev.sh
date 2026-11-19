#!/usr/bin/env bash
# dev.sh — glyph3d dev-loop helper.
#
# Owns the two long-running dev servers of an app so refreshes are one command. Two profiles:
#   ide (default)  Vite (the r3f IDE, app/) on :5173 + its relay on :8080, termd namespace `default`
#   wall           Vite (the wall, wall/)  on :5180 + its own relay on :8180, termd namespace `wall`
# A relay takes ONE display, so the wall runs its own relay; both profiles can run at once.
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
# Usage:  tools/dev.sh [wall] {vite|relay|refresh|status|stop}     (no profile word = ide)
#   tools/dev.sh vite      clear .vite cache + (re)start Vite     [after editing JS/JSX]
#   tools/dev.sh relay     rebuild Go + termd (make) + (re)start relay    [after editing cli/*.go]
#                          (terminals live in g3d-termd and survive; a NEW g3d-termd binary takes
#                          effect only once the running daemon stops: `./g3d stop` kills every shell)
#   tools/dev.sh refresh   relay then vite (the whole loop)
#   tools/dev.sh status    what's listening, with pids
#   tools/dev.sh stop      stop both
#
# After `vite`/`refresh`: HARD-RELOAD the browser (Ctrl+Shift+R).
# The wall's page is http://localhost:5180/?relay=8180 (`tools/dev.sh wall status` prints it).
#
# Env overrides: VITE_PORT, RELAY_PORT, TERMD_NS (the profile's defaults above),
#                GLYPH_SERVE_ROOT (the relay's served root; default the repo),
#                GLYPH_LOG_DIR (<pw_dir>/.local/state/g3d/logs).

set -euo pipefail
umask 0077

resolve_pw_dir() {
  local uid pw=""
  uid="$(id -u)"
  if [ "$(uname -s)" = "Darwin" ] && command -v id >/dev/null 2>&1; then
    pw="$(/usr/bin/id -P 2>/dev/null | awk -F: -v u="$uid" '$3 == u { print $9; exit }')"
  elif command -v getent >/dev/null 2>&1; then
    pw="$(getent passwd "$uid" 2>/dev/null | awk -F: -v u="$uid" '$3 == u { print $6; exit }')"
  fi
  if [ -z "$pw" ] && [ -r /etc/passwd ]; then
    pw="$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  fi
  if [ -z "$pw" ]; then
    pw="${HOME:-}"
  fi
  if [ -z "$pw" ]; then
    echo "✗ cannot resolve home directory for uid $uid" >&2
    exit 1
  fi
  printf '%s' "$pw"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=ide
if [ "${1:-}" = wall ]; then PROFILE=wall; shift; fi
case "$PROFILE" in
  # ide: the r3f IDE (panel system + HUD overlay + command bar) beside agent sessions (gomuxai).
  ide)  APP_DIR="$ROOT/app";  DEF_VITE=5173; DEF_RELAY=8080; DEF_NS=default; RELAY_FLAGS=() ;;
  # wall: the 2D terminal canvas beside agent sessions (gomuxai) — every host's on the agent bus.
  wall) APP_DIR="$ROOT/wall"; DEF_VITE=5180; DEF_RELAY=8180; DEF_NS=wall;    RELAY_FLAGS=(--gomuxai-hosts all) ;;
esac
VITE_PORT="${VITE_PORT:-$DEF_VITE}"
RELAY_PORT="${RELAY_PORT:-$DEF_RELAY}"
TERMD_NS="${TERMD_NS:-$DEF_NS}"
SERVE_ROOT="${GLYPH_SERVE_ROOT:-$ROOT}"
PW_DIR="$(resolve_pw_dir)"
LOG_DIR="${GLYPH_LOG_DIR:-$PW_DIR/.local/state/g3d/logs}"
if [ -L "$LOG_DIR" ]; then
  echo "✗ refusing symlinked LOG_DIR: $LOG_DIR" >&2
  exit 1
fi
mkdir -p -m 0700 "$LOG_DIR"
if [ -L "$LOG_DIR" ] || [ ! -d "$LOG_DIR" ] || [ ! -O "$LOG_DIR" ]; then
  echo "✗ unsafe LOG_DIR (must be a real directory owned by uid $(id -u)): $LOG_DIR" >&2
  exit 1
fi
chmod 0700 "$LOG_DIR"
VITE_LOG="$LOG_DIR/$PROFILE-vite.log"
RELAY_LOG="$LOG_DIR/$PROFILE-relay.log"

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
  if [ -L "$VITE_LOG" ] || { [ -e "$VITE_LOG" ] && { [ ! -f "$VITE_LOG" ] || [ ! -O "$VITE_LOG" ]; }; }; then
    echo "  ✗ refusing symlinked or unsafe log file: $VITE_LOG" >&2
    return 1
  fi
  if [ -f "$VITE_LOG" ]; then chmod 0600 "$VITE_LOG"; fi
  # exec: the server replaces the subshell, so no wrapper shell lingers holding this script's
  # stdout (a caller piping dev.sh's output would otherwise wait on it forever).
  ( cd "$APP_DIR" && VITE_PORT="$VITE_PORT" exec nohup bun run dev >"$VITE_LOG" 2>&1 </dev/null ) & disown
  # Wait for the port, not a fixed time: a first start after a dependency change re-optimizes
  # for several seconds.
  for _ in $(seq 1 60); do
    if [ -n "$(pid_on_port "$VITE_PORT")" ]; then
      echo "  vite up → $(page_url)   (url: ./glyph3d-cli --port $RELAY_PORT url '$(page_url)')   (log: $VITE_LOG)"
      echo "  ⤷ HARD-RELOAD the browser now (Ctrl+Shift+R)"
      return 0
    fi
    sleep 0.5
  done
  echo "  ✗ vite didn't listen on :$VITE_PORT within 30 s — last lines of $VITE_LOG:"; tail -n6 "$VITE_LOG"
  return 1
}

start_relay() {
  echo "→ relay: rebuild Go + termd, (re)start on 127.0.0.1:$RELAY_PORT, termd namespace $TERMD_NS   (terminals live in g3d-termd and survive)"
  ( cd "$ROOT" && make )
  kill_port "$RELAY_PORT" relay
  if [ -L "$RELAY_LOG" ] || { [ -e "$RELAY_LOG" ] && { [ ! -f "$RELAY_LOG" ] || [ ! -O "$RELAY_LOG" ]; }; }; then
    echo "  ✗ refusing symlinked or unsafe log file: $RELAY_LOG" >&2
    return 1
  fi
  if [ -f "$RELAY_LOG" ]; then chmod 0600 "$RELAY_LOG"; fi
  # --keep-token: a rebuild's restart keeps the port's token, so an open page reconnects by itself.
  ( cd "$ROOT" && exec nohup env -u G3D_RELAY_TOKEN ./glyph3d-cli serve --port "$RELAY_PORT" --keep-token --origin "http://localhost:$VITE_PORT" --origin "http://127.0.0.1:$VITE_PORT" --termd-ns "$TERMD_NS" ${RELAY_FLAGS[@]+"${RELAY_FLAGS[@]}"} "$SERVE_ROOT" >"$RELAY_LOG" 2>&1 </dev/null ) & disown
  # The relay retries the bind for ~5s if a just-killed predecessor still holds the
  # port (relay.go listenAndServeRelay), so poll the window before declaring failure —
  # otherwise a relay that's simply waiting reads as a false "✗ failed to start".
  for _ in $(seq 1 14); do
    if [ -n "$(pid_on_port "$RELAY_PORT")" ]; then
      echo "  relay up → $(page_url)   (url: ./glyph3d-cli --port $RELAY_PORT url '$(page_url)')   (log: $RELAY_LOG)"
      return 0
    fi
    sleep 0.5
  done
  echo "  ✗ relay failed to start — last lines of $RELAY_LOG:"; tail -n6 "$RELAY_LOG"
  return 1
}

# The base page URL (no token): safe to echo anywhere. Retrieve `#token=` explicitly via `glyph3d-cli url`.
page_url() {
  echo "http://localhost:$VITE_PORT/?relay=$RELAY_PORT"
}

status() {
  local vp rp
  vp="$(pid_on_port "$VITE_PORT")"
  rp="$(pid_on_port "$RELAY_PORT")"
  [ -n "$vp" ] && echo "vite  :$VITE_PORT  up (pid $vp)" || echo "vite  :$VITE_PORT  down"
  [ -n "$rp" ] && echo "relay :$RELAY_PORT  up (pid $rp)" || echo "relay :$RELAY_PORT  down"
  echo "page  $(page_url)   (url: ./glyph3d-cli --port $RELAY_PORT url '$(page_url)')   (termd namespace $TERMD_NS)"
  echo "logs  $LOG_DIR/$PROFILE-{vite,relay}.log"
  echo "      structured app logs: ./glyph3d-cli log.follow  (and log.search / log.query / log.errors / log.stats)"
}

case "${1:-refresh}" in
  vite)        start_vite ;;
  relay)       start_relay ;;
  refresh|all) start_relay; start_vite ;;
  status)      status ;;
  stop)        kill_port "$VITE_PORT" vite; kill_port "$RELAY_PORT" relay ;;
  *) echo "usage: tools/dev.sh [wall] {vite|relay|refresh|status|stop}" >&2; exit 2 ;;
esac
