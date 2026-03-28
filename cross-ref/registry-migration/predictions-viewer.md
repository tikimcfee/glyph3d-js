# Predictions from Agent: viewer

## Predicting: commands agent

The commands agent likely catalogued every command handler (focus, goto, remove, highlight, layout, etc.) that resolves grids by numeric index via `resolveGrid(grids, arg)` and mapped out which ones need dual index/ID lookup. They probably concluded that most commands can switch to registry-based `get(id)` with a fallback to numeric index parsing, and that `resolveGrid` should become a thin wrapper that tries ID-based lookup first, then falls back to index-based lookup against the materialized grids array. The agent likely flagged the WebSocket command handlers as the highest-priority migration target since external callers currently pass raw indices that become stale after add/remove operations.

## Predicting: compatibility agent

The compatibility agent likely focused on ensuring that numeric-index-based access (tab traversal, `focusOnGrid(index)`, WS commands with integer args) continues working during and after migration by proposing an adapter or shim layer that translates indices against the cached grids array. They probably identified the key risk that Map insertion order must match the old array push order to preserve index stability, and recommended that the registry expose an `entries()` or `toArray()` method whose ordering contract is explicitly documented. The agent likely also raised edge cases around `clearGrids` followed by `loadDiff` (full replacement scenario) and concurrent WS grid mutations, proposing that the compatibility layer version-stamp or sequence-number the grids array to detect stale index references.
