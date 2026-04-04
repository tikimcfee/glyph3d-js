# Round 1: buffer-pipeline reviews picking-system, integration-testing

## Errors Found

### picking-system: Vertex shader world-position formula is wrong

`phase0-picking-system.md` section 2, picking vertex shader:

```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

The production vertex shader at `src/GlyphRenderer.js:285` reads:

```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

These look identical, but the main shader also has `colorBlend` logic at line 309–310 that reads `gScale.w`. The picking shader omits this — fine for a picking pass. However, the formula itself has a semantic problem shared with the production code: `instancePosition` is being scaled by `gScale.xyz` when it should be the *quad vertices* that are scaled. The current production behavior is preserved in the picking shader, so this is not a regression, but the formula is conceptually wrong in both places. Not a blocker for this phase, but worth flagging so it isn't cemented further.

### picking-system: `instancePickingId` assigned by PickingSystem.registerRenderer, not at build time

`phase0-picking-system.md` section 4 says `instancePickingId[i] = start + i + 1` is written during `_rebuildAllInstances / applyPrebuiltBuffers`. But section 9's `registerRenderer()` implementation writes the buffer *after* the geometry already exists — this means the attribute is set twice (once as a zero array during `_createInstanceMesh`, then overwritten by `registerRenderer`). This creates a sequencing hazard: if the picking system is not registered before the first render frame, glyphs render to the picking target with all-zero IDs. The buffer-pipeline plan (`phase0-buffer-pipeline.md` section 7, step E) avoids this by writing picking IDs at flush time via `assignPickingIds()`. The picking-system's late-write approach is workable but requires that `registerRenderer` be called synchronously within the same frame as `flush()`.

### integration-testing: Phase 1 test checks wrong attribute name

`phase0-integration-testing.md` section 2:

```js
const attr = geometry.attributes.instanceBufferIndex;
```

The buffer-pipeline plan uses `instancePickingId` (not `instanceBufferIndex`) as the attribute name — see `phase0-buffer-pipeline.md` section 7E and section 3. `instanceBufferIndex` does not appear in the buffer-pipeline design at all; the pipeline explicitly rejects it in favor of `gl_InstanceID` (section 2, paragraph on `instanceBufferIndex` decision). The Phase 1 self-test will always fail as written because the attribute will never exist.

### integration-testing: Phase 2 picking color encoding splits renderer identity across RGBA, but buffer-pipeline and picking-system use RGB-only

`phase0-integration-testing.md` section 3:

> The picking color encodes `pickingId` in the high bits and `bufferIndex` in the low bits of the RGBA value.

Both `phase0-buffer-pipeline.md` (section 4, picking fragment) and `phase0-picking-system.md` (section 2, fragment + section 1 format decision) encode a single 24-bit ID across RGB only. There is no room for a separate renderer/grid identifier in the remaining 8 bits — the alpha channel is hardcoded to `1.0`. If integration-testing's design requires embedding `pickingId` and `bufferIndex` separately, the picking shader must change, or the registry-based range lookup (which picking-system uses) must be abandoned. The two documents contradict each other here.

### integration-testing: `getCollection().getRenderer()` — GlyphCollection does not expose `getRenderer()`

`phase0-integration-testing.md` section 2:

```js
const geometry = grid.getCollection().getRenderer().instanceMesh.geometry;
```

`GlyphCollection` (src/collections/GlyphCollection.js line 61) holds `this._renderer` as a private field. There is no `getRenderer()` accessor. The test code will throw `TypeError: grid.getCollection().getRenderer is not a function`. Either a `getRenderer()` accessor must be added, or the test snippet must access `_renderer` directly (acceptable in a test page).

---

## Gaps

### What picking-system covered that buffer-pipeline missed

- **Resize handling**: `onResize()` re-creates the render target (`_createTarget()`). Buffer-pipeline never mentions render target lifecycle.
- **The parallel picking `Scene`**: Using a dedicated `THREE.Scene` with picking meshes that share geometry (not cloned) is cleaner than material-swapping. Buffer-pipeline section 4 describes a material-swap approach; picking-system section 5 explains why shared geometry + separate scene is better.
- **Async PBO path for phase 1**: Picking-system section 8 describes the `PIXEL_PACK_BUFFER` + fence sync pattern. Buffer-pipeline doesn't address readback latency mitigation at all.
- **Invisible group suppression in picking shader**: `visible = step(0.01, gColor.a)` plus `gl_Position = ... vec4(worldPos, visible)` correctly hides invisible groups in the picking pass by collapsing w to 0. Buffer-pipeline's picking fragment has no equivalent.

