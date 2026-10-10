import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const GRID_VS = `
varying vec3 vWorldPosition;
void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPosition = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GRID_FS = `
varying vec3 vWorldPosition;
uniform vec3 uLineColor;
uniform vec3 uXAxisColor;
uniform vec3 uZAxisColor;
uniform float uMinorCell;
uniform float uMajorCell;
uniform float uFadeNear;
uniform float uFadeFar;
uniform vec3 uCameraPos;

float calcGrid(vec2 pos, float cell) {
    vec2 r = pos / cell;
    vec2 g = abs(fract(r - 0.5) - 0.5) / max(fwidth(r), vec2(1e-6, 1e-6));
    return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
    vec2 pos = vWorldPosition.xz;
    float minor = calcGrid(pos, uMinorCell);
    float major = calcGrid(pos, uMajorCell);
    float dist = length(pos - uCameraPos.xz);
    float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
    vec2 axisW = fwidth(pos) * 1.5;
    float xAxis = smoothstep(axisW.y, 0.0, abs(vWorldPosition.z));
    float zAxis = smoothstep(axisW.x, 0.0, abs(vWorldPosition.x));
    float lines = max(minor * 0.5, major);
    vec3 rgb = mix(uLineColor, uXAxisColor, xAxis);
    rgb = mix(rgb, uZAxisColor, zAxis);
    float alpha = max(lines, max(xAxis, zAxis)) * fade;
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(rgb, alpha);
}
`;

/**
 * <SceneEnvironment> — the world: a present, lit-feeling ground like a real 3D editor, NOT a
 * whispered grid on a black void.
 *
 * Two pieces:
 *   - a gradient SKYDOME (a camera-riding mesh, with raised mid-grey values)
 *   - an INFINITE GRID done with constant-pixel-width anti-aliased lines and distance fade
 */
export default function SceneEnvironment({
  groundY = 0,
  skyRadius = 9000,
  skyHorizon = 0x343a45,
  skyZenith = 0x191c24,
  skyNadir = 0x0d0e12,
  gridSize = 40000,
  minorCell = 200,
  majorCell = 2000,
  lineColor = 0x5b6478,
  xAxisColor = 0xe0556a,
  zAxisColor = 0x4a86d8,
  fadeNear = 600,
  fadeFar = 7000,
} = {}) {
  const { scene, camera } = useThree();
  const refs = useRef(null);

  useEffect(() => {
    const objs = [];

    // --- gradient skydome ---
    const skyGeo = new THREE.SphereGeometry(skyRadius, 32, 24);
    {
      const hz = new THREE.Color(skyHorizon), zn = new THREE.Color(skyZenith), nd = new THREE.Color(skyNadir);
      const pos = skyGeo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) / skyRadius;
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

    // --- infinite-looking grid ---
    const gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VS,
      fragmentShader: GRID_FS,
      uniforms: {
        uLineColor: { value: new THREE.Color(lineColor) },
        uXAxisColor: { value: new THREE.Color(xAxisColor) },
        uZAxisColor: { value: new THREE.Color(zAxisColor) },
        uMinorCell: { value: minorCell },
        uMajorCell: { value: majorCell },
        uFadeNear: { value: fadeNear },
        uFadeFar: { value: fadeFar },
        uCameraPos: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
    });

    const grid = new THREE.Mesh(new THREE.PlaneGeometry(gridSize, gridSize).rotateX(-Math.PI / 2), gridMat);
    grid.position.y = groundY;
    grid.renderOrder = -100;
    scene.add(grid); objs.push(grid);

    refs.current = { sky, grid, gridMat };
    return () => {
      objs.forEach(o => { scene.remove(o); o.geometry.dispose(); o.material.dispose(); });
      refs.current = null;
    };
  }, [scene, groundY, skyRadius, skyHorizon, skyZenith, skyNadir, gridSize, minorCell, majorCell, lineColor, xAxisColor, zAxisColor, fadeNear, fadeFar]);

  useFrame(() => {
    const r = refs.current;
    if (!r) return;
    r.sky.position.copy(camera.position);
    r.gridMat?.uniforms?.uCameraPos?.value?.copy(camera.position);
  });

  return null;
}

/** Hermite smoothstep, clamped 0..1. */
function hermite(x) { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); }
