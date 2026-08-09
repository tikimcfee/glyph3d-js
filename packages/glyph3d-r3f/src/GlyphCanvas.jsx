import React from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { setComputeRenderer, setPipelineArena } from '@glyph3d/core/compute/GlyphLayoutCompute.js';
import GlyphPipelineArena from '@glyph3d/core/compute/GlyphPipelineArena.js';
import { GlyphProvider } from './context.jsx';

/**
 * The shared pipeline arena's slot buffer is capacity-sized (44B per source byte) and
 * GROWS with the load — past the default maxStorageBufferBindingSize (128MB) at ~3MB of
 * source. Request the adapter's REAL limits (capped at 2GB). Probing the adapter first is
 * the WebGPU-recommended pattern: requestDevice fails if a required limit exceeds what
 * the adapter can provide. Returns {} (default limits) when probing is unavailable.
 *
 * HAZARD — this is the app's ONE requestDevice input, and it fails LOUD, never silent:
 * an invalid required limit (negative, non-finite, non-numeric) makes requestDevice
 * throw, and three's Renderer.init catches that and silently swaps in the WebGL2
 * backend with "WebGPU is not available" — which presents as MACHINE-level WebGPU
 * unavailability (adapter fine, chrome://gpu fine, "unavailable" anyway) and sends
 * debugging toward drivers/reboots instead of this function. So every limit is
 * validated here: a bad value logs the offending entry and ships {} (defaults) so the
 * app still boots on WebGPU. Mind signed 32-bit traps: 1 << 31 is -2^31, not 2^31.
 */
async function _pipelineLimits(glProps) {
  try {
    const pp = glProps && glProps.powerPreference;
    const adapter = await navigator.gpu?.requestAdapter(pp ? { powerPreference: pp } : undefined);
    const lim = adapter?.limits;
    if (!lim) return {};
    const cap = 2 ** 31;   // 2GB
    const requiredLimits = {
      maxBufferSize: Math.min(lim.maxBufferSize, cap),
      maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, cap),
      // The WebGPU DEFAULT is 8192 regardless of hardware; large sampled surfaces
      // (frame captures, far atlas growth) want the adapter's real ceiling.
      maxTextureDimension2D: lim.maxTextureDimension2D,
    };
    for (const [name, value] of Object.entries(requiredLimits)) {
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        console.error(
          `[glyph3d] requiredLimits.${name} computed as ${value} — invalid; requestDevice`
          + ' would reject it and three would fall back to WebGL2. Booting with default'
          + ' limits instead (large loads may hit the 128MB binding cap).');
        return {};
      }
    }
    return { requiredLimits };
  } catch {
    return {};
  }
}

/**
 * Defer out-of-frame renderer resizes to the START of the next frame.
 *
 * A WebGPU canvas resize DESTROYS the canvas-sized color/depth targets and
 * recreates them — and r3f applies `gl.setSize` from a React effect (its
 * ResizeObserver → store → effect), i.e. mid-task, outside the render loop.
 * Under a dock-divider drag that lands between frames whose encoded command
 * buffers still reference the old texture: "Destroyed texture … used in a
 * submit", a validation-error burst per resize (a continuous drag = an
 * every-frame storm; see the relay log 2026-08-08). Queuing the size and
 * applying it as the FIRST thing in the frame makes destroy → recreate →
 * render one synchronous run that no in-flight command buffer can straddle —
 * the ecosystem-standard shape for WebGPU resize.
 *
 * The wrap installs once per renderer instance (gl factory). One frame of
 * stale size during a drag is invisible; the initial r3f setSize defers to
 * the first frame, which is a no-op because the canvas backing was already
 * baked to that exact size at construction (see the component note below).
 */
function _deferResizeToFrame(renderer) {
  const applySize = renderer.setSize.bind(renderer);
  let pending = null;
  renderer.setSize = (w, h, updateStyle) => {
    // A dock layout transition can measure the canvas host at 0 for a beat —
    // applying that would destroy the canvas targets and recreate them
    // DEGENERATE (the destroyed-texture / zero-scissor storm). Drop it loudly;
    // the next real measurement lands normally.
    if (!(w > 0) || !(h > 0)) {
      console.warn(`[glyph3d] ignoring degenerate canvas resize ${w}×${h} (dock layout transient)`);
      return;
    }
    pending = [w, h, updateStyle];
  };
  renderer.__flushPendingResize = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    applySize(...p);
  };
}

/** Runs before everything else in the frame (most-negative priority) — the
 *  one place a deferred resize is safe to land. */
function ResizeFrameGate() {
  const { gl } = useThree();
  useFrame(() => { gl.__flushPendingResize?.(); }, -10000);
  return null;
}

