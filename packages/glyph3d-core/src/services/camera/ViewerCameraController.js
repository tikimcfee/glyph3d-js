/**
 * ViewerCameraController — the fly camera.
 *
 * The camera IS the viewer. Every motion is egocentric — measured in the
 * camera's own frame, never relative to an external anchor:
 *
 *   - drag       → pan (truck/pedestal: slide along your own right/up)
 *   - shift+drag → look (yaw/pitch in place — turn to face things)
 *   - wheel      → dolly (move yourself toward/away from what you're looking at)
 *   - WASD/QE    → strafe / dolly / rise
 *
 * Movement scales to the distance down your forward axis to whatever you're looking at
 * (`_lookDistance()`). PAN holds a STILL anchor — it SAMPLES that distance once when the
 * drag starts (clamped to the engagement band by `_panDistance()`) and holds it for the
 * stroke, so a drag covers consistent on-screen distance start to finish (the Blender
 * lesson; a drag has an anchor, the thing under your cursor). WASD and dolly read it LIVE:
 * a flight's speed follows the `_flightSpeedScale()` valley — slow as it nears a file, snap
 * back to cruise once it's too close — and a dolly is a smooth approach while zooming.
 * Reading a file head-on → fine; sweeping the void → coarse. Nothing scales off the cursor
 * or a content centroid — the RTS-style refs that made the same gesture behave differently
 * over a grid vs. empty space are gone.
 *
 * Architecture: single-drain input state machine.
 *   - Event handlers are pure state updaters — they record intent into
 *     `this.input` and never touch the camera.
 *   - `applyCamera(dt)`, once per frame, reduces `this.input` into one camera
 *     transform. All position/rotation writes live here — the only place the
 *     camera is mutated.
 *
 * Settings persist to localStorage under namespaced g3d.camera.* keys via
 * StateController. Receives a SceneContext for shared refs (camera, canvas, …).
 * Emits 'camera-focus-changed' window events for tree UI sync.
 */

import { getCanvasViewportSize } from '../../core/canvasSize.js';
import { stateController } from '../state/StateController.js';
import { zDistanceForFit, worldPerPixel, tweenPose } from '../spatial/spatialMath.js';
import { worldBounds } from '../spatial/sceneBounds.js';

const CAMERA_DEFAULTS = {
    cameraSpeed: 500,
    dragSensitivity: 1.0,
    scrollSensitivity: 1.0,
    invertDragX: false,
    invertDragY: false,
    invertScroll: false,
    dynamicSpeed: true,
    // Proximity auto-slow. The speed is a relevance VALLEY over distance-to-content,
    // decoupling WHERE the slow happens (the distance knobs) from HOW slow/fast it gets
    // (the × knobs — multiples of base move speed). See _flightSpeedScale for the curve.
    //   min/max   — floor (closest) and ceiling (far/cruise) speed multipliers.
    //   near/far  — distances bounding the ramp: floor reached at nearDist, cruise at farDist.
    //   release   — TOO-close cutoff: inside it you snap back to cruise (you've passed through
    //               the content). 0 disables the snap-back.
    //   smoothing — seconds: exponential damping of the live speed scale so the valley (and the
    //               snap-back) arrive as a smooth surge, not a per-frame step. 0 = off/instant.
    // Values below are hand-tuned by feel (not derived): a gentle ramp to a 2× cruise that
    // tops out by 800 units, with an early 40-unit punch-through. Keep in lockstep with the
    // settings-schema defaults (app/client/settings.js) so a fresh controller + panel agree.
    dynamicSpeedMin: 0.15,
    dynamicSpeedMax: 2,
    dynamicNearDist: 30,
    dynamicFarDist: 800,
    dynamicReleaseDist: 40,
    dynamicSpeedSmoothing: 0.12,
    // Soft bounds — a gentle leash so a dropped frame (a dev hot-reload stalls, dt balloons,
    // one WASD step flings you miles) can't strand the camera in the void with the content out
    // of sight. The content's world AABB padded by `softBoundsPadding` × the world's max
    // dimension is the FREE zone — inside it you fly unhindered. Stray outside AND let go of the
    // controls and a spring (`softBoundsReturn` seconds) eases you back to the nearest edge; it
    // never fights an active drive, so a deliberate pull-back-for-overview still works. A hard
    // wall at `softBoundsHardCap` × the world size is always on (even mid-drive) so nothing can
    // launch you to infinity. Keep in lockstep with the settings-schema defaults (app/client/settings.js).
    softBounds: true,
    softBoundsPadding: 1.0,
    softBoundsHardCap: 4.0,
    softBoundsReturn: 0.35,
};

const CLICK_THRESHOLD_PX = 5;

// Movement scale (world units): the flat constant when dynamicSpeed is off / no content
// exists, and the floor & ceiling that clamp the dynamic look-distance so a glance at
// empty space can never make dolly/zoom run away (nor freeze it nose-against a panel).
const DEFAULT_LOOK_DIST = 200;
const MIN_LOOK_DIST = 2;
const MAX_LOOK_DIST = 2000;

// A2 — the look-ray is a small CONE: forward + 4 rays tilted by ±CONE_TAN in the screen
// right/up axes. A single thin ray threads through gaps to a far hit and misses near
// content just off the view axis that you're actually flying toward; the cone catches it.
const CONE_TAN = 0.25;   // tan of the cone half-angle (~14°)

// Soft-bounds scale floor (world units): the world's max dimension is clamped up to this before
// the leash margins are derived from it, so a tiny or near-empty world still leaves a sane amount
// of room — a single small file shouldn't leash the camera to its face.
const MIN_WORLD_EXTENT = 500;
// Soft-bounds settle deadband (world units): an exp glide is asymptotic, so once the spring is
// within this of the boundary, snap exactly onto it and stop — otherwise the sub-unit residual
// would re-fire the move-save trigger every idle frame.
const SOFT_BOUNDS_SETTLE = 0.5;

// The keys that drive the camera (WASD pan, Q/E/Space vertical). A fly (flyTo)
// is cancelled when the user "grabs control" — but only via THESE keys, not any
// keypress: nav bindings (hjkl → focus.neighbor) issue a fly AND hold a key, so
// a blanket "any key held" cancel would kill the fly the same frame it starts.
const FLIGHT_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyQ', 'KeyE']);
const anyFlightKey = (keys) => {
    for (const k of FLIGHT_KEYS) if (keys.has(k)) return true;
    return false;
};

