import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useAppCommands } from '../../app/client/CommandProvider.jsx';

const round = (n) => Math.round(n * 100) / 100;

// Canvas interaction — clicking/hovering grids in the 3D scene.
//
// The grids are imperative Object3Ds (not r3f <mesh> JSX), so r3f's own event
// system doesn't see them. We attach our own pointer handlers to the canvas and
// raycast against each grid's world-space BOUNDS (cheap + grid-level — the GPU
// PickingSystem resolves to individual glyphs, which is overkill for "select a
// file"). Selection is written through the SAME attention.set / camera.focus
// commands the CLI uses, so a canvas click and `glyph3d-cli attention.set primary
// <id>` are indistinguishable downstream.

const DRAG_PX = 5; // pointer travel above this = a drag (orbit/pan), not a click

/**
 * Raycast every registered entity that exposes world bounds (code grids AND
 * terminals); return the nearest entry ({ id, type, grid, ... }) or null.
 * Bounds-only — no per-instance glyph raycast. We iterate registry.list()
 * rather than getGrids() (which is grids-only) so terminals are pickable too.
 */
function pickEntity(ctx, raycaster) {
  const ray = raycaster.ray;
  const hit = new THREE.Vector3();
  let best = null;
  let bestDist = Infinity;
  for (const entry of ctx.registry.list()) {
    const box = entry.grid?.getBounds?.();
    if (!box || box.isEmpty()) continue;
    if (ray.intersectBox(box, hit)) {
      const d = ray.origin.distanceToSquared(hit);
      if (d < bestDist) { bestDist = d; best = entry; }
    }
  }
  return best;
}

/** Pointer → raycast → attention + camera, all via the command router. */
export function CanvasPicker() {
  const { gl, camera } = useThree();
  const client = useAppCommands();

  useEffect(() => {
    if (!client) return;
    const { ctx, router } = client;
    const dom = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downX = 0, downY = 0, hoverId = null;

    const pickAt = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return pickEntity(ctx, raycaster);
    };

    const onDown = (e) => { downX = e.clientX; downY = e.clientY; };

    const onUp = (e) => {
      // Only a click if the pointer barely moved (else it was an orbit/pan).
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
      const entry = pickAt(e);
      if (!entry) {
        // Click on empty space releases keyboard focus so a terminal you clicked
        // away from stops receiving keystrokes.
        router.execute('attention.set key none');
        return;
      }
      router.execute(`attention.set primary ${entry.id}`);
      router.execute(`camera.focus ${entry.id}`);
      // Terminals take keyboard focus on click (type immediately); clicking any
      // other entity releases the key slot.
      if (entry.type === 'terminal') {
        router.execute(`attention.set key ${entry.id}`);
      } else {
        router.execute('attention.set key none');
      }
    };

    const onMove = (e) => {
      const id = pickAt(e)?.id ?? null;
      if (id !== hoverId) {
        hoverId = id;
        router.execute(`attention.set hover ${id || 'none'}`);
        dom.style.cursor = id ? 'pointer' : 'default';
      }
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
    };
  }, [client, gl, camera]);

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
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let drag = null; // { grid, id, type, lastX, lastY }

    const pickAt = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return pickEntity(ctx, raycaster);
    };

    const onDown = (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return; // Ctrl/Cmd + LMB only
      const entry = pickAt(e);
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
  // cheap, and getBounds is cached unless the grid actually moved).
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
