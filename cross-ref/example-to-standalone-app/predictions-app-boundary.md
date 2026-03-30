# Predictions from app-boundary

Written BEFORE reading the other agents' phase 0 outputs.

## Predicting: library-promotion (phase0-library-promotion.md)

I expect library-promotion identified a similar set of PROMOTE candidates -- TUI system (TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager), encoding.js, spatialHelpers.js, MinimapOverlay, and TouchController. They likely organized their analysis around what makes something "library-worthy" vs "app-specific" and proposed a destination structure within `src/`. They may have gone deeper on the API contracts these promoted modules should expose (e.g., should TUIWindow be a standalone export from `glyph3d-js/tui`?) and whether the promoted modules need interface changes to decouple them from app-specific assumptions. I'd expect them to have flagged the TUI subsystem as the most significant promotion candidate and possibly suggested a `src/tui/` or `src/components/tui/` directory.

## Predicting: migration-mechanics (phase0-migration-mechanics.md)

I expect migration-mechanics focused on the practical execution plan: file move ordering, import path rewriting, the `app/` directory structure, and how to handle the transition without breaking the running application. They likely addressed the import map changes needed in `index.html` and `ide.html`, the relative path adjustments for all internal imports, and whether to use a symlink/redirect strategy during migration or do a single atomic move. They probably proposed a phased execution order (e.g., promote utilities first, then TUI, then move app files, then clean up examples/) and identified the riskiest import chains. They may have been more conservative about promotions, preferring to keep things in `app/` first and promote later once the extraction is stable.
