# Contributing to glyph3d-js

Thanks for your interest. This repo is organized around three things:

- **the package** — `packages/glyph3d-core` (`@glyph3d/core`, the publishable
  WebGPU text/code rendering library) + `packages/glyph3d-r3f` (react-three-fiber
  bindings).
- **the app** — `app/`, a react-three-fiber IDE that consumes the package, driven
  by a command bus (UI actions and the CLI hit the same handlers).
- **the cli** — `cli/`, a Go single binary that bakes in the built app and serves
  it alongside a WebSocket relay + sandboxed filesystem RPC.

## Prerequisites

- [Bun](https://bun.sh) (workspace package manager + dev runner)
- [Go](https://go.dev) ≥ 1.21 (only to build the `cli/` binary)
- A **WebGPU** browser. On Linux, plain Firefox can crash on WebGPU — use a
  Chromium-based browser (Chrome/Edge/Vivaldi) or a properly-configured Firefox.

## Setup

```bash
git clone https://github.com/tikimcfee/glyph3d-js.git
cd glyph3d-js
bun install
```

## Development loop

The app is a Vite project; the relay is the Go binary. `tools/dev.sh` manages both:

```bash
tools/dev.sh        # start Vite (:5173) + the relay (:8080)
tools/dev.sh status # what's running
tools/dev.sh vite   # restart Vite + clear its cache (after editing core/handlers)
tools/dev.sh relay  # rebuild + restart the Go relay
```

`make dev`, `make dev-vite`, `make dev-relay`, `make dev-status`, `make dev-stop`
are thin aliases over the same script. Open `http://localhost:5173`, and
**hard-reload** (Ctrl-Shift-R) after a Vite restart.

Drive the running app from the CLI — the same command bus the UI uses:

```bash
./glyph3d-cli grid.list
./glyph3d-cli file.open path/to/file.js
```

## Building

```bash
make build      # build the app (Vite) + bake it into the cli binary (~13M)
make all        # cross-compile linux/macOS/windows × amd64/arm64
cd app && bun run build    # just the app's production bundle (→ app/dist)
```

`./glyph3d-cli serve ~/your-project` then serves the built IDE + relay from the
single binary at `http://localhost:8080/`.

## Conventions

- **ES modules** throughout; **JSDoc** for types (no TypeScript).
- Shaders are **TSL** (Three.js Shading Language) NodeMaterials, not GLSL — the
  renderer is WebGPU (`three/webgpu`).
- Worker-compatible code in `packages/glyph3d-core/src/workers/builders/` must
  stay free of DOM/Three.js imports.
- **One render path** — there is no sync/async split; the worker-compatible
  builder is the way text is rendered.
- **No compatibility shims, no aliases.** Refactor cleanly and update every
  caller in the same change; an atomic rename is a forcing function that surfaces
  intent mismatches. Don't add re-export forwarders or dual code paths.
- **Command-bus-native.** If an action is missing, add a verb rather than reaching
  around the bus. UI is one-way state→view; it owns no behavior.

## Pull requests

1. Branch off `main`.
2. Keep changes focused; match the surrounding code's style and comment density.
3. Make sure `make build` is green and the dev loop still renders before opening
   the PR.
4. Describe what changed and how you verified it.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
