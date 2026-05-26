import React, { useEffect, useRef, forwardRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { SceneContext } from 'glyph3d-js/services';
import { ViewerCameraController } from 'glyph3d-js/services/camera';
import { useGlyphAtlas, useGridRegistry } from './context.jsx';

const assignRef = (ref, value) => {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
};

/**
 * <ViewerCamera> — drives the active r3f camera with ViewerCameraController
 * (physics-based pan/orbit/zoom + focus helpers, the existing substrate).
 *
 * Builds the SceneContext bag VCC expects from r3f's useThree handles + the grid
 * registry. Honors the contract discovered in the keystone: the constructor only
 * builds input state — `setupEventListeners()` must be called to bind DOM input.
 * VCC's integrator runs in useFrame (before r3f's own gl.render); we do NOT use
 * renderer.setAnimationLoop (that would compete with r3f's loop).
 *
 * Exposes the controller instance via ref for imperative focus/fit calls.
 */
const ViewerCamera = forwardRef(function ViewerCamera(_props, ref) {
  const { scene, camera, gl } = useThree();
  const atlas = useGlyphAtlas();
  const registry = useGridRegistry();
  const ctrlRef = useRef(null);

  useEffect(() => {
    const ctx = new SceneContext({
      THREE,
      scene,
      camera,
      renderer: gl,
      canvas: gl.domElement,
      atlas,
      getGrids: () => registry.getGrids(),
    });
    const controller = new ViewerCameraController(ctx);
    controller.setupEventListeners(); // ctor builds state only; this binds input
    ctrlRef.current = controller;
    assignRef(ref, controller);

    return () => {
      controller.dispose?.();
      ctrlRef.current = null;
      assignRef(ref, null);
    };
  }, [scene, camera, gl, atlas, registry]);

  useFrame((_state, delta) => {
    ctrlRef.current?.update(delta);
  });

  return null;
});

export default ViewerCamera;