export class ViewerCameraController {
    /**
     * @param {SceneContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.THREE = ctx.THREE;

        this.settings = {
            cameraSpeed:       stateController.get('camera.speed', CAMERA_DEFAULTS.cameraSpeed),
            dragSensitivity:   stateController.get('camera.dragSensitivity', CAMERA_DEFAULTS.dragSensitivity),
            scrollSensitivity: stateController.get('camera.scrollSensitivity', CAMERA_DEFAULTS.scrollSensitivity),
            invertDragX:       stateController.get('camera.invertDragX', CAMERA_DEFAULTS.invertDragX),
            invertDragY:       stateController.get('camera.invertDragY', CAMERA_DEFAULTS.invertDragY),
            invertScroll:      stateController.get('camera.invertScroll', CAMERA_DEFAULTS.invertScroll),
            dynamicSpeed:      stateController.get('camera.dynamicSpeed', CAMERA_DEFAULTS.dynamicSpeed),
            dynamicSpeedMin:   stateController.get('camera.dynamicSpeedMin', CAMERA_DEFAULTS.dynamicSpeedMin),
            dynamicSpeedMax:   stateController.get('camera.dynamicSpeedMax', CAMERA_DEFAULTS.dynamicSpeedMax),
            dynamicNearDist:   stateController.get('camera.dynamicNearDist', CAMERA_DEFAULTS.dynamicNearDist),
            dynamicFarDist:    stateController.get('camera.dynamicFarDist', CAMERA_DEFAULTS.dynamicFarDist),
            dynamicReleaseDist: stateController.get('camera.dynamicReleaseDist', CAMERA_DEFAULTS.dynamicReleaseDist),
            dynamicSpeedSmoothing: stateController.get('camera.dynamicSpeedSmoothing', CAMERA_DEFAULTS.dynamicSpeedSmoothing),
            softBounds:        stateController.get('camera.softBounds', CAMERA_DEFAULTS.softBounds),
            softBoundsPadding: stateController.get('camera.softBoundsPadding', CAMERA_DEFAULTS.softBoundsPadding),
            softBoundsHardCap: stateController.get('camera.softBoundsHardCap', CAMERA_DEFAULTS.softBoundsHardCap),
            softBoundsReturn:  stateController.get('camera.softBoundsReturn', CAMERA_DEFAULTS.softBoundsReturn),
        };

        // Publicly-readable rotation state. `applyCamera` writes these into
        // the camera quaternion each frame using YXZ Euler order.
        this.pitch = 0;
        this.yaw = 0;

        // cameraSpeed is exposed as a settable property because the speed
        // slider writes directly to it. Keeping a top-level reference also
        // matches the TouchController's expectations.
        this.cameraSpeed = this.settings.cameraSpeed;

        // Input state — single source of truth for what the user is doing.
        // Event handlers update this; applyCamera() reads it.
        this.input = this._makeInputState();

        // Movement scale — the proximity distance that movement reads.
        //  - _moveScale: PAN samples it once at gesture start and HOLDS it (a drag must
        //    cover consistent on-screen distance start to finish — a still anchor). WASD
        //    re-samples it LIVE every frame, so a flight slows as it nears content and
        //    speeds back up as it clears it. Dolly also reads live (a smooth approach
        //    while zooming) and is the manual granularity knob. The last write is held
        //    here so a pan begun right after a flight/dolly inherits the live distance.
        this._moveScale = DEFAULT_LOOK_DIST;

        // A1 — the exponentially-damped flight speed scale, carried across frames so the
        // valley transitions surge smoothly. null = unlatched (next flight frame snaps);
        // reset to null whenever movement stops, so takeoff stays crisp.
        this._dampedSpeedScale = null;

        // camera.lock: when true, applyCamera applies NO camera transform (drag / WASD /
        // rotation / zoom frozen) — but the wheel still routes to a focused framed surface
        // (grid/terminal scroll is not camera motion). Toggled via setLocked() / camera.lock.
        this.locked = false;

        // Save trigger: SessionStore hangs a callback here, fired from applyCamera whenever the
        // pose actually changes this frame. Debounced downstream, so a continuous flight collapses
        // to one save ~when the camera settles. Null until armed (and during/after dispose).
        this.onMoved = null;

        // Listener registry for clean teardown.
        this._listeners = [];
    }

    _makeInputState() {
        return {
            buttons:   { left: false, middle: false, right: false },
            cursor:    { x: 0, y: 0, inCanvas: false },
            keys:      new Set(),
            drag: {
                active: false,
                mode:   null,             // 'pan' | 'look'
                startX: 0, startY: 0,
                prevX:  0, prevY:  0,
                dx:     0, dy:     0,     // accumulated since last drain
            },
            wheel: {
                dy: 0,                    // accumulated wheel delta since last drain (dolly)
            },
        };
    }

    /**
     * Bind all event listeners. Call once after construction.
     *
     * Handlers here are intentionally thin — they update `this.input` and
     * nothing else. Anything that touches the camera lives in applyCamera.
     */
    setupEventListeners() {
        const canvas = this.ctx.canvas;
        const input = this.input;

        const track = (target, event, handler, opts) => {
            target.addEventListener(event, handler, opts);
            this._listeners.push({ target, event, handler, opts });
        };

        // --- Keyboard ---

        track(document, 'keydown', (e) => {
            // L1-A WASD gate: when an entity holds the key-focus slot
            // (attention.key.id set to e.g. a terminal), the camera
            // drain stops consuming keys. Without this, typing in a
            // focused terminal flies the camera. The ShortcutManager
            // continues to fire for unambiguous shortcuts (Esc etc.);
            // it has its own per-binding logic.
            const am = this.ctx?.attentionManager;
            if (am?.get?.('key')) return;
            input.keys.add(e.code);
        });
        track(document, 'keyup', (e) => {
            // Symmetric: if key-focus is active, keyup for that same
            // focused period should also not reach the camera. The
            // input.keys set is ignored in that mode; nothing to clear.
            const am = this.ctx?.attentionManager;
            if (am?.get?.('key')) return;
            input.keys.delete(e.code);
        });

        // --- Mouse: drag state + click disambiguation ---

        track(canvas, 'mousedown', (e) => {
            if (!(e.target === canvas || canvas.contains(e.target))) return;
            if (e.button === 0) input.buttons.left = true;
            if (e.button === 1) input.buttons.middle = true;
            if (e.button === 2) input.buttons.right = true;

            // The camera yields a left-press to a direct-manipulation gesture, so
            // the view never slides out from under what you're dragging:
            //   • Ctrl/Cmd + left-drag MOVES the object under the cursor (ObjectDragger).
            //   • A plain left-press on a resize grip RESIZES it (ResizeDragger).
            // isGripPress() is the shared, freshness-gated authority both this and
            // ResizeDragger consult (assigned onto this controller's ctx by the
            // canvas picker — see CanvasInteraction.jsx), so the resize-vs-pan
            // verdict is identical on both sides and never trusts a stale pick.
            if (e.button === 0 && (e.ctrlKey || e.metaKey || this.ctx?.isGripPress?.(e.clientX, e.clientY))) {
                input.drag.active = false;
                return;
            }

            input.drag.active = true;
            input.drag.mode   = e.shiftKey ? 'look' : 'pan';
            input.drag.startX = e.clientX;
            input.drag.startY = e.clientY;
            input.drag.prevX  = e.clientX;
            input.drag.prevY  = e.clientY;
            input.drag.dx     = 0;
            input.drag.dy     = 0;
            // Sample the move scale ONCE, here, and hold it for the whole drag — the
            // pan keeps one consistent feel from grab to release (the per-frame
            // recompute is what made it morph as the camera neared a file).
            if (input.drag.mode === 'pan') this._moveScale = this._panDistance();

            canvas.style.cursor = input.drag.mode === 'look' ? 'move' : 'grabbing';
        });

        track(document, 'mouseup', (e) => {
            if (e.button === 0) input.buttons.left = false;
            if (e.button === 1) input.buttons.middle = false;
            if (e.button === 2) input.buttons.right = false;

            if (input.drag.active) {
                const dx = e.clientX - input.drag.startX;
                const dy = e.clientY - input.drag.startY;
                if (Math.sqrt(dx * dx + dy * dy) < CLICK_THRESHOLD_PX) {
                    canvas.dispatchEvent(new CustomEvent('canvas-click', {
                        detail: {
                            clientX: e.clientX,
                            clientY: e.clientY,
                            shiftKey: e.shiftKey,
                            ctrlKey: e.ctrlKey,
                            metaKey: e.metaKey,
                        },
                        bubbles: true,
                    }));
                }
            }
            input.drag.active = false;
            input.drag.mode   = null;
            canvas.style.cursor = 'grab';
        });

        track(document, 'mousemove', (e) => {
            input.cursor.x = e.clientX;
            input.cursor.y = e.clientY;
            input.cursor.inCanvas = (e.target === canvas || canvas.contains(e.target));

            if (input.drag.active) {
                // Accumulate drag delta; applyCamera drains it each frame.
                input.drag.dx += e.clientX - input.drag.prevX;
                input.drag.dy += e.clientY - input.drag.prevY;
                input.drag.prevX = e.clientX;
                input.drag.prevY = e.clientY;
            }
            // Idle hover is resolved by the GPU pick (CanvasPicker), not here.
        });

        // --- Wheel: dolly toward / away from what you're looking at ---

        track(canvas, 'wheel', (e) => {
            if (!(e.target === canvas || canvas.contains(e.target))) return;
            e.preventDefault();
            // One axis, one meaning: the wheel dollies (moves you along your view
            // axis). applyCamera's _applyWheel drains it. No device heuristic, no
            // cursor raycast — the dolly is purely egocentric.
            input.wheel.dy += e.deltaY;
        }, { passive: false });

        // --- Window resize ---

        track(window, 'resize', () => {
            const { width, height } = getCanvasViewportSize(canvas);
            this.ctx.camera.aspect = width / height;
            this.ctx.camera.updateProjectionMatrix();
        });

        canvas.style.cursor = 'grab';
        // (The old DOM slider/button glue — cam-speed/drag-/scroll-sensitivity, reset-camera,
        //  fit-all — targeted elements that don't exist in the r3f app. Settings now flow
        //  through app/client/settings.js + the camera.* verbs. Glue deleted.)
    }

