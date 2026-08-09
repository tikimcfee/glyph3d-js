import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { worldBounds } from '@glyph3d/core/services';
import { useGridRegistry } from './context.jsx';

const _rsize = new THREE.Vector2();

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
/**
 * An InstancedMesh whose instance matrices ride a STORAGE attribute. Three's
 * WebGPU instancing puts a small mesh's matrices (≤1024) in a uniform buffer
 * that re-uploads WHOLE every frame regardless of changes; a
 * StorageInstancedBufferAttribute flips it onto the version-gated path with
 * addUpdateRange support, so a still skyline uploads nothing.
 */
function makeFills(geo, material, capacity) {
  const fills = new THREE.InstancedMesh(geo, material, capacity);
  const im = new THREE.StorageInstancedBufferAttribute(fills.instanceMatrix.array, 16);
  im.name = 'MinimapProxyMatrices';
  fills.instanceMatrix = im;
  fills.frustumCulled = false;
  return fills;
}

export default function Minimap({
  fraction = 0.26,
  margin = 12,
  fov = 35,
  viewDir = [0.4, 0.75, 1.0],
} = {}) {
  const { gl, scene, camera, size } = useThree();
  const { registry } = useGridRegistry();
  const mm = useRef(null);

  // ── build the minimap scene once (instanced proxies + camera-cone + camera) ──
  useEffect(() => {
    const mscene = new THREE.Scene();
    mscene.background = new THREE.Color(0x0a0c12);

    const mcam = new THREE.PerspectiveCamera(fov, 1, 1, 100000);

    // The proxy skyline as TWO draws total, any surface count: one InstancedMesh
    // of unit boxes (per-instance matrix + color) and one LineSegments whose
    // positions are the boxes' 12 edges written per frame into a preallocated
    // buffer. The old pool was a Mesh + LineSegments PER surface — ~3000 draw
    // calls per frame at workspace scale, all encoder overhead.
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    // A unit box's 12 edges as segment endpoints (24 verts), transformed per
    // surface on write. Derived once from EdgesGeometry so the shape can't drift.
    const edgeTemplate = new THREE.EdgesGeometry(boxGeo).getAttribute('position').array.slice();

    const FILL_COLORS = { grid: 0x4f7fff, terminal: 0x3fbf8f, frame: 0xbf8f3f };
    const EDGE_COLORS = { grid: 0x9fc0ff, terminal: 0x8ff0c8, frame: 0xf0c884 };

    let capacity = 512;
    const fills = makeFills(boxGeo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthWrite: false }), capacity);
    fills.count = 0;

    const edgeGeo = new THREE.BufferGeometry();
    const edgeVerts = edgeTemplate.length;           // 72 floats (24 verts) per box
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * edgeVerts), 3));
    edgeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * edgeVerts), 3));
    const edges = new THREE.LineSegments(edgeGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    edges.frustumCulled = false;

    const proxies = new THREE.Group();
    proxies.add(fills, edges);
    mscene.add(proxies);

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

    mm.current = { mscene, mcam, proxies, fills, edges, edgeGeo, edgeTemplate, edgeVerts,
                   capacity, FILL_COLORS, EDGE_COLORS, cone, apex, boxGeo,
                   // Per-slot change stamps (center.xyz + size.xyz) — FLOAT64: matrix/bounds
                   // math is f64, and an f32 stamp truncates on store so the exact compare
                   // fails forever (the group-table lesson). NaN ≠ anything → first frame writes.
                   stamps: new Float64Array(capacity * 6).fill(NaN),
                   typeStamps: new Array(capacity).fill(null),
                   _box: new THREE.Box3(), _v: new THREE.Vector3(), _c: new THREE.Vector3(),
                   _col: new THREE.Color(), _m4: new THREE.Matrix4(), _list: [] };

    return () => {
      boxGeo.dispose(); edgeGeo.dispose(); coneGeo.dispose();
      fills.material.dispose(); fills.dispose();
      edges.material.dispose();
      cone.material.dispose(); apex.geometry.dispose(); apex.material.dispose();
      mm.current = null;
    };
  }, [fov]);

  // ── grow the instanced proxy buffers (×2) preserving nothing — the NaN stamps
  //    make every slot read as changed, so the next frame rewrites the lot ──
  const ensureCapacity = (M, n) => {
    if (n <= M.capacity) return;
    while (M.capacity < n) M.capacity *= 2;
    const fills = makeFills(M.fills.geometry, M.fills.material, M.capacity);
    M.proxies.remove(M.fills);
    M.fills.dispose();
    M.fills = fills;
    M.proxies.add(fills);
    M.edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M.capacity * M.edgeVerts), 3));
    M.edgeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(M.capacity * M.edgeVerts), 3));
    M.stamps = new Float64Array(M.capacity * 6).fill(NaN);
    M.typeStamps = new Array(M.capacity).fill(null);
  };

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

      // write the proxy skyline: per-surface instance matrix + color, and the
      // 12 box edges into the shared line buffer. Two draws total. CHANGE-STAMPED:
      // each slot rewrites only when its bounds/type moved (f64 center+size
      // compare), and the GPU upload covers just the changed slot span — a
      // static workspace uploads ZERO bytes (this loop once re-uploaded the
      // full capacity-sized buffers every frame: ~650KB/f for a still map).
      ensureCapacity(M, tagged.length);
      const posAttr = M.edgeGeo.getAttribute('position');
      const colAttr = M.edgeGeo.getAttribute('color');
      const et = M.edgeTemplate, ev = M.edgeVerts;
      M._list.length = 0;
      let n = 0;
      let lo = Infinity, hi = -1;   // changed slot span
      for (let i = 0; i < tagged.length; i++) {
        const [s, type] = tagged[i];
        M._list.push(s);
        const b = s.getBounds?.();
        if (!b || b.isEmpty?.()) continue;
        b.getCenter(M._c);
        b.getSize(M._v);
        const sb = n * 6;
        if (M.stamps[sb] === M._c.x && M.stamps[sb + 1] === M._c.y && M.stamps[sb + 2] === M._c.z
            && M.stamps[sb + 3] === M._v.x && M.stamps[sb + 4] === M._v.y && M.stamps[sb + 5] === M._v.z
            && M.typeStamps[n] === type) { n++; continue; }
        M.stamps[sb] = M._c.x; M.stamps[sb + 1] = M._c.y; M.stamps[sb + 2] = M._c.z;
        M.stamps[sb + 3] = M._v.x; M.stamps[sb + 4] = M._v.y; M.stamps[sb + 5] = M._v.z;
        M.typeStamps[n] = type;
        if (n < lo) lo = n;
        if (n > hi) hi = n;
        const sx = Math.max(M._v.x, 0.01), sy = Math.max(M._v.y, 0.01), sz = Math.max(M._v.z, 0.01);
        M._m4.makeScale(sx, sy, sz).setPosition(M._c);
        M.fills.setMatrixAt(n, M._m4);
        M.fills.setColorAt(n, M._col.set(M.FILL_COLORS[type]));
        M._col.set(M.EDGE_COLORS[type]);
        const base = n * ev;
        for (let v = 0; v < ev; v += 3) {
          posAttr.array[base + v]     = et[v]     * sx + M._c.x;
          posAttr.array[base + v + 1] = et[v + 1] * sy + M._c.y;
          posAttr.array[base + v + 2] = et[v + 2] * sz + M._c.z;
          colAttr.array[base + v]     = M._col.r;
          colAttr.array[base + v + 1] = M._col.g;
          colAttr.array[base + v + 2] = M._col.b;
        }
        n++;
      }
      M.fills.count = n;
      M.edgeGeo.setDrawRange(0, n * (ev / 3));
      if (hi >= 0) {
        const span = hi - lo + 1;
        M.fills.instanceMatrix.addUpdateRange(lo * 16, span * 16);
        M.fills.instanceMatrix.needsUpdate = true;
        if (M.fills.instanceColor) {
          M.fills.instanceColor.addUpdateRange(lo * 3, span * 3);
          M.fills.instanceColor.needsUpdate = true;
        }
        posAttr.addUpdateRange(lo * ev, span * ev);
        posAttr.needsUpdate = true;
        colAttr.addUpdateRange(lo * ev, span * ev);
        colAttr.needsUpdate = true;
      }

      // the shared world extent (+ the eye, so the cone never leaves the map). One canonical
      // computation — worldBounds — that the grounding arena + soft camera bounds will share.
      const union = worldBounds(M._list, M._box, { expandToInclude: camera.position });
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
      // Measured off the RENDERER's live size, not r3f's store: resizes apply at
      // the frame boundary (GlyphCanvas defers them), so the store can lead the
      // actual targets by a frame — a scissor computed from it lands out of
      // bounds (validation error). Degenerate sizes (dock transients) skip.
      const rsize = gl.getSize(_rsize);
      const w = Math.round(rsize.width * fraction);
      const h = Math.round(rsize.height * fraction);
      const x = rsize.width - w - margin;
      const y = margin;
      if (!(w > 4) || !(h > 4)) return;
      M.mcam.aspect = w / h;
      M.mcam.updateProjectionMatrix();

      gl.setScissorTest(true);
      gl.setViewport(x, y, w, h);
      gl.setScissor(x, y, w, h);
      gl.render(M.mscene, M.mcam);            // autoClear clears just this region to bg
      gl.setScissorTest(false);
      gl.setViewport(0, 0, gl.getSize(_rsize).width, _rsize.height);
    } catch (err) {
      gl.setScissorTest(false);
      gl.setViewport(0, 0, gl.getSize(_rsize).width, _rsize.height);
      if (!M._warned) { M._warned = true; console.warn('[Minimap] render skipped:', err); }
    }
  }, 1); // positive priority → we own the render loop while mounted

  return null;
}
