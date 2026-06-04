import React, { useState, useEffect, useCallback } from 'react';

// RepoPanel — repo selection. Enter owner/repo[/branch] (or a GitHub URL) and Load
// to render it as the 3D field, client-only (no relay needed). The dock sibling that
// gives the IDE an in-app front door for picking a repo, instead of only the ?repo=
// URL param. Every action is a command-bus verb (repo.load / repo.clear / file.openDir),
// identical to a CLI invocation — UI and bus stay in lockstep.

const styles = {
  content: {
    width: '100%', height: '100%', background: 'rgba(8,10,14,0.92)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  header: {
    padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
    letterSpacing: '0.04em', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8,
  },
  title: { flex: '1 1 auto' },
  src: { flex: '0 0 auto', fontSize: 11, color: '#5c6675' },
  body: { padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' },
  inputRow: { display: 'flex', gap: 6 },
  input: {
    flex: '1 1 auto', minWidth: 0, font: 'inherit', color: '#c8ccd6', background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, padding: '4px 7px', outline: 'none',
  },
  load: {
    flex: '0 0 auto', font: 'inherit', color: '#08101a', background: '#6cf',
    border: '1px solid #6cf', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontWeight: 600,
  },
  hint: { fontSize: 11, color: '#5c6675' },
  err: { color: '#e0888f', whiteSpace: 'pre-wrap', fontSize: 11 },
  current: {
    display: 'flex', alignItems: 'center', gap: 6, background: '#101820',
    border: '1px solid #1f2730', borderRadius: 4, padding: '4px 8px',
  },
  curName: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#7ad7a0' },
  clear: { flex: '0 0 auto', color: '#7c8596', cursor: 'pointer', padding: '0 4px' },
  localRow: { color: '#9aa3b2', cursor: 'pointer', fontSize: 11, padding: '2px 0' },
};

// The active GitHub repo, read straight from the provider (set by loadRepository) so
// a ?repo bootstrap or a CLI repo.load reflects here too. Local (relay) mode has no repo.
function currentRepoLabel(client) {
  const r = client?.ctx?.fileProvider?._currentRepo;
  if (!r?.owner) return null;
  // Only "current" while the field actually holds it: repo.clear empties the
  // registry, so the label clears with it (matches the × button's intent and
  // beats the registry-change listener that would otherwise repaint it).
  if (!client?.ctx?.registry?.findByType?.('grid')?.length) return null;
  return `${r.owner}/${r.repo}${r.branch ? '@' + r.branch : ''}`;
}

export default function RepoPanel({ client }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(() => currentRepoLabel(client));
  const [connected, setConnected] = useState(false);

  // Relay status drives the source line (github client-only vs +local).
  useEffect(() => {
    const bridge = client?.bridge;
    if (!bridge?.onConnectionChange) return undefined;
    return bridge.onConnectionChange(setConnected);
  }, [client]);

  // Reflect a repo loaded out-of-band (?repo bootstrap or a CLI repo.load): the
  // field (re)load mutates the registry.
  useEffect(() => {
    const reg = client?.ctx?.registry;
    if (!reg?.addChangeListener) return undefined;
    const refresh = () => setCurrent(currentRepoLabel(client));
    refresh();
    reg.addChangeListener(refresh);
    return () => reg.removeChangeListener(refresh);
  }, [client]);

  const load = useCallback(async () => {
    const ref = input.trim();
    if (!ref || !client || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await client.router.execute(['repo.load', ref]);
      if (r?.text?.startsWith('ERR')) setError(r.text.replace(/^ERR:\s*/, ''));
      else { setCurrent(r?.data?.repo || ref); setInput(''); }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [input, client, busy]);

  const clear = useCallback(() => {
    client?.router.execute('repo.clear');
    setCurrent(null);
  }, [client]);

  // When the relay is serving a project, render it (the active local provider) as the field.
  const browseLocal = useCallback(() => {
    if (!client) return;
    client.router.execute(['file.openDir', '']);
    client.router.execute('camera.fitall');
  }, [client]);

  // Keep keystrokes in the input (don't drive WASD / the focused grid) + Enter = Load.
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') load(); };

  return (
    <div style={styles.content}>
      <div style={styles.header}>
        <span style={styles.title}>repo</span>
        <span style={styles.src} title={connected ? 'relay connected — local + GitHub' : 'client-only — GitHub, no backend'}>
          {connected ? '◉ local + github' : '○ github'}
        </span>
      </div>
      <div style={styles.body}>
        <div style={styles.inputRow}>
          <input
            style={styles.input}
            placeholder="owner/repo[/branch]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
            spellCheck={false}
          />
          <button type="button" style={styles.load} onClick={load} disabled={busy || !input.trim()}>
            {busy ? '…' : 'Load'}
          </button>
        </div>
        {busy && <div style={styles.hint}>loading repo…</div>}
        {error && <div style={styles.err}>{error}</div>}
        {current && (
          <div style={styles.current}>
            <span style={styles.curName} title={current}>{current}</span>
            <span style={styles.clear} title="clear the field" onClick={clear}>×</span>
          </div>
        )}
        {connected && (
          <div style={styles.localRow} title="render the local project the relay is serving"
            onClick={browseLocal}>▦ browse local project →</div>
        )}
      </div>
    </div>
  );
}
