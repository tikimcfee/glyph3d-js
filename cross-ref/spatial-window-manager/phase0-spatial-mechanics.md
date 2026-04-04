# Phase 0: Spatial Window Manager -- Spatial Mechanics

Agent: **Spatial Mechanics**
Scope: screen-to-world projection, group layout geometry, animation, depth management

---

## 1. Screen-to-World Drag Projection

### Decision: Reuse camera drag math, invert the sign, parametrize by object Z

`ViewerCameraController._applyDragTranslation` already solves the core problem. Camera
drag moves the camera in the opposite direction of the mouse. Window drag moves the
*object* in the same direction. The only additional variable is the object's Z depth
(camera drag uses camera Z; window drag uses the window's Z).

### `screenToWorldDelta(dx, dy, objectZ, camera)`

```js
/**
 * Convert screen-pixel deltas to world-space deltas at a given Z depth.
 * Derived from ViewerCameraController._applyDragTranslation, but:
 *   - Uses objectZ instead of camera.position.z for the depth factor
 *   - Returns signed deltas (positive dx = rightward in world)
 *   - Camera orientation applied so it works at any pitch/yaw
 *
 * @param {number} dx - screen pixels rightward
 * @param {number} dy - screen pixels downward
 * @param {number} objectZ - world Z of the object being dragged
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement} canvas - for viewport height
 * @returns {{ x: number, y: number }}
 */
export function screenToWorldDelta(dx, dy, objectZ, camera, canvas) {
    const { height } = getCanvasViewportSize(canvas);

    // Signed distance from camera to the object's Z plane
    // Camera faces -Z, so depth = camera.z - object.z
    const depth = Math.abs(camera.position.z - objectZ);

    const fovRad = camera.fov * Math.PI / 180;
    const pixelScale = (2 * depth * Math.tan(fovRad / 2)) / height;

    // Camera-relative axes (handles pitch/yaw if ever non-zero)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    // dx rightward on screen = rightward in world
    // dy downward on screen = downward in world (negative Y)
    return {
        x:  dx * pixelScale * right.x + (-dy) * pixelScale * up.x,
        y:  dx * pixelScale * right.y + (-dy) * pixelScale * up.y,
    };
}
```

**Key properties:**
- Uses `getCanvasViewportSize(canvas)` -- never `window.innerHeight` (per project convention).
- `depth` is the signed distance from camera to the object's Z plane. Closer objects
  produce smaller `pixelScale`, so they move less per pixel (correct parallax).
- Works with current always-facing-minus-Z camera (right = +X, up = +Y), but the
  quaternion application future-proofs for rotated cameras.

### Integration point

The drag handler sits in `SpatialWindowManager`, not in the camera controller. It
intercepts mousedown on a window's hit area (background mesh), sets a `_dragging`
flag, and consumes mousemove deltas before they reach the camera controller. The
camera controller already checks `isDragging` -- the window manager should set a
separate flag and call `e.stopPropagation()` on the canvas mousedown.

---

## 2. WindowGroup Layout Geometry

### Decision: Three layout modes as pure functions that return target positions

Each mode is a function: `(members: WindowInfo[], config) => TargetPosition[]`
where `WindowInfo = { bounds: Box3, currentPos: Vector3, index: number }` and
`TargetPosition = { x, y, z, scale }`. The group stores the mode and calls the
function on demand. Transitions are handled by the animator, not the layout.

### Stack Mode

```
Offset per card:
  x: +2 world units (peek right edge)
  y: -1.5 world units (peek bottom edge)
  z: +0.5 world units (prevent z-fighting, keep readable)

Card 0 (top):    x=0,   y=0,    z=0
Card 1:          x=2,   y=-1.5, z=-0.5
Card 2:          x=4,   y=-3.0, z=-1.0
...
Card N:          x=N*2, y=-N*1.5, z=-N*0.5
```

Z offset of 0.5 units per card is large enough to prevent z-fighting (background
mesh sits at z=-0.1 behind text, so 0.5 gives 0.4 clearance). The peek offsets
(x=2, y=-1.5) expose the filename bar of each underlying card.

```js
function stackLayout(members, config = {}) {
    const peekX = config.peekX ?? 2;
    const peekY = config.peekY ?? -1.5;
    const stepZ = config.stepZ ?? -0.5;
    const anchor = config.anchor ?? members[0].currentPos;

    return members.map((m, i) => ({
        x: anchor.x + i * peekX,
        y: anchor.y + i * peekY,
        z: anchor.z + i * stepZ,
        scale: 1.0,
    }));
}
```

### Splay Mode

Fan N windows radially from a center point. Each card gets a fixed angular slot.

```
Total arc: 180 degrees (configurable)
Angle per card: arc / max(N - 1, 1)
Radius: max(avgWidth, avgHeight) * 0.8
Center: centroid of all member positions

Card i angle: -arc/2 + i * angleStep  (centered on 0 = straight up)
Card i x: center.x + radius * sin(angle)
Card i y: center.y + radius * cos(angle)
Card i z: center.z + i * 0.3  (slight depth stagger)
```

```js
function splayLayout(members, config = {}) {
    const arc = (config.arcDegrees ?? 180) * Math.PI / 180;
    const avgW = members.reduce((s, m) => s + m.bounds.width, 0) / members.length;
    const avgH = members.reduce((s, m) => s + m.bounds.height, 0) / members.length;
    const radius = config.radius ?? Math.max(avgW, avgH) * 0.8;

    // Centroid of current positions
    const cx = members.reduce((s, m) => s + m.currentPos.x, 0) / members.length;
    const cy = members.reduce((s, m) => s + m.currentPos.y, 0) / members.length;
    const cz = members.reduce((s, m) => s + m.currentPos.z, 0) / members.length;

    const N = members.length;
    const angleStep = N > 1 ? arc / (N - 1) : 0;
    const startAngle = -arc / 2;

    return members.map((m, i) => {
        const angle = startAngle + i * angleStep;
        return {
            x: cx + radius * Math.sin(angle),
            y: cy + radius * Math.cos(angle),
            z: cz + i * 0.3,
            scale: 1.0,
        };
    });
}
```

### Free Mode

Windows keep their current positions but are logically grouped. The group boundary
is the union AABB of all members (computed via `unionBounds` from spatialHelpers.js).
No position changes on entering free mode -- only the group registration is created.

Visualization of the group boundary: a wireframe box (like HierarchicalLayoutManager's
debug vis) with 10% padding, color-coded to the group. Depth: behind all members
(min Z of group - 1).

```js
function freeLayout(members) {
    return members.map(m => ({
        x: m.currentPos.x,
        y: m.currentPos.y,
        z: m.currentPos.z,
        scale: 1.0,
    }));
}
```

### Transitions Between Modes

Mode switch = compute new target positions, feed each to the animator. The animator
handles interpolation. There is no intermediate "transition layout" -- it is always
current position -> target position.

---

## 3. SpatialAnimator Design

### Decision: Single shared animator, keyed by Object3D identity, piggybacking on existing RAF

No separate `requestAnimationFrame` loop. The animator exposes an `update(dt)` method
called from the existing render loop (like `CameraController.update`). This avoids
double-RAF and keeps animation synchronized with rendering.

### Animated properties

- `position` (vec3) -- via `object.position.set()`
- `scale` (scalar) -- via `object.scale.setScalar()`
- `opacity` (float) -- via `object._background.material.opacity` (CodeGrid specific)

### Easing

`easeInOutCubic` already exists in spatialHelpers.js. For window movement, use it
as the default. For spring-like feels on drag release, use critically-damped spring:

```js
// Critically damped spring: smooth arrival without overshoot
// omega = natural frequency, zeta = 1.0 (critical damping)
function criticalDamp(current, target, velocity, omega, dt) {
    const diff = current - target;
    const exp = Math.exp(-omega * dt);
    const newPos = target + (diff + (velocity + omega * diff) * dt) * exp;
    const newVel = (velocity - omega * (velocity + omega * diff) * dt) * exp;
    return { value: newPos, velocity: newVel };
}
```

### Class sketch

```js
/**
 * SpatialAnimator -- frame-driven property animation for Object3D instances.
 *
 * Design:
 * - Keyed by (object, property) -- new animation on same key cancels in-flight
 * - Called from render loop via update(dt)
 * - Batch API for group transitions
 * - Zero allocations in hot path (pre-allocated lerp targets)
 */
export class SpatialAnimator {
    constructor() {
        /** @type {Map<string, Animation>} key -> active animation */
        this._active = new Map();
    }

    /**
     * Animate an object's property to a target value.
     * Cancels any in-flight animation on the same (object, property).
     *
     * @param {THREE.Object3D} object
     * @param {'position'|'scale'|'opacity'} property
     * @param {number|{x,y,z}} target
     * @param {Object} opts
     * @param {number} opts.duration - ms
     * @param {Function} [opts.easing=easeInOutCubic]
     * @param {Function} [opts.onComplete]
     * @returns {string} animation key (for manual cancel)
     */
    animateTo(object, property, target, opts = {}) {
        const key = `${object.uuid}:${property}`;
        this._active.delete(key); // cancel existing

        const duration = opts.duration ?? 300;
        const easing = opts.easing ?? easeInOutCubic;

        let startValue;
        if (property === 'position') {
            startValue = { x: object.position.x, y: object.position.y, z: object.position.z };
        } else if (property === 'scale') {
            startValue = object.scale.x;
        } else if (property === 'opacity') {
            startValue = object._background?.material?.opacity ?? 1.0;
        }

        this._active.set(key, {
            object, property, startValue, target,
            elapsed: 0, duration, easing,
            onComplete: opts.onComplete ?? null,
        });

        return key;
    }

    /**
     * Batch: animate multiple objects simultaneously.
     * @param {Array<{object, property, target, opts}>} batch
     */
    animateBatch(batch) {
        for (const { object, property, target, opts } of batch) {
            this.animateTo(object, property, target, opts);
        }
    }

    /**
     * Cancel a specific animation.
     * @param {string} key
     */
    cancel(key) {
        this._active.delete(key);
    }

    /**
     * Cancel all animations on an object.
     * @param {THREE.Object3D} object
     */
    cancelAll(object) {
        const prefix = object.uuid + ':';
        for (const key of this._active.keys()) {
            if (key.startsWith(prefix)) this._active.delete(key);
        }
    }

    /** @returns {boolean} true if any animations are running */
    get isAnimating() {
        return this._active.size > 0;
    }

    /**
     * Advance all animations. Call once per frame from render loop.
     * @param {number} dt - seconds since last frame
     */
    update(dt) {
        const dtMs = dt * 1000;
        const completed = [];

        for (const [key, anim] of this._active) {
            anim.elapsed += dtMs;
            const t = Math.min(anim.elapsed / anim.duration, 1.0);
            const e = anim.easing(t);

            if (anim.property === 'position') {
                const s = anim.startValue;
                const g = anim.target;
                anim.object.position.set(
                    s.x + (g.x - s.x) * e,
                    s.y + (g.y - s.y) * e,
                    s.z + (g.z - s.z) * e,
                );
            } else if (anim.property === 'scale') {
                anim.object.scale.setScalar(
                    anim.startValue + (anim.target - anim.startValue) * e
                );
            } else if (anim.property === 'opacity') {
                if (anim.object._background?.material) {
                    anim.object._background.material.opacity =
                        anim.startValue + (anim.target - anim.startValue) * e;
                }
            }

            if (t >= 1.0) completed.push(key);
        }

        for (const key of completed) {
            const anim = this._active.get(key);
            this._active.delete(key);
            anim.onComplete?.();
        }
    }
}
```

---

## 4. Depth Management

### Z-ordering: bring-to-front on interact

Current Z-pop pattern (SelectionManager + gridVisualState) uses a fixed +3 offset.
This is additive and doesn't account for multiple items needing distinct Z layers.

**Decision: monotonic Z counter for interaction order.**

```js
// In SpatialWindowManager
this._zCounter = 0;
const Z_LAYER_STEP = 0.5;  // same as stack mode step

bringToFront(window) {
    this._zCounter++;
    const targetZ = window._baseZ + this._zCounter * Z_LAYER_STEP;
    this._animator.animateTo(window.grid, 'position',
        { x: window.grid.position.x, y: window.grid.position.y, z: targetZ },
        { duration: 150 }
    );
}
```

- `_baseZ` is the window's layout-assigned Z (from group layout or free placement).
- Each interaction bumps the counter, so the most-recently-touched window is always
  frontmost.
- Counter resets when all windows return to their groups (compact operation).

### Stack Z offsets vs z-fighting

CodeGrid background mesh is at `position.z = -0.1` (local space). Text glyphs are
at z=0 (local). The minimum Z separation to prevent z-fighting between two stacked
cards is the background-to-text gap of the card behind: 0.1 units.

Stack mode uses 0.5 units per card -- 5x the minimum. This is deliberately generous
so that edges of stacked cards remain visually distinct even at high zoom.

### Interaction with SelectionManager's Z-pop

SelectionManager uses `Z_POP_AMOUNT = 3` and saves/restores original Z. The window
manager must coordinate:

1. **Windows not managed by SelectionManager.** Agent windows (AgentGrid) and
   dynamically-created windows are not in the `grids` array that SelectionManager
   raycasts against. No conflict.
2. **File grids that might be in a WindowGroup.** If a file grid is both in a
   WindowGroup and in SelectionManager's scope, the window manager should own Z
   positioning and SelectionManager should skip Z-pop for grouped grids. Detection:
   check `grid.userData._windowGroup` before applying Z-pop.

---

## 5. WindowGroup Class Sketch

```js
/**
 * WindowGroup -- logical grouping of windows with layout modes.
 *
 * Does not own the windows (no create/dispose). Only manages their
 * spatial arrangement and group identity.
 */
export class WindowGroup {
    /**
     * @param {string} id
     * @param {SpatialAnimator} animator
     */
    constructor(id, animator) {
        this.id = id;
        this._animator = animator;

        /** @type {Array<THREE.Object3D>} Ordered members */
        this.members = [];

        /** @type {'stack'|'splay'|'free'} */
        this.mode = 'free';

        /** @type {{x,y,z}} Group anchor (top-left of first member) */
        this.anchor = { x: 0, y: 0, z: 0 };

        /** Layout config overrides */
        this.config = {};
    }

    /** Add a window to the group. */
    add(object3d) {
        if (this.members.includes(object3d)) return;
        this.members.push(object3d);
        object3d.userData._windowGroup = this.id;
    }

    /** Remove a window from the group. */
    remove(object3d) {
        const idx = this.members.indexOf(object3d);
        if (idx === -1) return;
        this.members.splice(idx, 1);
        delete object3d.userData._windowGroup;
    }

    /**
     * Switch layout mode and animate all members to new positions.
     * @param {'stack'|'splay'|'free'} mode
     * @param {Object} [config] - mode-specific overrides
     * @param {number} [duration=400] - animation duration ms
     */
    setMode(mode, config = {}, duration = 400) {
        this.mode = mode;
        Object.assign(this.config, config);

        const infos = this.members.map((m, i) => ({
            bounds: { width: 0, height: 0, ...this._getBounds(m) },
            currentPos: { x: m.position.x, y: m.position.y, z: m.position.z },
            index: i,
        }));

        let targets;
        switch (mode) {
            case 'stack': targets = stackLayout(infos, { anchor: this.anchor, ...this.config }); break;
            case 'splay': targets = splayLayout(infos, this.config); break;
            case 'free':  targets = freeLayout(infos); break;
        }

        // Animate each member to its target
        const batch = targets.map((t, i) => ({
            object: this.members[i],
            property: 'position',
            target: { x: t.x, y: t.y, z: t.z },
            opts: { duration },
        }));
        this._animator.animateBatch(batch);

        // Also animate scale if targets specify it
        for (let i = 0; i < targets.length; i++) {
            if (targets[i].scale !== undefined && targets[i].scale !== 1.0) {
                this._animator.animateTo(this.members[i], 'scale', targets[i].scale, { duration });
            }
        }
    }

    /** Get union AABB of all members. */
    getBounds() {
        const box = new THREE.Box3();
        for (const m of this.members) {
            m.updateWorldMatrix(true, true);
            const b = m.getBounds?.() ?? new THREE.Box3().setFromObject(m);
            box.union(b);
        }
        return box;
    }

    /** @private */
    _getBounds(obj) {
        if (obj.getBounds) {
            const b = obj.getBounds();
            return { width: b.max.x - b.min.x, height: b.max.y - b.min.y };
        }
        return { width: 100, height: 60 }; // fallback
    }
}
```

---

## 6. Open Questions

1. **Drag hit testing:** Should window drag use the existing GPU picking system
   (PickingSystem) or a simpler raycaster against background meshes (like
   SelectionManager)? GPU picking gives glyph-level precision but is heavier.
   Recommendation: raycaster against background meshes for drag, GPU picking only
   for glyph interaction. The two paths are already separate.

2. **Group persistence:** Should window groups survive page reload (localStorage)?
   If yes, groups store member IDs (registry IDs from SceneRegistry) and mode.
   Straightforward via StatePersistence.

3. **Hide/show animation:** Fade opacity to 0 + scale to 0.01 (never 0 to avoid
   degenerate matrix), then set `visible = false`. Reverse for show. The animator
   handles both properties; an `onComplete` callback sets visibility.

4. **GridVirtualizer interaction:** Virtualizer adds/removes grids from scene based
   on frustum. A hidden (user-hidden) window should not be re-added by the
   virtualizer. Solution: mark `grid.userData._userHidden = true`, and the
   virtualizer checks this flag before adding.