/**
 * GlyphCanvas — an r3f <Canvas> wired for the WebGPU GlyphField stack.
 *
 * The load-bearing detail is sizing the canvas BEFORE the WebGPU renderer is
 * constructed. Root cause (from r3f's source + three's WebGPU backend): r3f waits
 * for a non-zero measured container, then `await`s the async `gl` factory, then
 * applies the size via setSize. But three's WebGPU `CanvasTarget` builds its
 * depth + MSAA render targets from `canvas.width/height` AT CONSTRUCTION — which,
 * inside the factory, is still the HTML default 300×150 — and it does NOT rebuild
 * them on the later setSize (only on a real resize *event*). So the targets
 * freeze at 300×150 while the color attachment tracks the real size: a permanent
 * "attachment size does not match" (fatal on HiDPI). It's exactly why a manual
 * window resize "fixes" it — the resize event finally triggers the rebuild.
 *
 * Fix: bake the canvas backing size in up front — from the PARENT container that
 * r3f has already measured (reading the canvas itself feeds back from the backing
 * we're setting → a runaway loop), times a pinned dpr so r3f's later setSize lands
 * on the exact same size and there's nothing to rebuild.
 *
 * @param {object} props
 * @param {number} [props.toneMapping] - THREE tone-mapping constant. Default NoToneMapping.
 * @param {number} [props.dpr] - Device pixel ratio. Defaults to clamped window.devicePixelRatio.
 * @param {(renderer, props) => void} [props.onRenderer] - Hook after init().
 * @param {import('@glyph3d/core').GlyphAtlas} props.atlas - Ready atlas from bootGlyphEngine.
 */
export default function GlyphCanvas({
  atlas,
  toneMapping = THREE.NoToneMapping,
  onRenderer,
  dpr,
  children,
  ...canvasProps
}) {
  // Pin dpr so the size we bake into the canvas matches exactly what r3f applies
  // afterward (otherwise depth/color diverge by the dpr factor — the HiDPI bug).
  const resolvedDpr = dpr ?? (typeof window !== 'undefined'
    ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1);

  return (
    <Canvas
      {...canvasProps}
      dpr={resolvedDpr}
      // r3f v9: the gl factory may be async; configure() awaits it and mounts
      // children only after it resolves. We size the canvas backing here, before
      // `new WebGPURenderer`, so the screen depth/MSAA targets are born at the
      // right size (see the component note above).
      gl={async (glProps) => {
        const canvas = glProps && glProps.canvas;
        if (canvas) {
          // Match r3f's own sizing math EXACTLY: it does Math.floor(rect × dpr)
          // off the measured bounding rect (fractional). Math.round + clientWidth
          // (integer) drifted by a pixel → depth 839 vs color 838, the mismatch.
          const host = canvas.parentElement;
          const rect = host && host.getBoundingClientRect();
          const w = (rect && rect.width) || (typeof window !== 'undefined' ? window.innerWidth : 0);
          const h = (rect && rect.height) || (typeof window !== 'undefined' ? window.innerHeight : 0);
          if (w > 0 && h > 0) {
            // Backing store (physical px) AND CSS display size (logical px) — the
            // standard HiDPI canvas setup. Without the style, the canvas displays
            // at its intrinsic backing size, overflowing the frame (clipped →
            // blank) until a resize makes r3f set the style.
            canvas.width = Math.floor(w * resolvedDpr);
            canvas.height = Math.floor(h * resolvedDpr);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
          }
        }
        const limits = await _pipelineLimits(glProps);
        const renderer = new THREE.WebGPURenderer({ ...glProps, antialias: true, ...limits });
        renderer.toneMapping = toneMapping;
        await renderer.init();
        // Fallback forensics: three's "WebGPU is not available" fallback warn is ambiguous —
        // it fires for a missing adapter AND for a rejected requestDevice. If the adapter
        // probe succeeded but we still landed on WebGL2, the DEVICE REQUEST failed: an
        // app-side problem (requiredLimits, or the browser's GPU-process crash backoff —
        // relaunch the browser), never machine-level WebGPU availability. Name it.
        if (renderer.backend?.isWebGPUBackend !== true && navigator.gpu) {
          console.error(
            '[glyph3d] WebGPU FELL BACK to WebGL2 despite navigator.gpu being present.'
            + (limits.requiredLimits
              ? ` requestDevice was sent requiredLimits ${JSON.stringify(limits.requiredLimits)} —`
                + ' if these look wrong, the bug is in _pipelineLimits, not the machine.'
              : ' No requiredLimits were requested — suspect the browser\'s GPU-process'
                + ' crash backoff (relaunch the browser, not the OS).'));
        }
        // Arm the core's GPU layout engine: core objects (CodeGrid) live below the renderer
        // and can't reach it through any ctx they own — this is the one registration point.
        setComputeRenderer(renderer);
        // THE byte-pipeline path: ONE shared pipeline arena per app (the multi-file
        // hoist) — a load storm stages every file as an item and flushes in three
        // dispatches, instead of one kernels instance (3 codegens) per grid. Also
        // reachable off the renderer: itests importing core modules via /@fs get a
        // DIFFERENT module instance than the app's, so the module singleton alone
        // would be invisible to them.
        // WebGPU-less boot (WebGL2 fallback): the arena can't exist — compute is
        // WebGPU-only. Log ONE clear error and boot without it; grids stay empty
        // (CodeGrid fails loud-once at load) instead of a shader-error storm.
        try {
          const arena = new GlyphPipelineArena(renderer, atlas, { worldScale: 0.025 });
          setPipelineArena(arena);
          renderer.glyphPipelineArena = arena;
        } catch (err) {
          console.error('[glyph3d] BYTE PIPELINE UNAVAILABLE — grids will not lay out:', err?.message || err);
        }
        _deferResizeToFrame(renderer);
        onRenderer?.(renderer, glProps);
        return renderer;
      }}
    >
      <GlyphProvider atlas={atlas}>
        <ResizeFrameGate />
        {children}
      </GlyphProvider>
    </Canvas>
  );
}
