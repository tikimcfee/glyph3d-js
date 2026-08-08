#!/usr/bin/env bash
# multica-up.sh — bring up a local Multica backend from source, for glyph3d to bind.
#
# Postgres + backend ONLY. The Multica frontend is never built or run: glyph3d IS the
# interface, and staying off their UI keeps us clear of the Multica License's branding
# condition (which covers UI derived from apps/web, apps/desktop, apps/mobile,
# packages/views, packages/ui) and squarely under its attribution condition for
# backend/daemon/CLI consumers. See NOTICE.md.
#
# The upstream docker-compose wants a docker daemon; this builds the Go binaries
# directly instead, so it works anywhere Go and postgres exist.
#
#   tools/multica-up.sh up          clone/build/migrate/start, print connect details
#   tools/multica-up.sh down        stop backend + daemon + postgres
#   tools/multica-up.sh status      what's running
#   tools/multica-up.sh logs        tail the backend log
#
# Env overrides: MULTICA_SRC, MULTICA_REF, MULTICA_PORT (backend), PGPORT, PGDIR,
#                PGSOCK, RUNDIR — set PGPORT + MULTICA_PORT + PGDIR to run a second,
#                isolated instance alongside an existing one.

set -euo pipefail

MULTICA_SRC="${MULTICA_SRC:-${TMPDIR:-/tmp}/multica-src}"
MULTICA_REF="${MULTICA_REF:-main}"
MULTICA_PORT="${MULTICA_PORT:-8099}"
PGPORT="${PGPORT:-5432}"
PGDIR="${PGDIR:-${TMPDIR:-/tmp}/multica-pgdata}"
PGSOCK="${PGSOCK:-${TMPDIR:-/tmp}}"
RUNDIR="${RUNDIR:-${TMPDIR:-/tmp}/multica-run}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}"
DBURL="postgres://multica@/multica?host=${PGSOCK}&port=${PGPORT}&sslmode=disable"

mkdir -p "$RUNDIR"

have() { command -v "$1" >/dev/null 2>&1; }

pg() {
  # postgres refuses to run as root, so route every server-side call through a
  # non-root owner when we happen to be root. Unprivileged users run it directly.
  if [ "$(id -u)" = 0 ]; then
    su multica -c "PATH=$PGBIN:\$PATH $*"
  else
    PATH="$PGBIN:$PATH" bash -c "$*"
  fi
}

ensure_pg_user() {
  [ "$(id -u)" = 0 ] || return 0
  id multica >/dev/null 2>&1 || useradd -m multica
  # The postgres user must be able to write its socket and its log. RUNDIR is created by
  # whoever ran this script (root, usually), so without this pg_ctl fails on the log
  # redirect before postgres itself ever starts — and the error names the log, not the
  # permission, which sends you looking in the wrong place.
  mkdir -p "$PGSOCK"
  chown multica "$PGSOCK" 2>/dev/null || true
}

up() {
  have go || { echo "multica-up: go is required" >&2; exit 1; }
  [ -n "$PGBIN" ] || { echo "multica-up: no postgres server binaries found (install postgresql)" >&2; exit 1; }

  if [ ! -d "$MULTICA_SRC/.git" ]; then
    echo "==> cloning multica → $MULTICA_SRC"
    git clone --depth 50 --branch "$MULTICA_REF" https://github.com/multica-ai/multica.git "$MULTICA_SRC"
  fi

  ensure_pg_user
  if ! pg "pg_isready -h '$PGSOCK' -p '$PGPORT' -q"; then
    if [ ! -s "$PGDIR/PG_VERSION" ]; then
      echo "==> initdb $PGDIR"
      mkdir -p "$PGDIR"
      [ "$(id -u)" = 0 ] && chown -R multica "$PGDIR"
      pg "initdb -D '$PGDIR' -U multica --auth=trust" >/dev/null
    fi
    echo "==> starting postgres"
    # -p so a second instance can coexist with a system postgres (or another run of
    # this script); -h '' keeps it off TCP entirely, since everything here talks over the
    # unix socket and binding 127.0.0.1 is the usual "address already in use" failure.
    pg "pg_ctl -D '$PGDIR' -l '$PGDIR/pg.log' -o \"-k '$PGSOCK' -p $PGPORT -h ''\" start" >/dev/null \
      || { echo "multica-up: postgres failed to start — see $PGDIR/pg.log" >&2; exit 1; }
    sleep 2
  fi
  pg "createdb -h '$PGSOCK' -p '$PGPORT' -U multica multica" 2>/dev/null || true

  echo "==> building backend + migrate + cli"
  ( cd "$MULTICA_SRC/server" && GOFLAGS=-mod=mod \
      go build -o "$RUNDIR/multica-migrate" ./cmd/migrate \
   && GOFLAGS=-mod=mod go build -o "$RUNDIR/multica-server" ./cmd/server \
   && GOFLAGS=-mod=mod go build -o "$RUNDIR/multica-cli" ./cmd/multica )

  echo "==> migrating"
  # The migrate binary resolves its SQL directory relative to CWD, so it must run
  # from inside the checkout — not from wherever the operator invoked this script.
  ( cd "$MULTICA_SRC" && DATABASE_URL="$DBURL" "$RUNDIR/multica-migrate" up >"$RUNDIR/migrate.log" 2>&1 ) \
    || { echo "multica-up: migrations failed — see $RUNDIR/migrate.log" >&2; exit 1; }

  echo "==> starting backend on :$MULTICA_PORT"
  ( cd "$MULTICA_SRC" && DATABASE_URL="$DBURL" PORT="$MULTICA_PORT" \
      JWT_SECRET="${JWT_SECRET:-dev-secret-glyph3d}" APP_ENV=development \
      MULTICA_DEV_VERIFICATION_CODE="${MULTICA_DEV_VERIFICATION_CODE:-123456}" \
      FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:5173}" \
      nohup "$RUNDIR/multica-server" >"$RUNDIR/server.log" 2>&1 & echo $! >"$RUNDIR/server.pid" )
  sleep 5

  if curl -sf --noproxy '*' "http://localhost:$MULTICA_PORT/health" >/dev/null; then
    echo
    echo "multica up:  http://localhost:$MULTICA_PORT   (dev login code: ${MULTICA_DEV_VERIFICATION_CODE:-123456})"
    echo "cli:         $RUNDIR/multica-cli"
    echo "next:        multica.login http://localhost:$MULTICA_PORT you@local"
  else
    echo "multica-up: backend did not answer /health — see $RUNDIR/server.log" >&2
    exit 1
  fi
}

down() {
  [ -f "$RUNDIR/server.pid" ] && kill "$(cat "$RUNDIR/server.pid")" 2>/dev/null || true
  rm -f "$RUNDIR/server.pid"
  "$RUNDIR/multica-cli" daemon stop >/dev/null 2>&1 || true
  pg "pg_ctl -D '$PGDIR' stop" >/dev/null 2>&1 || true
  echo "multica down"
}

status() {
  curl -sf --noproxy '*' -o /dev/null -w "backend  :$MULTICA_PORT  %{http_code}\n" \
    "http://localhost:$MULTICA_PORT/health" || echo "backend  :$MULTICA_PORT  down"
  pg "pg_isready -h '$PGSOCK' -p '$PGPORT'" || true
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  logs) tail -f "$RUNDIR/server.log" ;;
  *) echo "usage: tools/multica-up.sh [up|down|status|logs]" >&2; exit 2 ;;
esac
