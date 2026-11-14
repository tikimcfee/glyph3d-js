import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, useGridRegistry } from '@glyph3d/r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import italicUrl from '@glyph3d/core/fonts/Cousine-Italic.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';
import TerminalWall from './TerminalWall.js';
import Palette from './Palette.jsx';
import Sidebar from './Sidebar.jsx';
import StatusWindow, { TermdChip, TermdNotice } from './StatusWindow.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import ContextMenu from './ContextMenu.jsx';
import { dockLayout } from './Panel.jsx';
import { isChord, chordLabel, ALT_LABEL, SNAP_INVERT_LABEL } from './chord.js';

const FONT_CHAIN = [
  { url: fontUrl, name: 'Cousine', italic: { url: italicUrl } },
  { url: mesloUrl, name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

// ?relay=PORT — where the Go relay is (it forks the terminals). Defaults to the dev relay's 8080,
// which the IDE dials too — and a relay takes ONE display, so the second to connect is refused
// (the chip says so). Run the wall beside the IDE on its own relay (serve --port N --termd-ns …).
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
    const client = { ctx: wall.ctx, router: wall.router };
    window.__glyphClient = client;
    onReady(wall);
    return () => {
      wall.stop();
      if (window.__wall === wall) delete window.__wall;
      if (window.__glyphClient === client) delete window.__glyphClient;
    };
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

  // The chord + K opens the palette (the wall's other chords live in WallKeys; chord.js decides the
  // modifier: ⌘ on macOS, Ctrl+Alt elsewhere).
  useEffect(() => {
    const onKey = (e) => {
      if (isChord(e) && e.code === 'KeyK') { e.preventDefault(); e.stopPropagation(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!wall || !state) return null;
  const relay = state.relay;
  const inset = dockLayout(state).inset;
  const hidden = state.terminals.filter((t) => t.hidden).length;
  return (
    <>
      <div style={{ ...styles.topbar, right: inset.right }}>
        <button style={styles.button} onClick={() => wall.spawn()} title={`New terminal (${chordLabel(['↵'], { shift: true })})`}>+ terminal</button>
        <button style={styles.button} onClick={() => wall.fitAll()} title={`Fit all (${chordLabel(['0'])})`}>fit all</button>
        <button style={styles.button} onClick={() => setPaletteOpen(true)} title={`Find by name (${chordLabel(['K'])})`}>find {chordLabel(['K'])}</button>
        <button style={styles.button} data-action="sidebar" onClick={() => wall.run(['wall.sidebar', 'toggle'])} title={`Every terminal and group (${chordLabel(['B'])})`}>list {chordLabel(['B'])}</button>
        <button style={styles.button} data-action="settings" onClick={() => wall.run(['wall.settings', 'toggle'])} title={`Every knob, searchable (${chordLabel([','])})`}>settings</button>
        <span data-relay={relay.state} title={relay.state === 'refused' ? `the relay on :${RELAY_PORT} takes one display; it reconnects when the other one leaves` : ''}
          style={{ ...styles.chip, color: relay.state === 'up' ? '#6ee7a0' : '#e5534b' }}>
          {relay.state === 'up' ? '● relay' : relay.state === 'refused' ? `○ relay :${RELAY_PORT} — ${relay.reason}` : '○ relay offline'}
        </span>
        <TermdChip wall={wall} />
      </div>
      <TermdNotice wall={wall} />
      <div style={{ ...styles.hint, left: inset.left, right: inset.right }}>
        {state.focusedId ? `typing → ${wall.nameOf(state.focusedId)}` : 'click a terminal to type'}
        {' · '}{chordLabel(['[', ']'])} cycle · {chordLabel(['↵'])} frame/overview · {chordLabel(['K'])} find · {chordLabel(['-'])} hide · hold {chordLabel(['X'])} close · ⇧-drag lasso · {chordLabel(['G'])} group · {chordLabel(['S'])} termd · drag border to resize · drag a title bar (or {ALT_LABEL}-drag) to move · moves snap to the grid ({chordLabel(["'"])} snap, hold {SNAP_INVERT_LABEL} mid-drag: free) · wheel to zoom (over the focused terminal: its scrollback) · drag empty canvas to pan · right-click for a menu
        {' · '}{state.terminals.length} terminal{state.terminals.length === 1 ? '' : 's'}{hidden ? ` (${hidden} hidden)` : ''}
      </div>
      <Sidebar wall={wall} state={state} />
      <StatusWindow wall={wall} state={state} />
      <SettingsPanel wall={wall} state={state} />
      {paletteOpen && <Palette wall={wall} state={state} onClose={() => setPaletteOpen(false)} />}
      <ContextMenu wall={wall} state={state} />
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
    lineHeight: 1.5, zIndex: 5,   // wraps rather than cutting the line short
  },
};

const container = document.getElementById('root');
const root = (container.__wallRoot ??= createRoot(container));
root.render(<App />);
