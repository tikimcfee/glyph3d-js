import React, { useEffect, useMemo, useState } from 'react';

// FileTree — the IDE's DOM chrome. Lists the relay's filesystem (the locally
// served project) and opens a file as a 3D grid on click.
//
// It issues NO bespoke loading logic: a click runs `file.open <path>` through the
// command router — the exact command the CLI/Claude runs. The panel is a thin
// command surface, so UI and bus stay in lockstep by construction.

const styles = {
  panel: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: 280, zIndex: 10,
    background: 'rgba(8,10,14,0.82)', borderRight: '1px solid #1b1f29',
    backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column',
    font: '12px/1.5 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  header: {
    padding: '10px 12px', borderBottom: '1px solid #1b1f29',
    color: '#7c8596', letterSpacing: '0.04em', flex: '0 0 auto',
  },
  list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
  row: {
    padding: '2px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none',
  },
  rowOpen: { color: '#7ad7a0' },
  msg: { padding: '12px', color: '#7c8596' },
  err: { padding: '12px', color: '#e0888f' },
};

export default function FileTree({ client }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [hover, setHover] = useState(null);

  // Fetch + filter the tree once the bridge-backed provider is wired.
  useEffect(() => {
    const provider = client?.ctx?.fileProvider;
    if (!provider) return;
    let cancelled = false;
    (async () => {
      try {
        const tree = await provider.getRepositoryTree();
        const code = provider.filterCodeFiles(tree);
        if (!cancelled) setFiles(code.map((f) => f.path).sort());
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const openFile = async (path) => {
    if (!client) return;
    await client.router.execute(`file.open ${path}`);
    setOpen((prev) => new Set(prev).add(path));
  };

  const body = useMemo(() => {
    if (!client) return <div style={styles.msg}>connecting to relay…</div>;
    if (error) return <div style={styles.err}>tree error: {error}</div>;
    if (!files) return <div style={styles.msg}>listing files…</div>;
    if (files.length === 0) return <div style={styles.msg}>(no code files found)</div>;
    return (
      <div style={styles.list}>
        {files.map((p) => (
          <div
            key={p}
            title={p}
            onClick={() => openFile(p)}
            onMouseEnter={() => setHover(p)}
            onMouseLeave={() => setHover((h) => (h === p ? null : h))}
            style={{
              ...styles.row,
              ...(open.has(p) ? styles.rowOpen : null),
              background: hover === p ? 'rgba(255,255,255,0.05)' : 'transparent',
            }}
          >
            {p}
          </div>
        ))}
      </div>
    );
  }, [client, error, files, open, hover]);

  return (
    <aside style={styles.panel}>
      <div style={styles.header}>
        files{files ? ` · ${files.length}` : ''}{open.size ? ` · ${open.size} open` : ''}
      </div>
      {body}
    </aside>
  );
}
