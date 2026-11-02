#!/usr/bin/env sh
# verify-staged.sh — run the headless gates on the git INDEX alone: what a commit would hold, without
# the working tree's other in-flight edits (several sessions or helpers share one tree; you stage only
# your hunks — this proves the staged snapshot stands on its own).
#
#   tools/verify-staged.sh [test-name ...]     e.g. tools/verify-staged.sh carrel-plane overlay
#   (no names: every tools/*.test.mjs; GLYPH_STAGED_DIR picks the scratch dir, default $TMPDIR)
#
# The snapshot gets its own node_modules: every package links to the worktree's, EXCEPT @glyph3d/*,
# which point at the snapshot's own packages — otherwise an app module's '@glyph3d/core/…' import
# loads the worktree's copy beside the test's relative import of the snapshot's, two instances of one
# module (two SceneTransforms, two symbol sets) and a false failure.
set -eu
WT=$(git rev-parse --show-toplevel)
I=${GLYPH_STAGED_DIR:-${TMPDIR:-/tmp}/glyph3d-staged}
rm -rf "$I"
git -C "$WT" checkout-index -a --prefix="$I/"
mkdir -p "$I/node_modules"
for e in "$WT"/node_modules/* "$WT"/node_modules/.bin; do
  n=$(basename "$e"); [ "$n" = "@glyph3d" ] && continue
  ln -s "$e" "$I/node_modules/$n"
done
mkdir -p "$I/node_modules/@glyph3d"
ln -s ../../packages/glyph3d-core "$I/node_modules/@glyph3d/core"
ln -s ../../packages/glyph3d-r3f "$I/node_modules/@glyph3d/r3f"
[ -d "$WT/app/public" ] && ln -s "$WT/app/public" "$I/app/public"
[ -d "$WT/app/node_modules/.vite" ] && mkdir -p "$I/app/node_modules" && cp -r "$WT/app/node_modules/.vite" "$I/app/node_modules/.vite"
mkdir -p "$I/cli/web" && : > "$I/cli/web/index.html"
cd "$I"
if [ $# -gt 0 ]; then list=$(for t in "$@"; do echo "tools/$t.test.mjs"; done); else list=$(ls tools/*.test.mjs); fi

VITE_PID=""
cleanup() {
  if [ -n "$VITE_PID" ]; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ -z "${GLYPH_VITE_URL:-}" ] && grep -q "GLYPH_VITE_URL" $list 2>/dev/null; then
  SCRATCH_PORT=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);')
  (cd "$I/app" && VITE_PORT="$SCRATCH_PORT" "$I/node_modules/.bin/vite" >/dev/null 2>&1) &
  VITE_PID=$!
  export GLYPH_VITE_URL="http://localhost:$SCRATCH_PORT"
  for _ in $(seq 1 100); do
    bun -e "const r = await fetch('$GLYPH_VITE_URL/__glyph-boot.json').catch(() => null); process.exit(r?.ok ? 0 : 1);" && break
    sleep 0.1
  done
fi

pass=0; fail=0
for f in $list; do
  if timeout 150 bun "$f" >/dev/null 2>&1; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL $f"; fi
done
echo "staged snapshot: $pass passed, $fail failed"
bun -e "await import('$I/app/commands/handlers/index.js'); console.log('handlers index loads')" 2>&1 | tail -1
[ "$fail" -eq 0 ]
