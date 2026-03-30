# Predictions from library-promotion

Written BEFORE reading the other agents' work.

## Prediction: app-boundary (phase0-app-boundary.md)

I predict the app-boundary agent drew a hard line between "library infrastructure" and "application code," arriving at the conclusion that the TUI layer, the command handlers, the DOM components (Drawer, AppShell, DiffPanel), and the websocket wiring all belong on the app side of the boundary. They likely identified the WebSocketBridge/CommandRouter/ViewerAPI (already in src/) as the library-side transport, and argued that MinimapOverlay and TouchController should be promoted into the library because they serve general-purpose 3D interaction needs -- placing them on the library side of the boundary rather than deferring them as I did. They probably defined the boundary as: "src/ is the library, everything in examples/ is app code, and the app should depend on src/ with no reverse dependencies."

## Prediction: migration-mechanics (phase0-migration-mechanics.md)

I predict the migration-mechanics agent focused on the concrete steps: file moves, import rewrites, directory creation, and risk of breakage. They likely proposed a phased migration plan starting with the lowest-risk moves (files with no dependents or purely standalone utilities) and ending with the highest-risk moves (files deeply embedded in the command/websocket wiring). They probably did NOT advocate promoting TUI files into src/ at all -- instead keeping TUI code inside the app directory (perhaps under app/websocket/ or similar) and focusing purely on the mechanical extraction of the github-viewer example into a standalone app/directory at the repository root. Their concern would be "how do we move without breaking imports" rather than "what deserves to be library code."
