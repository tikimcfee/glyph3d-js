import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useAppCommands } from './CommandProvider.jsx';
import { resolveGesture } from './gestureResolver.js';
import { entryForGrid, resolveGlyphHitFor } from './CanvasInteraction.jsx';

// TouchAdapter — the touch twin of the mouse path (ViewerCameraController +
// CanvasPicker). Owns ALL finger-on-screen input on the canvas so the mouse
// substrate stays untouched: per-device/browser touch quirks isolate here,
// which is the reason this is a separate adapter rather than a merge of the
// mouse path onto Pointer Events (those have their own cross-browser seams to
// validate on macOS Safari / Linux Firefox before we cross that bridge).
//
// Gesture → substrate mapping (every seam is documented as preserved for this):
//   1-finger tap         → resolveGesture({type:'click'})   — same path as
//                          CanvasPicker.onUp: the responder chain decides what
//                          the tap MEANS (focus / place caret / free keyboard).
//   1-finger double-tap  → resolveGesture({type:'dblclick'}) — enters grid edit
//                          (the touch equivalent of dblclick-to-edit; a hardware
//                          keyboard attached to a tablet can then type).
//   1-finger drag        → cameraController._applyDragTranslation(dx, dy)
//                          (the "Public pan entry point preserved for
//                          TouchController" seam at ViewerCameraController:724).
//   2-finger pinch       → cameraController._zoomBy(-Δspread) — sign-flipped per
//                          the "Shared with TouchController" docstring (fingers
//                          spreading = dolly in = negative wheel deltaY).
//   2-finger drag        → ctx.tryScrollHovered(Δ) else _applyDragTranslation —
//                          the wheel equivalent: scroll the framed surface under
//                          the fingers (terminal scrollback / grid conveyor),
//                          else pan the camera.
//
// Not in this pass (clean follow-ups, each with its own seam):
//   • long-press → object move       (the ObjectDragger twin: Ctrl/Cmd+drag)
//   • two-finger twist → _lookBy     (yaw/pitch, the rotate twin)
//   • touch fires chrome actions     (close/pin/drop buttons; today a tap that
//     lands on a window control selects the window behind it — the dock/HUD
//     remains the chrome path on mobile)
//   • soft keyboard / IME            (the 3D editor + terminal still require
//     real KeyboardEvents; a hidden <textarea> IME sink is the separable, harder
//     next pass)
//
// Ownership contract (no double-eventing): CanvasInteraction's pointer handlers
// early-return on `pointerType === 'touch'`, and `touch-action: none` +
// preventDefault() on the touch listeners suppress the browser's compatibility
// mouse events. So a finger never re-fires through the mouse path, and the
// camera substrate (raw mousedown/move/wheel in ViewerCameraController) is
// naturally untouched — touch synthesizes no mouse events under touch-action:none.

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Release later than this (with little drift) is a hold, not a tap. */
const TAP_MS = 250;
/** Finger travel beyond this (quickly) is a drag, not a tap. */
const TAP_DRIFT_PX = 10;
/** Two taps within this window count as a dblclick (matches dblclick feel). */
const DBL_TAP_MS = 300;
/** …and within this radius of the first tap. */
const DBL_TAP_PX = 24;
/** |Δpinch-distance| past this locks a 2-finger gesture to pinch (zoom). */
const PINCH_LOCK_PX = 8;
/** 2-finger midpoint travel past this locks it to scroll/pan instead. */
const SCROLL_LOCK_PX = 8;
/**
 * Pinch-delta (CSS px, ~1–10/frame) → wheel-equivalent deltaY (~100/notch).
 * _zoomBy's math (and scrollSensitivity) is shared with the mouse wheel, so we
 * scale pinch into the same units. Tuned so a deliberate pinch feels like a
 * brisk wheel roll, not a notch-y click.
 */
const PINCH_TO_WHEEL = 6;

