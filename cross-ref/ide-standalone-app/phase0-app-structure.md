# Phase 0: Standalone App Directory Structure

## Directory Tree

```
/app                          # Root app directory (production at ivanlugo.dev/ide)
├── index.html                # Entry point (importmap, bootstrap script)
├── ide.html                  # Main IDE layout (replaces examples/ide/ide.html)
├── ide.css                   # IDE styling (copied from examples/ide/)
├── manifest.json             # PWA manifest (optional)
├── favicon.ico
│
├── components/               # App-specific UI components
│   ├── IDEShell.js          # Orchestrator (from examples/ide/)
│   ├── CommandBar.js        # Command input (from examples/ide/components/)
│   └── LogCapturePanel.js   # Log display (from examples/ide/ or linked)
│
├── lib/                      # Thin wrappers & compatibility shims
│   ├── drawer-shim.js       # DrawerController compatibility layer
│   ├── platform-compat.js   # Re-export platform utils from src/
│   └── encoding-compat.js   # Re-export websocket utils from examples/github-viewer/
│
├── ws-relay.js              # (symlink or copy from root/examples/github-viewer/)
├── ws-relay.mjs             # or move here
│
└── static/                   # Runtime assets (images, fonts, etc.)
    └── fonts/
```

## Design Decisions

### 1. Directory Location: `app/` at project root

**Choice**: `app/` (not `ide/`) to future-proof for other standalone apps.

**Rationale**: 
- IDE is the first standalone app extracted; naming it `app/` leaves room for CLI tools, web dashboard, etc.
- Sits at project root (alongside `src/`, `examples/`, `docs/`) for clarity.
- Served via Caddy at `ivanlugo.dev/ide` with reverse proxy config (not directory name).

### 2. HTML Entry Point & ImportMap Strategy

**File**: `app/index.html`

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>glyph3d IDE</title>
    <link rel="stylesheet" href="./ide.css">
    
    <script type="importmap">
    {
        "imports": {
            "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
            
            "glyph3d": "../src/index.js",
            "glyph3d/services": "../src/services/index.js",
            "glyph3d/utils": "../src/utils/index.js",
            "glyph3d/collections": "../src/collections/index.js",
            
            "github-viewer/": "../examples/github-viewer/",
            
            "platform": "./lib/platform-compat.js",
            "encoding": "./lib/encoding-compat.js"
        }
    }
    </script>
</head>
<body>
    <div id="app-root"></div>
    <script type="module" src="./bootstrap.js"></script>
</body>
</html>
```

**Why relative paths to `../src/`**:
- App is at `app/` and src is at project root `src/` → `../src/` resolves correctly
- When served via Caddy at `/ide/`, the path resolution uses file system, not URL structure
- Importmap specifiers allow aliasing: `glyph3d` → `../src/index.js`

### 3. Bootstrap Flow: `bootstrap.js`

A new file that orchestrates init (replaces inline script in `ide.html`):

```javascript
// app/bootstrap.js
import * as THREE from 'three';
import { GitHubRepoViewer } from 'github-viewer/GitHubRepoViewer.js';
import { IDEShell } from './components/IDEShell.js';
import CommandBar from './components/CommandBar.js';

