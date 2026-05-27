import React, { useEffect, useMemo, useState, useCallback } from 'react';

// FileTree — the IDE's DOM chrome. Lists the relay's filesystem (the locally
// served project) as a collapsible tree and opens a file as a 3D grid on click.
//
// It issues NO bespoke loading logic: a click runs `file.open <path>` through the
// command router — the exact command the CLI/Claude runs. The panel is a thin
// command surface, so UI and bus stay in lockstep by construction.
//
// Fetching is connection-aware: the bridge connects asynchronously (and the relay
// restarts often in dev), so we list the tree when the socket actually opens and
// re-list on every reconnect — never against a not-yet-open socket.

const styles = {
  panel: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: 280, zIndex: 10,
    background: 'rgba(8,10,14,0.82)', borderRight: '1px solid #1b1f29',
    backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  header: {
    padding: '10px 12px', borderBottom: '1px solid #1b1f29',
    color: '#7c8596', letterSpacing: '0.04em', flex: '0 0 auto',
    display: 'flex', justifyContent: 'space-between', gap: 8,
  },
  dot: (ok) => ({ color: ok ? '#7ad7a0' : '#caa14a' }),
  list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
  row: {
    cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', userSelect: 'none', paddingRight: 8,
  },
  caret: { display: 'inline-block', width: 12, color: '#5c6675', opacity: 0.8 },
  dir: { color: '#9aa3b2' },
  fileOpen: { color: '#7ad7a0' },
  msg: { padding: '12px', color: '#7c8596' },
  err: { padding: '12px', color: '#e0888f', whiteSpace: 'pre-wrap' },
};

// Build a nested {name, path, isDir, children[]} tree from flat path strings.
// Only directories that contain code files appear (we build from the filtered
// file list, not the raw tree). Sorted dirs-first, then alphabetical.
function buildTree(paths) {
  const root = { name: '', path: '', isDir: true, children: [], _map: new Map() };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root, acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const isDir = i < parts.length - 1;
      let child = node._map.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: acc, isDir, children: [], _map: new Map() };
        node._map.set(parts[i], child);
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortRec = (n) => {
    n.children.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function TreeRow({ node, depth, expanded, toggle, open, openFile, hover, setHover }) {
  const pad = 8 + depth * 12;
  const hovered = hover === node.path;
  const bg = hovered ? 'rgba(255,255,255,0.05)' : 'transparent';

  if (node.isDir) {
    const isExp = expanded.has(node.path);
    return (
      <>
        <div
          onClick={() => toggle(node.path)}
          onMouseEnter={() => setHover(node.path)}
          onMouseLeave={() => setHover((h) => (h === node.path ? null : h))}
          style={{ ...styles.row, ...styles.dir, paddingLeft: pad, background: bg }}
        >
          <span style={styles.caret}>{isExp ? '▾' : '▸'}</span>{node.name}
        </div>
        {isExp && node.children.map((c) => (
          <TreeRow key={c.path} node={c} depth={depth + 1}
            expanded={expanded} toggle={toggle} open={open}
            openFile={openFile} hover={hover} setHover={setHover} />
        ))}
      </>
    );
  }

  return (
    <div
      title={node.path}
      onClick={() => openFile(node.path)}
      onMouseEnter={() => setHover(node.path)}
      onMouseLeave={() => setHover((h) => (h === node.path ? null : h))}
      style={{
        ...styles.row, paddingLeft: pad + 12, background: bg,
        ...(open.has(node.path) ? styles.fileOpen : null),
      }}
    >
      {node.name}
    </div>
  );
}

export default function FileTree({ client }) {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [hover, setHover] = useState(null);

  // Live socket state via the bridge listener (fires true immediately if already
  // connected, and on every reconnect).
  useEffect(() => {
    const bridge = client?.bridge;
    if (!bridge?.onConnectionChange) return;
    return bridge.onConnectionChange(setConnected);
  }, [client]);

  // List the tree on (re)connect. Read fresh — no provider cache — so a relay
  // restart re-mirrors the actual disk.
  useEffect(() => {
    const provider = client?.ctx?.fileProvider;
    if (!provider || !connected) return;
    let cancelled = false;
    (async () => {
      try {
        const entries = await provider.listTree('file:///');
        const code = provider.filterCodeFiles({ tree: entries });
        if (!cancelled) {
          setFiles(code.map((f) => f.path).sort());
          setError(null);
          console.log(`[filetree] listed ${code.length} code files (${entries.length} tree entries)`);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [client, connected]);

  const tree = useMemo(() => (files ? buildTree(files) : null), [files]);

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const openFile = useCallback(async (path) => {
    if (!client) return;
    await client.router.execute(`file.open ${path}`);
    setOpen((prev) => new Set(prev).add(path));
  }, [client]);

  let body;
  if (!client) body = <div style={styles.msg}>starting…</div>;
  else if (!connected) body = <div style={styles.msg}>connecting to relay…</div>;
  else if (error) body = <div style={styles.err}>tree error:{'\n'}{error}</div>;
  else if (!tree) body = <div style={styles.msg}>listing files…</div>;
  else if (tree.children.length === 0) body = <div style={styles.msg}>(no code files found)</div>;
  else body = (
    <div style={styles.list}>
      {tree.children.map((c) => (
        <TreeRow key={c.path} node={c} depth={0}
          expanded={expanded} toggle={toggle} open={open}
          openFile={openFile} hover={hover} setHover={setHover} />
      ))}
    </div>
  );

  return (
    <aside style={styles.panel}>
      <div style={styles.header}>
        <span>files{files ? ` · ${files.length}` : ''}{open.size ? ` · ${open.size} open` : ''}</span>
        <span style={styles.dot(connected)} title={connected ? 'relay connected' : 'relay disconnected'}>●</span>
      </div>
      {body}
    </aside>
  );
}
