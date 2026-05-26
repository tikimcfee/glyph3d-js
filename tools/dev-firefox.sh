#!/usr/bin/env bash
#
# dev-firefox.sh — launch Firefox correctly for the WebGPU glyph3d dev loop.
#
# The app renders through THREE.WebGPURenderer (GlyphField). Firefox WebGPU on
# Linux needs two things that are NOT on by default, and getting either wrong
# is the difference between "renders" and "hard browser crash":
#
#   1. about:config prefs — WebGPU is gated + GPU-blocklisted on Linux.
#   2. A single-GPU pin — on a dual-GPU box (NVIDIA dGPU + AMD iGPU here) the
#      WebRender compositor null-derefs ("assertion failed: !missing", crash
#      signature SIGSEGV on thread WRRenderBackend) when wgpu picks one Vulkan
#      adapter and WebRender composites on the other. Pinning the whole process
#      to NVIDIA (Vulkan ICD + GL vendor) makes them agree and stops the crash.
#
# The prefs live in a dedicated profile's user.js (forced every startup, so it
# never depends on hand-set config in your main browsing profile). The GPU pin
# is process env, so it lives in the launch line here.
#
# Usage:
#   tools/dev-firefox.sh                 # default: app/home.html on :9876
#   tools/dev-firefox.sh app/ide.html    # a different page (path under the server root)
#   tools/dev-firefox.sh https://...     # an explicit URL
#   PORT=8080 tools/dev-firefox.sh       # different server port
#
set -euo pipefail

PORT="${PORT:-9876}"
ARG="${1:-app/home.html}"
case "$ARG" in
  http://*|https://*) URL="$ARG" ;;
  /*)                 URL="http://localhost:${PORT}${ARG}" ;;
  *)                  URL="http://localhost:${PORT}/${ARG}" ;;
esac

PROFILE_DIR="${GLYPH_FF_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/glyph3d-dev-firefox}"
DEBUG_PORT="${GLYPH_FF_DEBUG_PORT:-9222}"
NV_ICD="/usr/share/vulkan/icd.d/nvidia_icd.json"

[[ -f "$NV_ICD" ]] || echo "warning: $NV_ICD not found — Vulkan NVIDIA pin may not apply" >&2

# Dedicated profile with forced prefs. user.js is re-applied on every startup,
# so this is self-healing even if the profile's prefs.js drifts.
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/user.js" <<'PREFS'
// WebGPU on Linux: gated + blocklisted by default. Force it on.
user_pref("dom.webgpu.enabled", true);
user_pref("gfx.webgpu.ignore-blocklist", true);
user_pref("gfx.webrender.all", true);
// Remote debugging for the dev loop (CDP + BiDi: screenshot / console relay).
user_pref("remote.enabled", true);
user_pref("remote.active-protocols", 3);
// Quieter dev startup.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.aboutConfig.showWarning", false);
PREFS

echo "launching Firefox (NVIDIA-pinned, WebGPU) → $URL"
echo "  profile:    $PROFILE_DIR"
echo "  debug port: $DEBUG_PORT"

exec env \
  VK_ICD_FILENAMES="$NV_ICD" \
  __NV_PRIME_RENDER_OFFLOAD=1 \
  __GLX_VENDOR_LIBRARY_NAME=nvidia \
  MOZ_ENABLE_WAYLAND=1 \
  firefox \
    --new-instance \
    --profile "$PROFILE_DIR" \
    --remote-debugging-port "$DEBUG_PORT" \
    "$URL"
