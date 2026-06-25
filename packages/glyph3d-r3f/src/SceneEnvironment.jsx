import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
  Fn, positionWorld, cameraPosition, fract, fwidth, abs, min, max, float,
  color as tslColor, smoothstep as tslSmoothstep, length as tslLength, mix as tslMix,
} from 'three/tsl';

/**
 * <SceneEnvironment> — the world: a present, lit-feeling ground like a real 3D editor, NOT a
 * whispered grid on a black void. The lesson learned the hard way: RAISE THE VALUE RANGE.
 * Blender's viewport is mid-grey (~#3d3d3d) with a grid that's LIGHTER than the background;
 * we were near-black on near-black, so nothing read.
 *
 * Two pieces:
 *   - a gradient SKYDOME (a camera-riding mesh, with raised mid-grey values) — done as a mesh,
 *     not scene.background/backgroundNode, because the GPU pick pass needs scene.background null.
 *   - an INFINITE GRID done the real way: a TSL fragment grid off worldspace position with
 *     fwidth() constant-pixel-width anti-aliased lines, minor + major scales, saturated red-X /
 *     blue-Z origin axes, and a distance fade to the horizon. (A GridHelper is the fallback if
 *     the TSL build ever throws, so a shader hiccup can't blank the scene.)
 *
 * The SKY rides the camera (a smooth dome, always around you). The GRID does NOT chase the eye —
 * it's a large, static, world-locked plane at the origin, and the distance fade hides its far
 * edge so it reads as infinite without moving. (A plane that continuously recentered on the exact
 * camera position every frame made the floor feel like it was slip-sliding — coverage we get from
 * size + fade instead.) On the DEFAULT layer + unregistered, so the pick pass, the culler, and the
 * look-distance ignore them.
 *
 * Next layer (not here): a hemisphere/key light on a lit ground + a contact shadow so the
 * content visibly SITS on the floor (the Tinkercad effect). Content is emissive, so that's
 * mostly about the ground + shadow, not the panels.
 */
export default function SceneEnvironment({
  groundY = 0,
  skyRadius = 9000,
  skyHorizon = 0x343a45,   // raised mid-grey-blue — the present "lit" floor of the value range
  skyZenith = 0x191c24,
  skyNadir = 0x0d0e12,
  gridSize = 40000,   // large + STATIC (no camera-follow): the fade hides the far edge
  minorCell = 200,
  majorCell = 2000,
  lineColor = 0x5b6478,    // LIGHTER than the sky horizon (the whole point)
  xAxisColor = 0xe0556a,   // red X axis
  zAxisColor = 0x4a86d8,   // blue Z axis
  fadeNear = 600,
  fadeFar = 7000,
} = {}) {
  const { scene, camera } = useThree();
  const refs = useRef(null);

  useEffect(() => {
    const objs = [];

    // --- gradient skydome (mesh → pick-pass-safe; raised value range so it actually reads) ---
    const skyGeo = new THREE.SphereGeometry(skyRadius, 32, 24);
    {
      const hz = new THREE.Color(skyHorizon), zn = new THREE.Color(skyZenith), nd = new THREE.Color(skyNadir);
      const pos = skyGeo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) / skyRadius;                 // -1 (nadir) → +1 (zenith)
        if (t >= 0) c.copy(hz).lerp(zn, hermite(t)); else c.copy(hz).lerp(nd, hermite(-t));
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      skyGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    sky.renderOrder = -1000;
    scene.add(sky); objs.push(sky);

    // --- infinite-looking grid (TSL; GridHelper fallback if the node build throws). Static at
    //     the origin — the world-locked pattern + distance fade do the work, no camera-follow. ---
    let grid;
    try {
      const cellGrid = Fn(([cell]) => {
        const r = positionWorld.xz.div(cell);
        const g = abs(fract(r.sub(0.5)).sub(0.5)).div(fwidth(r));   // distance-to-line ÷ px-derivative
        return float(1).sub(min(min(g.x, g.y), float(1)));
      });
      const minor = cellGrid(float(minorCell));
      const major = cellGrid(float(majorCell));
      const dist = tslLength(positionWorld.xz.sub(cameraPosition.xz));
      const fade = float(1).sub(tslSmoothstep(float(fadeNear), float(fadeFar), dist));
      const axisW = fwidth(positionWorld.xz).mul(1.5);
      const xAxis = tslSmoothstep(axisW.y, float(0), abs(positionWorld.z));   // z≈0 → red line along X
      const zAxis = tslSmoothstep(axisW.x, float(0), abs(positionWorld.x));   // x≈0 → blue line along Z
      const lines = max(minor.mul(0.5), major);                              // major dominates, minor at half
      let rgb = tslMix(tslColor(lineColor), tslColor(xAxisColor), xAxis);
      rgb = tslMix(rgb, tslColor(zAxisColor), zAxis);
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.colorNode = rgb;
      mat.opacityNode = max(lines, max(xAxis, zAxis)).mul(fade);
      mat.transparent = true; mat.depthWrite = false;
      grid = new THREE.Mesh(new THREE.PlaneGeometry(gridSize, gridSize).rotateX(-Math.PI / 2), mat);
    } catch (err) {
      console.warn('[SceneEnvironment] TSL grid build failed, using GridHelper fallback:', err);
      grid = new THREE.GridHelper(gridSize, Math.max(2, Math.round(gridSize / minorCell)), lineColor, lineColor);
      grid.material.transparent = true; grid.material.opacity = 0.7; grid.material.depthWrite = false;
    }
    grid.position.y = groundY;
    grid.renderOrder = -100;
    scene.add(grid); objs.push(grid);

    refs.current = { sky, grid };
    return () => { objs.forEach(o => { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }); refs.current = null; };
  }, [scene, groundY, skyRadius, skyHorizon, skyZenith, skyNadir, gridSize, minorCell, majorCell, lineColor, xAxisColor, zAxisColor, fadeNear, fadeFar]);

  useFrame(() => {
    const r = refs.current;
    if (!r) return;
    r.sky.position.copy(camera.position);          // the sky is always around you; the grid stays put (static, world-locked)
  });

  return null;
}

/** Hermite smoothstep, clamped 0..1. */
function hermite(x) { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); }