document.addEventListener('DOMContentLoaded', async () => {
    const canvas = document.getElementById('canvas');
    const ide = new IDEShell();
    ide.injectPanelContent();
    
    const viewer = new GitHubRepoViewer(canvas, THREE);
    ide.attachViewer(viewer);
    // ... rest of init
});
```

### 4. Import Path Mapping

**Problem**: IDE files import from broken paths:
- `IDEShell.js` imports from `../github-viewer/platform.js` (doesn't exist — moved to src)
- `CommandBar.js` imports from `../../github-viewer/websocket/commands/encoding.js`

**Solution**: Use importmap + compatibility shims:

| Old Path | New Path | Via Importmap Alias |
|----------|----------|---------------------|
| `../github-viewer/platform.js` | `src/services/utils/platform.js` | `import { primaryMod } from 'platform'` |
| `../../github-viewer/websocket/commands/encoding.js` | (stays in examples/github-viewer/) | `import { encodeBase64 } from 'encoding'` |

**app/lib/platform-compat.js**:
```javascript
// Re-export from src/services/utils/platform.js
export { isMac, isLinux, primaryMod, secondaryMod } from 'glyph3d/services';
```

**app/lib/encoding-compat.js**:
```javascript
// Import stays in examples/github-viewer/ but re-exported via compat layer
export { encodeBase64 } from 'github-viewer/websocket/commands/encoding.js';
```

### 5. Serving Via Python or Caddy

#### Python (local dev, testing):
```bash
cd /home/user/dev/glyph3d-js
python3 -m http.server 8000
# Access: http://localhost:8000/app/
```

Relative paths work because Python serves from project root.

#### Caddy (production at ivanlugo.dev/ide):
```caddy
ivanlugo.dev {
    route /ide/* {
        uri strip_prefix /ide
        file_server {
            root /home/user/dev/glyph3d-js/app
        }
        
        # Fallback for SPA routes
        try_files {path} /index.html
    }
    
    route /relay {
        # Proxy to ws-relay.js (separate process)
        reverse_proxy localhost:9000
    }
}
```

**How it works**:
1. Request: `GET ivanlugo.dev/ide/`
2. Strip `/ide` prefix → request becomes `/`
3. Root is set to `/app` → serves `/app/index.html`
4. ImportMap resolves `../src/` → file system path `/src/`
5. ImportMap resolves `../examples/github-viewer/` → file system path `/examples/github-viewer/`

### 6. Component Files: Stay in `app/components/`

Move or symlink from `examples/ide/`:
- `IDEShell.js` → `app/components/IDEShell.js`
- `CommandBar.js` → `app/components/CommandBar.js` (already in subfolder)
- `LogCapturePanel.js` → `app/components/LogCapturePanel.js` (or import from examples)

**Imports within app/components/**:
```javascript
// IDEShell.js (in app/components/)
import { logCapturePanelHTML } from 'github-viewer/components/LogCapturePanel.js';
import { diffPanelHTML } from 'github-viewer/components/DiffPanel.js';
import { primaryMod } from 'platform';  // via compat alias
```

### 7. WebSocket Relay & CLI Tools

**Relay Location**: `/relay.js` (project root, unchanged)

**Update scripts in package.json**:
```json
{
  "scripts": {
    "serve": "python3 -m http.server 8000",
    "serve:app": "python3 -m http.server 8000 --directory app",
    "ws": "node relay.js",
    "cli": "node examples/github-viewer/cli/glyph-cli.mjs"
  }
}
```

**For production**: Caddy proxies `/relay` to relay service on separate port.

### 8. Static Assets & PWA

Optional: Add to `app/static/`:
- Images, fonts, icons
- `manifest.json` for PWA support
- Service worker (if offline support needed)

### 9. No Build Step

Files are served as ES modules directly:
- No bundling
- No transpilation
- Dev server or Caddy handles path resolution
- Source maps work natively

## Import Path Cheat Sheet

From within `app/` (e.g., `app/components/IDEShell.js`):

```javascript
// Core library (via importmap)
import { GlyphAtlas, CodeGrid } from 'glyph3d';
import { primaryMod } from 'glyph3d/services';

// Compat aliases (via importmap)
import { primaryMod } from 'platform';
import { encodeBase64 } from 'encoding';

// Direct github-viewer imports (when needed)
import { GitHubRepoViewer } from 'github-viewer/GitHubRepoViewer.js';
import { Drawer } from 'github-viewer/components/Drawer.js';

// Relative paths (for local app files)
import CommandBar from './CommandBar.js';
```

## Migration Checklist

1. [ ] Create `/app` directory at project root
2. [ ] Copy `examples/ide/{ide.html, ide.css}` → `app/`
3. [ ] Rename inline `<script type="module">` in `ide.html` to `bootstrap.js`
4. [ ] Create `app/index.html` with importmap
5. [ ] Create `app/lib/{platform-compat.js, encoding-compat.js}`
6. [ ] Move/copy IDE components to `app/components/`
7. [ ] Update imports in all component files
8. [ ] Add Caddy config for `/ide` route (if not present)
9. [ ] Update `package.json` scripts
10. [ ] Test locally: `python3 -m http.server 8000` → `http://localhost:8000/app/`
11. [ ] Test on production Caddy server

## Future: Other Standalone Apps

Structure supports adding more apps without conflict:

```
/app           # IDE (current)
/dashboard     # (future web dashboard)
/tools         # (future utility app)
```

Each would:
- Have own `index.html` with importmap
- Share `../src/` imports
- Have own `lib/` for compatibility shims if needed
- Be served at `ivanlugo.dev/{app,dashboard,tools}`
