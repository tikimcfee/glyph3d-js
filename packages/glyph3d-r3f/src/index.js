// @glyph3d/r3f — react-three-fiber bindings for the WebGPU glyph rendering stack.
//
// Composable primitives, not a monolithic wrapper:
//   useGlyphEngine / bootGlyphEngine  — boot atlas + shaper + slug (renderer-free)
//   <GlyphCanvas atlas>               — r3f Canvas wired for WebGPURenderer
//   <CodeGrid text filename .../>     — a file rendered as a 3D body
//   <ViewerCamera />                  — fly camera (pan/look/dolly/WASD) on the active camera
//   <SceneEnvironment />              — ground grid + gradient skydome (orientation landmarks)
//   useGlyphAtlas / useGridRegistry   — context accessors for custom components

export { bootGlyphEngine, DEFAULT_ENGINE_OPTIONS } from './glyphEngine.js';
export { useGlyphEngine } from './useGlyphEngine.js';
export { default as GlyphCanvas } from './GlyphCanvas.jsx';
export { default as CodeGrid } from './CodeGrid.jsx';
export { default as ViewerCamera } from './ViewerCamera.jsx';
export { default as SceneEnvironment } from './SceneEnvironment.jsx';
export { GlyphProvider, useGlyphAtlas, useGridRegistry } from './context.jsx';