### What buffer-pipeline covered that picking-system missed

- **`addedColor` additive highlight attribute**: Picking-system never discusses `instanceAddedColor`. The full additive color pipeline (buffer builder changes, `updateAddedColor()` direct-write API, fragment shader blend) only appears in buffer-pipeline.
- **Worker path for new attributes**: Buffer-pipeline explicitly shows `buildGlyphBuffers()` and `buildBatchBuffers()` changes. Picking-system section 7 mentions `applyPrebuiltBuffers` but doesn't detail how workers emit `pickingIds`.
- **`applyPrebuiltBuffers()` backward-compatibility fallback**: The `|| new Float32Array(count)` pattern on new attribute destructuring.
- **`gl_InstanceID` vs explicit buffer attribute**: Picking-system never mentions `gl_InstanceID`; it always writes an explicit buffer. Buffer-pipeline correctly identifies that `gl_InstanceID` is free in WebGL 2.

### What integration-testing covered that both others missed

- **SemanticInfoMap stale-index risk**: Section 10, second risk — buffer indices shift when `_rebuildAllInstances` is triggered by text removals. This is a real hazard neither pipeline plan addresses. `SemanticInfoMap` must be reconstructed alongside every rebuild.
- **Worker `startIndex` parameter requirement**: Section 10, third risk — `buildBatchBuffers` needs a global `startIndex` offset so per-worker buffer slots are globally unique. This is correct and neither other plan addresses it.
- **Hot-reload ID collision**: Section 10, fourth risk — module-level counter resets on hot-reload. `window.__pickingIdCounter` is a reasonable mitigation.

---

## Tensions

### Tension 1: `instanceBufferIndex` as an attribute vs `gl_InstanceID`

Integration-testing treats `instanceBufferIndex` as a real, writable attribute that gets emitted by workers and stored in the buffer (sections 2, 10). Buffer-pipeline explicitly rejects this: "Do not add as a separate buffer attribute. The vertex shader already knows the instance index via `gl_InstanceID`." (section 2, final paragraph).

**Buffer-pipeline is correct.** `gl_InstanceID` is a built-in GLSL ES 3.0 variable, available in WebGL 2 contexts at zero buffer cost. Writing a redundant `0, 1, 2, 3...` sequence to a Float32Array wastes 40 KB at 10K instances and requires an extra CPU write per rebuild. The integration-testing agent appears unaware of `gl_InstanceID`.

### Tension 2: Picking ID encoding scheme

Buffer-pipeline fragment shader (section 4): encodes a single sequential integer (`pickingIdBase + localGlyphIndex`) as 24-bit RGB. Picking-system (section 1, 2): also encodes a single global picking ID as 24-bit RGB. Integration-testing (section 3): claims the RGBA encoding must carry both `pickingId` (renderer/grid identity) and `bufferIndex` simultaneously in the same 4 bytes.

**Buffer-pipeline and picking-system agree; integration-testing is wrong.** 24-bit RGB gives 16.7M unique IDs. With the registry range-lookup approach (picking-system section 4), a single global ID unambiguously resolves to both the renderer and the slot within it. There is no need to pack two fields.

### Tension 3: Where picking IDs are assigned

Buffer-pipeline: IDs assigned at flush time by caller via `addText({pickingIdBase: N})`, flowing through the worker builder into the buffer. Picking-system: IDs assigned by `PickingSystem.registerRenderer()` *after* the renderer exists, by writing directly to the geometry attribute.

**Picking-system's approach is architecturally cleaner** for the global-counter use case: the PickingSystem owns the ID space and doesn't require callers to manually coordinate base IDs. Buffer-pipeline's approach gives more control to the caller but requires manual ID space management. These are not mutually exclusive — picking-system's `registerRenderer()` can write `instancePickingId` in bulk, overriding whatever the builder wrote. The buffer-pipeline's builder output for `pickingIds` can default to zeros and be overwritten by `registerRenderer`, making both approaches compatible.

