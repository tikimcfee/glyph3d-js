#!/usr/bin/env bash
#
# web-preview.sh — launch Vivaldi (Chromium-family) for the glyph3d preview /
# screenshot loop. Unlike tools/dev-firefox.sh (Firefox needs a Vulkan single-GPU
# pin + about:config dance for WebGPU), Vivaldi renders WebGPU out of the box on
# this box; we only force-enable the flag and open a remote-debugging port so
# tools/cdp-shot.mjs can grab pixels without the window being focused.
#
# Usage:
#   tools/web-preview.sh [url] [debug-port]
#   tools/web-preview.sh http://localhost:5173/        # default port 9222
#
# A dedicated, throwaway profile is used so it never touches your real Vivaldi
# session (no "restore tabs" prompt, no history pollution). Runs in the
# background; prints the PID. Kill it with: kill <pid>  (or pkill -f glyph3d-preview)
set -euo pipefail

URL="${1:-http://localhost:5173/}"
PORT="${2:-9222}"
PROFILE="${GLYPH_PREVIEW_PROFILE:-/tmp/glyph3d-preview-profile}"
BIN="${VIVALDI_BIN:-vivaldi}"

command -v "$BIN" >/dev/null || { echo "web-preview: $BIN not found" >&2; exit 1; }

"$BIN" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --enable-unsafe-webgpu --enable-features=Vulkan \
  --new-window "$URL" \
  >/tmp/glyph3d-preview.log 2>&1 &

echo "web-preview: launched $BIN (pid $!) → $URL  [CDP :$PORT]"
echo "  screenshot: bun tools/cdp-shot.mjs out.png $PORT"
echo "  quit:       kill $!"
