import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useAppCommands } from '../../app/client/CommandProvider.jsx';

const round = (n) => Math.round(n * 100) / 100;

// Canvas interaction — hovering / clicking / dragging grids in the 3D scene.
//
// The grids are imperative Object3Ds (not r3f <mesh> JSX), so r3f's own event
// system doesn't see them. Hit-testing is the GPU ID pass (PickingSystem), NOT
// raycasting: the picking buffer is the single source of truth for what's under
// the cursor. The 'grid' channel renders each grid's background panel with a
// grid-level ID — pixel-precise, covers the whole panel (no gaps), and resolves
// the FRONT grid in an overlap/cascade (depth-tested). The 'glyph' channel
// (char-level) stays registered for highlighting features.
//
// Selection is written through the SAME attention.set / camera.focus commands the
// CLI uses, so a canvas click and `glyph3d-cli attention.set primary <id>` are
// indistinguishable downstream.

const DRAG_PX = 5; // pointer travel above this = a drag (orbit/pan), not a click
// Hover outline is inflated by this many world units so that when you hover the
// already-selected grid it reads as a light halo just OUTSIDE the steady selection
// box, instead of the two line-boxes merging into one.
const HOVER_INFLATE = 3;

// Resize floors — a terminal smaller than this is useless (and a SIGWINCH to 0
// rows confuses the shell). Drags clamp the prospective size to these.
const MIN_COLS = 8;
const MIN_ROWS = 3;

// Map a grid object (the token a 'grid'-channel pick resolves to) back to its
// registry entry { id, type, grid }.
function entryForGrid(registry, grid) {
  if (!grid) return null;
  const id = registry.getIdByGrid(grid);
  return id ? registry.get(id) : null;
}

