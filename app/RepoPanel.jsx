import React, { useState, useEffect, useCallback } from 'react';

// RepoPanel — the thin SOURCES panel: what fills the world, from where.
//
// Two lanes, matching the progressive-enhancement shape of the product:
//   • GitHub (the baseline, client-only): owner/repo[/branch] → repo.load.
//   • Local (the relay lane): shows what the binary is serving, an "open
//     location" input for any path on the machine (file.openDir — the same
//     verb the file browser's ⊞ runs), and the opened roots with per-root
//     close. The HEAVY browsing UX lives in the Files panel — this is the
//     at-a-glance roster plus the type-a-path power move.
//
// Every action is a command-bus verb (repo.load / repo.clear / file.openDir /
// file.closeDir), identical to a CLI invocation — UI and bus stay in lockstep.

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
  section: { fontSize: 10, color: '#4a5566', letterSpacing: '0.08em', marginTop: 4 },
  inputRow: { display: 'flex', gap: 6 },
  input: {
    flex: '1 1 auto', minWidth: 0, font: 'inherit', color: '#c8ccd6', background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, padding: '4px 7px', outline: 'none',
  },
  load: {
    flex: '0 0 auto', font: 'inherit', color: '#08101a', background: '#6cf',
    border: '1px solid #6cf', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontWeight: 600,
  },
  open: {
    flex: '0 0 auto', font: 'inherit', color: '#c8ccd6', background: 'transparent',
    border: '1px solid #2a3340', borderRadius: 4, padding: '4px 12px', cursor: 'pointer',
  },
  hint: { fontSize: 11, color: '#5c6675' },
  err: { color: '#e0888f', whiteSpace: 'pre-wrap', fontSize: 11 },
  current: {
    display: 'flex', alignItems: 'center', gap: 6, background: '#101820',
    border: '1px solid #1f2730', borderRadius: 4, padding: '4px 8px',
  },
  curName: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#7ad7a0' },
  clear: { flex: '0 0 auto', color: '#7c8596', cursor: 'pointer', padding: '0 4px' },
  served: { fontSize: 11, color: '#9aa3b2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(() => currentRepoLabel(client));
  const [connected, setConnected] = useState(false);
  const [servedRoot, setServedRoot] = useState(null);
  const [localRoots, setLocalRoots] = useState([]);

  // Relay status drives the source line (github client-only vs +local).
  useEffect(() => {
    const bridge = client?.bridge;
    if (!bridge?.onConnectionChange) return undefined;
    return bridge.onConnectionChange(setConnected);
  }, [client]);

  // Reflect out-of-band loads (?repo bootstrap, CLI repo.load / file.openDir):
  // field (re)loads mutate the registry — re-read the repo label, the served
  // root (known once fs/roots lands), and the opened local roots.
  useEffect(() => {
    const reg = client?.ctx?.registry;
    if (!reg?.addChangeListener) return undefined;
    const refresh = () => {
      setCurrent(currentRepoLabel(client));
      setServedRoot(client?.ctx?.fileProvider?.rootInfo?.root ?? null);
      const sources = Array.isArray(client?.ctx?.fieldSources) ? client.ctx.fieldSources : [];
      setLocalRoots(sources.filter((s) => s?.type === 'local').map((s) => s.dir));
    };
    refresh();
    reg.addChangeListener(refresh);
    return () => reg.removeChangeListener(refresh);
  }, [client, connected]);

  const load = useCallback(async () => {
    const ref = input.trim();
    if (!ref || !client || busy) return;
    setBusy(true); setError(null);
    // The fetch count narrates in the StatusBar (it polls getProgress globally); the
    // panel just shows the busy state.
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

  // Open any local path as a field root — the typed-path twin of the file
  // browser's ⊞. file.openDir canonicalizes ('~' works) and registers the
  // reach root server-side.
  const openLocation = useCallback(async () => {
    const p = pathInput.trim();
    if (!p || !client || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await client.router.execute(['file.openDir', p]);
      if (r?.text?.startsWith('ERR')) setError(r.text.replace(/^ERR:\s*/, ''));
      else {
        setPathInput('');
        client.router.execute('camera.fitall');
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [pathInput, client, busy]);

  const closeRoot = useCallback((dir) => {
    client?.router.execute(['file.closeDir', dir]);
  }, [client]);

  // When the relay is serving a project, render it (the active local provider) as the field.
  const browseLocal = useCallback(() => {
    if (!client) return;
    client.router.execute(['file.openDir', '']);
    client.router.execute('camera.fitall');
  }, [client]);

  // Keep keystrokes in the inputs (don't drive WASD / the focused grid) + Enter submits.
  const onRepoKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') load(); };
  const onPathKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') openLocation(); };

  return (
    <div style={styles.content}>
      <div style={styles.header}>
        <span style={styles.title}>sources</span>
        <span style={styles.src} title={connected ? 'relay connected — local + GitHub' : 'client-only — GitHub, no backend'}>
          {connected ? '◉ local + github' : '○ github'}
        </span>
      </div>
      <div style={styles.body}>
        <div style={styles.section}>GITHUB</div>
        <div style={styles.inputRow}>
          <input
            style={styles.input}
            placeholder="owner/repo[/branch]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onRepoKey}
            disabled={busy}
            spellCheck={false}
          />
          <button type="button" style={styles.load} onClick={load} disabled={busy || !input.trim()}>
            {busy ? '…' : 'Load'}
          </button>
        </div>
        {busy && <div style={styles.hint}>working…</div>}
        {error && <div style={styles.err}>{error}</div>}
        {current && (
          <div style={styles.current}>
            <span style={styles.curName} title={current}>{current}</span>
            <span style={styles.clear} title="clear the field" onClick={clear}>×</span>
          </div>
        )}
        {connected && (
          <>
            <div style={styles.section}>LOCAL</div>
            {servedRoot && (
              <div style={styles.served} title={servedRoot}>serving {servedRoot}</div>
            )}
            <div style={styles.inputRow}>
              <input
                style={styles.input}
                placeholder="/any/path or ~/anywhere"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={onPathKey}
                disabled={busy}
                spellCheck={false}
              />
              <button type="button" style={styles.open} onClick={openLocation} disabled={busy || !pathInput.trim()}>
                Open
              </button>
            </div>
            <div style={styles.localRow} title="render the local project the relay is serving"
              onClick={browseLocal}>▦ open served project →</div>
            {localRoots.map((dir) => (
              <div key={dir} style={styles.current}>
                <span style={styles.curName} title={dir}>{dir}</span>
                <span style={styles.clear} title="close everything loaded from this root"
                  onClick={() => closeRoot(dir)}>×</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
