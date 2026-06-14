import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useAppCommands } from './CommandProvider.jsx';
import { resolveGesture } from './gestureResolver.js';
import { resolveKeyBinding } from './keymap.js';
import { moveVerbFor } from './surfaceInteractions.js';

const round = (n) => Math.round(n * 100) / 100;

// Canvas interaction — hovering / clicking / dragging grids in the 3D scene.
//
// The grids are imperative Object3Ds (not r3f <mesh> JSX), so r3f's own event
// system doesn't see them. Hit-testing is the GPU ID pass (PickingSystem), NOT
// raycasting: the picking buffer is the single source of truth for what's under
// the cursor. The 'grid' channel renders each grid's background panel with a
// grid-level ID — pixel-precise, covers the whole panel (no gaps), and resolves
// the FRONT grid in an overlap/cascade (depth-tested). The 'glyph' channel
// (char-level) stays registered for highlighting features.
//
// Selection is written through the SAME attention.set / camera.focus commands the
// CLI uses, so a canvas click and `glyph3d-cli attention.set primary <id>` are
// indistinguishable downstream.

const DRAG_PX = 5; // pointer travel above this = a drag (orbit/pan), not a click
// Caret-preview tint for the glyph under the pointer (additive over syntax color,
// via the highlight texture). Mid-tone cool lift — pure white blows out light glyphs.
const HOVER_GLYPH_TINT = { r: 0.18, g: 0.25, b: 0.38 };
// Hover outline inflation. Small — the box hugs the panel edge (getLocalBounds
// already carries the background padding), so a hover on an UNfocused grid reads as
// a tight halo, not a fat frame floating out in space. When hover lands on the
// focused grid we don't draw a second box at all (see below) — we recolor the one
// focus box — so there's no two-boxes-merging case left to space apart.
const HOVER_INFLATE = 0.35;

// Control-state outline colors. The focus box recolors by where keystrokes land, so the window's
// state is legible in 3D (not only in the HUD): green = focused/selected, amber = input-active
// (a code grid in edit mode, or the keyboard-target terminal). Amber matches the HUD edit color.
const FOCUS_COLOR = 0x6ee7a0;  // green
const INPUT_COLOR = 0xf0b45a;  // amber (HUD editOn)
const HOVER_COLOR = 0x9fd2ff;  // light blue — hover
// When you hover the grid that's ALREADY focused, the single focus box fades part-
// way toward the hover blue instead of stacking a second outline on top. Keeps the
// state color legible while still acknowledging the hover. Lerp/frame = the fade rate.
const HOVER_FOCUS_BLEND = 0.5;
const OUTLINE_FADE = 0.16;

// A directory reads as a glowing REGION, not just an edge: when the focused entity
// is a directory, its footprint fills with a faint, slowly breathing tint (the same
// focus-state color) inside the edge box. A file is a panel — a crisp wireframe; a
// directory is a volume — a soft lit area. Same color language, different body.
const FILL_OPACITY_MIN = 0.05; // breathing low — barely-there wash
const FILL_OPACITY_MAX = 0.14; // breathing high
const FILL_BREATH_HZ = 0.24;   // breaths per second (~4s cycle) — calm, not blinky
const FILL_INFLATE = 0.1;      // a little z-thickness so the flat footprint reads as a slab

// Resize floors — a terminal smaller than this is useless (and a SIGWINCH to 0
// rows confuses the shell). Drags clamp the prospective size to these.
const MIN_COLS = 8;
const MIN_ROWS = 3;

// Map a grid object (the token a 'grid'-channel pick resolves to) back to its
// registry entry { id, type, grid }.
function entryForGrid(registry, grid) {
  if (!grid) return null;
  const id = registry.getIdByGrid(grid);
  return id ? registry.get(id) : null;
}