/** Pointer + camera → GPU grid-channel pick → attention + camera, via the router. */
export function CanvasPicker() {
  const { gl, camera, scene } = useThree();
  const client = useAppCommands();
  // Cursor + last-pick guards, so the per-frame hover only picks when the cursor
  // OR the camera actually moved (idle frames cost nothing). hoverEntry caches the
  // last resolved entity so a click/drag acts on exactly what's highlighted.
  const s = useRef({
    x: 0, y: 0, in: false, downX: 0, downY: 0,
    hoverId: null, hoverEntry: null,
    pickPending: false, gpuOk: false, gpuWarned: false, lastPs: null,
    lx: NaN, ly: NaN, lin: false,
    px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN,
  }).current;

  // Wire the picking system into each grid/terminal as it registers, so the ID
  // pass covers every glyph mesh + panel. ps is created in CommandProvider's
  // effect (which runs after this child mounts), so we (re)sweep on every registry
  // change — by the time any grid registers (session restore / file.open), ps exists.
  useEffect(() => {
    if (!client) return;
    const { ctx, registry } = client;
    const wired = new WeakSet();
    let cancelled = false;
    let tslWarned = false;
    const wire = () => {
      const ps = ctx.pickingSystem;
      if (!ps) return;
      ps._tslReady.then(() => {
        if (cancelled) return;
        for (const entry of [...registry.findByType('grid'), ...registry.findByType('terminal')]) {
          const grid = entry.grid;
          if (grid && !wired.has(grid) && typeof grid.setPickingSystem === 'function') {
            wired.add(grid);
            grid.setPickingSystem(ps);
          }
        }
      }).catch((e) => {
        // TSL failed to load (e.g. the dynamic three/webgpu import rejected): no
        // grid gets wired and the ID pass stays empty (hover/click won't resolve).
        // Warn once so it isn't silent.
        if (!tslWarned) { tslWarned = true; console.warn('[CanvasPicker] TSL picking unavailable; hover/select disabled', e); }
      });
    };
    wire();
    registry.addChangeListener(wire);
    return () => { cancelled = true; registry.removeChangeListener(wire); };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const { router } = client;
    const dom = gl.domElement;

    // The one authority for "is this press on a resize grip?" — consulted by BOTH
    // ResizeDragger.onDown and ViewerCameraController.mousedown (CommandProvider
    // forwards it onto VCC's separate ctx) so the resize-vs-pan decision is identical
    // on both sides. It gates the async-resolved handleHover on FRESHNESS: the cursor
    // must still be within DRAG_PX of where the grip pick sampled, so a press never
    // acts on a stale grip the cursor has already left.
    const isGripPress = (clientX, clientY) => {
      const hh = client.ctx.handleHover, at = client.ctx.handleHoverAt;
      return !!(hh && at && Math.hypot(clientX - at.x, clientY - at.y) <= DRAG_PX);
    };
    client.ctx.isGripPress = isGripPress;

    const onMove = (e) => { s.x = e.clientX; s.y = e.clientY; s.in = true; };
    const onEnter = () => { s.in = true; };
    const onLeave = () => { s.in = false; };
    const onDown = (e) => { s.downX = e.clientX; s.downY = e.clientY; };

    const onUp = (e) => {
      // A resize drag (ResizeDragger) owns this release — never treat its tiny
      // sub-DRAG_PX nudges as a click that would re-select / refocus.
      if (client.ctx.resizing) return;
      // Only a click if the pointer barely moved (else it was an orbit/pan/drag).
      if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) > DRAG_PX) return;
      // Act on exactly what's highlighted (the grid-channel hover result). The
      // hover loop keeps s.hoverEntry current for the cursor position; clicking
      // empty space (hoverEntry null) releases keyboard focus.
      const entry = s.hoverEntry;
      if (!entry) {
        router.execute('attention.set key none');
        return;
      }
      router.execute(`attention.set primary ${entry.id}`);
      router.execute(`camera.focus ${entry.id}`);
      // Terminals take keyboard focus on click (type immediately); clicking any
      // other entity releases the key slot.
      router.execute(entry.type === 'terminal' ? `attention.set key ${entry.id}` : 'attention.set key none');
    };

    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerenter', onEnter);
    dom.addEventListener('pointerleave', onLeave);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    return () => {
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerenter', onEnter);
      dom.removeEventListener('pointerleave', onLeave);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      if (client.ctx.isGripPress === isGripPress) client.ctx.isGripPress = null;
    };
  }, [client, gl, s]);

  // Re-evaluate hover every frame the cursor OR camera moved. A pure pointermove
  // hover goes stale the moment the CAMERA moves under a still cursor (pan / zoom /
  // Ctrl-drag fire no pointer event). The 'grid' channel ID pass is pixel-precise
  // and covers the whole panel — immune to the AABB overlap ambiguity that
  // mis-hovered cascaded grids, and with no dead zones between glyphs.
  useFrame(() => {
    if (!client) return;
    // A resize drag is in progress (ResizeDragger): it owns the cursor + the
    // captured grip; pause hover picking so the two don't fight over the cursor
    // and we don't pick against a panel that's about to change size.
    if (client.ctx.resizing) return;
    const c = camera;
    const dom = gl.domElement;

    // Resolve a picked entry into the hover slot. Always refresh the cached entry
    // (cheap); only fire the command + cursor change when the id changes.
    const applyHover = (entry) => {
      const id = entry?.id ?? null;
      s.hoverEntry = entry ?? null;
      if (id === s.hoverId) return;
      s.hoverId = id;
      client.router.execute(`attention.set hover ${id || 'none'}`);
      dom.style.cursor = id ? 'pointer' : 'default';
    };

    // Resolve the resize-grip pick into the shared ctx.handleHover flag + the
    // pixel it was SAMPLED at (handleHoverAt). The cursor cue is set here; the
    // press DECISION (resize vs. pan) is gated by ctx.isGripPress(), which checks
    // freshness against that sample pixel. The pick is async (a GPU readback that
    // lands a frame+ later), so the press must NOT trust a stale token — both the
    // ResizeDragger and ViewerCameraController go through isGripPress. atX/atY are
    // the cursor at pick-sample time (threaded in), not at resolve time.
    const applyHandleHover = (token, atX, atY) => {
      client.ctx.handleHover = token ?? null;
      client.ctx.handleHoverAt = token ? { x: atX, y: atY } : null;
      if (token) dom.style.cursor = 'nwse-resize';
    };

    const cursorMoved = s.x !== s.lx || s.y !== s.ly || s.in !== s.lin;
    const camMoved =
      c.position.x !== s.px || c.position.y !== s.py || c.position.z !== s.pz ||
      c.quaternion.x !== s.qx || c.quaternion.y !== s.qy || c.quaternion.z !== s.qz || c.quaternion.w !== s.qw;
    if (!cursorMoved && !camMoved) return;
    s.lx = s.x; s.ly = s.y; s.lin = s.in;
    s.px = c.position.x; s.py = c.position.y; s.pz = c.position.z;
    s.qx = c.quaternion.x; s.qy = c.quaternion.y; s.qz = c.quaternion.z; s.qw = c.quaternion.w;

    const ps = client.ctx.pickingSystem;
    // If the PickingSystem instance was swapped (dev HMR of CommandProvider),
    // reset the per-instance confirmation latch so the log reflects the new one.
    if (ps !== s.lastPs) { s.lastPs = ps; s.gpuOk = false; s.gpuWarned = false; }

    if (ps && s.in) {
      // Feed the cursor (canvas-relative); force a pick on camera-move (no pointer
      // event fires then). One pick in flight at a time. useFrame runs before r3f's
      // main render, so the offscreen ID pass is safe here.
      const rect = dom.getBoundingClientRect();
      const sx = s.x, sy = s.y; // the pixel THIS pick samples — stamped onto handleHoverAt
      ps.setMousePosition(sx - rect.left, sy - rect.top);
      if (camMoved) ps.markDirty();
      if (!s.pickPending && ps._needsPick) {
        s.pickPending = true;
        ps.pickAsync('grid', c, scene).then((hit) => {
          // Guard on s.in: a pick resolving AFTER the cursor left must clear hover.
          const entry = (s.in && hit) ? entryForGrid(client.ctx.registry, hit.token) : null;
          if (entry && !s.gpuOk) {
            s.gpuOk = true;
            console.log(`[CanvasPicker] grid picking confirmed → ${entry.id}`);
          }
          applyHover(entry);
          // Second channel, SAME frame: the resize grips. markDirty() is
          // MANDATORY — both passes share one _needsPick latch, so without it the
          // handle pass no-ops and hands back the prior frame's hit. The grip
          // stage swallows its own error so a handle-pass hiccup never clears a
          // good grid hover (the outer catch is for grid-pass failures only).
          ps.markDirty();
          return ps.pickAsync('handle', c, scene).then(
            (h) => applyHandleHover(s.in ? (h?.token ?? null) : null, sx, sy),
            () => applyHandleHover(null),
          );
        }).then(() => {
          s.pickPending = false;
        }).catch((err) => {
          s.pickPending = false;
          if (!s.gpuWarned) {
            s.gpuWarned = true;
            console.warn('[CanvasPicker] grid pick failed', err);
          }
          applyHover(null);
          applyHandleHover(null);
        });
      }
      return;
    }

    // No picking system yet, or cursor outside the canvas → clear hover + grip flag.
    applyHover(null);
    applyHandleHover(null);
  });

  return null;
}

