import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber'],
  },
  optimizeDeps: {
    exclude: ['@glyph3d/core', '@glyph3d/r3f'],
    include: ['@xterm/headless/lib-headless/xterm-headless.mjs'],
  },
  worker: { format: 'es' },
  server: {
    // Its own port so the wall runs beside the IDE (5173) without colliding.
    port: Number(process.env.VITE_PORT) || 5180,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
