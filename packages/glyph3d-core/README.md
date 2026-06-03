# @glyph3d/core

High-performance **3D text and code rendering** for [Three.js](https://threejs.org/),
using GPU-instanced glyphs on a WebGPU renderer. Thousands of glyphs in a single
draw call — the rendering core behind the [glyph3d-js](https://github.com/tikimcfee/glyph3d-js)
project.

> `v0.1.0`, pre-release — the API is still settling.

## Install

```bash
bun add @glyph3d/core three
# three is a peer dependency; the renderer targets WebGPU (three/webgpu)
```

## What it provides

- **GPU-instanced rendering** via `InstancedBufferGeometry` — one draw call for
  thousands of glyphs.
- **WebGPU / TSL** NodeMaterials (no GLSL).
- **Vector glyphs** — HarfBuzz shaping + Slug GPU bezier coverage, a font fallback
  chain, and color-emoji support.
- **CodeGrid / TerminalGrid** — source files and tmux-backed terminals as
  navigable 3D objects, with layout managers, in-place editing, and highlighting.
- **WorkerBridge** — buffer computation parallelized off the main thread.

## Entry points

```javascript
import { ... } from '@glyph3d/core';               // main entry
import { ... } from '@glyph3d/core/collections';    // CodeGrid, TerminalGrid, layout managers
import { ... } from '@glyph3d/core/workers';        // WorkerBridge
import { ... } from '@glyph3d/core/shaping';         // HarfBuzz + Slug shaping
import { ... } from '@glyph3d/core/services/...';    // interaction, camera, data, orchestration, …
```

See `package.json` `exports` for the full map, and the
[`app/`](https://github.com/tikimcfee/glyph3d-js/tree/main/app) project for a
complete react-three-fiber consumer.

## License

MIT © tikimcfee — see [LICENSE](./LICENSE).
