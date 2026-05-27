import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useAppCommands } from '../../app/client/CommandProvider.jsx';

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
 * Raycast the registered grids by world bounds; return the nearest grid's
 * registry id, or null. Bounds-only — no per-instance glyph raycast.
 */
function pickGridId(ctx, raycaster) {
  const ray = raycaster.ray;
  const hit = new THREE.Vector3();
  let bestId = null;
  let bestDist = Infinity;
  for (const grid of ctx.getGrids()) {
    const box = grid.getBounds?.();
    if (!box || box.isEmpty()) continue;
    if (ray.intersectBox(box, hit)) {
      const d = ray.origin.distanceToSquared(hit);
      if (d < bestDist) { bestDist = d; bestId = ctx.registry.getIdByGrid(grid); }
    }
  }
  return bestId;
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

    const toNdc = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return pickGridId(ctx, raycaster);
    };

    const onDown = (e) => { downX = e.clientX; downY = e.clientY; };

    const onUp = (e) => {
      // Only a click if the pointer barely moved (else it was an orbit/pan).
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
      const id = toNdc(e);
      if (!id) return;
      router.execute(`attention.set primary ${id}`);
      router.execute(`camera.focus ${id}`);
    };

    const onMove = (e) => {
      const id = toNdc(e);
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
 * Selection feedback — wireframe boxes around the primary (selected) and hover
 * grids, driven by attentionManager change events (not a per-frame probe). Reads
 * the same state whether selection came from a canvas click or a CLI command.
 */
export function SelectionIndicator() {
  const { scene } = useThree();
  const client = useAppCommands();

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
    const primaryBox = mkBox(0x7ad7a0); // green — selected
    const hoverBox = mkBox(0x4a7f9a);   // muted blue — hover

    const apply = (box, slotVal, { hideIfPrimary } = {}) => {
      const id = slotVal?.id;
      // Don't double-draw a box when hover == primary.
      if (hideIfPrimary && id && id === am.get('primary')?.id) { box.visible = false; return; }
      const grid = id ? registry.get(id)?.grid : null;
      const bounds = grid?.getBounds?.();
      if (bounds && !bounds.isEmpty()) { box.box.copy(bounds); box.visible = true; }
      else box.visible = false;
    };

    const refreshPrimary = () => apply(primaryBox, am.get('primary'));
    const refreshHover = () => { apply(hoverBox, am.get('hover'), { hideIfPrimary: true }); };

    refreshPrimary();
    refreshHover();
    const offP = am.on('change:primary', () => { refreshPrimary(); refreshHover(); });
    const offH = am.on('change:hover', refreshHover);

    return () => {
      offP?.(); offH?.();
      scene.remove(primaryBox); scene.remove(hoverBox);
      primaryBox.geometry?.dispose?.(); hoverBox.geometry?.dispose?.();
    };
  }, [client, scene]);

  return null;
}
