import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..'); // apps/demo → repo root
const require = createRequire(import.meta.url);

// Mirror of apps/home's config (the keystone). The ONE intentional alias: point
// both `three` and `three/webgpu` at the WebGPU build (a superset carrying
// WebGPURenderer + TSL), so there's a SINGLE three instance across r3f, the
// bindings, and the core — otherwise instanceof/hook checks across the boundary
// break.
const threeWebGPU = require.resolve('three/webgpu');

export default defineConfig({
  // Relative base so the built bundle works when iframed under a subpath
  // (e.g. glyph3d.dev embeds /demo/) rather than only at domain root.
  base: './',
  // Multi-page: index.html (the rotation-title hero) + tour.html (the
  // core-features tour). glyph3d.dev iframes both, live — no captured video.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(here, 'index.html'),
        tour: path.resolve(here, 'tour.html'),
        play: path.resolve(here, 'play.html'),
        shell: path.resolve(here, 'shell.html'),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^three$/, replacement: threeWebGPU },
      { find: /^three\/webgpu$/, replacement: threeWebGPU },
    ],
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber'],
  },
  optimizeDeps: {
    // @glyph3d/core & glyph3d-r3f are symlinked SOURCE workspaces — never
    // pre-bundle them. Pre-declare the deep npm deps they pull so the optimizer
    // doesn't re-trigger mid-session.
    exclude: ['@glyph3d/core', 'glyph3d-r3f'],
    include: ['@xterm/headless/lib-headless/xterm-headless.mjs'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
