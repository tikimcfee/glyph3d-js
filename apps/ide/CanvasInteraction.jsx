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

    const onMove = (e) => { s.x = e.clientX; s.y = e.clientY; s.in = true; };
    const onEnter = () => { s.in = true; };
    const onLeave = () => { s.in = false; };
    const onDown = (e) => { s.downX = e.clientX; s.downY = e.clientY; };

    const onUp = (e) => {
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
    };
  }, [client, gl, s]);

  // Re-evaluate hover every frame the cursor OR camera moved. A pure pointermove
  // hover goes stale the moment the CAMERA moves under a still cursor (pan / zoom /
  // Ctrl-drag fire no pointer event). The 'grid' channel ID pass is pixel-precise
  // and covers the whole panel — immune to the AABB overlap ambiguity that
  // mis-hovered cascaded grids, and with no dead zones between glyphs.
  useFrame(() => {
    if (!client) return;
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
      ps.setMousePosition(s.x - rect.left, s.y - rect.top);
      if (camMoved) ps.markDirty();
      if (!s.pickPending && ps._needsPick) {
        s.pickPending = true;
        ps.pickAsync('grid', c, scene).then((hit) => {
          s.pickPending = false;
          // Guard on s.in: a pick resolving AFTER the cursor left must clear hover.
          const entry = (s.in && hit) ? entryForGrid(client.ctx.registry, hit.token) : null;
          if (entry && !s.gpuOk) {
            s.gpuOk = true;
            console.log(`[CanvasPicker] grid picking confirmed → ${entry.id}`);
          }
          applyHover(entry);
        }).catch((err) => {
          s.pickPending = false;
          if (!s.gpuWarned) {
            s.gpuWarned = true;
            console.warn('[CanvasPicker] grid pick failed', err);
          }
          applyHover(null);
        });
      }
      return;
    }

    // No picking system yet, or cursor outside the canvas → clear hover.
    applyHover(null);
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
 * Selection feedback — wireframe boxes around the primary (selected) and hover
 * grids. WHICH grid each box tracks comes from attentionManager change events
 * (not a per-frame scan of all grids); the box GEOMETRY is re-synced each frame
 * from that one grid's bounds, so the outline follows when layout.flow moves it.
 * Reads the same state whether selection came from a canvas click or a command.
 */
export function SelectionIndicator() {
  const { scene } = useThree();
  const client = useAppCommands();
  const tracked = useRef({ primaryGrid: null, hoverGrid: null, primaryBox: null, hoverBox: null });

  useEffect(() => {
    if (!client) return;
    const am = client.ctx.attentionManager;
    const registry = client.ctx.registry;

    const mkBox = (color) => {
      const b = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(color));
      b.visible = false;
      b.renderOrder = 9999;            // draw the outline over the glyphs
      if (b.material) b.material.depthTest = false;
      scene.add(b);
      return b;
    };
    const t = tracked.current;
    t.primaryBox = mkBox(0x7ad7a0); // green — selected
    t.hoverBox = mkBox(0x4a7f9a);   // muted blue — hover

    const gridFor = (slot) => {
      const id = am.get(slot)?.id;
      return id ? (registry.get(id)?.grid ?? null) : null;
    };
    const sync = () => { t.primaryGrid = gridFor('primary'); t.hoverGrid = gridFor('hover'); };
    sync();
    const offP = am.on('change:primary', sync);
    const offH = am.on('change:hover', sync);

    return () => {
      offP?.(); offH?.();
      scene.remove(t.primaryBox); scene.remove(t.hoverBox);
      t.primaryBox.geometry?.dispose?.(); t.hoverBox.geometry?.dispose?.();
      t.primaryBox = t.hoverBox = t.primaryGrid = t.hoverGrid = null;
    };
  }, [client, scene]);

  // Re-sync box geometry from the tracked grids' bounds each frame (2 boxes —
  // cheap: getBounds is an 8-corner transform of cached local content bounds).
  useFrame(() => {
    const t = tracked.current;
    const fit = (box, grid) => {
      if (!box) return;
      const b = grid?.getBounds?.();
      if (b && !b.isEmpty()) { box.box.copy(b); box.visible = true; }
      else box.visible = false;
    };
    fit(t.primaryBox, t.primaryGrid);
    // Don't double-draw a box when hovering the selected grid.
    fit(t.hoverBox, t.hoverGrid && t.hoverGrid !== t.primaryGrid ? t.hoverGrid : null);
  });

  return null;
}
