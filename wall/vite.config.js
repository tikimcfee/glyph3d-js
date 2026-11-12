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
    // Its own page port, so its Vite and the IDE's (5173) can both serve. The RELAY is another matter:
    // both default to :8080 and a relay takes one display, so beside the IDE the wall needs its own
    // relay (?relay=PORT; main.jsx) — on a shared one, whichever page connects second is refused.
    port: Number(process.env.VITE_PORT) || 5180,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
