---
name: webgpu-dev-loop
description: The repeatable in-browser experiment loop for glyph3d's WebGPU rendering — run a Vite dev harness, launch a correctly-configured browser, and read the browser console from a file so you can iterate WITHOUT being able to see the screen yourself. Use whenever you're changing renderer/shader/r3f/binding code and need to verify it actually renders, or debugging "it loads but nothing shows."
argument-hint: "[page-url-or-path]"
user-invocable: true
effort: medium
---

# WebGPU dev loop

A self-service loop for experimenting on the WebGPU rendering stack when you (the
agent) cannot see pixels and have no node runtime in the sandbox. It turns the
human into a thin "reload + report visuals" step and gives you everything else.

## Why this exists

WebGPU only runs in a real GPU browser, not the agent sandbox. Without this loop
you're blind: you edit, ask the human to paste console output, and guess. With it,
you read the browser console from a file yourself and only need the human for a
reload and a one-line "what do you see."

## The pieces (in this repo)

- **`keystone/`** — a Vite + bun dev harness that mounts the real `src/` /
  `packages/glyph3d-r3f` code. `cd keystone && bun run dev` → Vite on `:5173`.
- **`keystone/console-capture.js`** — a Vite plugin that injects a client shim
  forwarding `console.*` + `window.onerror` + unhandledrejection to
  `POST /__log`, appended to **`keystone/console.log`**. Truncated on each server
  start. **You read this file** to see what happened in-browser.
- **`tools/dev-firefox.sh <url>`** — launches Firefox correctly for WebGPU on the
  dual-GPU box (NVIDIA Vulkan pin + `dom.webgpu.enabled` + frame-rate pin). A
  plain `firefox` launch crashes WebRender. See `reference_r3f_webgpu_integration`
  and `webgpu-dev-launch-firefox-dual-gpu` memory. (Pattern is browser-agnostic;
  only the Firefox launcher exists today — a Chromium variant could be added.)

## The loop

1. **Serve:** `cd keystone && bun run dev` (background). Confirm `:5173` responds.
2. **Open:** ask the human to run `tools/dev-firefox.sh http://localhost:5173/`
   (or your target page). You can't launch their browser.
3. **Edit** source. Vite HMR auto-reloads for component/source edits.
4. **Read** `keystone/console.log` — your eyes. Grep for your own
   `[keystone] …` markers + `[error]`/`[uncaught]`.
5. **For visuals** (does it actually render? right colors? interactivity?), ask
   the human for a one-line report. Pixels are ground truth, not logs — see the
   `display-ground-truth` skill.

## Sharp edges (learned the hard way)

- **HMR does NOT rebuild the renderer.** Changes to the `gl`/WebGPURenderer setup
  or `vite.config.js` need a **hard reload** (config changes auto-restart the
  server). State-y component changes HMR fine.
- **Stale Vite dep cache lies.** `node_modules/.vite/deps` can keep serving an OLD
  bundled version of a dep after you bump it. Verify *content*, not just the
  installed version: `grep -c "<known-new-token>" node_modules/.vite/deps/<dep>.js`.
  Reset clean: clear `.vite` in its own command, then `vite --force`. (A `pkill`
  in the same command can signal your own shell before the `rm` runs — separate
  the steps; kill by port via `lsof -ti:5173`.)
- **Don't leave stray servers.** One dev server. Kill by port, not `pkill -f vite`
  (that also matches your own command line → false "still alive").

## Syntax-check without node

`bun` is the only JS runtime here. To parse/transpile-check a file (esp. app
files not in the keystone graph) without running it:

```
bun -e 'new Bun.Transpiler({loader:"jsx"}).transformSync(await Bun.file(process.argv[1]).text()); console.log("ok")' <file>
```

Core files (`src/…`) are validated for free through the keystone Vite graph
(curl them via `http://localhost:5173/@fs<abs-path>` and check for 200 + no
error string). App/command-handler files are NOT in that graph → syntax-check
with bun, and behavior-verify with an IDE smoke (`glyph3d-cli serve --local` +
`tools/dev-firefox.sh .../app/ide.html`).
