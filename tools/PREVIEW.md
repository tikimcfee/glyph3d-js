# Preview & screenshot loop (agent-drivable)

How to run a glyph3d web app in a real GPU browser and **read the pixels back**
without a human — for verifying WebGPU renders actually land. Companion to the
`webgpu-dev-loop` skill (that one uses Firefox + a console-log file; this one
uses Vivaldi + CDP screenshots, which is simpler when you just need to *see* it).

## Tools

- **`tools/web-preview.sh [url] [port]`** — launches Vivaldi (Chromium-family)
  with WebGPU forced on and a remote-debugging port, in a throwaway profile so it
  never touches your real browser session. Vivaldi renders WebGPU out of the box
  here (no Vulkan single-GPU pin, unlike Firefox / `dev-firefox.sh`).
- **`tools/cdp-shot.mjs <out.png> [port] [urlMatch]`** — `bun` script that pulls
  a PNG straight from the browser via the remote-debugging protocol. Captures the
  rendered page even when the window isn't focused.
- **`tools/capture.mjs <url> <outDir> [name]`** — `bun` + Playwright: records a
  looping **video** + stills while scripting the real controls (orbit/zoom/type).
  This is the "live-generate the glyph3d.dev media" pipeline — re-runnable, points
  at any glyph3d URL (the hero, or the full app once the binary serves it).
  Playwright bundles Chromium + ffmpeg, so no extra installs; runs headed for
  WebGPU. Example: `bun tools/capture.mjs http://127.0.0.1:5181/ media hero`.

## The loop

```bash
# 1. Serve the app on an EXPLICIT, free port + IPv4 host (see gotcha below).
cd apps/hero && bun run dev -- --port 5180 --strictPort --host 127.0.0.1 &
curl -s http://127.0.0.1:5180/ | grep -i '<title>'    # confirm it's the app you think

# 2. Launch the preview browser with a debug port (once).
tools/web-preview.sh http://127.0.0.1:5180/ 9222

# 3. Open the target as a fresh tab (the launcher may land on a welcome page).
curl -s -X PUT "http://localhost:9222/json/new?http://127.0.0.1:5180/"
sleep 10                                               # atlas gen + WebGPU first frame

# 4. Grab pixels and read them.
bun tools/cdp-shot.mjs /tmp/shot.png 9222 "127.0.0.1:5180"
#   → then Read /tmp/shot.png

# Re-shoot after a construction-time change (camera/textColor/worldScale need a
# real remount, not HMR): close the stale tab, open a fresh one, re-shoot.
for id in $(curl -s http://localhost:9222/json | jq -r '.[]|select(.url|test("5180")).id'); do
  curl -s "http://localhost:9222/json/close/$id" >/dev/null; done
```

## Gotchas (learned the hard way)

- **`localhost` + IPv6 collision.** If another vite/server already holds `:5173`
  on `::1` (e.g. the IDE dev server), a second vite can still bind `127.0.0.1:5173`
  (different address family). `localhost` then resolves to `::1` first, so your
  browser hits the *other* server and you screenshot the wrong app. **Fix:** pick
  a distinct port with `--strictPort` and address it as `127.0.0.1`, not
  `localhost`. The pixels caught this; the vite log (which said `:5173 ready`) did
  not — server state isn't ground truth, pixels are.
- **Vivaldi welcome tab.** The launcher may foreground a welcome page; always open
  your URL via `PUT /json/new` and match on the URL substring when screenshotting.
- **Construction-time props don't HMR.** `<CodeGrid>` `textColor`/`worldScale`/
  `showBackground` and `<GlyphCanvas camera>` apply on mount only — reload the tab
  to see changes, don't trust hot-reload for those.
- **Cleanup.** `web-preview.sh` and the vite server are backgrounded; kill them
  when done (`pkill -f glyph3d-preview-profile`, and the vite PID). Don't kill
  servers you didn't start.