---

## Recommendations

1. **Rename `instanceBufferIndex` to `instancePickingId` in integration-testing's test plan.** The Phase 1 self-test at section 2 should check `geometry.attributes.instancePickingId`, not `instanceBufferIndex`. Update the phase dependency description accordingly.

2. **Add `getRenderer()` accessor to GlyphCollection** (`src/collections/GlyphCollection.js`):
   ```js
   getRenderer() { return this._renderer; }
   ```
   Required for integration-testing's test page snippets to run without hacking private fields.

3. **Resolve the picking ID encoding contradiction.** Integration-testing section 3's "high bits = pickingId, low bits = bufferIndex" design must be dropped. Adopt the single 24-bit global sequential ID from buffer-pipeline and picking-system. Update integration-testing section 3 to reference the registry range-lookup for renderer resolution.

4. **Add `startIndex` parameter to `buildBatchBuffers()`** in `src/workers/builders/index.js`. Integration-testing section 10 correctly identifies this requirement. Buffer-pipeline's builder changes (section 3) must thread a `globalStartIndex` into the per-item `pickingIds` fill: `pickingIds[idx] = globalStartIndex + idx + 1`.

5. **Add invisible-group suppression to the picking vertex shader.** Buffer-pipeline's picking vertex sketch (section 4) does not include the `visible = step(0.01, gColor.a)` trick from picking-system section 2. Use the picking-system version — it is correct and cheaper than a fragment discard.

6. **Wire `SemanticInfoMap.populate()` into the flush completion callback**, not once at load. Integration-testing section 10 identifies this requirement correctly. Buffer-pipeline's `flush()` integration section (section 5) should note that `itemMeta` from `applyPrebuiltBuffers` is the correct hook point.

7. **Add resize handling to PickingSystem.** Buffer-pipeline never mentions render target resize. Use picking-system's `onResize()` → `_createTarget()` pattern. The resize event should also update the mouse pixel coordinate scaling.

8. **Implement additive color (`instanceAddedColor`) in phase 3 before picking.** Integration-testing's phase ordering (section 1) lists `instanceBufferIndex` as Phase 1 blocking all others. Since `gl_InstanceID` replaces that, Phase 1 can be merged into Phase 2 (picking texture). Phase 3 (additive color) can proceed in parallel from day one using buffer-pipeline section 7D's `updateAddedColor()` direct-write API.

9. **Do not clone picking mesh geometry.** Picking-system section 5's shared-geometry approach is correct. Buffer-pipeline section 4 mentions a material-swap approach as an alternative. Discard material-swap — shared geometry with a dedicated picking scene is zero extra memory and avoids the renderer state mutation risk.

10. **Guard `applyPrebuiltBuffers()` new attribute fallbacks against missing geometry attributes in the sync path.** When `skipPrealloc = false` (the default), the sync path's `_createInstanceMesh()` pre-allocates attributes. `_updateInstanceMesh()` reads those arrays directly at lines 1049–1053 without null-checks. New attributes (`instanceAddedColor`, `instancePickingId`) must be pre-allocated in `_createInstanceMesh` before `_updateInstanceMesh` can write them, or a null-check guard is required before each new array read.

---

## Key Insight

The integration-testing plan's Phase 1 (`instanceBufferIndex` as a writable buffer attribute) is the foundational assumption that the other three phases build on — and it is wrong. `gl_InstanceID` is a free GLSL built-in that provides the same value without any buffer write, and buffer-pipeline correctly identifies this. This means Phase 1 as described collapses: there is no separate `instanceBufferIndex` attribute to verify, no worker emission to test, and no shader passthrough to validate. The picking system can proceed directly to Phase 2 with a single globally-assigned `instancePickingId` buffer (written by `PickingSystem.registerRenderer`, not by the builder), and the integration-testing harness should be redesigned around testing the `instancePickingId` range assignments and the registry lookup rather than a sequential-index identity check. The SemanticInfoMap stale-index risk that integration-testing identifies in section 10 is the most practically dangerous issue in the entire set of plans — and it is the only one not addressable at the buffer or shader layer.