/** Pointer + camera → GPU grid-channel pick → attention + camera, via the router. */
export function CanvasPicker() {
  const { gl, camera, scene } = useThree();
  const client = useAppCommands();
  // Cursor + last-pick guards, so the per-frame hover only picks when the cursor
  // OR the camera actually moved (idle frames cost nothing). hoverEntry caches the
  // last resolved entity so a click/drag acts on exactly what's highlighted.
  const s = useRef({
    x: 0, y: 0, in: false, downX: 0, downY: 0,
    hoverId: null, hoverEntry: null, hoverGlyph: null,
    pickPending: false, gpuOk: false, gpuWarned: false, lastPs: null,
    lx: NaN, ly: NaN, lin: false,
    px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN,
  }).current;

  // Wire the picking system into each grid/terminal as it registers, so the ID
  // pass covers every glyph mesh + panel. ps is created in CommandProvider's
  // effect (which runs after this child mounts), so we (re)sweep on every registry
  // change — by the time any grid registers (session restore / file.open), ps exists.
  useEffect(() => {
    if (!client) return;
    const { ctx, registry } = client;
    const wired = new WeakSet();
    let cancelled = false;
    let tslWarned = false;
    const wire = () => {
      const ps = ctx.pickingSystem;
      if (!ps) return;
      ps._tslReady.then(() => {
        if (cancelled) return;
        for (const entry of [...registry.findByType('grid'), ...registry.findByType('terminal')]) {
          const grid = entry.grid;
          if (grid && !wired.has(grid) && typeof grid.setPickingSystem === 'function') {
            wired.add(grid);
            grid.setPickingSystem(ps);
          }
        }
      }).catch((e) => {
        // TSL failed to load (e.g. the dynamic three/webgpu import rejected): no
        // grid gets wired and the ID pass stays empty (hover/click won't resolve).
        // Warn once so it isn't silent.
        if (!tslWarned) { tslWarned = true; console.warn('[CanvasPicker] TSL picking unavailable; hover/select disabled', e); }
      });
    };
    wire();
    registry.addChangeListener(wire);
    return () => { cancelled = true; registry.removeChangeListener(wire); };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const { router } = client;
    const dom = gl.domElement;

    // The one authority for "is this press on a resize grip?" — consulted by BOTH
    // ResizeDragger.onDown and ViewerCameraController.mousedown (CommandProvider
    // forwards it onto VCC's separate ctx) so the resize-vs-pan decision is identical
    // on both sides. It gates the async-resolved handleHover on FRESHNESS: the cursor
    // must still be within DRAG_PX of where the grip pick sampled, so a press never
    // acts on a stale grip the cursor has already left.
    const isGripPress = (clientX, clientY) => {
      const hh = client.ctx.handleHover, at = client.ctx.handleHoverAt;
      return !!(hh && at && Math.hypot(clientX - at.x, clientY - at.y) <= DRAG_PX);
    };
    client.ctx.isGripPress = isGripPress;

    const onMove = (e) => { s.x = e.clientX; s.y = e.clientY; s.in = true; };
    const onEnter = () => { s.in = true; };
    const onLeave = () => { s.in = false; };
    const onDown = (e) => { s.downX = e.clientX; s.downY = e.clientY; };

    // Glyph-level pick at the current pointer → caret. The glyph channel returns
    // the instance index; instance order == buffer-slot order, so the grid inverts
    // it to (line,col) and edit.goto places the caret — in ANY layout (column,
    // framed, z-pages), because layout only moves quads, never slots. Resolves
    // false when the pointer is over the panel but not a glyph. Async: the GPU
    // readback lands a frame later; the click guards already passed, so the
    // pointer is parked.
    const placeCaretFromPointer = (entry) => {
      const ps = client.ctx.pickingSystem;
      if (!ps || entry?.type !== 'grid') return Promise.resolve(false);
      const rect = dom.getBoundingClientRect();
      ps.setMousePosition(s.x - rect.left, s.y - rect.top);
      ps.markDirty(); // channels share one _needsPick latch — mandatory before this pass
      return ps.pickAsync('glyph', camera, scene).then((hit) => {
        if (!hit || hit.token !== entry.grid.getRenderer?.()) return false; // missed, or another grid's glyphs
        const pos = entry.grid.getCharForSlot?.(hit.slotIndex);
        if (!pos) return false;
        router.execute(['edit.goto', entry.id, String(pos.line), String(pos.col)]);
        return true;
      }).catch(() => false);
    };

    // The responder chain env: gestures resolve against the context nodes and
    // emit VERBS (never direct mutation) — see gestureResolver.js. The guards
    // here decide whether a pointer release IS a gesture; the resolver decides
    // what the gesture MEANS in the current context.
    // Lazy getters, deliberately: this CHILD effect runs before CommandProvider's
    // PARENT effect creates interactionContext, so capturing the reference here
    // would freeze it as undefined and every gesture would fall to the ROOT tier.
    const gestureEnv = {
      exec: (cmd) => router.execute(cmd),
      get attention() { return client.ctx.attentionManager; },
      get context() { return client.ctx.interactionContext; },
      get cameraDock() { return client.ctx.cameraDock; },
      placeCaretFromPointer,
    };

    const onUp = (e) => {
      // A resize drag (ResizeDragger) owns this release — never treat its tiny
      // sub-DRAG_PX nudges as a click that would re-select / refocus.
      if (client.ctx.resizing) return;
      // Only a click if the pointer barely moved (else it was an orbit/pan/drag).
      if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) > DRAG_PX) return;
      // Act on exactly what's highlighted (the grid-channel hover result the
      // hover loop keeps current). hoverEntry null = empty space. Modifiers ride
      // along so meta+click can toggle dock membership (gestureResolver).
      const mods = { meta: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey };
      resolveGesture({ type: 'click', target: s.hoverEntry, mods }, gestureEnv);
    };

    const onDblClick = (e) => {
      if (client.ctx.resizing) return;
      resolveGesture({ type: 'dblclick', target: s.hoverEntry }, gestureEnv);
    };

    // Host keyboard (bubble phase): EntityKeystrokeRouter (capture) has already
    // taken edit/terminal keys, so anything reaching here is NAV mode.
    //   • Escape pops the innermost context node (leave edit / release the hold),
    //     resolved through the gesture chain. EntityKeystrokeRouter deliberately
    //     ignores Escape for the host; this is the host.
    //   • Otherwise consult the nav keymap (hjkl → focus.neighbor, …) and fire
    //     the bound verb through the bus — same path as a click / the CLI.
    // DOM inputs (command bar, panels) keep their own keys — guarded first.
    const onKeyDown = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        if (resolveGesture({ type: 'esc', target: null }, gestureEnv)) e.preventDefault();
        return;
      }
      if (e.repeat) return; // one press = one jump; holding a key doesn't sweep the field
      const cmd = resolveKeyBinding(e);
      if (cmd) { router.execute(cmd); e.preventDefault(); }
    };
    document.addEventListener('keydown', onKeyDown);

    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerenter', onEnter);
    dom.addEventListener('pointerleave', onLeave);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('dblclick', onDblClick);
    return () => {
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerenter', onEnter);
      dom.removeEventListener('pointerleave', onLeave);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('dblclick', onDblClick);
      document.removeEventListener('keydown', onKeyDown);
      if (client.ctx.isGripPress === isGripPress) client.ctx.isGripPress = null;
    };
  }, [client, gl, s]);

  // Re-evaluate hover every frame the cursor OR camera moved. A pure pointermove
  // hover goes stale the moment the CAMERA moves under a still cursor (pan / zoom /
  // Ctrl-drag fire no pointer event). The 'grid' channel ID pass is pixel-precise
  // and covers the whole panel — immune to the AABB overlap ambiguity that
  // mis-hovered cascaded grids, and with no dead zones between glyphs.
  useFrame(() => {
    if (!client) return;
    // A resize drag is in progress (ResizeDragger): it owns the cursor + the
    // captured grip; pause hover picking so the two don't fight over the cursor
    // and we don't pick against a panel that's about to change size.
    if (client.ctx.resizing) return;
    const c = camera;
    const dom = gl.domElement;

    // Resolve a picked entry into the hover slot. Always refresh the cached entry
    // (cheap); only fire the command + cursor change when the id changes.
    const applyHover = (entry) => {
      const id = entry?.id ?? null;
      s.hoverEntry = entry ?? null;
      if (id === s.hoverId) return;
      s.hoverId = id;
      client.router.execute(`attention.set hover ${id || 'none'}`);
      dom.style.cursor = id ? 'pointer' : 'default';
    };

    // Resolve the resize-grip pick into the shared ctx.handleHover flag + the
    // pixel it was SAMPLED at (handleHoverAt). The cursor cue is set here; the
    // press DECISION (resize vs. pan) is gated by ctx.isGripPress(), which checks
    // freshness against that sample pixel. The pick is async (a GPU readback that
    // lands a frame+ later), so the press must NOT trust a stale token — both the
    // ResizeDragger and ViewerCameraController go through isGripPress. atX/atY are
    // the cursor at pick-sample time (threaded in), not at resolve time.
    const applyHandleHover = (token, atX, atY) => {
      // Drive the Button3D hover visual: clear the one we're leaving, light the one we're on.
      const prev = client.ctx.handleHover;
      if (prev?.button && prev.button !== token?.button) prev.button.setHovered(false);
      client.ctx.handleHover = token ?? null;
      client.ctx.handleHoverAt = token ? { x: atX, y: atY } : null;
      if (token?.button) token.button.setHovered(true);
      // Drag grips show the resize cursor; the click buttons (pin + dials) keep the
      // 'pointer' that the grid-hover pass already set this frame.
      if (token && (token.role === 'resize' || token.role === 'scale')) dom.style.cursor = 'nwse-resize';
    };

    // Caret-preview tint: light the glyph under the pointer (additive highlight
    // texture — one texel write, syntax colors untouched). Tracks the lit slot so
    // each move clears the last. KNOWN LIMIT: the highlight texture is shared, so
    // clearing the tint also clears a user highlight.* on that exact glyph.
    const applyGlyphHover = (renderer, slot) => {
      const prev = s.hoverGlyph;
      if (prev && (prev.renderer !== renderer || prev.slot !== slot)) {
        prev.renderer.setGlyphHighlight?.(prev.slot, null);
      }
      s.hoverGlyph = (renderer && slot != null)
        ? (renderer.setGlyphHighlight?.(slot, HOVER_GLYPH_TINT), { renderer, slot })
        : null;
    };

    const cursorMoved = s.x !== s.lx || s.y !== s.ly || s.in !== s.lin;
    const camMoved =
      c.position.x !== s.px || c.position.y !== s.py || c.position.z !== s.pz ||
      c.quaternion.x !== s.qx || c.quaternion.y !== s.qy || c.quaternion.z !== s.qz || c.quaternion.w !== s.qw;
    if (!cursorMoved && !camMoved) return;
    s.lx = s.x; s.ly = s.y; s.lin = s.in;
    s.px = c.position.x; s.py = c.position.y; s.pz = c.position.z;
    s.qx = c.quaternion.x; s.qy = c.quaternion.y; s.qz = c.quaternion.z; s.qw = c.quaternion.w;

    const ps = client.ctx.pickingSystem;
    // If the PickingSystem instance was swapped (dev HMR of CommandProvider),
    // reset the per-instance confirmation latch so the log reflects the new one.
    if (ps !== s.lastPs) { s.lastPs = ps; s.gpuOk = false; s.gpuWarned = false; }

    if (ps && s.in) {
      // Feed the cursor (canvas-relative); force a pick on camera-move (no pointer
      // event fires then). One pick in flight at a time. useFrame runs before r3f's
      // main render, so the offscreen ID pass is safe here.
      const rect = dom.getBoundingClientRect();
      const sx = s.x, sy = s.y; // the pixel THIS pick samples — stamped onto handleHoverAt
      ps.setMousePosition(sx - rect.left, sy - rect.top);
      if (camMoved) ps.markDirty();
      if (!s.pickPending && ps._needsPick) {
        s.pickPending = true;
        ps.pickAsync('grid', c, scene).then((hit) => {
          // Guard on s.in: a pick resolving AFTER the cursor left must clear hover.
          const entry = (s.in && hit) ? entryForGrid(client.ctx.registry, hit.token) : null;
          if (entry && !s.gpuOk) {
            s.gpuOk = true;
            console.log(`[CanvasPicker] grid picking confirmed → ${entry.id}`);
          }
          applyHover(entry);
          // Second channel, SAME frame: the resize grips. markDirty() is
          // MANDATORY — both passes share one _needsPick latch, so without it the
          // handle pass no-ops and hands back the prior frame's hit. The grip
          // stage swallows its own error so a handle-pass hiccup never clears a
          // good grid hover (the outer catch is for grid-pass failures only).
          ps.markDirty();
          return ps.pickAsync('handle', c, scene).then(
            (h) => applyHandleHover(s.in ? (h?.token ?? null) : null, sx, sy),
            () => applyHandleHover(null),
          ).then(() => {
            // Third channel: caret-preview on the doc being EDITED. Gated to the
            // key-target grid — the glyph pass renders every instance, so it stays
            // off during plain navigation. (markDirty: shared latch, as above.)
            const keyId = client.ctx.attentionManager?.get('key')?.id;
            if (!entry || entry.type !== 'grid' || entry.id !== keyId) {
              applyGlyphHover(null, null);
              return;
            }
            ps.markDirty();
            return ps.pickAsync('glyph', c, scene).then((gh) => {
              const renderer = entry.grid.getRenderer?.();
              if (s.in && gh && gh.token === renderer) applyGlyphHover(renderer, gh.slotIndex);
              else applyGlyphHover(null, null);
            }, () => applyGlyphHover(null, null));
          });
        }).then(() => {
          s.pickPending = false;
        }).catch((err) => {
          s.pickPending = false;
          if (!s.gpuWarned) {
            s.gpuWarned = true;
            console.warn('[CanvasPicker] grid pick failed', err);
          }
          applyHover(null);
          applyHandleHover(null);
          applyGlyphHover(null, null);
        });
      }
      return;
    }

    // No picking system yet, or cursor outside the canvas → clear hover + grip flag.
    applyHover(null);
    applyHandleHover(null);
    applyGlyphHover(null, null);
  });

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
    let drag = null; // { grid, id, type, lastX, lastY }

    const onDown = (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return; // Ctrl/Cmd + LMB only
      // Grab whatever's highlighted — the grid-channel hover result, in the
      // attention bus. Consistent with the outline the user sees.
      const hid = ctx.attentionManager?.get('hover')?.id;
      const entry = hid ? ctx.registry.get(hid) : null;
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
      // capture the new layout. The per-surface move verb is one record per type
      // (surfaceInteractions), not a type branch here.
      router.execute(`${moveVerbFor(type)} ${id} ${round(p.x)} ${round(p.y)} ${round(p.z)}`);
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
 * Terminal resize — a plain left-drag on a terminal's SE-corner grip RESIZES it.
 * The grip is a pick target in the 'handle' channel; CanvasPicker's hover loop
 * sets ctx.handleHover (+ the sampled pixel) while the cursor is over it and shows
 * the nwse-resize cursor. The press DECISION (resize vs. pan) goes through the
 * shared, freshness-gated ctx.isGripPress() that BOTH this and ViewerCameraController
 * consult — so a grip press resizes (and the camera yields its pan) while a stale,
 * async-lagged token never starts a resize on a grip the cursor has left.
 *
 * The drag is LIVE — each time the cursor crosses an integer cell step we fire
 * terminal.resize, so the panel re-grids under the cursor (the grip tracks your
 * hand) and the PTY reflows as you go, exactly as a real terminal window does.
 * Every step is the same bus verb the CLI uses, so each one lands as a logged
 * command record — drag and watch them stream via log.search / buslog. A clean
 * release just saves the session; an interrupt (pointercancel / lostpointercapture)
 * reverts to the size the drag started at. The verb moves grid + emulator + the
 * adapter's PTY (pty.Setsize → SIGWINCH) in lockstep, and a docked tile's
 * onResize tap lets CameraDock re-pack around the new size.
 *
 * The grip renders depthTest-off (an always-on-top overlay), so "the grip you see
 * is the grip you grab" even when it sits over another terminal's panel.
 */
// Scratch vectors for the resize-drag math — reused per pointermove (no allocation).
const _rzFwd = new THREE.Vector3();
const _rzRight = new THREE.Vector3();
const _rzUp = new THREE.Vector3();
const _rzCenter = new THREE.Vector3();
const _rzDrag = new THREE.Vector3();
const _rzGridRight = new THREE.Vector3();
const _rzGridDown = new THREE.Vector3();
const _rzGridDiag = new THREE.Vector3();

export function ResizeDragger() {
  const { gl, camera } = useThree();
  const client = useAppCommands();

  useEffect(() => {
    if (!client) return;
    const { ctx, router } = client;
    const dom = gl.domElement;

    let drag = null; // { grid, id, startCols, startRows, startBounds, startStride, startX, startY, appliedCols, appliedRows }

    // Single teardown for EVERY way a drag can end. A clean pointerup KEEPS the live
    // size and saves; pointercancel / lostpointercapture REVERT to the start size (the
    // live steps already re-gridded, so an interrupt must undo them). Either way the
    // shared flags reset, so an interrupted drag can never wedge the canvas (a stuck
    // ctx.resizing kills hover picking + click-select until reload).
    const endDrag = (e, commit) => {
      if (!drag) return; // lostpointercapture also echoes after a normal up — ignore it
      const { id, mode, startCols, startRows, appliedCols, appliedRows, startZoom, appliedZoom } = drag;
      drag = null;
      dom.style.cursor = 'default';
      ctx.handleHover = null;   // drop the cached grip; next press must re-establish via a fresh pick
      ctx.handleHoverAt = null;
      if (e?.pointerId != null) dom.releasePointerCapture?.(e.pointerId);
      // Hold ctx.resizing across THIS event dispatch so CanvasPicker's onUp (same
      // tick, listener-order-independent) skips its click-select; clear once drained.
      queueMicrotask(() => { ctx.resizing = false; });
      if (mode === 'scale') {
        // SCALE grip: the live steps already applied window.scale (which saves). A
        // clean release just keeps it; an interrupt reverts to the start zoom.
        if (Math.abs(appliedZoom - startZoom) <= 1e-4) return;
        if (commit) client.session?.scheduleSave?.();
        else router.execute(`window.scale ${id} ${startZoom}`); // undo the live zoom
        return;
      }
      const changed = appliedCols !== startCols || appliedRows !== startRows;
      if (!changed) return;
      if (commit) client.session?.scheduleSave?.();      // keep the live size, persist it
      else router.execute(`terminal.resize ${id} ${startCols} ${startRows}`); // undo the live steps
    };

    // CLICK chrome controls (pin + the size/scale ± dials) share the 'handle' channel with
    // the drag grips; a press FIRES a verb instead of starting a drag. Steps read from
    // ctx.windowConfig (Settings ▸ Window). The dials compose the same window.scale /
    // terminal.resize verbs the CLI uses, so each step lands as a logged command record.
    const fireChromeAction = (role, id, grid) => {
      const wc = ctx.windowConfig || {};
      if (role === 'pin') { router.execute(['window.pin', id]); return; } // verb lights the Pin button
      if (role === 'scale-inc' || role === 'scale-dec') {
        const step = wc.scaleStep || 1.1;
        const z = (grid.zoom ?? 1) * (role === 'scale-inc' ? step : 1 / step);
        router.execute(`window.scale ${id} ${z}`);
        return;
      }
      // size dial: step cols by sizeStep, rows in proportion so the panel keeps its aspect.
      const dir = role === 'size-inc' ? 1 : -1;
      const step = Math.max(1, Math.round(wc.sizeStep || 4));
      const cols = grid.cols ?? 0, rows = grid.rows ?? 0;
      const dRows = Math.max(1, Math.round(step * (rows / Math.max(cols, 1))));
      router.execute(`terminal.resize ${id} ${cols + dir * step} ${rows + dir * dRows}`);
    };

    const onDown = (e) => {
      // Plain LMB on a grip. Ctrl/Cmd is the MOVE gesture (ObjectDragger owns it),
      // so a modifier here is not a resize — bail and let that path run. The press
      // authority is isGripPress() (freshness-gated), NOT the raw async hover flag.
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      if (!ctx.isGripPress?.(e.clientX, e.clientY)) return;
      const token = ctx.handleHover;       // { grid, edge, role }; isGripPress ⇒ non-null
      const grid = token?.grid;
      if (!grid) return;
      const id = ctx.registry.getIdByGrid(grid);
      if (!id) return;
      // Chrome splits by role: the click buttons (pin + dials) fire a verb on press and
      // return — NO drag. ctx.resizing (drained the microtask after this press's trailing
      // pointerup) suppresses the click-select so the press acts on the button, not the
      // panel behind it. The two drag grips fall through to the ResizeDragger setup below.
      if (token.role !== 'resize' && token.role !== 'scale') {
        // The button can carry its own handler (token.onClick); else the role→verb map runs.
        if (token.button?.onClick) token.button.onClick(id, grid);
        else fireChromeAction(token.role, id, grid);
        // Suppress the trailing click-select so the press acts on the button, not the panel
        // behind it (drained the microtask after this press's pointerup). handleHover is left
        // intact — the hover loop clears the button's visual when the cursor leaves it.
        ctx.resizing = true;
        const drain = () => { queueMicrotask(() => { ctx.resizing = false; }); window.removeEventListener('pointerup', drain, true); };
        window.addEventListener('pointerup', drain, true);
        e.preventDefault();
        return;
      }
      // The two drag grips: 'scale' (red) zooms the Object3D, 'resize' (green) reshapes
      // cols/rows. Press authority is identical; only the drag math differs.
      const mode = token.role === 'scale' ? 'scale' : 'resize';
      const startBounds = grid.getBounds().clone();
      drag = {
        grid, id, mode,
        startCols: grid.cols, startRows: grid.rows,
        startBounds,
        // Captured at the START so the screen→{cells|zoom} mapping stays anchored to the
        // drag origin even as live re-grids / rescales change things:
        //  - startStride: the panel's LIVE world cell size (cellStride now reads world
        //    scale, so a docked/shrunk tile maps 1:1, not at its un-docked size).
        //  - startQuat: the panel's world orientation, to project the drag onto its OWN
        //    right/down axes (a docked tile faces the camera at an arbitrary world angle).
        startStride: { x: grid.cellStride.x, y: grid.cellStride.y },
        startQuat: grid.getWorldQuaternion(new THREE.Quaternion()),
        startX: e.clientX, startY: e.clientY,
        appliedCols: grid.cols, appliedRows: grid.rows,
        // scale mode: zoom is proportional to how far the corner is pulled along the
        // panel diagonal relative to its start half-diagonal (pull the corner out by its
        // own reach → 2×). startReach is that half-diagonal in world units.
        startZoom: grid.zoom ?? 1,
        appliedZoom: grid.zoom ?? 1,
        startReach: Math.max(1e-3, 0.5 * Math.hypot(
          startBounds.max.x - startBounds.min.x, startBounds.max.y - startBounds.min.y)),
      };
      ctx.resizing = true; // CanvasPicker pauses hover + skips click-select while set
      dom.style.cursor = mode === 'scale' ? 'nesw-resize' : 'nwse-resize';
      dom.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // Screen delta → a world-space drag vector at the panel's depth (camera right/up
      // basis), THEN projected onto the panel's OWN right/down axes — so cols grow along
      // the panel and rows down it, for ANY orientation: a head-on world grid, a docked
      // tile facing the camera at an arbitrary world angle, or a tile tilted on the dome.
      // (Dividing the drag's world X/Y components by the stride was the bug — that only
      // matched an unrotated, head-on panel.) Depth is probed at the panel CENTER
      // (startBounds) so a pixel of travel maps to the right cell count for large/close
      // panels; startStride is the panel's LIVE world cell size (docked tiles included).
      const q = camera.quaternion;
      const fwd   = _rzFwd.set(0, 0, -1).applyQuaternion(q);
      const right = _rzRight.set(1, 0, 0).applyQuaternion(q);
      const up    = _rzUp.set(0, 1, 0).applyQuaternion(q);
      const center = drag.startBounds.getCenter(_rzCenter);
      const depth = Math.max(1, center.sub(camera.position).dot(fwd));
      const pixelScale = (2 * depth * Math.tan((camera.fov * Math.PI / 180) / 2)) / dom.clientHeight;
      const dragVec = _rzDrag.copy(right).multiplyScalar(dx * pixelScale).addScaledVector(up, -dy * pixelScale);
      const gridRight = _rzGridRight.set(1, 0, 0).applyQuaternion(drag.startQuat);   // panel +X (cols east)
      const gridDown  = _rzGridDown.set(0, -1, 0).applyQuaternion(drag.startQuat);   // panel −Y (rows south)

      if (drag.mode === 'scale') {
        // SCALE: project the drag onto the panel's SE diagonal; the signed distance past
        // the start reach scales the zoom proportionally. Uniform (glyph aspect kept) —
        // the deliberate stretch is the verb's tuple form, never the mouse. window.scale
        // applies it live (and re-places the docked tile via the dock).
        const diag = _rzGridDiag.copy(gridRight).add(gridDown).normalize();
        const factor = Math.max(0.1, (drag.startReach + dragVec.dot(diag)) / drag.startReach);
        const zoom = Math.min(20, Math.max(0.1, drag.startZoom * factor));
        if (Math.abs(zoom - drag.appliedZoom) < 0.01) return; // sub-step → nothing to do
        drag.appliedZoom = zoom;
        router.execute(`window.scale ${drag.id} ${zoom.toFixed(3)}`);
        return;
      }

      const stride = drag.startStride;
      const newCols = Math.max(MIN_COLS, drag.startCols + Math.round(dragVec.dot(gridRight) / stride.x));
      const newRows = Math.max(MIN_ROWS, drag.startRows + Math.round(dragVec.dot(gridDown) / stride.y));
      if (newCols === drag.appliedCols && newRows === drag.appliedRows) return; // same cell step → nothing to do
      drag.appliedCols = newCols; drag.appliedRows = newRows;

      // LIVE re-grid: the panel itself is the preview. One bus verb per integer step —
      // grid + emulator + PTY in lockstep, logged, and a docked tile re-packs via its
      // onResize tap. Session save is deferred to release (endDrag), not per step.
      router.execute(`terminal.resize ${drag.id} ${newCols} ${newRows}`);
    };

    const onUp     = (e) => endDrag(e, true);  // clean release → keep the live size + save
    const onCancel = (e) => endDrag(e, false); // gesture interrupted → revert to the start size

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onCancel);
    dom.addEventListener('lostpointercapture', onCancel);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('lostpointercapture', onCancel);
      if (drag) ctx.resizing = false; // unmounted mid-drag → never leave the shared flag stuck
    };
  }, [client, gl, camera]);

  return null;
}

