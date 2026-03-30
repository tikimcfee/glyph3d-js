# Phase 0: Deployment Analysis -- IDE Extraction to `app/ide/`

Agent perspective: **deployment** (serving, URL paths, config, dev workflow)

---

## 1. Current State

| Aspect | Detail |
|---|---|
| IDE files | `examples/ide/` (5 files: ide.html, ide.css, index.html, IDEShell.js, components/CommandBar.js) |
| Dev server | `python3 -m http.server 8000` from project root (`npm run serve`) |
| Dev URL | `http://localhost:8000/examples/ide/` (index.html meta-redirects to ide.html) |
| Production URL | `https://ivanlugo.dev/ide` via Caddy reverse proxy on the host |
| Build step | None. Files served as-is. |
| Deployment config in repo | **None found.** No Caddyfile, nginx.conf, docker-compose, Dockerfile, or .service file exists in the repository. Caddy config lives on the server. |

## 2. Target Directory: `app/ide/` (Recommended)

### Why `app/ide/` over `/ide/`

Placing the IDE at `app/ide/` rather than a bare top-level `ide/` directory:

- **Avoids polluting the project root.** The root already has `src/`, `examples/`, `cross-ref/`. A top-level `ide/` sits at the same level as `src/` and looks like a source directory. `app/` is a conventional container for runnable applications.
- **Allows future apps.** If a second app ships (e.g., `app/spectrometer/`), the pattern is already established.
- **Dev URL becomes** `http://localhost:8000/app/ide/` -- clean, clear, not confused with source code.
- **Production URL remains** `https://ivanlugo.dev/ide` -- Caddy maps `/ide` to whatever filesystem path it needs. The external URL does not change.

### Why NOT `/ide/` at root

- A bare `/ide/` directory means the dev URL is `localhost:8000/ide/`, which is slightly shorter, but adds a top-level directory with HTML/CSS alongside `src/`. This is a style concern, not a blocker.
- If you strongly prefer the shorter dev URL, `/ide/` works just as well technically.

---

## 3. URL Path Changes

### 3a. Development (python3 HTTP server)

| Before | After |
|---|---|
| `localhost:8000/examples/ide/` | `localhost:8000/app/ide/` |
| `localhost:8000/examples/ide/ide.html` | `localhost:8000/app/ide/ide.html` |

The python HTTP server serves anything under the project root. No server config change needed. Both paths work immediately after the file move.

### 3b. Production (Caddy on the host)

The Caddy config is **not in this repository**, so the exact directive is unknown. However, it almost certainly does one of:

1. **`reverse_proxy`** to the python HTTP server, then a `rewrite` or `handle_path /ide/*` maps to the filesystem path. In this case, only the Caddy rewrite target path changes from `/examples/ide/` to `/app/ide/`.

2. **`file_server`** pointing at the repo checkout directly. Same change: update the `root` or `rewrite` to point to `app/ide/` instead of `examples/ide/`.

3. **`try_files` / `handle`** with a path matcher. Same pattern.

**Action required:** SSH into the the host instance, find the Caddyfile (likely `/etc/caddy/Caddyfile` or `~/Caddyfile`), and update the path. The external URL `ivanlugo.dev/ide` does NOT change -- only the internal mapping does.

### 3c. URL-driven auto-load (ide.html lines 293-325)

The IDE's auto-load feature parses `/ide/owner/repo` from `window.location.pathname`:

```javascript
const ideMatch = path.match(/\/ide\/([^\/]+)\/([^\/]+)(?:\/(.+))?/);
```

This regex matches `/ide/` anywhere in the path. It will work at both:
- `localhost:8000/app/ide/` (path contains `/ide/`)
- `ivanlugo.dev/ide/` (path contains `/ide/`)

**No change needed** to this regex. It is already location-agnostic.

---

## 4. Relative Import Path Changes

The IDE uses relative imports that reference sibling (`../github-viewer/`) and ancestor (`../../src/`) directories. Moving from `examples/ide/` to `app/ide/` changes the relative depth.

### Current relative paths (from `examples/ide/`):

