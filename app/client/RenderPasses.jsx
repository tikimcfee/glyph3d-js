import { useCallback, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { MinimapPass } from '@glyph3d/core/services/visual';
import { PASS_ORDER } from './FramePasses.js';

/**
 * <RenderPasses passes registry minimap /> — the app's ONE render-loop owner (FramePasses.js): a
 * priority-1 useFrame, so r3f stops rendering the frame itself, that draws the frame through
 * `passes` (ctx.renderPasses) — after every priority-0 system, where r3f would have rendered — and
 * checks each frame that no other positive-priority useFrame took the loop. `minimap` (the
 * view.minimap setting) declares the minimap pass over `registry`'s surfaces; off removes it.
 * CommandProvider mounts it.
 * @param {{passes: import('./FramePasses.js').default, registry: {toArray: Function}, minimap?: boolean}} props
 */
export default function RenderPasses({ passes, registry, minimap = false }) {
  useEffect(() => {
    if (!minimap) return undefined;
    const pass = new MinimapPass(registry);
    const remove = passes.add('minimap', PASS_ORDER.minimap, (r, cam) => pass.render(r, cam));
    return () => { remove(); pass.dispose(); };
  }, [minimap, passes, registry]);

  const frame = useCallback((state) => {
    passes.checkLoop(state.internal, frame);
    passes.renderFrame(state.camera);
  }, [passes]);
  useFrame(frame, 1);
  return null;
}
