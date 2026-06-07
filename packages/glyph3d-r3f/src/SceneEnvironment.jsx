import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

/**
 * <SceneEnvironment> — spatial-orientation landmarks for the fly camera.
 *
 * A fly camera in a sparse scene is easy to get lost in: rotate too hard and the view
 * is featureless void with nothing to recover "down" or "where am I" against. This adds
 * the two canonical aids (cf. Blender's grid floor): an infinite GROUND GRID and a
 * subtle gradient SKYDOME.
 *
 * Both are deliberately invisible to everything but the eye:
 *   - DEFAULT layer (0) → the GPU picking pass (which isolates to its own layers) never
 *     renders them, so they can't be hovered/clicked.
 *   - NOT registered grids → the frustum culler and the camera's look-distance raycast
 *     (which only sees registry grids) ignore them, so the floor never becomes the
 *     "nearest content" the camera scales movement to.
 *   - The sky is a MESH, not `scene.background` — a set background would bleed into the
 *     pick target as a stray id (a known WebGPU/TSL gotcha). Vertex-color gradient, so
 *     no shader/NodeMaterial is needed.
 *
 * The grid re-centers under the camera each frame, snapped to its own spacing, so it
 * reads as infinite without sliding; the sky rides the camera so it's always "far."
 *
 * Lighting note: the glyph/line materials are emissive/unlit, so THREE lights would be
 * a no-op here — the skydome's gradient IS the "lit environment" feel, for free.
 *
 * @param {object} [props]
 * @param {number} [props.groundY=-120]   world Y of the ground plane (below typical content)
 * @param {number} [props.size=4000]      ground grid extent in world units
 * @param {number} [props.divisions=80]   cells across (spacing = size/divisions)
 * @param {number} [props.lineColor=0x161b26]   minor grid line color
 * @param {number} [props.axisColor=0x2a3550]   center cross-line color
 * @param {number} [props.opacity=0.5]    grid line opacity (quiet by default)
 * @param {number} [props.skyTop=0x05070b]      skydome color at the zenith
 * @param {number} [props.skyBottom=0x0c1018]   skydome color at the horizon/nadir
 */
export default function SceneEnvironment({
  groundY = -120,
  size = 4000,
  divisions = 80,
  lineColor = 0x161b26,
  axisColor = 0x2a3550,
  opacity = 0.5,
  skyTop = 0x05070b,
  skyBottom = 0x0c1018,
} = {}) {
  const { scene, camera } = useThree();
  const gridRef = useRef(null);
  const skyRef = useRef(null);
  const spacing = size / divisions;

  useEffect(() => {
    // --- ground grid -------------------------------------------------------
    const grid = new THREE.GridHelper(size, divisions, axisColor, lineColor);
    grid.position.y = groundY;
    grid.renderOrder = -100;          // behind content (backdrops −10, grid bg −1)
    grid.material.transparent = true;
    grid.material.opacity = opacity;
    grid.material.depthWrite = false; // a faint reference — never occludes a file
    scene.add(grid);
    gridRef.current = grid;

    // --- gradient skydome (vertex colors → no shader, no scene.background) --
    const geo = new THREE.SphereGeometry(8000, 24, 16);
    const top = new THREE.Color(skyTop);
    const bottom = new THREE.Color(skyBottom);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) / 8000 + 1) / 2;   // 0 at nadir → 1 at zenith
      c.copy(bottom).lerp(top, t);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,   // seen from inside
      depthWrite: false,
      fog: false,
    }));
    sky.renderOrder = -200;   // behind even the grid
    scene.add(sky);
    skyRef.current = sky;

    return () => {
      scene.remove(grid); grid.geometry.dispose(); grid.material.dispose();
      scene.remove(sky); sky.geometry.dispose(); sky.material.dispose();
      gridRef.current = skyRef.current = null;
    };
  }, [scene, groundY, size, divisions, lineColor, axisColor, opacity, skyTop, skyBottom]);

  useFrame(() => {
    const grid = gridRef.current;
    const sky = skyRef.current;
    if (grid) {
      // Re-center under the camera, snapped to the cell size → reads as infinite,
      // no visible sliding of the lines as you move.
      grid.position.x = Math.round(camera.position.x / spacing) * spacing;
      grid.position.z = Math.round(camera.position.z / spacing) * spacing;
    }
    if (sky) sky.position.copy(camera.position); // always "infinitely far"
  });

  return null;
}
