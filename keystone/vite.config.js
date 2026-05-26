import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { consoleCapture } from './console-capture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

// The ONE intentional alias: serve the WebGPU build of three for BOTH `three`
// and `three/webgpu`. The webgpu build is a superset (it carries WebGPURenderer
// + the node-material/TSL system), and pointing both specifiers at the same file
// guarantees a SINGLE three module instance across r3f, the bindings, and the
// core (otherwise instanceof/hook checks across the boundary break). Resolved via
// node so it works wherever three is hoisted (workspace root, not hardcoded).
const threeWebGPU = require.resolve('three/webgpu');

// Everything else (react, react-dom, @react-three/fiber, glyph3d-js, glyph3d-r3f)
// resolves natively through the bun workspace's node_modules symlinks + each
// package's exports map. No alias reinvention of module resolution.
export default defineConfig({
  plugins: [react(), consoleCapture()],
  resolve: {
    alias: [
      { find: /^three$/, replacement: threeWebGPU },
      { find: /^three\/webgpu$/, replacement: threeWebGPU },
    ],
    // Single instance of these even if a transitive dep pulls its own copy.
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber'],
  },
  server: {
    // Workspace packages + the core's font asset resolve to real paths under the
    // repo root (via node_modules symlinks); allow Vite to serve them.
    fs: { allow: [repoRoot] },
  },
});
