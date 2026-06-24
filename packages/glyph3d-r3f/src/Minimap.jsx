import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useGridRegistry } from './context.jsx';

/**
 * <Minimap> — a 3D overview HUD: a schematic of the whole space in a corner, with the
 * user's camera drawn as a moving frustum-cone so position + heading read at a glance.
 *
 * Two deliberate design calls:
 *
 *  1. SCHEMATIC, not a second render of the real scene. Re-rendering thousands of glyphs
 *     at thumbnail scale is both expensive AND illegible (mush). Instead the minimap scene
 *     holds one translucent BOX per framed surface, sized straight from its world AABB
 *     (getBounds) — footprints/massing, the "city skyline." It's cheaper than a real
 *     re-render and it's the right level of detail for a map. Boxes live in WORLD
 *     coordinates; the minimap camera just frames that world from an external vantage, so
 *     the cone (the user camera, in world space) moves through the same schematic.
 *
 *  2. A genuine SECOND RENDER PASS (the old GL minimap did this and it held up fine on
 *     portables — a pass is cheap; it's stacking many that gets tricky). r3f has no drei
 *     here, so we take the render loop over with a positive `useFrame` priority: r3f stops
 *     auto-rendering, and this callback renders the main scene exactly as r3f would, then
 *     renders the minimap scene into a scissored corner viewport. Main is drawn FIRST and
 *     the minimap is wrapped so a minimap error can never blank the app.
 *
 * Fed entirely by state we already own (registry bounds + the live camera pose), read-only
 * — it never mutates the world or React state per frame (the WebGPU render-loop rule).
 *
 * WebGPU notes / risk points if it looks off:
 *   - setViewport/setScissor take LOGICAL px (three multiplies by pixelRatio); y is from
 *     the BOTTOM. We pass r3f's CSS `size` and restore the full viewport each frame.
 *   - minimapScene.background + autoClear (default) clears ONLY the scissor region.
 *
 * @param {object} [props]
 * @param {number} [props.fraction=0.26]  minimap width/height as a fraction of the canvas
 * @param {number} [props.margin=12]      gap from the canvas edge, CSS px
 * @param {number} [props.fov=35]         minimap camera field of view
 * @param {[number,number,number]} [props.viewDir]  external vantage direction (toward content)
 */