    // ============ Per-frame drain ============

    /**
     * Update the camera from accumulated input state. Called once per frame
     * from the animation loop.
     *
     * Ordering matters: drag first (it may move the camera), then wheel
     * (which may zoom into a new spot), then keyboard (WASD flight),
     * finally rotation (from pitch/yaw). Anything that wants to be
     * additive in a single frame composes here.
     *
     * @param {number} deltaTime - seconds since last frame
     */
    update(deltaTime) {
        this.applyCamera(deltaTime);
    }

    /**
     * Internal name that the new architecture uses; `update()` is kept as
     * the external entry point because the animate loop already calls it.
     */
    applyCamera(deltaTime) {
        if (this.locked) {
            // Camera frozen (camera.lock). Still drain the wheel so a focused framed grid/
            // terminal scrolls — that is NOT camera motion, and _applyWheel self-gates its zoom
            // on `locked`. Apply no other transform; drop accumulated drag so unlocking can't jump.
            this._applyWheel();
            this.input.drag.dx = 0;
            this.input.drag.dy = 0;
            return;
        }
        // Snapshot the pose so we can tell, after the transforms below, whether the camera ACTUALLY
        // moved this frame — that edge is the save trigger (a flight/drag/zoom/fly all flow through
        // here, so one check covers every motion path).
        const cam = this.ctx.camera;
        const bx = cam.position.x, by = cam.position.y, bz = cam.position.z, bp = this.pitch, byaw = this.yaw;
        // A camera fly (flyTo) owns the frame while it runs — UNLESS the user grabs control
        // (drag / wheel / WASD), which cancels it instantly so the fly never traps the view.
        if (this._tween && this._stepTween(deltaTime)) { this._notifyMoved(bx, by, bz, bp, byaw); return; }
        // Did the user drive THIS frame? Capture the wheel intent before _applyWheel drains it
        // (drag.active and held keys persist across frames; wheel.dy is zeroed by the drain).
        const drovewheel = this.input.wheel.dy !== 0;
        this._applyDrag();
        this._applyWheel();
        this._applyKeyboardMotion(deltaTime);
        this._applyRotation();
        this._applySoftBounds(deltaTime, drovewheel);
        this._notifyMoved(bx, by, bz, bp, byaw);
    }

    /**
     * Fire onMoved iff the camera pose changed since the frame's start snapshot. At rest the camera
     * re-derives the same quaternion every frame but position/pitch/yaw don't move, so this stays
     * silent — no idle save churn. @private
     */
    _notifyMoved(bx, by, bz, bp, byaw) {
        if (!this.onMoved) return;
        const p = this.ctx.camera.position;
        if (p.x !== bx || p.y !== by || p.z !== bz || this.pitch !== bp || this.yaw !== byaw) this.onMoved();
    }

    /**
     * The camera's full serializable state: position + orientation (pitch/yaw — the camera carries
     * no roll) + flight speed. This IS the camera for persistence; pitch/yaw are the raw inputs to
     * the per-frame YXZ quaternion, so they round-trip orientation exactly with no reconstruction.
     * @returns {{pos:{x:number,y:number,z:number}, pitch:number, yaw:number, speed:number}}
     */
    getState() {
        const p = this.ctx.camera.position;
        return { pos: { x: p.x, y: p.y, z: p.z }, pitch: this.pitch, yaw: this.yaw, speed: this.cameraSpeed };
    }