| File | Import | Resolves to |
|---|---|---|
| ide.html | `../github-viewer/GitHubRepoViewer.js` | `examples/github-viewer/GitHubRepoViewer.js` |
| ide.html | `../github-viewer/components/Drawer.js` | `examples/github-viewer/components/Drawer.js` |
| IDEShell.js | `../github-viewer/components/Drawer.js` | `examples/github-viewer/components/Drawer.js` |
| IDEShell.js | `../github-viewer/components/LogCapturePanel.js` | same pattern |
| IDEShell.js | `../github-viewer/components/DiffPanel.js` | same pattern |
| IDEShell.js | `../../src/services/utils/platform.js` | `src/services/utils/platform.js` |
| CommandBar.js | `../../../src/services/utils/platform.js` | `src/services/utils/platform.js` |
| CommandBar.js | `../../github-viewer/websocket/commands/encoding.js` | `examples/github-viewer/websocket/commands/encoding.js` |

### After move to `app/ide/` (from project root):

| File | Old Import | New Import |
|---|---|---|
| ide.html | `../github-viewer/GitHubRepoViewer.js` | `../../examples/github-viewer/GitHubRepoViewer.js` |
| ide.html | `../github-viewer/components/Drawer.js` | `../../examples/github-viewer/components/Drawer.js` |
| IDEShell.js | `../github-viewer/components/Drawer.js` | `../../examples/github-viewer/components/Drawer.js` |
| IDEShell.js | `../github-viewer/components/LogCapturePanel.js` | `../../examples/github-viewer/components/LogCapturePanel.js` |
| IDEShell.js | `../github-viewer/components/DiffPanel.js` | `../../examples/github-viewer/components/DiffPanel.js` |
| IDEShell.js | `../../src/services/utils/platform.js` | `../../src/services/utils/platform.js` |
| CommandBar.js | `../../../src/services/utils/platform.js` | `../../../src/services/utils/platform.js` |
| CommandBar.js | `../../github-viewer/websocket/commands/encoding.js` | `../../../examples/github-viewer/websocket/commands/encoding.js` |

**Key observation:** The `src/` imports happen to stay the same depth (`app/ide/` is two levels from root, same as `examples/ide/`). The `github-viewer` imports all change because the sibling relationship breaks: `app/ide/` is no longer a sibling of `examples/github-viewer/` -- it needs to go up two levels then into `examples/`.

**Total imports to update: 7** (3 in IDEShell.js, 2 in ide.html, 2 in CommandBar.js).

Wait -- let me recount the depth. `examples/ide/IDEShell.js` imports `../../src/` (up two = project root, then `src/`). From `app/ide/IDEShell.js`, `../../src/` also goes up two to project root, then `src/`. **Same.** Confirmed: `src/` imports are unchanged. Only the `github-viewer` cross-references change (5 imports across 3 files).

---

## 5. Asset References

### ide.css
- **No external url() references.** The single `url()` call (line 791) is an inline data URI SVG for a dropdown arrow. It is fully self-contained.
- No font imports via `@font-face` -- the IDE uses system monospace fonts.
- **No changes needed to ide.css.**

### ide.html
- `<link rel="stylesheet" href="ide.css">` -- relative to same directory. Works at any location. **No change.**
- `<script type="importmap">` uses CDN URL (`https://cdn.jsdelivr.net/npm/three@0.160.0/...`). Absolute URL, directory-depth irrelevant. **No change.**
- Local module imports (lines 180-183) -- covered in Section 4 above.

### index.html (redirect)
- `<meta http-equiv="refresh" content="0; url=./ide.html">` -- relative redirect to sibling file. Works at any location. **No change** to the file itself, but this file moves along with everything else.

---

## 6. npm Scripts

Current scripts in `package.json`:

```json
"serve": "python3 -m http.server 8000",
"ws": "node examples/github-viewer/ws-relay.mjs",
"ws:py": "python3 examples/github-viewer/ws-relay.py",
"relay": "node examples/github-viewer/ws-relay.mjs",
"cli": "node examples/github-viewer/cli/glyph-cli.mjs"
```

**None of these reference `examples/ide/`.** The `serve` command serves the entire project root, so `app/ide/` is automatically accessible. The `ws`, `relay`, and `cli` commands reference `examples/github-viewer/` which is not moving.

**No package.json changes needed** for the extraction itself. However, consider adding a convenience script:

```json
"ide": "python3 -m http.server 8000 & sleep 1 && open http://localhost:8000/app/ide/"
```

