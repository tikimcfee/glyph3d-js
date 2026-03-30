# Predictions from dependency-resolution

Written BEFORE reading other agents' Phase 0 outputs.

## Prediction: file-moves

The file-moves agent likely concluded that the 4 IDE files (`ide.html`, `ide.css`, `IDEShell.js`, `components/CommandBar.js`) should move from `examples/ide/` to either `app/ide/` or a top-level `ide/` directory, preserving the internal directory structure (the `components/` subfolder stays nested). They probably recommended `app/ide/` or `app/` as the destination because the CLAUDE.md memory entry says "extract from examples/ to root-level app," and they likely flagged that no other files in the repo need to move -- the IDE's dependencies on `examples/github-viewer/` components and `src/` utilities remain in place as cross-directory imports rather than being co-located. They may have also considered whether to promote shared components (Drawer panels, encoding.js) but likely decided those stay where they are since the IDE consumes them rather than owning them.

## Prediction: deployment

The deployment agent likely concluded that the HTTP server (`python3 -m http.server 8000` from repo root) continues to work for any destination since it serves the entire repo tree, but the URL path changes from `/examples/ide/ide.html` to `/app/ide/ide.html` (or `/ide/ide.html`). They probably identified that the importmap's CDN URL for Three.js is absolute and therefore unaffected by the move. They likely recommended updating any references to the old URL (bookmarks, docs, npm scripts) and possibly discussed whether the `npm run serve` command or any configuration files need updating. If the IDE is intended as a production app at `ivanlugo.dev/ide`, they may have discussed reverse proxy or deployment pipeline considerations for serving from a different path than the development server uses.
