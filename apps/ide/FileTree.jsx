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
  // A flex sibling of the canvas (not an overlay): collapsing hands width back.
  panel: (collapsed) => ({
    flex: '0 0 auto', width: collapsed ? 30 : 280, height: '100%',
    background: 'rgba(8,10,14,0.92)', borderRight: '1px solid #1b1f29',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    transition: 'width 0.15s ease',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  }),
  header: {
    padding: '10px 8px', borderBottom: '1px solid #1b1f29',
    color: '#7c8596', letterSpacing: '0.04em', flex: '0 0 auto',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  toggle: { cursor: 'pointer', color: '#7c8596', padding: '0 2px', flex: '0 0 auto', userSelect: 'none' },
  dot: (ok) => ({ color: ok ? '#7ad7a0' : '#caa14a' }),
  list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
  row: {
    cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', userSelect: 'none', paddingRight: 8,
    display: 'flex', alignItems: 'center',
  },
  caret: { display: 'inline-block', width: 12, color: '#5c6675', opacity: 0.8, flex: '0 0 auto' },
  name: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  treeBtn: (lit) => ({
    flex: '0 0 auto', marginLeft: 6, padding: '0 5px', borderRadius: 3,
    color: lit ? '#7ad7a0' : '#39414f', cursor: 'pointer',
  }),
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

function TreeRow({ node, depth, expanded, toggle, open, openFile, openDir, hover, setHover }) {
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
          <span style={styles.caret}>{isExp ? '▾' : '▸'}</span>
          <span style={styles.name}>{node.name}</span>
          <span
            title="lay this folder out in 3D"
            onClick={(e) => { e.stopPropagation(); openDir(node.path); }}
            style={styles.treeBtn(hovered)}
          >⊞</span>
        </div>
        {isExp && node.children.map((c) => (
          <TreeRow key={c.path} node={c} depth={depth + 1}
            expanded={expanded} toggle={toggle} open={open}
            openFile={openFile} openDir={openDir} hover={hover} setHover={setHover} />
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
      <span style={styles.name}>{node.name}</span>
    </div>
  );
}

export default function FileTree({ client, collapsed = false, onToggle }) {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set([''])); // root expanded
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

  const tree = useMemo(() => {
    if (!files) return null;
    const t = buildTree(files);
    t.name = '/'; // the repo root — same ⊞ as any dir; its empty path opens it all
    return t;
  }, [files]);

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
    // Tightest feedback loop: frame the file you just opened so it doesn't load
    // off-screen. Same camera.focus command the CLI/Claude uses (id == path).
    client.router.execute(`camera.focus ${path}`);
  }, [client]);

  // The ⊞ button: recursively open a directory's files + tree-layout, then frame
  // the lot. Empty path == repo root == the whole project (root is just a dir).
  const openDir = useCallback(async (path) => {
    if (!client) return;
    await client.router.execute(`file.openDir ${path}`.trimEnd());
    client.router.execute('camera.fitall');
  }, [client]);

  let body;
  if (!client) body = <div style={styles.msg}>starting…</div>;
  else if (!connected) body = <div style={styles.msg}>connecting to relay…</div>;
  else if (error) body = <div style={styles.err}>tree error:{'\n'}{error}</div>;
  else if (!tree) body = <div style={styles.msg}>listing files…</div>;
  else if (tree.children.length === 0) body = <div style={styles.msg}>(no code files found)</div>;
  else body = (
    <div style={styles.list}>
      {/* The root is just a directory row: its ⊞ opens the whole project. */}
      <TreeRow node={tree} depth={0}
        expanded={expanded} toggle={toggle} open={open}
        openFile={openFile} openDir={openDir} hover={hover} setHover={setHover} />
    </div>
  );

  return (
    <aside style={styles.panel(collapsed)}>
      <div style={styles.header}>
        <span onClick={onToggle} title={collapsed ? 'expand files' : 'collapse files'} style={styles.toggle}>
          {collapsed ? '▶' : '◀'}
        </span>
        {!collapsed && (
          <>
            <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              files{files ? ` · ${files.length}` : ''}{open.size ? ` · ${open.size} open` : ''}
            </span>
            <span style={styles.dot(connected)} title={connected ? 'relay connected' : 'relay disconnected'}>●</span>
          </>
        )}
      </div>
      {!collapsed && body}
    </aside>
  );
}