    /**
     * Set the camera DIRECTLY from serialized state — position, orientation, speed — with no tween
     * and no verb replay. Cancels any in-flight fly so a restored pose isn't immediately overridden.
     * This is the load path: deserialize → applyState, and the camera lands exactly where it was
     * saved. Each field is guarded so a partial/legacy blob applies what it has and ignores the rest.
     * @param {{pos?:{x:number,y:number,z:number}, pitch?:number, yaw?:number, speed?:number}} s
     */
    applyState(s) {
        if (!s) return;
        this._tween = null;
        const p = s.pos;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
            this.ctx.camera.position.set(p.x, p.y, p.z);
        }
        if (Number.isFinite(s.pitch)) this.pitch = s.pitch;
        if (Number.isFinite(s.yaw)) this.yaw = s.yaw;
        this._applyRotation();
        if (Number.isFinite(s.speed)) { this.cameraSpeed = s.speed; this.settings.cameraSpeed = s.speed; }
    }

    /**
     * Animate the camera to a target pose over `ms` (ease-out). Replayable — calling it again
     * retargets from wherever the camera is now. Interruptible (see applyCamera). The actual
     * interpolation is the pure `tweenPose` (unit-tested); this just holds the from/to/clock.
     * @param {{position:{x,y,z}, pitch?:number, yaw?:number}} to
     * @param {{ms?:number}} [opts]
     */
    flyTo(to, { ms = 300 } = {}) {
        const cam = this.ctx.camera;
        this._tween = {
            from: { position: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, pitch: this.pitch, yaw: this.yaw },
            to:   { position: { x: to.position.x, y: to.position.y, z: to.position.z }, pitch: to.pitch ?? 0, yaw: to.yaw ?? 0 },
            ms: Math.max(1, ms),
            elapsed: 0,
        };
    }

    /**
     * Advance the active fly one frame. Returns true if it consumed the frame (still flying),
     * false if it was cancelled by user input (so applyCamera falls through to normal control).
     * @private
     */
    _stepTween(dt) {
        const i = this.input;
        if (i.drag.active || i.wheel.dy !== 0 || anyFlightKey(i.keys)) { this._tween = null; return false; }
        const tw = this._tween;
        tw.elapsed += dt * 1000;
        const t = Math.min(tw.elapsed / tw.ms, 1);
        const pose = tweenPose(tw.from, tw.to, t);
        this.ctx.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
        this.pitch = pose.pitch;
        this.yaw = pose.yaw;
        this._applyRotation();
        if (t >= 1) this._tween = null;
        return true;
    }

    /** @private */
    _applyDrag() {
        const drag = this.input.drag;
        if (!drag.active) return;
        if (drag.dx === 0 && drag.dy === 0) return;
        if (drag.mode === 'look') {
            this._lookBy(drag.dx, drag.dy);
        } else {
            this._panBy(drag.dx, drag.dy);
        }
        drag.dx = 0;
        drag.dy = 0;
    }

    /** @private */
    _applyWheel() {
        const wheel = this.input.wheel;
        if (wheel.dy === 0) return;

        // Hovered-surface scroll gate: the framed surface UNDER THE CURSOR (a terminal, or a
        // framed code grid) takes the wheel to scroll ITSELF instead of moving the camera —
        // pointing at open space or an unframed grid falls through to the dynamic-speed dolly.
        // The bridged hook dispatches terminal.scroll / grid.scroll and returns true when it
        // consumes the wheel — gate here in the drain (not the listener) so the verdict uses the
        // live hover and the camera never also dollies.
        if (this.ctx?.tryScrollHovered?.(wheel.dy)) {
            wheel.dy = 0;
            return;
        }

        // Camera frozen (camera.lock): the wheel didn't hit a focused surface, so consume it
        // without moving the camera.
        if (this.locked) {
            wheel.dy = 0;
            return;
        }

        this._zoomBy(wheel.dy); // dolly along the view axis
        wheel.dy = 0;
    }

    /** @private */
    _applyKeyboardMotion(dt) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const keys = this.input.keys;
        const moveDir = new THREE.Vector3();

        if (keys.has('KeyW')) moveDir.z -= 1;
        if (keys.has('KeyS')) moveDir.z += 1;
        if (keys.has('KeyA')) moveDir.x -= 1;
        if (keys.has('KeyD')) moveDir.x += 1;
        if (keys.has('Space') || keys.has('KeyQ')) moveDir.y += 1;
        if (keys.has('KeyE')) moveDir.y -= 1;

        const moving = moveDir.lengthSq() > 0;
        if (!moving) { this._dampedSpeedScale = null; return; } // unlatch → next takeoff snaps

        // LIVE, re-sampled every frame: the flight visibly DECELERATES as it nears content
        // and re-accelerates as it clears it (or punches back to cruise once it's too close
        // — the release zone) — the auto-slow you feel mid-flight, not only after a stop-
        // and-restart. One distance read drives both the speed curve and the held pan
        // distance, so a pan begun right after a flight inherits the live distance. (Pan
        // itself HOLDS its sample — a drag has an on-screen anchor a flight doesn't.)
        const dist = this._lookDistance();
        this._moveScale = this._panDistance(dist);

        // A1 — frame-rate-independent exponential damping of the speed scale: the valley and
        // the snap-back arrive as a smooth surge, not a per-frame step. alpha = 1−exp(−dt/τ),
        // τ = dynamicSpeedSmoothing seconds. The first frame of a flight (null latch) or
        // smoothing off (τ≤0) snaps, so takeoff is crisp; only in-flight changes are damped.
        const target = this._flightSpeedScale(dist);
        const tau = this.settings.dynamicSpeedSmoothing;
        if (this._dampedSpeedScale == null || !(tau > 0)) {
            this._dampedSpeedScale = target;
        } else {
            this._dampedSpeedScale += (target - this._dampedSpeedScale) * (1 - Math.exp(-dt / tau));
        }
        const speedScale = this._dampedSpeedScale;

        moveDir.normalize();
        moveDir.applyQuaternion(camera.quaternion);
        moveDir.multiplyScalar(this.cameraSpeed * dt * speedScale);
        camera.position.add(moveDir);
    }

    /** @private */
    _applyRotation() {
        const THREE = this.THREE;
        const q = new THREE.Quaternion();
        q.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
        this.ctx.camera.quaternion.copy(q);
    }

    /**
     * Soft bounds — keep the fly camera from getting lost in the void. The content's world AABB
     * (the shared `worldBounds` spine, dock chrome excluded) padded by `softBoundsPadding` × the
     * world's max dimension is the FREE zone — inside it nothing happens. Outside it, and only
     * when you're NOT actively driving, a frame-rate-independent spring (`softBoundsReturn`
     * seconds) eases the eye back to the nearest point on that padded box: a fling that overshoots
     * glides home the moment you let go, while a deliberate pull-back for an overview is never
     * fought. A HARD wall at `softBoundsHardCap` × the world size is clamped every frame — even
     * mid-drive — so a dropped-frame step (a huge dt during a dev hot-reload) can't strand the
     * camera in orbit. No content → no leash. Never runs during a fly or while locked (those
     * paths return from applyCamera before reaching here).
     * @private
     * @param {number} dt seconds since last frame
     * @param {boolean} drovewheel whether the wheel dollied this frame (drained before this runs)
     */
    _applySoftBounds(dt, drovewheel) {
        const s = this.settings;
        if (!s.softBounds) return;
        const surfaces = this.ctx.getSurfaces?.() || this.ctx.getGrids?.() || [];
        if (!surfaces.length) return;

        const THREE = this.THREE;
        // The content extent — the shared world-bounds spine. Dock tiles ride a fixed offset
        // ahead of the eye, so counting them would drag the leash box around with the camera;
        // skip them (the same exclusion the look-distance scan makes).
        const box = worldBounds(surfaces, this._softBox ??= new THREE.Box3(), { skip: this.ctx.dockTiles ?? null });
        if (box.isEmpty()) return;

        // Scale the margins off the world's MAX dimension (floored), not per-axis size: planar
        // content has ~zero depth, yet you still need room to pull BACK off the plane to see it.
        const size = box.getSize(this._softSize ??= new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z, MIN_WORLD_EXTENT);
        const eye = this.ctx.camera.position;

        // Hard cap FIRST and ALWAYS: an absolute wall the eye cannot cross, even while driving —
        // the dropped-frame backstop. Forced ≥ the soft pad so the two can never invert.
        const capScale = Math.max(s.softBoundsHardCap, s.softBoundsPadding);
        const cap = (this._softCapBox ??= new THREE.Box3()).copy(box).expandByScalar(extent * capScale);
        cap.clampPoint(eye, eye);   // in place; a no-op when already inside

        // Soft spring: idle only. A held drive (drag / wheel / WASD) is an intentional move — the
        // leash waits for you to let go, then eases you home, so an overview pull-back isn't fought.
        if (this.input.drag.active || drovewheel || anyFlightKey(this.input.keys)) return;

        const soft = (this._softPadBox ??= new THREE.Box3()).copy(box).expandByScalar(extent * s.softBoundsPadding);
        const nearest = soft.clampPoint(eye, this._softNearest ??= new THREE.Vector3());
        const gap = eye.distanceTo(nearest);
        if (gap <= SOFT_BOUNDS_SETTLE) {            // inside, on the face, or within the deadband
            if (gap > 0) eye.copy(nearest);         // settle exactly so the move-save trigger goes quiet
            return;
        }
        const tau = s.softBoundsReturn;
        eye.lerp(nearest, tau > 0 ? 1 - Math.exp(-dt / tau) : 1);   // frame-rate-independent ease; 0 = instant
    }

    /**
     * Freeze / unfreeze camera motion (camera.lock). When locked, applyCamera applies no
     * camera transform, but the wheel still routes to a focused framed surface (grid/terminal
     * scroll). Idempotent.
     * @param {boolean} locked
     */
    setLocked(locked) { this.locked = !!locked; }

    /** @returns {boolean} whether camera motion is frozen */
    isLocked() { return this.locked; }

    // ============ Camera math (called from applyCamera only) ============

    /**
     * First-person mouselook: drag yaws/pitches the camera IN PLACE — no pivot,
     * no orbit — so you keep your position and only change where you're looking.
     * pitch/yaw feed _applyRotation (YXZ), which sets the quaternion each frame.
     * @private
     */
    _lookBy(dx, dy) {
        const sens = this.settings?.rotateSensitivity ?? 0.005;
        this.yaw   -= dx * sens;
        this.pitch -= dy * sens;
        const lim = Math.PI / 2 - 0.02;   // stop just short of looking straight up/down
        this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }

    /**
     * Pan (truck/pedestal): slide the camera in its own right/up plane. Pixel deltas
     * convert to world units through `_moveScale` — the scale SAMPLED at gesture start
     * and held — so a drag covers the same on-screen distance start to finish, and
     * feels identical whether you're over a grid or empty space.
     * @private
     */
    _panBy(dx, dy) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const { height: vpHeight } = getCanvasViewportSize(this.ctx.canvas);
        const wpp = worldPerPixel(camera, this._moveScale, vpHeight) * this.settings.dragSensitivity;

        const moveX = (this.settings.invertDragX ? dx : -dx) * wpp;
        const moveY = (this.settings.invertDragY ? -dy : dy) * wpp;

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

        camera.position.addScaledVector(right, moveX);
        camera.position.addScaledVector(up, moveY);
    }

    /**
     * Dolly: move the camera along its OWN forward axis — no pivot, no anchor. Unlike
     * pan/WASD (which hold a sampled scale), dolly reads the LIVE look distance each
     * tick: the step is a geometric fraction of it, so you approach smoothly and
     * brake as you near what you're pointed at — the one motion where a continuously-
     * updating distance is the right feel, and your manual granularity knob. It also
     * refreshes `_moveScale`, so a pan right after a dolly inherits the new distance.
     *
     *   Positive deltaY = "scroll away" = dolly back (camera retreats).
     *   Negative deltaY = "scroll toward" = dolly in (camera advances).
     *
     * Shared with TouchController: pinch-delta becomes a wheel-equivalent deltaY
     * (sign flipped, fingers-spreading = in) and lands here so the math lives once.
     * @private
     */
    _zoomBy(deltaY) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const delta = this.settings.invertScroll ? -deltaY : deltaY;

        // K sets perceived speed: each unit of deltaY scales distance by exp(K·delta),
        // so a typical wheel tick (≈100) moves ≈22% of the current view distance.
        const K = 0.002;
        const factor = Math.exp(delta * K * this.settings.scrollSensitivity);

        const dist = this._lookDistance();   // live: smooth approach while zooming
        const step = dist * factor - dist;   // + when dollying back, − when dollying in
        this._moveScale = dist;              // keep pan/WASD in sync with the new granularity

        // camera-local −Z is "forward" (what the camera faces). Dollying back moves
        // backward (+step in the −forward direction).
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(forward, -step);
    }

    /**
     * Public pan entry point preserved for TouchController, which doesn't
     * go through the InputState pipeline. Routes to the same math.
     */
    _applyDragTranslation(dx, dy) {
        this._panBy(dx, dy);
    }

    /**
     * Look distance: how far away the content is that you're navigating relative to.
     * The SAMPLING PRIMITIVE — pan/WASD read it once at gesture start (then hold in
     * `_moveScale`); dolly reads it live. Depends only on the camera, never on the
     * cursor or a content centroid.
     *
     * Two samples, one robust answer (the cheap version of multiscale-nav's depth
     * cubemap — see [[reference_camera_navigation_prior_art]]):
     *   1. `fwd`  — nearest hit within a small forward CONE (the view ray + 4 rays tilted
     *      ±CONE_TAN in screen right/up), each hit projected onto the view axis. "What I'm
     *      flying toward" — the cone catches near content just off-axis that a single thin
     *      ray would thread past on its way to a far hit.
     *   2. `near` — distance to the nearest surface AABB that ISN'T fully behind the eye
     *      (any direction you could be moving into). No raycast, so no forward blind spot;
     *      the behind-cull keeps content you've already flown past from braking you — no
     *      reason to slow for what you're not looking at.
     * Samples EVERY framed surface (code grids AND terminals — getSurfaces, not the
     * grid-only getGrids), so flying toward a terminal slows you down exactly as flying
     * toward a file does; a terminal is content too.
     * Prefer `fwd`; fall back to `near` when the ray misses (looking at empty space)
     * — NOT a stale hold, which is what let dolly run away off the top of the tree.
     * Clamp to [MIN, MAX] so a glance at the void can never blow the scale up (nor a
     * nose-against-panel pin it to zero). dynamicSpeed off → flat constant.
     * @private @returns {number} distance in world units, in [MIN_LOOK_DIST, MAX_LOOK_DIST]
     */
    _lookDistance() {
        if (!this.settings.dynamicSpeed) return DEFAULT_LOOK_DIST;
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const surfaces = this.ctx.getSurfaces?.() || this.ctx.getGrids?.() || [];
        if (!surfaces.length) return DEFAULT_LOOK_DIST;

        // Dock tiles ride a fixed offset ahead of the camera (CameraDock). Counted,
        // they'd pin look-distance to ~0 — a wall in your face braking every move. We
        // skip them inline (Set.has on identity) rather than pre-filtering the array:
        // this runs every frame, so no per-frame allocation. Null when no dock exists.
        const dockTiles = this.ctx.dockTiles ?? null;

        const origin = camera.position;
        const q = camera.quaternion;
        const forward = (this._lookFwd ??= new THREE.Vector3()).set(0, 0, -1).applyQuaternion(q);
        const right   = (this._lookRight ??= new THREE.Vector3()).set(1, 0, 0).applyQuaternion(q);
        const up      = (this._lookUp ??= new THREE.Vector3()).set(0, 1, 0).applyQuaternion(q);
        // The forward cone: view ray + 4 tilted rays (±CONE_TAN in right/up), renormalized.
        const dirs = (this._coneDirs ??= [0, 0, 0, 0, 0].map(() => new THREE.Vector3()));
        dirs[0].copy(forward);
        dirs[1].copy(forward).addScaledVector(right,  CONE_TAN).normalize();
        dirs[2].copy(forward).addScaledVector(right, -CONE_TAN).normalize();
        dirs[3].copy(forward).addScaledVector(up,     CONE_TAN).normalize();
        dirs[4].copy(forward).addScaledVector(up,    -CONE_TAN).normalize();
        const ray = (this._ray ??= new THREE.Ray());
        ray.origin.copy(origin);
        const hit = new THREE.Vector3();
        const center = (this._lookCenter ??= new THREE.Vector3());
        const half = (this._lookHalf ??= new THREE.Vector3());
        let fwd = Infinity;   // nearest forward hit — precise "what I'm aimed at"
        let near = Infinity;  // nearest content you could move into — behind-eye excluded
        for (const g of surfaces) {
            if (dockTiles?.has(g)) continue; // camera-locked chrome, not world content
            const box = g.getBounds?.();
            if (!box || box.isEmpty?.()) continue;

            // Ignore surfaces fully BEHIND the eye — you're flying away from them, so they
            // have no business braking you. AABB vs the camera plane (point = eye, normal =
            // forward): the box's farthest reach along forward is centerProj + the extent's
            // projection onto |forward|; ≤0 means every corner sits behind you. A box that
            // straddles the plane (you're inside / nosing into it) still counts.
            box.getCenter(center);
            box.getSize(half).multiplyScalar(0.5);
            const centerProj = (center.x - origin.x) * forward.x
                             + (center.y - origin.y) * forward.y
                             + (center.z - origin.z) * forward.z;
            const reach = half.x * Math.abs(forward.x)
                        + half.y * Math.abs(forward.y)
                        + half.z * Math.abs(forward.z);
            if (centerProj + reach <= 0) continue; // fully behind the eye → ignore

            const dn = box.distanceToPoint(origin);
            if (dn < near) near = dn;
            for (let i = 0; i < dirs.length; i++) {
                ray.direction.copy(dirs[i]);
                if (!ray.intersectBox(box, hit)) continue;
                // Project onto the view axis (forward is unit-length) — forward-distance to
                // the content, consistent across cone rays; skip hits behind us / inside.
                const d = (hit.x - origin.x) * forward.x
                        + (hit.y - origin.y) * forward.y
                        + (hit.z - origin.z) * forward.z;
                if (d > 0 && d < fwd) fwd = d;
            }
        }

        const d = Number.isFinite(fwd) ? fwd
                : Number.isFinite(near) ? near
                : DEFAULT_LOOK_DIST;
        return Math.min(Math.max(d, MIN_LOOK_DIST), MAX_LOOK_DIST);
    }

    /**
     * The PAN move distance — the held look distance, clamped to the engagement band
     * [nearDist, farDist]. Pan needs a real DISTANCE (it drives worldPerPixel, so a drag
     * covers consistent on-screen distance), not a speed multiplier — so it just bounds
     * the raw look distance: a nose-against-a-panel floors at nearDist instead of crawling
     * to ~0, a sweep of the void caps at farDist. dynamicSpeed off → flat DEFAULT.
     * @private @param {number} [dist] the look distance to clamp (defaults to a fresh read)
     * @returns {number} pan distance in world units, in [nearDist, farDist]
     */
    _panDistance(dist = this._lookDistance()) {
        if (!this.settings.dynamicSpeed) return DEFAULT_LOOK_DIST;
        const lo = this.settings.dynamicNearDist;
        const hi = this.settings.dynamicFarDist;
        return Math.min(Math.max(dist, lo), hi);
    }

    /**
     * The WASD flight SPEED multiplier (× cameraSpeed) for a given content distance — the
     * decoupled remap that splits WHERE the slow happens (nearDist/farDist) from HOW slow
     * it gets (min/max). A relevance valley as you fly at a file:
     *   - dist ≥ farDist            → ceiling (max): far content, cruise.
     *   - nearDist ≤ dist < farDist → lerp(ceiling, floor): natural deceleration approaching.
     *   - releaseDist ≤ dist < near → floor (min): the slow reading plateau.
     *   - dist < releaseDist        → ceiling: TOO close — you've effectively passed through
     *                                 it, so it stops braking you (same idea as the behind-
     *                                 the-eye cull). releaseDist = 0 disables the snap-back.
     * Distances are decoupled from the speeds: floor/ceiling no longer ride
     * DEFAULT_LOOK_DIST, so the default near/far/release are hand-tuned by feel, not
     * derived from the multipliers. dynamicSpeed off → flat 1×.
     * @private @param {number} [dist] content distance (defaults to a fresh read)
     * @returns {number} speed multiplier in [min, max]
     */
    _flightSpeedScale(dist = this._lookDistance()) {
        const s = this.settings;
        if (!s.dynamicSpeed) return 1;
        const { dynamicNearDist: near, dynamicFarDist: far, dynamicSpeedMin: floor, dynamicSpeedMax: ceil, dynamicReleaseDist: release } = s;
        if (release > 0 && dist < release) return ceil;  // too close → snap back to cruise
        if (dist >= far) return ceil;
        if (dist <= near) return floor;
        const t = (far - dist) / (far - near);           // 0 at far, 1 at near
        return ceil + t * (floor - ceil);                // lerp(ceil, floor, t)
    }

    /** @private */
    _persistSettings() {
        const s = this.settings;
        stateController.set('camera.speed', s.cameraSpeed);
        stateController.set('camera.dragSensitivity', s.dragSensitivity);
        stateController.set('camera.scrollSensitivity', s.scrollSensitivity);
        stateController.set('camera.invertDragX', s.invertDragX);
        stateController.set('camera.invertDragY', s.invertDragY);
        stateController.set('camera.invertScroll', s.invertScroll);
        stateController.set('camera.dynamicSpeed', s.dynamicSpeed);
        stateController.set('camera.dynamicSpeedMin', s.dynamicSpeedMin);
        stateController.set('camera.dynamicSpeedMax', s.dynamicSpeedMax);
        stateController.set('camera.dynamicNearDist', s.dynamicNearDist);
        stateController.set('camera.dynamicFarDist', s.dynamicFarDist);
        stateController.set('camera.dynamicReleaseDist', s.dynamicReleaseDist);
        stateController.set('camera.dynamicSpeedSmoothing', s.dynamicSpeedSmoothing);
        stateController.set('camera.softBounds', s.softBounds);
        stateController.set('camera.softBoundsPadding', s.softBoundsPadding);
        stateController.set('camera.softBoundsHardCap', s.softBoundsHardCap);
        stateController.set('camera.softBoundsReturn', s.softBoundsReturn);
    }

    teardownEventListeners() {
        for (const { target, event, handler, opts } of this._listeners) {
            try { target.removeEventListener(event, handler, opts); } catch {}
        }
        this._listeners = [];
        if (this.ctx.canvas) {
            this.ctx.canvas.style.cursor = '';
        }
    }

    // ============ Focus methods (public API) ============

    /**
     * The focused object's true content PLANE in world space — center, FRONT normal (the glyph
     * face, local +Z), up axis (local +Y), and the on-plane width/height/depth — from its local
     * bounds × world transform. This is what reverse-billboard frames: a rotated grid's real face,
     * NOT its axis-aligned bounding box, which collapses to a sliver viewed straight down +Z. Null
     * if the object exposes no local bounds.
     * @param {Object} obj an Object3D with getLocalBounds()
     * @returns {{center:Object, normal:Object, up:Object, width:number, height:number, depth:number}|null}
     * @private
     */
    _planeOf(obj) {
        const THREE = this.THREE;
        const lb = obj?.getLocalBounds?.();
        if (!lb || lb.isEmpty?.()) return null;
        obj.updateWorldMatrix(true, false);
        const q = obj.getWorldQuaternion(new THREE.Quaternion());
        const s = obj.getWorldScale(new THREE.Vector3());
        const center = obj.localToWorld(new THREE.Vector3(
            (lb.min.x + lb.max.x) / 2, (lb.min.y + lb.max.y) / 2, (lb.min.z + lb.max.z) / 2));
        return {
            center,
            normal: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
            up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
            width: (lb.max.x - lb.min.x) * Math.abs(s.x),
            height: (lb.max.y - lb.min.y) * Math.abs(s.y),
            depth: (lb.max.z - lb.min.z) * Math.abs(s.z),
        };
    }

    /**
     * The flyTo pose that REVERSE-BILLBOARDS a plane: the camera squares up to `normal` at a
     * distance that fits width×height head-on (so an oblique surface reads face-on, not as a
     * foreshortened sliver), sitting in front of the slab and looking back along -normal. anchorTop
     * shifts the aim toward the plane's TOP edge (reading from the head of a file — fullHeight is the
     * un-capped content height); else it center-frames. FPS-style (pitch/yaw, roll-free): exact for
     * upright / yaw-rotated surfaces (the common layouts), graceful for pitched ones.
     * @returns {{position:{x:number,y:number,z:number}, pitch:number, yaw:number}}
     * @private
     */
    _billboardPose({ center, normal, up, width, height, depth = 0, fullHeight = height, anchorTop = false, fill = 0.85, topMargin = 0.08 }) {
        const camera = this.ctx.camera;
        const n = normal.clone().normalize();
        const distance = Math.max(zDistanceForFit(camera, width, height, fill), 5);

        // Aim point on the plane: center, or shifted UP toward the top edge so the head sits near
        // the top of the view (the content top, pulled down by the view margin).
        const aim = center.clone();
        if (anchorTop) {
            const visibleHalfH = distance * Math.tan((camera.fov * Math.PI / 180) / 2);
            aim.addScaledVector(up.clone().normalize(), fullHeight / 2 - visibleHalfH * (1 - 2 * topMargin));
        }

        const camPos = aim.addScaledVector(n, distance + depth * 0.5); // clear the slab, sit in front
        const fwd = n.multiplyScalar(-1);                              // look back toward the plane
        const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));     // YXZ inverse (see _applyRotation)
        const yaw = Math.atan2(-fwd.x, -fwd.z);
        return { position: { x: camPos.x, y: camPos.y, z: camPos.z }, pitch, yaw };
    }

    /**
     * Compute the world-space target POSE the camera should fly to when
     * focusing on a grid. Pure — does not mutate the camera.
     *
     * Exposed so reader-mode can animate toward the target instead of
     * snapping instantly. REVERSE-BILLBOARDED: squares to the grid's own plane (a rotated file
     * frames face-on, not as a sliver) and top-anchored to its head, so the pose carries pitch/yaw.
     *
     * @param {number} index - grid index in ctx.getGrids()
     * @returns {{x:number,y:number,z:number,pitch:number,yaw:number}|null} pose or null if invalid
     */
    computeGridFocus(index) {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (index < 0 || index >= grids.length) return null;
        const grid = grids[index];

        const plane = this._planeOf(grid);
        if (!plane) {
            // Defensive fallback: no local bounds → old axis-aligned AABB framing, head-on.
            const b = grid.getBounds?.();
            if (!b || b.isEmpty?.()) return null;
            const size = new THREE.Vector3(); b.getSize(size);
            const dist = Math.max(zDistanceForFit(this.ctx.camera, size.x, size.y, 0.85), 5);
            return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.max.z + dist, pitch: 0, yaw: 0 };
        }

        // Cap the FIT height to the readable-lines window so a long file frames its head at a
        // readable size (the rest scrolls); the top-anchor uses the FULL plane height. lineSpacing
        // is read off the TRUE plane height, so the cap is right even for a rotated grid.
        const lineCount = grid.lines ? grid.lines.length : 1;
        const READABLE_LINES = 35;
        const fitHeight = (Math.min(lineCount, READABLE_LINES) / Math.max(lineCount, 1)) * plane.height;

        const pose = this._billboardPose({
            center: plane.center, normal: plane.normal, up: plane.up,
            width: plane.width, height: fitHeight, fullHeight: plane.height, depth: plane.depth,
            anchorTop: true,
        });
        return { x: pose.position.x, y: pose.position.y, z: pose.position.z, pitch: pose.pitch, yaw: pose.yaw };
    }

    focusOnGrid(index) {
        const pose = this.computeGridFocus(index);
        if (!pose) return;
        // Fly to the file's head (top-anchored), squared to its face (reverse-billboard pitch/yaw).
        this.flyTo({ position: pose, pitch: pose.pitch, yaw: pose.yaw });
        window.dispatchEvent(new CustomEvent('camera-focus-changed', {
            detail: { index }
        }));
    }

    /**
     * Frame a single registry object (a grid OR a terminal — anything with getBounds) by its
     * world bounds, centered. focusOnGrid is grid-INDEX-coupled (getGrids('grid') excludes
     * terminals), so camera.focus routes non-grid windows here. Center-framed — the readable-
     * lines / top-anchor logic in computeGridFocus is code-grid-specific and irrelevant here.
     * @returns {boolean} true if it framed something.
     */
    focusOnObject(obj) {
        // Reverse-billboard: square the camera to the object's OWN plane so a rotated grid/terminal
        // is framed head-on (true width/height), never an edge-on sliver. Falls back to the AABB
        // path only when the object exposes no local bounds (no orientation to read).
        const plane = this._planeOf(obj);
        if (!plane) return this.focusOnBox(obj?.getBounds?.());
        const pose = this._billboardPose({
            center: plane.center, normal: plane.normal, up: plane.up,
            width: plane.width, height: plane.height, depth: plane.depth,
        });
        this.flyTo({ position: pose.position, pitch: pose.pitch, yaw: pose.yaw });
        return true;
    }

    /**
     * Frame a world-space AABB head-on, centered — the orientation-FREE focus. A box carries no
     * facing, so this squares straight down +Z. dock.focus passes a docked window's captured HOME
     * bounds (frames where it'll land, not its live mid-slide tile); a loose object's own facing
     * comes through focusOnObject/_planeOf instead.
     * @param {Object} bounds THREE.Box3
     * @returns {boolean}
     */
    focusOnBox(bounds) {
        const THREE = this.THREE;
        if (!bounds || bounds.isEmpty?.()) return false;
        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);
        const pose = this._billboardPose({
            center, normal: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0),
            width: size.x, height: size.y, depth: size.z,
        });
        this.flyTo({ position: pose.position, pitch: pose.pitch, yaw: pose.yaw });
        return true;
    }

    /**
     * Drop a framed surface (grid / terminal) into the viewer's CURRENT view — the inverse
     * of focusOnObject. focusOnObject flies the camera to a still object; this places a still
     * camera's gaze ONTO an object: it centers the object's bounds on the view axis, a fitting
     * distance ahead, and leaves it axis-aligned (+Z toward the viewer) so focusOnObject's
     * head-on framing still squares to it later. Used by terminal.create so a new terminal
     * lands where you're looking instead of at the world origin. The camera does NOT move.
     * @param {{getBounds:Function,setWorldPosition:Function,position?:Object,getWorldPosition?:Function}} obj
     * @param {{fill?:number}} [opts] - fraction of the viewport the panel should fill (default 0.7)
     * @returns {boolean} true if it placed the object
     */
    placeInView(obj, { fill = 0.7 } = {}) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        if (!camera || typeof obj?.getBounds !== 'function' || typeof obj?.setWorldPosition !== 'function') return false;
        const bounds = obj.getBounds();
        if (!bounds || bounds.isEmpty?.()) return false;

        const size = new THREE.Vector3();
        bounds.getSize(size);
        const center = new THREE.Vector3();
        bounds.getCenter(center);

        // How far ahead to sit the panel so it fills `fill` of the view; floored so a tiny
        // panel can't land on the camera's nose.
        const distance = Math.max(zDistanceForFit(camera, size.x, size.y, fill), 5);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const target = camera.position.clone().addScaledVector(forward, distance);

        // setWorldPosition moves the object's ORIGIN; its bounds center sits at a fixed local
        // offset from that origin. Translation preserves the offset, so solve for the origin
        // that lands the center exactly on `target`.
        const origin = obj.getWorldPosition?.(new THREE.Vector3()) ?? obj.position?.clone?.() ?? new THREE.Vector3();
        const offset = center.clone().sub(origin);
        const pos = target.sub(offset);
        obj.setWorldPosition({ x: pos.x, y: pos.y, z: pos.z });
        return true;
    }

    focusOnGrids() {
        const THREE = this.THREE;
        // Fit-all frames every framed surface — terminals included, so a "+ terminal"
        // you spawned off to the side is still pulled into view by fit-all. Dock tiles
        // are excluded: they're camera-locked chrome, always in view, and would skew
        // the union toward the camera.
        const surfaces = this.ctx.getSurfaces?.() || this.ctx.getGrids?.() || [];
        if (surfaces.length === 0) return;
        const dockTiles = this.ctx.dockTiles ?? null; // camera-locked chrome, excluded from the fit

        // Prefer a layout manager's cached total bounds; otherwise (e.g. the r3f
        // client, which has no managers) union the surfaces' own world bounds.
        const mgr = this.ctx.stackManager || this.ctx.treemapManager
            || this.ctx.spiralManager || this.ctx.hierarchicalManager || this.ctx.layoutManager;
        let bounds;
        if (mgr && typeof mgr.getTotalBounds === 'function') {
            bounds = mgr.getTotalBounds();
        } else {
            bounds = new THREE.Box3();
            for (const g of surfaces) {
                if (dockTiles?.has(g)) continue;
                const b = g.getBounds?.();
                if (b && !b.isEmpty()) bounds.union(b);
            }
        }
        if (!bounds || bounds.isEmpty()) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = zDistanceForFit(this.ctx.camera, size.x, size.y, 0.85);
        this.ctx.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;

        // The fit must be DRAWABLE: a large field's stand-off distance plus its own depth
        // can exceed the camera's far plane, and a fit-all that frames content the
        // renderer then clips reads as an empty world. Grow far (never shrink — the
        // Draw-distance setting owns the resting horizon) so what fit-all frames,
        // fit-all shows.
        const needed = (distance + size.z) * 1.5;
        if (this.ctx.camera.far < needed) {
            this.ctx.camera.far = needed;
            this.ctx.camera.updateProjectionMatrix();
        }
    }

    focusOnDirectory(dirPath) {
        const THREE = this.THREE;
        if (!this.ctx.hierarchicalManager) return;

        const bounds = this.ctx.hierarchicalManager.getDirectoryBounds(dirPath);
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = zDistanceForFit(this.ctx.camera, size.x, size.y, 0.85);
        this.ctx.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
    }

    focusOnDiffGrids(diffController) {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (grids.length === 0) return;

        const bounds = diffController.getTotalBounds();
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const maxDim = Math.max(size.x, size.y);
        const distance = Math.min(maxDim * 0.5, 800);
        this.ctx.camera.position.set(center.x, center.y, center.z + distance + 100);
        this.pitch = 0;
        this.yaw = 0;
    }

    focusOnDiffFile(fileIndex) {
        const gridIndex = fileIndex * 2;
        const grids = this.ctx.getGrids();
        if (gridIndex >= 0 && gridIndex < grids.length) {
            this.focusOnGrid(gridIndex);
        }
    }

    // ============ Controls ============

    setSpeed(speed) {
        // One unit convention: cameraSpeed is RAW — the same units the ctor reads from
        // settings (:94), the session saves/restores (SessionStore), and the integrator
        // consumes. The old ×20 made the verb + settings-slider 20× the boot speed while
        // save/restore stayed raw — two conventions on one key. Raw everywhere now.
        this.cameraSpeed = speed;
        this.settings.cameraSpeed = this.cameraSpeed;
        this._persistSettings();
    }

    toggleDynamicSpeed() {
        this.settings.dynamicSpeed = !this.settings.dynamicSpeed;
        this._persistSettings();
        return this.settings.dynamicSpeed;
    }

    reset() {
        this.ctx.camera.position.set(0, 0, 500);
        this.pitch = 0;
        this.yaw = 0;
    }

    resetSettings() {
        this.settings = { ...CAMERA_DEFAULTS };
        this.cameraSpeed = this.settings.cameraSpeed;
        this._persistSettings();
    }

    // ============ Helpers ============

    dispose() {
        this.teardownEventListeners();
    }
}

export default ViewerCameraController;
