import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, useGridRegistry } from '@glyph3d/r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';
import TerminalWall from './TerminalWall.js';
import Palette from './Palette.jsx';

const FONT_CHAIN = [
  { url: fontUrl, name: 'Cousine' },
  { url: mesloUrl, name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

// ?relay=PORT — where the Go relay is (it forks the terminals). Defaults to the dev relay's 8080.
const RELAY_PORT = Number(new URLSearchParams(location.search).get('relay')) || 8080;

/** In-canvas bridge: builds the TerminalWall once and hands it up to the DOM chrome. */
function Wall({ atlas, onReady }) {
  const { scene, camera, gl } = useThree();
  const { registry } = useGridRegistry();
  const ref = useRef(null);
  if (!ref.current) ref.current = new TerminalWall({ scene, camera, gl, atlas, registry, relayPort: RELAY_PORT });
  useEffect(() => {
    const wall = ref.current;
    wall.start();
    window.__wall = wall;   // devtools / test handle
    // The repo's harness handle (tools/itest/driver.mjs, tools/frame-profile.mjs read
    // __glyphClient.{ctx.renderer, ctx.camera, ctx.scene, router}) — same shape as the IDE's.
    window.__glyphClient = { ctx: wall.ctx, router: wall.router };
    onReady(wall);
    return () => wall.stop();
  }, []);
  useFrame((state, dt) => ref.current.tick(dt, state.size));
  return null;
}

/** Re-render on any wall change; returns the wall's current snapshot. */
function useWallState(wall) {
  const cache = useRef(null);
  return useSyncExternalStore(
    (cb) => (wall ? wall.onChange(() => { cache.current = null; cb(); }) : () => {}),
    () => {
      if (!wall) return null;
      if (!cache.current) cache.current = wall.snapshot();
      return cache.current;
    },
  );
}

function Chrome({ wall }) {
  const state = useWallState(wall);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd+K opens the palette (the wall's own chords live in TerminalWall._onKeyDown).
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey && e.code === 'KeyK') { e.preventDefault(); e.stopPropagation(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!wall || !state) return null;
  return (
    <>
      <div style={styles.topbar}>
        <button style={styles.button} onClick={() => wall.spawn()} title="New terminal (⌘⇧↵)">+ terminal</button>
        <button style={styles.button} onClick={() => wall.fitAll()} title="Fit all (⌘0)">fit all</button>
        <button style={styles.button} onClick={() => setPaletteOpen(true)} title="Find by name (⌘K)">find ⌘K</button>
        <span style={{ ...styles.chip, color: state.connected ? '#6ee7a0' : '#e5534b' }}>
          {state.connected ? '● relay' : '○ relay offline'}
        </span>
      </div>
      <div style={styles.hint}>
        {state.focusedId ? `typing → ${state.focusedId}` : 'click a terminal to type'}
        {' · '}⌘[ ⌘] cycle · ⌘↵ frame/overview · ⌘K find · drag border to resize · drag to move · pinch zoom · two-finger pan (over the focused terminal: its scrollback)
        {' · '}{state.terminals.length} terminal{state.terminals.length === 1 ? '' : 's'}
      </div>
      {paletteOpen && <Palette wall={wall} state={state} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

function App() {
  const { atlas, stage, error } = useGlyphEngine({ fontUrl, fonts: FONT_CHAIN });
  const [wall, setWall] = useState(null);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {error && <div style={styles.boot}>boot failed: {error.message}</div>}
      {!atlas && !error && <div style={styles.boot}>engine: {stage}</div>}
      {atlas && !error && (
        <GlyphCanvas
          atlas={atlas}
          orthographic
          camera={{ position: [0, 0, 500], zoom: 4, near: 0.1, far: 2000 }}
          onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(0x07080b), 1); }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <Wall atlas={atlas} onReady={setWall} />
        </GlyphCanvas>
      )}
      <Chrome wall={wall} />
    </div>
  );
}

const styles = {
  boot: { position: 'absolute', top: 12, left: 12, color: '#7c8596' },
  topbar: { position: 'absolute', top: 10, right: 12, display: 'flex', gap: 6, alignItems: 'center', zIndex: 5 },
  button: {
    background: '#141821', color: '#c8ced8', border: '1px solid #2a303c', borderRadius: 5,
    padding: '4px 9px', font: 'inherit', cursor: 'pointer',
  },
  chip: { padding: '4px 6px' },
  hint: {
    position: 'absolute', bottom: 8, left: 12, right: 12, color: '#6b7383', pointerEvents: 'none',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', zIndex: 5,
  },
};

const container = document.getElementById('root');
const root = (container.__wallRoot ??= createRoot(container));
root.render(<App />);