/**
 * Object dragging — Ctrl/Cmd + drag MOVES the grid/terminal under the cursor
 * instead of panning the camera (the camera controller yields Ctrl-drag to us,
 * see ViewerCameraController mousedown). Default drag still pans, so you can get
 * right up to a file without nudging it; hold Ctrl when you actually want to move
 * it. The drag is direct (60fps position writes); on release we persist the final
 * spot through the same move verb the CLI uses, then nudge a session save.
 */
export function ObjectDragger() {
  const { gl, camera } = useThree();
  const client = useAppCommands();

  useEffect(() => {
    if (!client) return;
    const { ctx, router } = client;
    const dom = gl.domElement;
    let drag = null; // { grid, id, type, lastX, lastY }

    const onDown = (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return; // Ctrl/Cmd + LMB only
      // Grab whatever's highlighted — the grid-channel hover result, in the
      // attention bus. Consistent with the outline the user sees.
      const hid = ctx.attentionManager?.get('hover')?.id;
      const entry = hid ? ctx.registry.get(hid) : null;
      if (!entry) return;
      drag = { grid: entry.grid, id: entry.id, type: entry.type, lastX: e.clientX, lastY: e.clientY };
      router.execute(`attention.set primary ${entry.id}`); // highlight what you're moving
      dom.style.cursor = 'grabbing';
      dom.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX; drag.lastY = e.clientY;
      const p = drag.grid.position;

      // FPS "held object" grab: move in the camera's VIEW PLANE at the object's
      // own view-axis depth, using the FULL 3D right/up vectors — so it hangs off
      // the cursor at any camera angle. (The old helper flattened to world X/Y,
      // dropping the camera-right Z component, which locked moves to one axis the
      // moment you rotated the view.)
      const q = camera.quaternion;
      const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const depth = Math.max(1, new THREE.Vector3().copy(p).sub(camera.position).dot(fwd));
      const pixelScale = (2 * depth * Math.tan((camera.fov * Math.PI / 180) / 2)) / dom.clientHeight;
      const delta = right.multiplyScalar(dx * pixelScale).add(up.multiplyScalar(-dy * pixelScale));

      const nx = p.x + delta.x, ny = p.y + delta.y, nz = p.z + delta.z;
      // Terminals must go through setWorldPosition (mirrors the group DataTexture);
      // code grids move via the Object3D transform.
      if (typeof drag.grid.setWorldPosition === 'function') {
        drag.grid.setWorldPosition({ x: nx, y: ny, z: nz });
      } else {
        drag.grid.position.set(nx, ny, nz);
      }
    };

    const onUp = (e) => {
      if (!drag) return;
      const { id, type, grid } = drag;
      const p = grid.position;
      drag = null;
      dom.style.cursor = 'default';
      dom.releasePointerCapture?.(e.pointerId);
      // Persist through the bus (CLI/session parity), then let the session store
      // capture the new layout.
      const verb = type === 'terminal' ? 'terminal.move' : 'grid.move';
      router.execute(`${verb} ${id} ${round(p.x)} ${round(p.y)} ${round(p.z)}`);
      client.session?.scheduleSave?.();
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
    };
  }, [client, gl, camera]);

  return null;
}

