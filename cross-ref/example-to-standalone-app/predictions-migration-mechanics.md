# Predictions from migration-mechanics

## What app-boundary likely concluded

The app-boundary agent likely focused on defining the clean separation line between what belongs in `app/` versus what belongs in `src/`. They probably argued that many of the files currently in `src/services/` (like `WebSocketBridge`, `ViewerAPI`, `CommandRouter`, and possibly the data services like `GitHubRepositorySource`) are app-specific rather than library-generic, and should either move into `app/` or be flagged as misplaced. They likely also proposed renaming `websocket/` to something more intent-descriptive (like `commands/` or `shell/`) since the WebSocket is a transport mechanism, not the organizing concept. They probably raised the question of whether the TUI system (TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager) belongs in `app/` or `src/`, leaning toward `src/` since it's a reusable rendering concept.

## What library-promotion likely concluded

The library-promotion agent probably identified specific files currently inside `examples/` that are actually library-quality abstractions deserving promotion into `src/`. Prime candidates would be the TUI system (TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager) which extends the core glyph rendering concept into terminal-like windows -- a natural extension of CodeGrid. They likely also flagged `encoding.js` and `spatialHelpers.js` as utility-grade code that belongs in `src/utils/`. They may have proposed a new `src/tui/` directory or similar. They probably argued that some of the `src/services/` files are actually app-specific and should move the other direction (into `app/`), creating a counter-flow to my migration plan.