export default function TouchAdapter() {
  const { gl, camera, scene } = useThree();
  const client = useAppCommands();

  useEffect(() => {
    if (!client) return;
    const { ctx, router, registry } = client;
    const dom = gl.domElement;

    // cameraController is a lazy getter on ctx (CommandProvider.jsx:140) — same
    // read HudPanel uses. Called at gesture time so a late-mounting controller
    // (ViewerCamera's effect) is picked up without re-running this effect.
    const cc = () => ctx.cameraController;

    // Claim the canvas for touch: no browser pan/pinch-zoom-of-page, no
    // compatibility mouse events. The page handles every gesture here. Restored
    // on unmount so a hot-swap during dev doesn't strand the style.
    const prevTouchAction = dom.style.touchAction;
    dom.style.touchAction = 'none';

    // ── Gesture state ──────────────────────────────────────────────────────
    // Active touches: identifier → {x,y, startX,startY,startT, prevX,prevY}.
    const touches = new Map();
    /** null | 'pan' | 'pinch' | 'scroll' — locked once a 1- or 2-finger gesture commits. */
    let mode = null;
    let prevPinchDist = 0;
    let prevMid = null; // {x, y}
    /** Last single-tap {t, x, y} for double-tap detection. */
    let lastTap = null;
    /**
     * The pixel the current tap resolved at. Set in onTouchEnd right before
     * resolveGesture runs; read by placeCaretFromPointer. Touch has no hover
     * phase, so the caret can't read a cursor — this is the tap coordinate the
     * mouse path gets from its live cursor (CanvasPicker reads s.x/s.y). Symmetric
     * closures, same resolver contract (one-arg placeCaretFromPointer).
     */
    let pendingTapPos = null;

    // ── Caret placement at the pending tap pixel ───────────────────────────
    // Same body as CanvasPicker.placeCaretFromPointer, but the pick coords are
    // the TAP position (pendingTapPos, set by onTouchEnd), not a mouse cursor —
    // touch has no hover phase to inherit. resolveGesture's click/dblclick
    // policies call this with a single `entry` arg (no coords), exactly like the
    // mouse path, so the tap position flows through closure state, not args.
    const placeCaretFromPointer = (entry) => {
      const ps = ctx.pickingSystem;
      if (!ps || entry?.type !== 'grid' || !pendingTapPos) return Promise.resolve(false);
      const rect = dom.getBoundingClientRect();
      ps.setMousePosition(pendingTapPos.x - rect.left, pendingTapPos.y - rect.top);
      ps.markDirty(); // channels share one _needsPick latch — mandatory before this pass
      return ps.pickAsync('glyph', camera, scene).then((hit) => {
        const slot = resolveGlyphHitFor(entry.grid, hit);
        if (slot == null) return false; // missed, or another grid's glyphs
        const pos = entry.grid.getCharForSlot?.(slot);
        if (!pos) return false;
        router.execute(['edit.goto', entry.id, String(pos.line), String(pos.col)]);
        return true;
      }).catch(() => false);
    };

    // gestureEnv — same shape CanvasPicker builds (gestureResolver.js reads
    // exec/ctx/attention/context/cameraDock/placeCaretFromPointer). Lazy getters
    // so it tracks the live interactionContext/cameraDock (this child effect
    // mounts before CommandProvider's parent effect creates them).
    const gestureEnv = {
      exec: (cmd) => router.execute(cmd),
      get ctx() { return ctx; },
      get attention() { return ctx.attentionManager; },
      get context() { return ctx.interactionContext; },
      get cameraDock() { return ctx.cameraDock; },
      placeCaretFromPointer,
    };

    // Resolve what's under a tap → registry entry (or null = empty space). The
    // grid+group cascade; the handle channel (window controls) is deliberately
    // NOT consulted this pass — a tap on a close/pin button selects the window
    // behind it (see "Not in this pass" above). Cross-channel precedence mirrors
    // CanvasPicker's hover loop: grid wins; group (corridor boxes) is lowest and
    // only catches the empty interior.
    const resolveTapTarget = (clientX, clientY) => {
      const ps = ctx.pickingSystem;
      if (!ps) return Promise.resolve(null);
      const rect = dom.getBoundingClientRect();
      ps.setMousePosition(clientX - rect.left, clientY - rect.top);
      ps.markDirty();
      return ps.pickAsync('grid', camera, scene).then((hit) => {
        // Instanced panel-field hit resolves through ownerOf (same convention as
        // CanvasPicker's grid-channel resolve).
        const hitToken = (hit && typeof hit.token?.ownerOf === 'function')
          ? hit.token.ownerOf(hit.slotIndex)
          : hit?.token;
        const gridEntry = hitToken ? entryForGrid(registry, hitToken) : null;
        if (gridEntry) return gridEntry;
        // No grid under the tap → try the group channel (corridor/container
        // boxes). Lowest precedence, so it only wins in empty interior.
        ps.markDirty();
        return ps.pickAsync('group', camera, scene).then(
          (g) => (g?.token ? entryForGrid(registry, g.token) : null),
          () => null,
        );
      }).catch(() => null);
    };

    // ── Touch listeners ────────────────────────────────────────────────────

    const onTouchStart = (e) => {
      // preventDefault suppresses the compatibility mouse events the browser
      // synthesizes from touch (the mouse path must never see a finger). Bound
      // passive:false above so this is honored.
      e.preventDefault();
      for (const t of e.changedTouches) {
        touches.set(t.identifier, {
          x: t.clientX, y: t.clientY,
          startX: t.clientX, startY: t.clientY, startT: performance.now(),
          prevX: t.clientX, prevY: t.clientY,
          // Once true, this finger can never become a tap — it joined a
          // multi-finger gesture (pinch/scroll). Stays true through its lift so
          // the SECOND finger of a 2-finger gesture can't fall through to the
          // tap-candidate path after the first lift resets `mode`.
          multiTouch: false,
        });
      }
      // A second finger ends any single-finger pan/tap candidate and arms the
      // 2-finger decision (pinch vs scroll), resolved on the first qualifying move.
      // Mark every active touch multi-touch so neither finger's lift is a tap.
      if (touches.size >= 2) {
        mode = null;
        for (const rec of touches.values()) rec.multiTouch = true;
        const [a, b] = [...touches.values()];
        prevPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        prevMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    };

    const onTouchMove = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const rec = touches.get(t.identifier);
        if (!rec) continue;
        rec.x = t.clientX; rec.y = t.clientY;
      }

      if (touches.size === 1) {
        const rec = [...touches.values()][0];
        // Commit to pan once the finger drifts past the tap threshold. Before
        // that, the move is still a tap candidate (a slightly jittery finger).
        if (mode === null) {
          if (Math.hypot(rec.x - rec.startX, rec.y - rec.startY) > TAP_DRIFT_PX) mode = 'pan';
        }
        if (mode === 'pan') {
          // Pixel deltas — _panBy applies invertDragX/Y + dragSensitivity, so a
          // finger drag feels identical to a mouse drag at the same sensitivity.
          cc()?._applyDragTranslation(rec.x - rec.prevX, rec.y - rec.prevY);
        }
        rec.prevX = rec.x; rec.prevY = rec.y;
        return;
      }

      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dDist = dist - prevPinchDist;
        const dMidX = mid.x - prevMid.x;
        const dMidY = mid.y - prevMid.y;

        // Decide pinch vs scroll on the first qualifying movement; once locked,
        // a gesture doesn't flip mid-stream (avoids zoom/scroll stutter when a
        // pinch drifts slightly).
        if (mode === null) {
          if (Math.abs(dDist) > PINCH_LOCK_PX) mode = 'pinch';
          else if (Math.hypot(dMidX, dMidY) > SCROLL_LOCK_PX) mode = 'scroll';
        }

        const controller = cc();
        if (!controller) return;

        if (mode === 'pinch') {
          // Sign-flipped per the seam docstring: fingers spreading (Δdist > 0)
          // = dolly in = negative wheel deltaY.
          controller._zoomBy(-dDist * PINCH_TO_WHEEL);
        } else if (mode === 'scroll') {
          // Two-finger drag = the wheel equivalent: scroll the framed surface
          // under the fingers (terminal/grid), else pan. Vertical primary; the
          // page (paging) gate is the scroll's sibling, so try it on a miss.
          const consumed = ctx.tryScrollHovered?.(-dMidY) || ctx.tryPageHovered?.(-dMidY);
          if (!consumed) controller._applyDragTranslation(dMidX, dMidY);
        }

        prevPinchDist = dist;
        prevMid = mid;
      }
    };

    const onTouchEnd = (e) => {
      e.preventDefault();
      const ended = [];
      for (const t of e.changedTouches) {
        const rec = touches.get(t.identifier);
        if (rec) ended.push(rec);
        touches.delete(t.identifier);
      }

      // A 2-finger gesture peeling off: never synthesize taps for fingers that
      // were part of a pinch/scroll. Reset and wait for a clean single tap.
      if (mode === 'pinch' || mode === 'scroll') {
        if (touches.size < 2) { mode = null; prevMid = null; prevPinchDist = 0; }
        return;
      }
      // A pan already consumed this gesture (drag moved past tap drift): no tap.
      if (mode === 'pan') {
        if (touches.size === 0) mode = null;
        return;
      }

      // Tap candidate: single finger, short, low drift, NEVER part of a
      // multi-finger gesture. Measure timing at LIFT (double-tap detection reads
      // the clock now); the async target resolve follows, so the gesture fires a
      // touch later — fine, the user's finger is already up.
      const rec = ended[ended.length - 1];
      if (!rec || rec.multiTouch) { if (touches.size === 0) mode = null; return; }
      const dt = performance.now() - rec.startT;
      const drift = Math.hypot(rec.x - rec.startX, rec.y - rec.startY);
      if (dt > TAP_MS || drift > TAP_DRIFT_PX) {
        if (touches.size === 0) mode = null;
        return;
      }

      const now = performance.now();
      const x = rec.x, y = rec.y;
      const isDbl = !!lastTap
        && (now - lastTap.t) < DBL_TAP_MS
        && Math.hypot(x - lastTap.x, y - lastTap.y) < DBL_TAP_PX;

      resolveTapTarget(x, y).then((target) => {
        // Mirror the hover slot the mouse path maintains, so the caret-preview,
        // focus outline, and command verbs all see the touched entity. resolveGesture's
        // dock.spotlight / modifier-click pre-empts read ctx + mods; mods is empty
        // (touch has no modifier keys), so those branches decline naturally.
        router.execute(`attention.set hover ${target?.id || 'none'}`);
        // Stamp the tap pixel BEFORE resolveGesture — placeCaretFromPointer (which
        // the click/dblclick policies invoke) reads it from closure state.
        pendingTapPos = { x, y };
        resolveGesture({ type: isDbl ? 'dblclick' : 'click', target, mods: {} }, gestureEnv);
      });
      lastTap = isDbl ? null : { t: now, x, y };
      if (touches.size === 0) mode = null;
    };

    const onTouchCancel = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) touches.delete(t.identifier);
      if (touches.size === 0) { mode = null; prevMid = null; prevPinchDist = 0; }
    };

    dom.addEventListener('touchstart', onTouchStart, { passive: false });
    dom.addEventListener('touchmove', onTouchMove, { passive: false });
    dom.addEventListener('touchend', onTouchEnd, { passive: false });
    dom.addEventListener('touchcancel', onTouchCancel, { passive: false });

    return () => {
      dom.removeEventListener('touchstart', onTouchStart);
      dom.removeEventListener('touchmove', onTouchMove);
      dom.removeEventListener('touchend', onTouchEnd);
      dom.removeEventListener('touchcancel', onTouchCancel);
      dom.style.touchAction = prevTouchAction;
    };
  }, [client, gl, camera, scene]);

  return null;
}
