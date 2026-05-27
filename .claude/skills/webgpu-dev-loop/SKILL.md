---
name: webgpu-dev-loop
description: The repeatable in-browser experiment loop for glyph3d's WebGPU rendering AND for profiling runtime behavior/perf you can't see from the sandbox — run a dev harness (Vite, or the Go --local server), drive the live instance, and read the browser console from a file so you iterate WITHOUT seeing the screen. Use when changing renderer/shader/r3f/binding code and verifying it renders, debugging "it loads but nothing shows," OR chasing a main-thread hang / load-unload stall / "feels slow when I do X."
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

- **`apps/home/`** — the Vite + bun r3f client (the promoted keystone; mounts the
  real `packages/glyph3d-core` / `packages/glyph3d-r3f` code + the command center).
  `cd apps/home && bun run dev` → Vite on `:5173`.
- **`apps/home/console-capture.js`** — a Vite plugin that injects a client shim
  forwarding `console.*` + `window.onerror` + unhandledrejection to
  `POST /__log`, appended to **`apps/home/console.log`**. Truncated on each server
  start. **You read this file** to see what happened in-browser.
- **`tools/dev-firefox.sh <url>`** — launches Firefox correctly for WebGPU on the
  dual-GPU box (NVIDIA Vulkan pin + `dom.webgpu.enabled` + frame-rate pin). A
  plain `firefox` launch crashes WebRender. See `reference_r3f_webgpu_integration`
  and `webgpu-dev-launch-firefox-dual-gpu` memory. (Pattern is browser-agnostic;
  only the Firefox launcher exists today — a Chromium variant could be added.)

## The loop

1. **Serve:** `cd apps/home && bun run dev` (background). Confirm `:5173` responds.
2. **Open:** ask the human to run `tools/dev-firefox.sh http://localhost:5173/`
   (or your target page). You can't launch their browser.
3. **Edit** source. Vite HMR auto-reloads for component/source edits.
4. **Read** `apps/home/console.log` — your eyes. Grep for your own
   `[home] …` / `[command-center] …` markers + `[error]`/`[uncaught]`.
5. **For visuals** (does it actually render? right colors? interactivity?), ask
   the human for a one-line report. Pixels are ground truth, not logs — see the
   `display-ground-truth` skill.

## Measure, don't theorize (profiling a runtime hang / perf issue)

The same "read the browser from a file" loop profiles behavior you can't see —
main-thread hangs, load/unload stalls, "feels slow when I move around." The trap
is reasoning about where the time goes; a confident wrong mechanism sends you on
a wrong rewrite. **Instrument the real thing, drive it, read the numbers.** This
loop found a 400ms camera-move stall in one session (commit `3b88399`):

1. **Instrument the suspected hot path** with `performance.now()` and a
   **gated** `console.log` — log ONLY on events that did real work or ran long
   (e.g. `if (didWork || ms > 2)`), never every frame, or the relay log drowns.
   Mark every temp line with a removable tag: `// [PERF-PROBE temp — remove after X]`.
2. **Drive the live instance from the CLI** — no human needed for input:
   `glyph3d-cli camera.fitall`, `camera.sim orbit|zoom|pan <args>`,
   `console.log "<marker>"`, any registered command. To exercise evict/reload,
   move away, `sleep` past the timer, move back.
3. **Read the timing** from the Go relay log: browser `console.*` is forwarded as
   `[browser:log] …`. Run the server as YOUR background task (a user-launched one
   hides stdout); grep your probe marker. One line often tells the whole story —
   here `[virt] update=421ms reload=242` was the entire diagnosis.
4. **Measure before AND after** the fix with the same probe + same drive sequence.
   Quote both numbers in the commit (400ms → ~20ms), then **strip the probe**
   (grep your tag to be sure none survive) and commit the fix clean.
5. **Distrust mechanism claims — verify the cheap way.** A sub-agent here blamed a
   "GPU readback fence stall"; the hot loop actually read `geometry.attributes.*.array`
   (a CPU-side typed array in RAM — no GPU sync). Reading the actual line refuted
   it in seconds. CPU stampede, not GPU stall → six-line fix, not a rewrite. See
   `feedback_crossref_verify_premises`.

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
files not in the apps/home Vite graph) without running it:

```
bun -e 'new Bun.Transpiler({loader:"jsx"}).transformSync(await Bun.file(process.argv[1]).text()); console.log("ok")' <file>
```

Core files (`packages/glyph3d-core/src/…`) are validated for free through the apps/home Vite graph
(curl them via `http://localhost:5173/@fs<abs-path>` and check for 200 + no
error string). App/command-handler files are NOT in that graph → syntax-check
with bun, and behavior-verify with an IDE smoke (`glyph3d-cli serve --local` +
`tools/dev-firefox.sh .../app/ide.html`).