/**
 * Selection feedback — wireframe boxes around the primary (selected) and hover
 * grids. WHICH grid each box tracks comes from attentionManager change events
 * (not a per-frame scan of all grids); the box GEOMETRY is re-synced each frame
 * from that one grid's bounds, so the outline follows when a relayout moves it.
 * Reads the same state whether selection came from a canvas click or a command.
 */
// Reused per frame to compose each outline's matrix (grid.matrixWorld × local offset).
const _off = new THREE.Matrix4();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _identQ = new THREE.Quaternion();
const _targetColor = new THREE.Color();
const _hoverColor = new THREE.Color(HOVER_COLOR);

export function SelectionIndicator() {
  const { scene } = useThree();
  const client = useAppCommands();
  const tracked = useRef({ primaryBox: null, hoverBox: null, am: null, registry: null });

  useEffect(() => {
    if (!client) return;
    // An ORIENTED unit-box outline (not a Box3Helper): its matrix is driven from the
    // grid's matrixWorld each frame, so it rides the grid's rotation/scale instead of
    // morphing like a world-space AABB does when the grid is docked under the camera.
    const mkBox = (color, renderOrder) => {
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)); // unit cube, centered
      // depthTest ON so the grid's own (depth-writing) background panel occludes the
      // box's REAR edges — the back of the cuboid is logically behind the tile body,
      // and should read that way instead of ghosting over the panel. depthWrite OFF:
      // the outline tests against the scene's depth but never writes its own, so it
      // can't occlude glyphs or other tiles. Front edges sit in front of the panel
      // and still draw over the content.
      //
      // transparent ON is the load-bearing bit for TRANSLUCENT panels: a panel at
      // opacity<1 draws in the transparent pass (which runs AFTER the opaque pass),
      // so if the box were opaque it would draw BEFORE the panel wrote its depth and
      // lose the occlusion. As a transparent object the box sorts by renderOrder, and
      // 9999/10000 ≫ the panel's -1, so the panel's depth is always laid down first —
      // occlusion holds whether the panel is opaque or see-through.
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: true, depthWrite: false, transparent: true });
      const b = new THREE.LineSegments(geo, mat);
      b.visible = false;
      b.renderOrder = renderOrder;     // draw the outline over the glyphs
      b.matrixAutoUpdate = false;      // we set b.matrix directly from the grid transform
      b.frustumCulled = false;         // its real extent lives in the composed matrix, not the unit geo
      scene.add(b);
      return b;
    };
    // A translucent solid box (not edges) — the directory region glow. Same
    // matrix-driven, frustum-free setup as the edge boxes; renderOrder just under
    // the green edge so the outline still crowns it. depthWrite off so it never
    // occludes glyphs; transparent so it sorts into the post-opaque pass.
    const mkFill = (color, renderOrder) => {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), depthTest: true, depthWrite: false, transparent: true, opacity: 0, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = renderOrder;
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    const t = tracked.current;
    t.am = client.ctx.attentionManager;
    t.registry = client.ctx.registry;
    // One box per role: a green/amber box for the SELECTED grid, a light-blue box
    // for HOVER on a DIFFERENT grid. Hovering the focused grid recolors the focus
    // box (fades toward blue) rather than drawing the hover box on top — no stack.
    t.primaryBox = mkBox(FOCUS_COLOR, 9999);  // green — focused; recolored amber when input-active, blue-tinted on hover
    t.hoverBox = mkBox(HOVER_COLOR, 10000);   // light blue — hover (follows the cursor)
    t.primaryFill = mkFill(FOCUS_COLOR, 9998); // directory-only region glow, under the edge box

    return () => {
      scene.remove(t.primaryBox); scene.remove(t.hoverBox); scene.remove(t.primaryFill);
      t.primaryBox.geometry?.dispose?.(); t.hoverBox.geometry?.dispose?.(); t.primaryFill.geometry?.dispose?.();
      t.primaryBox.material?.dispose?.(); t.hoverBox.material?.dispose?.(); t.primaryFill.material?.dispose?.();
      t.primaryBox = t.hoverBox = t.primaryFill = t.am = t.registry = null;
    };
  }, [client, scene]);

  // Resolve the tracked grids LIVE each frame straight from attention + registry
  // — no cached grid objects, no dependence on change events. This self-heals two
  // ways: a grid id re-pointed to a NEW object (virtualizer reload / session
  // restore) is picked up immediately, and a same-id re-selection that fires no
  // change event still tracks correctly. (2 boxes/frame: a Map get + an 8-corner
  // getBounds transform each — negligible.)
  useFrame((state) => {
    const t = tracked.current;
    if (!t.am || !t.registry) return;
    const gridFor = (slot) => {
      const id = t.am.get(slot)?.id;
      return id ? (t.registry.get(id)?.grid ?? null) : null;
    };
    const fit = (box, node, inflate) => {
      if (!box) return;
      // Two bounds sources, one unit cube. File grids expose LOCAL bounds → compose
      // with grid.matrixWorld for an ORIENTED box glued to the grid whatever its
      // parent (scene, a ContentTree node, the camera dock). Directory nodes expose
      // only a world-space getBounds() footprint (axis-aligned in the tree plane) →
      // drive the box matrix straight from that AABB, no parent transform.
      const lb = node?.getLocalBounds?.();
      const sizeForOutline = () => {
        // unit cube → padded box: scale to size (+ inflate), keep a sliver of z so a
        // flat panel/footprint still composes a valid (non-degenerate) matrix.
        _size.set(_size.x + inflate * 2, _size.y + inflate * 2, Math.max(_size.z, 1e-3) + inflate * 2);
        _off.compose(_center, _identQ, _size);
      };
      if (lb) {
        if (lb.isEmpty()) { box.visible = false; return; }
        node.updateWorldMatrix(true, false);
        lb.getCenter(_center);
        lb.getSize(_size);
        sizeForOutline();
        box.matrix.multiplyMatrices(node.matrixWorld, _off);
      } else {
        const wb = node?.getBounds?.();
        if (!wb || wb.isEmpty()) { box.visible = false; return; }
        wb.getCenter(_center);
        wb.getSize(_size);
        sizeForOutline();
        box.matrix.copy(_off); // world-space AABB — the composed offset IS the world matrix
      }
      box.matrixWorldNeedsUpdate = true;
      box.visible = true;
    };
    // The focus box recolors to signal WHERE KEYSTROKES LAND: amber when the focused window is
    // input-active (a code grid in edit mode, or the keyboard-target terminal — attention.key),
    // green when focused-but-inert. So "type here" reads the same in the HUD and in 3D.
    const primaryId = t.am.get('primary')?.id ?? null;
    const keyId = t.am.get('key')?.id ?? null;
    const primaryEntry = primaryId ? t.registry.get(primaryId) : null;
    const primaryGrid = primaryEntry?.grid ?? null;
    const primaryIsDir = primaryEntry?.type === 'dir';
    const hoverGrid = gridFor('hover');
    const editing = typeof primaryGrid?.getCursor === 'function' && primaryGrid.getCursor() != null;
    const inputActive = !!primaryGrid && (editing || (!!keyId && keyId === primaryId));
    // Hover on the already-focused grid → no second box; the focus box itself fades
    // partway toward the hover blue. Otherwise the focus box holds its state color.
    const hoverOnFocus = !!hoverGrid && hoverGrid === primaryGrid;
    _targetColor.set(inputActive ? INPUT_COLOR : FOCUS_COLOR);
    if (hoverOnFocus) _targetColor.lerp(_hoverColor, HOVER_FOCUS_BLEND);
    // Smooth fade toward the target (state change OR hover on/off) — no instant snap.
    if (t.primaryBox.material) t.primaryBox.material.color.lerp(_targetColor, OUTLINE_FADE);

    // Selection box: exact panel bounds, steady. Hover box: only on a DIFFERENT grid
    // than the focused one (the merge case is handled by the recolor above), hugging
    // the panel edge so it's a tight halo, not a fat floating frame.
    fit(t.primaryBox, primaryGrid, 0);
    if (hoverOnFocus) t.hoverBox.visible = false;
    else fit(t.hoverBox, hoverGrid, HOVER_INFLATE);

    // Directory region glow: when the focused entity is a directory, fill its
    // footprint with a faint, slowly breathing tint inside the edge box (tracks the
    // same state color). Files leave it hidden — they're panels, not regions. The
    // breath rides r3f's clock (not wall time), so it pauses with the render loop.
    if (t.primaryFill) {
      if (primaryIsDir && primaryGrid) {
        fit(t.primaryFill, primaryGrid, FILL_INFLATE);
        t.primaryFill.material.color.copy(_targetColor);
        const breath = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * FILL_BREATH_HZ * Math.PI * 2);
        t.primaryFill.material.opacity = FILL_OPACITY_MIN + (FILL_OPACITY_MAX - FILL_OPACITY_MIN) * breath;
      } else {
        t.primaryFill.visible = false;
      }
    }
  });

  return null;
}
