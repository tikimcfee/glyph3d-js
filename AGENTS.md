# AGENTS.md — Development Invariants & Guidelines for glyph3d-js

## 1. WebGL2 Instanced Rendering & GPU Resource Management
- **InstancedMesh Disposal**: When disposing any `THREE.InstancedMesh` (or classes wrapping one), always call `mesh.dispose()` in addition to `mesh.geometry.dispose()` and `mesh.material.dispose()`. In Three.js, `InstancedMesh.dispose()` is required to free the internal `instanceMatrix` and `instanceColor` GPU buffer attributes.
- **Color Packing Invariant**: When packing numeric hex colors into 32-bit uint/RGBA vertex-instanced attributes (e.g. in `LayoutGenerator` or `InstancedSlotBuffer`), always pack the alpha byte (`| 0xFF000000` or `| (alpha << 24)`). Unpacked hex values leave `0x00` in the alpha byte, causing content to render completely invisible.
- **Z-Fighting Prevention**: On layered planar 3D surfaces (labels, tabs, background plates), always enforce a small positive local offset (`instanceMesh.position.z = 1 / s` or `+1 unit`) to prevent co-planar Z-fighting.

## 2. WebGL2 vs WebGPU Runtime Seams
- **Context Loss Handling**: On `THREE.WebGLRenderer`, context loss is dispatched as a DOM event `webglcontextlost` on `renderer.domElement`. Event listeners must call `event.preventDefault()` to allow WebGL context recovery/reload. Keep this paired with `renderer.onDeviceLost` for WebGPU compatibility.
- **Hardware Occlusion Culling**: Hardware occlusion queries (`renderer.isOccluded()`) are WebGPU-exclusive in Three.js. Never assume `isOccluded` exists; always guard queries with `typeof renderer?.isOccluded === 'function'` and gracefully disable culling under WebGL2.

## 3. Core Engine Architecture & Embeddability
- **Framework Agnosticism**: `@glyph3d/core` must have zero UI framework dependencies (no React, no DOM window globals where headless/Node/worker execution is possible).
- **Self-Contained Bootstrapping**: Engine bootstrapping functions (`bootGlyphEngine`), defaults (`DEFAULT_ENGINE_OPTIONS`), and core ranges (`LARGE_CORE_RANGES`) belong in `@glyph3d/core`. `@glyph3d/r3f` is strictly a thin React wrapper over them — consumers import them from core (no re-exports).
- **Single Source of Layout Metrics**: Never hardcode font/glyph dimensions or character pitch. Font advances and line pitches must derive from the font chain and HarfBuzz shaper at runtime via `deriveCharSize` / `computeCellMetrics`.