/**
 * Terminal resize — a plain left-drag on a terminal's SE-corner grip RESIZES it.
 * The grip is a pick target in the 'handle' channel; CanvasPicker's hover loop
 * sets ctx.handleHover (+ the sampled pixel) while the cursor is over it and shows
 * the nwse-resize cursor. The press DECISION (resize vs. pan) goes through the
 * shared, freshness-gated ctx.isGripPress() that BOTH this and ViewerCameraController
 * consult — so a grip press resizes (and the camera yields its pan) while a stale,
 * async-lagged token never starts a resize on a grip the cursor has left.
 *
 * The drag is preview-only — a ghost Box3 shows the prospective size at integer
 * cell steps and we never re-grid (rebuild buffers) per frame. On release we commit
 * ONCE through terminal.resize, which moves grid + emulator + the adapter's PTY
 * (pty.Setsize → SIGWINCH) in lockstep — identical to the CLI verb.
 *
 * The grip renders depthTest-off (an always-on-top overlay), so "the grip you see
 * is the grip you grab" even when it sits over another terminal's panel.
 */
export function ResizeDragger() {
  const { gl, camera, scene } = useThree();
  const client = useAppCommands();

  useEffect(() => {
    if (!client) return;
    const { ctx, router } = client;
    const dom = gl.domElement;

    // Preview box, mounted once. depthTest off + high renderOrder so it reads over
    // the panel/glyphs and the selection outline — a live size hint.
    const ghost = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x6ee7a0));
    ghost.visible = false;
    ghost.renderOrder = 10002;
    if (ghost.material) ghost.material.depthTest = false;
    scene.add(ghost);

    let drag = null; // { grid, id, startCols, startRows, startBounds, startX, startY, newCols, newRows }

    // Single teardown for EVERY way a drag can end. commit=true only on a clean
    // pointerup; pointercancel / lostpointercapture end WITHOUT committing. Either
    // way the shared flags reset, so an interrupted drag can never wedge the canvas
    // (a stuck ctx.resizing kills hover picking + click-select until reload).
    const endDrag = (e, commit) => {
      if (!drag) return; // lostpointercapture also echoes after a normal up — ignore it
      const { id, startCols, startRows, newCols, newRows } = drag;
      drag = null;
      ghost.visible = false;
      dom.style.cursor = 'default';
      ctx.handleHover = null;   // drop the cached grip; next press must re-establish via a fresh pick
      ctx.handleHoverAt = null;
      if (e?.pointerId != null) dom.releasePointerCapture?.(e.pointerId);
      // Hold ctx.resizing across THIS event dispatch so CanvasPicker's onUp (same
      // tick, listener-order-independent) skips its click-select; clear once drained.
      queueMicrotask(() => { ctx.resizing = false; });
      if (commit && (newCols !== startCols || newRows !== startRows)) {
        router.execute(`terminal.resize ${id} ${newCols} ${newRows}`);
        client.session?.scheduleSave?.();
      }
    };

    const onDown = (e) => {
      // Plain LMB on a grip. Ctrl/Cmd is the MOVE gesture (ObjectDragger owns it),
      // so a modifier here is not a resize — bail and let that path run. The press
      // authority is isGripPress() (freshness-gated), NOT the raw async hover flag.
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      if (!ctx.isGripPress?.(e.clientX, e.clientY)) return;
      const grid = ctx.handleHover?.grid; // token = { grid, edge }; isGripPress ⇒ non-null
      if (!grid) return;
      const id = ctx.registry.getIdByGrid(grid);
      if (!id) return;
      drag = {
        grid, id,
        startCols: grid.cols, startRows: grid.rows,
        startBounds: grid.getBounds().clone(),
        startX: e.clientX, startY: e.clientY,
        newCols: grid.cols, newRows: grid.rows,
      };
      ctx.resizing = true; // CanvasPicker pauses hover + skips click-select while set
      dom.style.cursor = 'nwse-resize';
      dom.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // Map the screen delta into the panel's fixed world axes through the camera's
      // right/up basis (mirrors ObjectDragger) — so cols grow east / rows grow south
      // correctly from ANY camera angle, not just head-on (the first-person mouselook
      // can view a panel rotated; raw dx→cols/dy→rows would map to the wrong axis).
      // Depth is probed at the panel CENTER (startBounds), not grid.position (the
      // NW-ish cell origin), so a pixel of travel maps to the right cell count for
      // large / close panels. cellStride is world-units/cell, gridScale included.
      const q = camera.quaternion;
      const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const center = drag.startBounds.getCenter(new THREE.Vector3());
      const depth = Math.max(1, center.sub(camera.position).dot(fwd));
      const pixelScale = (2 * depth * Math.tan((camera.fov * Math.PI / 180) / 2)) / dom.clientHeight;
      const world = right.multiplyScalar(dx * pixelScale).add(up.multiplyScalar(-dy * pixelScale));
      const stride = drag.grid.cellStride;
      const newCols = Math.max(MIN_COLS, drag.startCols + Math.round(world.x / stride.x));
      const newRows = Math.max(MIN_ROWS, drag.startRows + Math.round(-world.y / stride.y));
      drag.newCols = newCols; drag.newRows = newRows;

      // Ghost = the start panel with its SE corner pushed out, NW pinned — matches
      // resize()'s own anchor (NW ~fixed, grows east/south), so no jump on commit.
      const b = ghost.box.copy(drag.startBounds);
      b.max.x = drag.startBounds.max.x + (newCols - drag.startCols) * stride.x;
      b.min.y = drag.startBounds.min.y - (newRows - drag.startRows) * stride.y;
      ghost.visible = true;
    };

    const onUp     = (e) => endDrag(e, true);  // clean release → commit the new size
    const onCancel = (e) => endDrag(e, false); // gesture interrupted → reset, no commit

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onCancel);
    dom.addEventListener('lostpointercapture', onCancel);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('lostpointercapture', onCancel);
      scene.remove(ghost);
      ghost.geometry?.dispose?.();
      ghost.material?.dispose?.();
      if (drag) ctx.resizing = false; // unmounted mid-drag → never leave the shared flag stuck
    };
  }, [client, gl, camera, scene]);

  return null;
}

