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

PORT="${PORT:-8080}"
ARG="${1:-}"
case "$ARG" in
  http://*|https://*) URL="$ARG" ;;
  /*)                 URL="http://localhost:${PORT}${ARG}" ;;
  *)                  URL="http://localhost:${PORT}/${ARG}" ;;
esac

PROFILE_DIR="${GLYPH_FF_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/glyph3d-dev-firefox}"
DEBUG_PORT="${GLYPH_FF_DEBUG_PORT:-9222}"
NV_ICD="/usr/share/vulkan/icd.d/nvidia_icd.json"

[[ -f "$NV_ICD" ]] || echo "warning: $NV_ICD not found — Vulkan NVIDIA pin may not apply" >&2

# Detect the active monitor refresh rate (KDE/Wayland). Firefox on Linux/NVIDIA
# under-paces high-refresh displays and splits the frame rate across animating
# GL contexts (Mozilla bug 1720634), which shows up as severe frame jitter
# (e.g. 30↔140 fps on a 240Hz panel). Pinning layout.frame_rate to the real
# refresh gives Firefox a steady software frame clock instead of the buggy
# multi-context vsync source. Falls back to 60 if detection fails.
REFRESH_RAW=$(kscreen-doctor -o 2>/dev/null | grep -oE '@[0-9.]+\*' | tr -d '@*' | head -1 || true)
REFRESH=$(printf '%.0f' "${REFRESH_RAW:-60}")
{ [[ "$REFRESH" -ge 24 ]]; } 2>/dev/null || REFRESH=60

# Dedicated profile with forced prefs. user.js is re-applied on every startup,
# so this is self-healing even if the profile's prefs.js drifts.
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/user.js" <<'PREFS'
// WebGPU on Linux: gated + blocklisted by default. Force it on.
user_pref("dom.webgpu.enabled", true);
user_pref("gfx.webgpu.ignore-blocklist", true);
user_pref("gfx.webrender.all", true);
// Frame pacing on Linux/Wayland: native Wayland vsync (paired with the
// MOZ_ENABLE_WAYLAND launch env). layout.frame_rate is appended below,
// interpolated to the detected refresh.
user_pref("widget.wayland_vsync.enabled", true);
// Remote debugging for the dev loop (CDP + BiDi: screenshot / console relay).
user_pref("remote.enabled", true);
user_pref("remote.active-protocols", 3);
// Quieter dev startup.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.aboutConfig.showWarning", false);
PREFS
# Appended (not in the quoted heredoc) so $REFRESH interpolates.
printf 'user_pref("layout.frame_rate", %s);\n' "$REFRESH" >> "$PROFILE_DIR/user.js"

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