export default function Minimap({
  fraction = 0.26,
  margin = 12,
  fov = 35,
  viewDir = [0.4, 0.75, 1.0],
} = {}) {
  const { gl, scene, camera, size } = useThree();
  const { registry } = useGridRegistry();
  const mm = useRef(null);

  // ── build the minimap scene once (proxy pool + camera-cone + camera) ──
  useEffect(() => {
    const mscene = new THREE.Scene();
    mscene.background = new THREE.Color(0x0a0c12);

    const mcam = new THREE.PerspectiveCamera(fov, 1, 1, 100000);

    // Shared geometry for the surface proxies — a unit box, scaled per surface.
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const edgeGeo = new THREE.EdgesGeometry(boxGeo);

    // Fill (translucent → overlaps read as depth) + crisp edges, keyed by surface type.
    const mat = (color, opacity, line = false) => line
      ? new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const fill = {
      grid:     mat(0x4f7fff, 0.42), terminal: mat(0x3fbf8f, 0.42), frame: mat(0xbf8f3f, 0.42),
    };
    const edge = {
      grid:     mat(0x9fc0ff, 0.9, true), terminal: mat(0x8ff0c8, 0.9, true), frame: mat(0xf0c884, 0.9, true),
    };

    const proxies = new THREE.Group();
    mscene.add(proxies);
    const pool = []; // [{ node, box, edges }]

    // The user camera: a translucent frustum-cone (apex at the eye, flaring along view)
    // + a bright apex dot. Hot color so it pops against the cool boxes.
    const coneGeo = new THREE.ConeGeometry(0.45, 1, 22);
    coneGeo.translate(0, -0.5, 0);     // apex → origin
    coneGeo.rotateX(Math.PI / 2);      // axis +Y → -Z (camera looks down local -Z)
    const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: 0xff6ea0, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide,
    }));
    const apex = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff6ea0 }));
    mscene.add(cone, apex);

    mm.current = { mscene, mcam, proxies, pool, cone, apex, boxGeo, edgeGeo, fill, edge,
                   _box: new THREE.Box3(), _v: new THREE.Vector3(), _c: new THREE.Vector3() };

    return () => {
      boxGeo.dispose(); edgeGeo.dispose(); coneGeo.dispose();
      cone.material.dispose(); apex.geometry.dispose(); apex.material.dispose();
      Object.values(fill).forEach(m => m.dispose());
      Object.values(edge).forEach(m => m.dispose());
      mm.current = null;
    };
  }, [fov]);

  // ── per-frame: sync proxies + cone, frame the minimap camera, render both passes ──
  useFrame(() => {
    // 1) main scene — exactly r3f's own call. Drawn FIRST and unconditionally so the app
    //    never goes dark even if the minimap below throws.
    gl.render(scene, camera);

    const M = mm.current;
    if (!M) return;
    try {
      // tagged surfaces (type drives color) — registry is the single source of truth.
      const tagged = [];
      for (const t of ['grid', 'terminal', 'frame'])
        for (const s of registry.toArray(t)) tagged.push([s, t]);

      // sync the proxy pool to the current surfaces, and union their bounds for framing.
      const union = M._box.makeEmpty();
      for (let i = 0; i < tagged.length; i++) {
        const [s, type] = tagged[i];
        const b = s.getBounds?.();
        let node = M.pool[i];
        if (!node) {                                  // grow the pool lazily
          const box = new THREE.Mesh(M.boxGeo, M.fill[type]);
          const edges = new THREE.LineSegments(M.edgeGeo, M.edge[type]);
          const g = new THREE.Group(); g.add(box, edges); M.proxies.add(g);
          node = { node: g, box, edges }; M.pool[i] = node;
        }
        if (!b || b.isEmpty?.()) { node.node.visible = false; continue; }
        node.node.visible = true;
        node.box.material = M.fill[type];
        node.edges.material = M.edge[type];
        b.getCenter(node.node.position);
        b.getSize(node.node.scale);
        node.node.scale.set(Math.max(node.node.scale.x, 0.01),
                            Math.max(node.node.scale.y, 0.01),
                            Math.max(node.node.scale.z, 0.01));
        union.union(b);
      }
      for (let i = tagged.length; i < M.pool.length; i++) M.pool[i].node.visible = false;

      // the user camera lives in the framing too, so the cone never leaves the map.
      union.expandByPoint(camera.position);
      const center = union.getCenter(M._c);
      const radius = union.isEmpty() ? 200 : Math.max(union.getSize(M._v).length() * 0.5, 1);

      // place the external vantage; frame the whole union with a little padding.
      const dir = M._v.set(viewDir[0], viewDir[1], viewDir[2]).normalize();
      const dist = radius / Math.sin((fov * Math.PI / 180) / 2) * 1.15;
      M.mcam.position.copy(center).addScaledVector(dir, dist);
      M.mcam.up.set(0, 1, 0);
      M.mcam.lookAt(center);
      M.mcam.far = dist + radius * 4 + 1000;
      M.mcam.updateProjectionMatrix();

      // the camera-cone: at the eye, oriented like the eye, scaled to the scene.
      const cs = Math.max(radius * 0.16, 4);
      M.cone.position.copy(camera.position);
      M.cone.quaternion.copy(camera.quaternion);
      M.cone.scale.setScalar(cs);
      M.apex.position.copy(camera.position);
      M.apex.scale.setScalar(cs * 0.06);

      // 2) minimap pass — scissored corner viewport (logical px, y from bottom).
      const w = Math.round(size.width * fraction);
      const h = Math.round(size.height * fraction);
      const x = size.width - w - margin;
      const y = margin;
      M.mcam.aspect = w / h;
      M.mcam.updateProjectionMatrix();

      gl.setScissorTest(true);
      gl.setViewport(x, y, w, h);
      gl.setScissor(x, y, w, h);
      gl.render(M.mscene, M.mcam);            // autoClear clears just this region to bg
      gl.setScissorTest(false);
      gl.setViewport(0, 0, size.width, size.height);
    } catch (err) {
      gl.setScissorTest(false);
      gl.setViewport(0, 0, size.width, size.height);
      if (!M._warned) { M._warned = true; console.warn('[Minimap] render skipped:', err); }
    }
  }, 1); // positive priority → we own the render loop while mounted

  return null;
}