/**
 * Selection feedback — wireframe boxes around the primary (selected) and hover
 * grids. WHICH grid each box tracks comes from attentionManager change events
 * (not a per-frame scan of all grids); the box GEOMETRY is re-synced each frame
 * from that one grid's bounds, so the outline follows when layout.flow moves it.
 * Reads the same state whether selection came from a canvas click or a command.
 */
export function SelectionIndicator() {
  const { scene } = useThree();
  const client = useAppCommands();
  const tracked = useRef({ primaryBox: null, hoverBox: null, am: null, registry: null });

  useEffect(() => {
    if (!client) return;
    const mkBox = (color, renderOrder) => {
      const b = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(color));
      b.visible = false;
      b.renderOrder = renderOrder;     // draw the outline over the glyphs
      if (b.material) b.material.depthTest = false;
      scene.add(b);
      return b;
    };
    const t = tracked.current;
    t.am = client.ctx.attentionManager;
    t.registry = client.ctx.registry;
    // Distinct styles: a steady green box for the SELECTED grid, a lighter blue
    // box for HOVER drawn on top (higher renderOrder). They read as different
    // things even when both land on the same grid.
    t.primaryBox = mkBox(0x6ee7a0, 9999);  // green — the selected / active grid
    t.hoverBox = mkBox(0x9fd2ff, 10000);   // light blue — hover (follows the cursor)

    return () => {
      scene.remove(t.primaryBox); scene.remove(t.hoverBox);
      t.primaryBox.geometry?.dispose?.(); t.hoverBox.geometry?.dispose?.();
      t.primaryBox = t.hoverBox = t.am = t.registry = null;
    };
  }, [client, scene]);

  // Resolve the tracked grids LIVE each frame straight from attention + registry
  // — no cached grid objects, no dependence on change events. This self-heals two
  // ways: a grid id re-pointed to a NEW object (virtualizer reload / session
  // restore) is picked up immediately, and a same-id re-selection that fires no
  // change event still tracks correctly. (2 boxes/frame: a Map get + an 8-corner
  // getBounds transform each — negligible.)
  useFrame(() => {
    const t = tracked.current;
    if (!t.am || !t.registry) return;
    const gridFor = (slot) => {
      const id = t.am.get(slot)?.id;
      return id ? (t.registry.get(id)?.grid ?? null) : null;
    };
    const fit = (box, grid, inflate) => {
      if (!box) return;
      const b = grid?.getBounds?.();
      if (b && !b.isEmpty()) {
        box.box.copy(b);
        if (inflate) box.box.expandByScalar(inflate);
        box.visible = true;
      } else box.visible = false;
    };
    // Selection: exact bounds, steady. Hover: ALWAYS shown on the cursor grid —
    // including the selected one — inflated into a light halo just outside the
    // selection box. No suppression special-case: selection and hover are two
    // distinct, independently-tracked things.
    fit(t.primaryBox, gridFor('primary'), 0);
    fit(t.hoverBox, gridFor('hover'), HOVER_INFLATE);
  });

  return null;
}
