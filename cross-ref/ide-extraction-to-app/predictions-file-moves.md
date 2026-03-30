# Predictions from file-moves Agent

Written BEFORE reading the other agents' Phase 0 outputs.

## Prediction: dependency-resolution

The dependency-resolution agent likely concluded that the IDE's imports from `examples/github-viewer/` are the primary concern -- these cross-boundary imports represent an architectural smell where a production app depends on code living inside `examples/`. They probably recommended either (a) extracting shared components (Drawer, LogCapturePanel, DiffPanel, encoding utilities) into `src/` or a shared module so both the IDE and github-viewer can import from a clean path, or (b) at minimum updating the relative paths (adding one `../` level) while flagging the cross-boundary dependency as tech debt. They likely also noted that the `src/services/utils/platform.js` import stays stable since both locations are depth-2 from root, and that the importmap for `three` in ide.html needs no change since it uses a CDN URL.

## Prediction: deployment

The deployment agent likely concluded that the Caddy reverse proxy config for `ivanlugo.dev/ide` needs updating to serve from `app/ide/` instead of `examples/ide/`. They probably identified that the `npm run serve` (python http.server) dev workflow requires no changes since it serves from the project root and the new path is just `localhost:8000/app/ide/`. They may have recommended a Caddy redirect from the old `/examples/ide/` path to `/app/ide/` for any existing bookmarks/links, and flagged that the importmap CDN URL for Three.js is deployment-stable. They likely also discussed whether the `package.json` `files` field matters for deployment or only for npm publishing.
