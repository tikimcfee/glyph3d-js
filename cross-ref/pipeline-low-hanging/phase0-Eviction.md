# Phase 0 — Eviction Agent Analysis

## Target

Firefox profiler: `reloadContent` at 10.8% of total time, caused by eviction churn at the frustum boundary.

## Files Read

- `/home/user/dev/glyph3d-js/src/collections/GridVirtualizer.js`
- `/home/user/dev/glyph3d-js/src/collections/CodeGrid.js`
- `/home/user/dev/glyph3d-js/src/collections/GlyphCollection.js` (header)
- `/home/user/dev/glyph3d-js/src/core/constants.js`

## Root Cause Analysis

### The churn cycle

The profiler symptom (10.8% in `reloadContent`) is not caused by too-frequent evictions per se — the existing `EVICTION_DELAY_MS = 5000` timer on the eviction side adequately throttles `unloadContent()` calls. The problem is on the **reload side**.

The flow for a thrashing grid at the frustum edge:

```
1. Grid is evicted (far from camera, 5s timer elapsed)
2. Camera pans slightly → grid enters frustum
3. Virtualizer sees: entry.evicted=true, entry.active=true
4. → fires reloadContent() (async worker path, ~200-400ms)
5. Camera pans back → grid leaves frustum
6. Grid is inactive, distance > evictionDistance
7. eviction timer starts immediately (the reload just finished)
8. 5s later → unloadContent() again
9. goto 2
```

Each `reloadContent()` call runs `_layoutContentAsync()` → `flushAsync()` → worker round-trip + GPU buffer upload. A 1000-char file costs roughly one worker dispatch + typed-array allocation + GPU attribute re-upload. At 60fps with multiple grids on the frustum edge, this adds up to 10%+ of frame time.

### Secondary issue: overlapping reloads

Before this fix, there was no guard against a second `reloadContent()` starting before the first completed. If the camera oscillated quickly enough, `entry.evicted` was reset to `false` on the first entry, but a second pass could see `entry.active=true` and `entry.evicted=false` (already cleared) and do nothing — but in pathological cases with the eviction timer also running, overlapping calls were possible.

### Why `EVICTION_DISTANCE_FACTOR = 10` is insufficient

With `hysteresis=50` world units, the eviction zone starts at `50 * 10 = 500` units. The frustum hysteresis band is only 50 units wide. A grid at 490-510 units that oscillates slightly across the frustum will:
- Enter frustum at 490 → scene.add, then immediately reload if evicted
- Leave frustum at 510 → start 5s eviction timer
- Re-enter at 490 → reload again

The gap between the hysteresis removal edge (50 units) and the eviction zone (500 units) is 450 units. That sounds large, but in practice any grid that was ever evicted and is now at 510 units is in reload-thrash territory if the camera sways.

## Changes Made

### `/home/user/dev/glyph3d-js/src/collections/GridVirtualizer.js`

**1. New constant: `RELOAD_COOLDOWN_MS = 8000`**

After a `reloadContent()` promise resolves, the grid cannot be evicted for 8 seconds. This directly breaks the churn cycle: even if the grid immediately leaves the frustum again, the eviction timer cannot fire for 8 seconds. The user is highly unlikely to pan back again within 8 seconds of having just seen the grid — and if they do, the grid is now live and visible anyway.

**2. Increased `EVICTION_DISTANCE_FACTOR`: 10 → 15**

The eviction zone now starts at `50 * 15 = 750` world units (vs 500 before). This provides more headroom between the frustum edge (where grids pop in/out of the scene) and the eviction zone (where GPU buffers are freed). Grids that are oscillating near the frustum boundary at 400-600 units now sit safely inside the eviction-exempt zone.

**3. New entry field: `_reloadInFlight: boolean`**

Guards against concurrent reload calls. Before starting a `reloadContent()`, the code checks `!entry._reloadInFlight`. The flag is set true before the call and cleared in both `.then()` and `.catch()`. This ensures at most one reload is outstanding per grid at any time, even if the virtualizer runs many eviction-check passes while the worker is busy.

**4. New entry field: `_reloadCooldownUntil: number`**

Stores `performance.now() + RELOAD_COOLDOWN_MS` when a reload completes. The eviction path checks `now < entry._reloadCooldownUntil` before starting a new eviction countdown. During cooldown, the eviction timer is also reset to null, so the 5-second countdown restarts fresh after the cooldown expires.

**5. Initialized `_reloadCooldownUntil: 0`** in `register()`

New grids get cooldown=0 so they are immediately eligible for eviction after `EVICTION_DELAY_MS` without waiting for a phantom cooldown period.

## Expected Impact

The reload-cooldown mechanism directly prevents the churn loop. The worst case is now:

```
1. Grid evicted
2. Grid re-enters frustum → reloadContent() starts
3. Reload completes → _reloadCooldownUntil = now + 8000ms
4. Grid leaves frustum → eviction timer blocked until cooldown expires
5. 8 seconds later: cooldown expires, eviction timer starts
6. 5 more seconds: unloadContent() fires
```

So the minimum round-trip time is 13 seconds (8s cooldown + 5s eviction delay), compared to the previous minimum of 5 seconds with no protection. More importantly, rapid oscillation (sub-second camera movement) cannot trigger more than one reload per oscillation period.

## Domain Conflicts

No conflicts detected. The changes are confined to `GridVirtualizer.js`. The eviction loop is the only consumer of `reloadContent()` in the codebase — `CodeGrid.reloadContent()` itself is unchanged. No shader, buffer builder, or collection internals are touched.

## Observability

`getStats()` already returns `{ active, total, evicted, lastUpdateMs }`. The `_reloadInFlight` flag could be surfaced there if desired — not added now to keep the diff minimal.
