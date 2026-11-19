#!/usr/bin/env bash
# dev-gpu.sh — run THIS worktree's dev servers on isolated ports.
#
# This is the experiment/gpu-sweep worktree. Its whole point is that we can
# break core (GlyphField / the builder / the shaders) while the main checkout
# at ~/dev/glyph3d-js stays a known-good reference on :5173. To A/B them live
# we must NOT collide ports — so everything here is shifted:
#
#   Vite   :5273   (main: :5173)   green text-path  vs  packed cyan
#   relay  :8180   (main: :8080)
#   logs   ~/.local/state/g3d/logs-gpu   (main: ~/.local/state/g3d/logs)
#
# Usage (same verbs as tools/dev.sh): vite | relay | refresh | status | stop
#   tools/dev-gpu.sh vite
#
# bench-reload.mjs honors VITE_PORT, so to restart+verify THIS worktree:
#   VITE_PORT=5273 bun _experiments/glyph-encoding/bench-reload.mjs "<marker>"
# then open http://localhost:5273/glyph-bench.html in a WebGPU browser.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VITE_PORT="${VITE_PORT:-5273}"
export RELAY_PORT="${RELAY_PORT:-8180}"
PW_DIR=""
if [ "$(uname -s)" = "Darwin" ]; then
  PW_DIR="$(/usr/bin/id -P 2>/dev/null | awk -F: -v u="$(id -u)" '$3 == u { print $9; exit }')"
elif command -v getent >/dev/null 2>&1; then
  PW_DIR="$(getent passwd "$(id -u)" 2>/dev/null | awk -F: -v u="$(id -u)" '$3 == u { print $6; exit }')"
fi
PW_DIR="${PW_DIR:-${HOME:-}}"
export GLYPH_LOG_DIR="${GLYPH_LOG_DIR:-$PW_DIR/.local/state/g3d/logs-gpu}"
exec bash "$ROOT/tools/dev.sh" "$@"
