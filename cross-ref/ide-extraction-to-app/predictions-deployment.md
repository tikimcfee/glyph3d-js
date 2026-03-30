# Predictions from deployment agent

Written BEFORE reading the other agents' Phase 0 outputs.

## Prediction: file-moves

The file-moves agent likely concluded that 5 files need to move from `examples/ide/` to some target directory (either `app/ide/` or a root-level `ide/`). They probably catalogued the full file list (ide.html, ide.css, index.html, IDEShell.js, components/CommandBar.js) and proposed a directory structure mirroring the current layout. I expect they also identified the need to update `examples/index.html` which links to the IDE, and possibly recommended a redirect stub at the old location. They may have flagged the question of whether shared dependencies (Drawer.js, LogCapturePanel.js, DiffPanel.js from github-viewer) should also move or remain in place.

## Prediction: dependency-resolution

The dependency-resolution agent likely mapped every import path in the 5 IDE files, identified which ones break after the move, and computed corrected relative paths. They almost certainly found the same 5-7 import path changes I identified: the `../github-viewer/` references in IDEShell.js and ide.html that need an extra `../` prefix, plus the CommandBar.js reference to `../../github-viewer/websocket/commands/encoding.js`. They probably noted that `src/` imports remain unchanged if the target is `app/ide/` (same depth as `examples/ide/`). They may have raised the question of whether to use import maps or path aliases instead of deeply nested relative paths, and might have suggested extracting shared components (Drawer, DiffPanel, LogCapturePanel) into a shared location to reduce cross-directory coupling.
