# glyph3d-js

High-performance **3D text and code rendering** for [Three.js](https://threejs.org/),
using GPU-instanced glyphs on a WebGPU renderer. Thousands of glyphs in a single
draw call — built for navigating source code, directory trees, and live terminals
in 3D space.

> Status: `v0.1.0`, pre-release. The core library API is still settling.

## What's in here

This is a monorepo organized as **a package, an app, and a cli**:

| | Path | What it is |
|---|---|---|
| **Package** | `packages/glyph3d-core` | [`@glyph3d/core`](packages/glyph3d-core) — the renderer + glyph atlas + layout + code/terminal grids. The publishable library. |
| | `packages/glyph3d-r3f` | react-three-fiber bindings for the core. |
| **App** | `app/` | A react-three-fiber IDE that consumes the package — file tree + 3D code grids + terminals, driven by a command bus. |
| **CLI** | `cli/` | A Go single binary: bakes in the built app and serves it alongside a WebSocket relay + sandboxed filesystem RPC. |

## Features

- **GPU-instanced rendering** — thousands of glyphs in one `InstancedBufferGeometry`
  draw call.
- **WebGPU / TSL** — renders through `three/webgpu` with Three.js Shading Language
  NodeMaterials (no GLSL).
- **Vector glyphs** — HarfBuzz shaping + Slug GPU bezier coverage for crisp text at
  any scale, plus a font fallback chain and color-emoji support.
- **CodeGrid** — a source file as a navigable 3D object (background, label, spatial
  bounds, in-place editing, highlight ranges).
- **Terminals in 3D** — tmux-backed terminal grids rendered as first-class objects.
- **Command bus** — every action is a verb; UI clicks and the CLI hit the same
  handlers.
- **Web Worker parallelization** — buffer computation off the main thread.

## Install (library)

```bash
bun add @glyph3d/core three
# three is a peer dependency
```

The renderer targets WebGPU, so use `three/webgpu`. For a complete, working
consumer of the library, see the **`app/`** project (a react-three-fiber client).
The package's entry points:

```javascript
import { ... } from '@glyph3d/core';               // main entry
import { ... } from '@glyph3d/core/collections';    // CodeGrid, TerminalGrid, layout managers
import { ... } from '@glyph3d/core/workers';        // WorkerBridge
import { ... } from '@glyph3d/core/shaping';         // HarfBuzz + Slug shaping
import { ... } from '@glyph3d/core/services/...';    // interaction, camera, data, orchestration, …
```

(See `packages/glyph3d-core/package.json` for the full `exports` map.)

## Run the app (single binary)

```bash
make build                       # build the app + bake it into the binary (~13M)
./glyph3d-cli serve ~/your-project
# open http://localhost:8080/
```

The binary is self-contained — it serves the built IDE and runs the relay +
filesystem RPC for a single operator (no auth; designed for personal/dev use).

## Development

```bash
git clone https://github.com/tikimcfee/glyph3d-js.git
cd glyph3d-js
bun install
tools/dev.sh        # Vite dev server (:5173) + Go relay (:8080)
```

Open `http://localhost:5173` (hard-reload after a Vite restart). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full dev loop, build, and conventions.

## Performance

| Metric | Value |
|--------|-------|
| Atlas generation | ~200ms (one-time) |
| Buffer building | Parallel via Web Workers |
| Rendering | Single instanced draw call |
| Max instances per mesh | 10,000 (auto-splits beyond) |
| Target | 60fps with 100,000+ glyphs |

## Browser support

Requires **WebGPU**. Works in current Chrome / Edge / Vivaldi. On Linux, plain
Firefox may crash on WebGPU — prefer a Chromium-based browser or a
properly-configured Firefox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Credits

Inspired by [SwiftGlyph](https://github.com/nicklockwood/SwiftGlyph) and the need
for high-performance text rendering in web-based code visualization tools.
