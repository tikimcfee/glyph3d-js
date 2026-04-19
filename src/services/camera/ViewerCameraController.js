/**
 * ViewerCameraController — extracted camera subsystem
 *
 * Translation-first navigation: click-drag pans, scroll zooms,
 * WASD translates in camera-relative directions.
 *
 * Architecture: single-drain input state machine.
 *
 *   - Event handlers are pure state updaters. They record what the user is
 *     doing into `this.input` and never touch the camera directly.
 *   - `applyCamera(dt)`, called once per frame from the animate loop,
 *     reduces `this.input` into a single camera transform. All position
 *     and rotation writes live here.
 *
 * This is the only place the camera is mutated. New modes (focus-lock,
 * fly-cam, trackball) are added as branches inside `applyCamera`, not as
 * new event listeners fighting over the camera matrix.
 *
 * All user-adjustable settings are persisted to localStorage under
 * namespaced g3d.camera.* keys via StateController.
 *
 * Receives a SceneContext for shared references (camera, canvas, etc.).
 * Emits 'camera-focus-changed' window events for tree UI sync.
 */

import { primaryMod, secondaryMod } from '../utils/platform.js';
import { getCanvasViewportSize } from '../../core/canvasSize.js';
import { stateController } from '../state/StateController.js';

/**
 * Distinguish a trackpad two-finger swipe from a discrete mouse-wheel
 * tick. Wheel events carry no "source" field in browsers, so we infer
 * from delta characteristics and latch the result once any definitive
 * signal fires.
 *
 * Definitive trackpad signals (any one latches the detection):
 *   - non-zero deltaX — vertical mouse wheels don't produce it
 *   - fractional deltaY — most mouse wheels emit exact integers
 *     (100, 120, ...), trackpads produce fine-grained floats
 *   - |deltaY| < 40 px — real wheel ticks are ≥100 per event
 *
 * Definitive mouse signals:
 *   - deltaMode 1 (line) or 2 (page) — trackpads always emit pixel mode
 *
 * Ambiguous cases (integer deltaY ≥ 40 in pixel mode with no dx) fall
 * back to the latched state. Once we've seen the trackpad fingerprint
 * once in the session, we assume it holds — a fast vertical swipe that
 * produces a 150 px integer-rounded delta is still a trackpad gesture.
 *
 * If we never see a trackpad signal, we stay in "mouse wheel" mode by
 * default — the correct behaviour for desktop/mouse users.
 */
let _trackpadLatched = false;
function wheelLooksLikeTrackpad(e) {
    if (e.deltaMode !== 0) return false;
    if (Math.abs(e.deltaX) > 0.01)            { _trackpadLatched = true; return true; }
    if (e.deltaY !== Math.trunc(e.deltaY))    { _trackpadLatched = true; return true; }
    if (Math.abs(e.deltaY) < 40)              { _trackpadLatched = true; return true; }
    return _trackpadLatched;
}

const CAMERA_DEFAULTS = {
    cameraSpeed: 100,
    dragSensitivity: 1.0,
    scrollSensitivity: 1.0,
    invertDragX: false,
    invertDragY: false,
    invertScroll: false,
    dynamicSpeed: true,
};