Also: the `"files"` field in package.json lists `["src", "examples"]`. If the IDE is a production app (not a publishable example), it should not be in the npm package anyway. But if you want `app/` included in `npm pack`, add `"app"` to the files array. For now this is likely irrelevant since glyph3d-js is not published to npm.

---

## 7. Redirect / Backward Compatibility

Anyone who bookmarked `localhost:8000/examples/ide/` or has it in browser history will get a 404 after the move.

**Recommended:** Leave a stub `examples/ide/index.html` that redirects:

```html
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="0; url=../../app/ide/ide.html">
    <title>Moved</title>
</head>
<body>
    <p>The IDE has moved to <a href="../../app/ide/ide.html">app/ide/</a>.</p>
</body>
</html>
```

This is a single file, zero maintenance cost. Remove it after a few weeks or whenever convenient. No rush -- it costs nothing to keep.

For production (`ivanlugo.dev/ide`), the Caddy config update handles this directly. No redirect needed on the production side -- just update the path mapping.

---

## 8. Landing Page (examples/index.html)

The landing page currently has an "IDE Shell" card linking to `ide/` (relative, resolves to `examples/ide/`). After extraction, two options:

**Option A (recommended):** Change the link to `../app/ide/` and add a note like "(production app)" to the description. The IDE is still discoverable from the examples page.

**Option B:** Remove the IDE card entirely and list it elsewhere (e.g., the project README). This is cleaner semantically but reduces discoverability for anyone browsing `localhost:8000/examples/`.

Option A is simpler and loses nothing.

---

## 9. CORS / Import Map

The importmap uses an absolute CDN URL for Three.js. CORS on jsdelivr allows all origins. Directory depth has zero effect. **No issue.**

All local imports use relative paths. The browser resolves these relative to the importing file's URL. As long as the relative paths are updated (Section 4), everything works. **No CORS implications.**

---

## 10. CLAUDE.md Update

The project structure section in `CLAUDE.md` lists:

```
examples/
  ...
  ide/                 # (currently listed inline or implied)
```

After extraction, add:

```
app/
  ide/                 # Production IDE shell (ivanlugo.dev/ide)
    ide.html
    ide.css
    index.html         # Redirect to ide.html
    IDEShell.js
    components/
      CommandBar.js
```

And note in the `examples/` section that the IDE has been extracted.

---

## 11. Checklist Summary

| Task | Files Affected | Blocking? |
|---|---|---|
| Create `app/ide/` and `app/ide/components/` | filesystem | Yes |
| Move 5 files from `examples/ide/` to `app/ide/` | 5 files | Yes |
| Update 5 relative imports (github-viewer refs) | IDEShell.js (3), ide.html (2), CommandBar.js (1) | Yes |
| Update Caddy config on the host server | Caddyfile (not in repo) | Yes (for prod) |
| Leave redirect stub at `examples/ide/index.html` | 1 new file | No (recommended) |
| Update `examples/index.html` IDE card link | 1 file | No (recommended) |
| Update `CLAUDE.md` project structure | 1 file | No (recommended) |
| Optionally add `"app"` to package.json `"files"` | package.json | No |
| Optionally add `"ide"` npm script | package.json | No |

**Risk assessment: Low.** No build step means no build config to update. No bundler, no path aliases, no tsconfig. The entire change is: move files, fix 5-6 relative import paths, update one Caddy directive on the server. The importmap, CSS, and asset references are all self-contained and location-agnostic.

---

## 12. Gotchas

1. **Service worker caches.** If anyone ever added a service worker (unlikely given the codebase), cached paths would break. Verified: no service worker exists.

2. **Browser import map caching.** Browsers cache resolved module specifiers aggressively. After the move, a hard refresh (Ctrl+Shift+R) may be needed. This is a non-issue in practice.

3. **The python HTTP server has no rewrite rules.** It serves files literally from disk. There is no way to make `localhost:8000/ide/` serve `app/ide/` without either (a) a symlink, or (b) putting the IDE at `/ide/` in the repo. If the shorter dev URL matters, use a symlink or switch to a dev server with rewrite support. For now, `localhost:8000/app/ide/` is fine.

4. **`git mv` vs plain `mv`.** Use `git mv` to preserve history tracking. The files are small enough that git's rename detection will handle it either way, but `git mv` makes intent explicit.
