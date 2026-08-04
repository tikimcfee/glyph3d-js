import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..'); // app → repo root
const require = createRequire(import.meta.url);

// The boot stamp — the page's answer to "what code am I running?". In DEV the tree moves
// under a long-lived server (hot reloads, shared checkouts), so the stamp is fetched live
// per page load from the middleware below; a baked-at-server-start value would lie. In the
// PRODUCTION build there is no server — the stamp is baked via define (build time IS the
// version for the embedded binary).
const gitStamp = () => {
  const run = (cmd) => execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return { hash: run('git rev-parse --short HEAD'), branch: run('git rev-parse --abbrev-ref HEAD'),
      dirty: run('git status --porcelain').length > 0, at: new Date().toISOString() };
  } catch {
    return { hash: 'unknown', branch: 'unknown', dirty: true, at: new Date().toISOString() };
  }
};
const bootStampPlugin = {
  name: 'glyph-boot-stamp',
  configureServer(server) {
    server.middlewares.use('/__glyph-boot.json', (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(gitStamp()));
    });
  },
};

// The ONE intentional alias: serve the WebGPU build of three for BOTH `three`
// and `three/webgpu`. The webgpu build is a superset (it carries WebGPURenderer
// + the node-material/TSL system), and pointing both specifiers at the same file
// guarantees a SINGLE three module instance across r3f, the bindings, and the
// core (otherwise instanceof/hook checks across the boundary break). Resolved via
// node so it works wherever three is hoisted (workspace root, not hardcoded).
const threeWebGPU = require.resolve('three/webgpu');

// Everything else (react, react-dom, @react-three/fiber, @glyph3d/core, @glyph3d/r3f)
// resolves natively through the bun workspace's node_modules symlinks + each
// package's exports map. No alias reinvention of module resolution.
export default defineConfig({
  // Where the build will be MOUNTED. Default '/' serves dev and the cli-embedded
  // build (binary serves at root); the hosted IDE lives under glyph3d.dev/ide/,
  // so its deploy builds with GLYPH_BASE=/ide/ (see `make deploy-ide`).
  base: process.env.GLYPH_BASE || '/',
  plugins: [react(), bootStampPlugin],
  define: {
    __GLYPH_BOOT_BUILD__: JSON.stringify(gitStamp()),
  },
  resolve: {
    alias: [
      { find: /^three$/, replacement: threeWebGPU },
      { find: /^three\/webgpu$/, replacement: threeWebGPU },
    ],
    // Single instance of these even if a transitive dep pulls its own copy.
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber'],
  },
  // The dep optimizer is the source of the "clear .vite + restart" tax. Two rules
  // keep its shape right:
  //   exclude — @glyph3d/core / @glyph3d/r3f are SOURCE (symlinked workspace pkgs),
  //     not frozen deps; never pre-bundle them, so edits hot-reload instead of being
  //     served stale from .vite/deps.
  //   include — pre-declare the real npm deps those source pkgs pull in (the
  //     @xterm/headless deep ESM import) so adding one doesn't trigger a mid-session
  //     re-optimize + surprise full reload (the dance we kept hitting).
  optimizeDeps: {
    exclude: ['@glyph3d/core', '@glyph3d/r3f'],
    include: ['@xterm/headless/lib-headless/xterm-headless.mjs'],
  },
  server: {
    // Port is env-overridable so an isolated worktree (e.g. experiment/gpu-sweep)
    // can run its own dev server alongside main's without colliding. Defaults to
    // 5173 so the normal checkout is unchanged. strictPort = fail loudly instead
    // of silently drifting to 5174 (which would break the A/B port assumptions).
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    // Workspace packages + the core's font asset resolve to real paths under the
    // repo root (via node_modules symlinks); allow Vite to serve them.
    fs: { allow: [repoRoot] },
  },
});