const CLICK_THRESHOLD_PX = 5;
const FOCUS_PROBE_INTERVAL_MS = 60;

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

        // Backwards-compat alias. Other code and helpers in this file still
        // reference `_focusPivot` directly; point both at the same Vector3.
        this._focusPivot = this.input.focus.pivot;

        // Listener registry for clean teardown.
        this._listeners = [];
    }

    _makeInputState() {
        const THREE = this.THREE;
        return {
            // Event-shaped modifier snapshot — passed directly to
            // primaryMod / secondaryMod without needing a conversion.
            modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
            buttons:   { left: false, middle: false, right: false },
            cursor:    { x: 0, y: 0, inCanvas: false },
            keys:      new Set(),
            drag: {
                active: false,
                mode:   null,             // 'pan' | 'orbit'
                startX: 0, startY: 0,
                prevX:  0, prevY:  0,
                dx:     0, dy:     0,     // accumulated since last drain
            },
            wheel: {
                dx: 0, dy: 0,             // accumulated since last drain
                clientX: 0, clientY: 0,
                mods: null,               // snapshot at event time
            },
            focus: {
                // Geometric state only: the pivot point (where zoom/orbit
                // anchor) and the gesture-anchor client coords. Attention
                // semantics (who is "attended", whether the probe should
                // suppress) moved to ctx.attentionManager in L1-A:
                //   attention.primary !== null  = probe suppressed
                //                                 (replaces focus.locked)
                //   attention.hover.id          = hovered entity
                //                                 (replaces focus.attendedId)
                pivot:       new THREE.Vector3(0, 0, 0),
                lastProbeMs: 0,
                // Client-space position of the current gesture's "anchor":
                // cursor for mouse, pinch centroid for touch. The zoom
                // pipeline itself is dolly-forward (doesn't use these),
                // but the focus probe + future anchor-aware handlers need
                // a common place to read where the gesture is happening.
                clientX:     0,
                clientY:     0,
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

        const snapshotModifiers = (e) => {
            input.modifiers.shiftKey = !!e.shiftKey;
            input.modifiers.altKey   = !!e.altKey;
            input.modifiers.ctrlKey  = !!e.ctrlKey;
            input.modifiers.metaKey  = !!e.metaKey;
        };

        // --- Keyboard ---

        track(document, 'keydown', (e) => {
            snapshotModifiers(e);
            input.keys.add(e.code);
        });
        track(document, 'keyup', (e) => {
            snapshotModifiers(e);
            input.keys.delete(e.code);
        });

        // --- Mouse: drag state + click disambiguation ---

        track(canvas, 'mousedown', (e) => {
            if (!(e.target === canvas || canvas.contains(e.target))) return;
            snapshotModifiers(e);
            if (e.button === 0) input.buttons.left = true;
            if (e.button === 1) input.buttons.middle = true;
            if (e.button === 2) input.buttons.right = true;

            input.drag.active = true;
            input.drag.mode   = e.shiftKey ? 'orbit' : 'pan';
            input.drag.startX = e.clientX;
            input.drag.startY = e.clientY;
            input.drag.prevX  = e.clientX;
            input.drag.prevY  = e.clientY;
            input.drag.dx     = 0;
            input.drag.dy     = 0;

            canvas.style.cursor = input.drag.mode === 'orbit' ? 'move' : 'grabbing';
        });

        track(document, 'mouseup', (e) => {
            snapshotModifiers(e);
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
            snapshotModifiers(e);
            input.cursor.x = e.clientX;
            input.cursor.y = e.clientY;
            input.cursor.inCanvas = (e.target === canvas || canvas.contains(e.target));

            if (input.drag.active) {
                // Accumulate drag delta; applyCamera drains it each frame.
                input.drag.dx += e.clientX - input.drag.prevX;
                input.drag.dy += e.clientY - input.drag.prevY;
                input.drag.prevX = e.clientX;
                input.drag.prevY = e.clientY;
            } else {
                // Idle hover — probe the focus pivot so zoom/orbit anchor on
                // whatever the cursor is pointing at.
                this._probeFocusPivot(e.clientX, e.clientY);
            }
        });

        // --- Scroll: pan by default, zoom with secondary mod or pinch ---

        track(canvas, 'wheel', (e) => {
            if (!(e.target === canvas || canvas.contains(e.target))) return;
            e.preventDefault();
            snapshotModifiers(e);
            input.wheel.dx += e.deltaX;
            input.wheel.dy += e.deltaY;
            input.wheel.clientX = e.clientX;
            input.wheel.clientY = e.clientY;
            input.wheel.mods = {
                shiftKey: e.shiftKey,
                altKey:   e.altKey,
                ctrlKey:  e.ctrlKey,
                metaKey:  e.metaKey,
            };

            // Device heuristic: trackpad two-finger swipes produce small,
            // smooth pixel deltas (often with a non-zero dx axis). Mouse
            // wheels fire larger discrete ticks on the dy axis only. This
            // flips the default action so a wheel-user gets zoom-to-cursor
            // while a trackpad-user gets the natural two-finger pan.
            //
            // Synthetic ctrlKey — set by browsers during trackpad pinch —
            // is treated as a modifier, which pairs with the trackpad
            // default (modifier → zoom) so pinch-to-zoom does what you
            // expect.
            const isTrackpad = wheelLooksLikeTrackpad(e);
            const modHeld    = secondaryMod(e) || e.ctrlKey;
            const willZoom   = isTrackpad ? modHeld : !modHeld;
            input.wheel.isTrackpad = isTrackpad;
            input.wheel.willZoom   = willZoom;

            // Fresh raycast at the cursor so the focus pivot reflects
            // exactly where the user is pointing. The mousemove probe
            // throttles to 60ms, so without a fresh hit a zoom initiated
            // right after a cursor jump uses the previous target and
            // "rolls off" onto the old hit point.
            // Probe gate: when the primary attention is sticky-set (reader
            // mode, camera.attend) we don't want the wheel-zoom to steal
            // hover attention back to whatever happens to be under the
            // cursor. Previously this was `!input.focus.locked`; L1-A
            // replaces that gate with a direct AttentionManager check.
            const am = this.ctx?.attentionManager;
            const primaryHeld = !!am?.get?.('primary');
            if (!primaryHeld && willZoom) {
                const router = this.ctx?.entityInputRouter;
                if (router && typeof router.raycastAtClient === 'function') {
                    const hit = router.raycastAtClient(e.clientX, e.clientY);
                    if (hit && hit.point) {
                        input.focus.pivot.copy(hit.point);
                        // Wheel-zoom's fresh hit is a stronger signal than
                        // the throttled mousemove probe, so update the
                        // hover slot directly (single writer: AttentionManager).
                        if (hit.registryId) {
                            am?.set?.('hover', hit.registryId, { entity: hit.entry || null });
                        } else {
                            am?.clear?.('hover');
                        }
                    }
                }
            }
        }, { passive: false });

        // --- Window resize ---

        track(window, 'resize', () => {
            const { width, height } = getCanvasViewportSize(canvas);
            this.ctx.camera.aspect = width / height;
            this.ctx.camera.updateProjectionMatrix();
        });

        canvas.style.cursor = 'grab';

        // --- Settings UI (sliders, buttons) ---

        this._bindSlider('cam-speed', 'cam-speed-value', (val) => this.setSpeed(val));
        this._bindSlider('drag-sensitivity', 'drag-sensitivity-value', (val) => {
            this.settings.dragSensitivity = val;
            this._persistSettings();
        });
        this._bindSlider('scroll-sensitivity', 'scroll-sensitivity-value', (val) => {
            this.settings.scrollSensitivity = val;
            this._persistSettings();
        });

        const resetBtn = document.getElementById('reset-camera');
        if (resetBtn) {
            const handler = () => this.reset();
            resetBtn.addEventListener('click', handler);
            this._listeners.push({ target: resetBtn, event: 'click', handler });
        }
        const fitAllBtn = document.getElementById('fit-all');
        if (fitAllBtn) {
            const handler = () => this.focusOnGrids();
            fitAllBtn.addEventListener('click', handler);
            this._listeners.push({ target: fitAllBtn, event: 'click', handler });
        }

        this._restoreUI();
    }

    /**
     * Throttled raycast under the cursor; updates `focus.pivot` to the
     * exact world-space hit point. Left alone when no window is hit so the
     * pivot doesn't flick back to origin between windows.
     *
     * @private
     */
    _probeFocusPivot(clientX, clientY) {
        // Probe gate: when primary is sticky-set, don't let the free-roaming
        // hover probe overwrite the attended entity. (Pre-L1 this was
        // `focus.locked`; AttentionManager.primary is the single source.)
        const am = this.ctx?.attentionManager;
        if (am?.get?.('primary')) return;

        const focus = this.input.focus;
        const now = performance.now();
        if (now - focus.lastProbeMs < FOCUS_PROBE_INTERVAL_MS) return;
        focus.lastProbeMs = now;

        const router = this.ctx?.entityInputRouter;
        if (!router || typeof router.raycastAtClient !== 'function') return;
        const hit = router.raycastAtClient(clientX, clientY);
        if (!hit) {
            // Cursor over empty space — keep the pivot where it was (avoid
            // flicking back to origin) but clear hover attention so the
            // previously-hovered grid starts easing back to its default.
            am?.clear?.('hover');
            return;
        }
        if (hit.point) focus.pivot.copy(hit.point);
        if (hit.registryId) {
            am?.set?.('hover', hit.registryId, { entity: hit.entry || null });
        } else {
            am?.clear?.('hover');
        }
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
        this._applyDrag();
        this._applyWheel();
        this._applyKeyboardMotion(deltaTime);
        this._applyRotation();
    }

    /** @private */
    _applyDrag() {
        const drag = this.input.drag;
        if (!drag.active) return;
        if (drag.dx === 0 && drag.dy === 0) return;
        if (drag.mode === 'orbit') {
            this._orbitBy(drag.dx, drag.dy);
        } else {
            this._panBy(drag.dx, drag.dy);
        }
        drag.dx = 0;
        drag.dy = 0;
    }

    /** @private */
    _applyWheel() {
        const wheel = this.input.wheel;
        if (wheel.dx === 0 && wheel.dy === 0) return;

        // willZoom was resolved at event time against the device heuristic
        // + modifier state (see wheel listener). Fall back to mouse-wheel
        // semantics if the field is missing (e.g. code injected a delta).
        const willZoom = wheel.willZoom ?? true;
        if (willZoom) {
            this._zoomBy(wheel.dy);
        } else {
            this._panBy(-wheel.dx, -wheel.dy);
        }
        wheel.dx = 0;
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
        if (moveDir.lengthSq() === 0) return;

        moveDir.normalize();
        moveDir.applyQuaternion(camera.quaternion);
        const speedScale = this.settings.dynamicSpeed
            ? this._getViewDistance() / 200
            : 1;
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

    // ============ Camera math (called from applyCamera only) ============

    /**
     * Orbit around the focus pivot. Screen-pixel deltas → spherical
     * rotation; pitch/yaw are re-derived from the resulting quaternion
     * (YXZ order) so _applyRotation doesn't stomp our orbit next frame.
     * @private
     */
    _orbitBy(dx, dy) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const pivot = this.input.focus.pivot;
        const offset = camera.position.clone().sub(pivot);
        const radius = offset.length();
        if (radius < 0.001) return;

        let theta = Math.atan2(offset.x, offset.z);
        let phi   = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));

        const sens = this.settings?.rotateSensitivity ?? 0.005;
        theta -= dx * sens;
        phi   -= dy * sens;

        const eps = 0.02;
        phi = Math.max(eps, Math.min(Math.PI - eps, phi));

        offset.x = radius * Math.sin(phi) * Math.sin(theta);
        offset.y = radius * Math.cos(phi);
        offset.z = radius * Math.sin(phi) * Math.cos(theta);

        camera.position.copy(pivot).add(offset);
        camera.lookAt(pivot);

        // Sync pitch/yaw from the quaternion lookAt just wrote, using the
        // same YXZ order that _applyRotation will use on the next frame.
        // Otherwise the orbit would appear to do nothing.
        const euler = new THREE.Euler(0, 0, 0, 'YXZ');
        euler.setFromQuaternion(camera.quaternion);
        this.pitch = euler.x;
        this.yaw   = euler.y;
    }

    /**
     * Pan: translate the camera in its own right/up plane. Pixel deltas
     * are scaled to world units via FOV + viewport height; when
     * dynamicSpeed is on, view distance also factors in so drag feels
     * proportional at any zoom.
     * @private
     */
    _panBy(dx, dy) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const sens = this.settings.dragSensitivity;

        const dist = this.settings.dynamicSpeed ? this._getViewDistance() : 200;
        const fovFactor = 2 * Math.tan((camera.fov * Math.PI / 180) / 2);
        const { height: vpHeight } = getCanvasViewportSize(this.ctx.canvas);
        const pixelScale = (dist * fovFactor) / vpHeight;

        const moveX = (this.settings.invertDragX ? dx : -dx) * pixelScale * sens;
        const moveY = (this.settings.invertDragY ? -dy : dy) * pixelScale * sens;

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

        camera.position.addScaledVector(right, moveX);
        camera.position.addScaledVector(up, moveY);
    }

    /**
     * Zoom: dolly the camera toward the focus pivot using a multiplicative
     * (geometric) step. Each unit of wheel delta multiplies the camera's
     * distance from the pivot by a constant ratio — so consecutive scroll
     * ticks feel consistent whether you're far from the pivot or close to
     * it, instead of asymptotically braking as dist → 0 (the old linear
     * step did that and felt like rolling a skateboard over a cylinder).
     *
     * Because the camera translates along the camera→pivot axis, the pivot
     * stays pinned to its screen-space position — so if the pivot was set
     * from a cursor raycast, zoom visibly converges on the cursor.
     * @private
     */
    /**
     * Dolly along the camera's current forward direction — no pivot, no
     * raycast, no anchor point. Each call moves the camera by a step
     * proportional to the current view distance, so the perceived zoom
     * rate stays consistent whether you're close to or far from the scene.
     *
     * Positive deltaY = "scroll away" = zoom out (camera retreats).
     * Negative deltaY = "scroll toward" = zoom in (camera advances).
     *
     * Shared with TouchController: pinch-delta becomes a wheel-equivalent
     * deltaY (sign flipped because fingers-spreading = zoom in) and lands
     * here so the math lives in exactly one place.
     */
    _zoomBy(deltaY) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const delta = this.settings.invertScroll ? -deltaY : deltaY;

        // k controls perceived speed: each unit of deltaY multiplies view
        // distance by exp(k · delta), so a typical wheel tick (≈100) is
        // ≈22% of current distance. Exponential keeps near and far zoom
        // feeling the same instead of asymptotically braking.
        const K = 0.002;
        const factor = Math.exp(delta * K * this.settings.scrollSensitivity);

        const viewDist = this._getViewDistance();
        const newDist = Math.max(1, viewDist * factor);
        const step = newDist - viewDist; // + when zooming out, − zooming in

        // camera-local −Z is "forward" (what the camera faces). Zooming
        // out moves backward (+step in the −forward direction).
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

    /** @private */
    _getViewDistance() {
        return Math.max(Math.abs(this.ctx.camera.position.z), 1);
    }

    // ============ UI glue ============

    /** @private */
    _bindSlider(sliderId, labelId, onChange) {
        const slider = document.getElementById(sliderId);
        const label = document.getElementById(labelId);
        if (!slider) return;
        const handler = (e) => {
            const val = parseFloat(e.target.value);
            if (label) label.textContent = val.toFixed(1);
            onChange(val);
        };
        slider.addEventListener('input', handler);
        this._listeners.push({ target: slider, event: 'input', handler });
    }

    /** @private */
    _restoreUI() {
        const s = this.settings;

        const speedSlider = document.getElementById('cam-speed');
        const speedLabel = document.getElementById('cam-speed-value');
        if (speedSlider) {
            const sliderVal = s.cameraSpeed / 20;
            speedSlider.value = sliderVal;
            if (speedLabel) speedLabel.textContent = sliderVal.toFixed(1);
        }

        const dragSlider = document.getElementById('drag-sensitivity');
        const dragLabel = document.getElementById('drag-sensitivity-value');
        if (dragSlider) {
            dragSlider.value = s.dragSensitivity;
            if (dragLabel) dragLabel.textContent = s.dragSensitivity.toFixed(1);
        }

        const scrollSlider = document.getElementById('scroll-sensitivity');
        const scrollLabel = document.getElementById('scroll-sensitivity-value');
        if (scrollSlider) {
            scrollSlider.value = s.scrollSensitivity;
            if (scrollLabel) scrollLabel.textContent = s.scrollSensitivity.toFixed(1);
        }
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
     * Compute the world-space target position the camera should fly to when
     * focusing on a grid. Pure — does not mutate the camera.
     *
     * Exposed so reader-mode can animate toward the target instead of
     * snapping instantly.
     *
     * @param {number} index - grid index in ctx.getGrids()
     * @returns {{x:number,y:number,z:number}|null} target or null if invalid
     */
    computeGridFocus(index) {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (index < 0 || index >= grids.length) return null;

        const grid = grids[index];
        const bounds = grid.getBounds();
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const lineCount = grid.lines ? grid.lines.length : 1;
        const lineSpacing = size.y / Math.max(lineCount, 1);

        const READABLE_LINES = 35;
        const visibleLines = Math.min(lineCount, READABLE_LINES);
        const targetViewHeight = visibleLines * lineSpacing;

        const fovRad = this.ctx.camera.fov * Math.PI / 180;
        const halfTan = Math.tan(fovRad / 2);

        const distForHeight = (targetViewHeight / 0.85) / (2 * halfTan);
        const distForWidth = (size.x / 0.85) / (2 * this.ctx.camera.aspect * halfTan);
        const distance = Math.max(distForHeight, distForWidth, 5);

        const centerX = (bounds.min.x + bounds.max.x) / 2;
        const topY = bounds.max.y;

        const visibleHalfH = distance * halfTan;
        const topMargin = 0.08;
        const cameraY = topY - visibleHalfH * (1 - 2 * topMargin);

        return { x: centerX, y: cameraY, z: bounds.max.z + distance };
    }

    focusOnGrid(index) {
        const target = this.computeGridFocus(index);
        if (!target) return;
        this.pitch = 0;
        this.yaw = 0;
        this.ctx.camera.position.set(target.x, target.y, target.z);
        window.dispatchEvent(new CustomEvent('camera-focus-changed', {
            detail: { index }
        }));
    }

    focusOnGrids() {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (grids.length === 0) return;

        const bounds = this.ctx.stackManager
            ? this.ctx.stackManager.getTotalBounds()
            : this.ctx.treemapManager
                ? this.ctx.treemapManager.getTotalBounds()
                : this.ctx.spiralManager
                    ? this.ctx.spiralManager.getTotalBounds()
                    : this.ctx.hierarchicalManager
                        ? this.ctx.hierarchicalManager.getTotalBounds()
                        : this.ctx.layoutManager.getTotalBounds();

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
        this.ctx.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
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

        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
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
        this.cameraSpeed = speed * 20;
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
        this._restoreUI();
    }

    // ============ Helpers ============

    /**
     * Z-distance needed for a `width`x`height` region to fill `fillFraction`
     * of the viewport. Accounts for FOV and aspect ratio.
     * @private
     */
    _zDistanceForFit(width, height, fillFraction = 0.85) {
        const fovRad = this.ctx.camera.fov * Math.PI / 180;
        const aspect = this.ctx.camera.aspect;

        const dH = (height / fillFraction) / (2 * Math.tan(fovRad / 2));
        const dW = (width / fillFraction) / (2 * aspect * Math.tan(fovRad / 2));

        return Math.max(dH, dW);
    }

    dispose() {
        this.teardownEventListeners();
    }
}

export default ViewerCameraController;
