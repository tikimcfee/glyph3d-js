import React, { useEffect, useState } from 'react';

// StatusBar — the slim "what's happening" pill (bottom-left, clear of the HUD at
// bottom-right). One-way reflection, owns no behavior:
//   • Activity: polls the active fileProvider's getProgress() — which narrates the
//     whole load (loadRepository's "Loading file tree…" → getMultipleFiles' per-file
//     "N/total"). A session restore drives the same repo.load/openDir, so a reload
//     narrates itself here for free — the reason this exists.
//   • Connection: a relay dot (client-only vs relay-connected).
//   • Idle: the boot/controls hint passed from main.
// Informational only (pointer-events:none) so it never steals a canvas click.

// A progress `current` is either a coarse phase message ("Loading file tree…") or a
// file path mid-fetch; show the phase verbatim, trim a path to its tail.
function shortCurrent(s) {
  s = String(s || '');
  if (s.includes('/') && !s.includes(' ')) {
    const parts = s.split('/');
    return '…/' + parts.slice(-1)[0];
  }
  return s.length > 44 ? s.slice(0, 43) + '…' : s;
}

export default function StatusBar({ client, hint }) {
  const [prog, setProg] = useState(null);          // { current, loaded, total } while a fetch runs (GitHub)
  const [activity, setActivity] = useState(null);  // ctx.status message — the general live signal
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!client) return undefined;
    const tick = () => {
      // Read the provider fresh — repo.load can swap it. current != null ⇒ active.
      const p = client.ctx?.fileProvider?.getProgress?.();
      setProg(p && p.current != null ? { current: p.current, loaded: p.loaded, total: p.total } : null);
    };
    const iv = setInterval(tick, 120);
    tick();
    const status = client.ctx?.status;
    setActivity(status?.get?.() ?? null);
    const offStatus = status?.subscribe?.(setActivity);
    const offConn = client.bridge?.onConnectionChange?.(setConnected);
    return () => { clearInterval(iv); offStatus?.(); offConn?.(); };
  }, [client]);

  // Priority: a live fetch with counts (most specific) → the activity message →
  // the idle hint. The progress bar only rides the counted fetch.
  const hasCount = !!prog && prog.total > 0;
  const pct = hasCount ? Math.min(100, Math.round((prog.loaded / prog.total) * 100)) : 0;
  const label = prog
    ? `${shortCurrent(prog.current)}${hasCount ? `  ${prog.loaded}/${prog.total}` : ''}`
    : (activity || hint);

  if (!label) return null;

  return (
    <div style={S.bar}>
      <span style={S.dot(connected)} title={connected ? 'relay connected' : 'client-only'}>●</span>
      <span style={S.msg}>{label}</span>
      {hasCount && <span style={S.track}><span style={{ ...S.fill, width: `${pct}%` }} /></span>}
    </div>
  );
}

const S = {
  bar: {
    position: 'fixed', left: 12, bottom: 12, zIndex: 20,
    display: 'flex', alignItems: 'center', gap: 8,
    font: '11px/1.4 ui-monospace, Menlo, monospace', color: '#9fb1c2',
    background: 'rgba(10,12,16,0.82)', border: '1px solid #283341', borderRadius: 7,
    padding: '5px 10px', maxWidth: '46vw',
    backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
    pointerEvents: 'none', userSelect: 'none',
  },
  dot: (ok) => ({ color: ok ? '#7ad7a0' : '#5b6675', fontSize: 9, flex: '0 0 auto' }),
  msg: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  track: { flex: '0 0 70px', height: 3, background: '#1c2530', borderRadius: 2, overflow: 'hidden' },
  fill: { display: 'block', height: '100%', background: '#6cf', transition: 'width 0.12s linear' },
};
