import React, { useEffect, useMemo, useState, useCallback } from 'react';

// FileTree — the IDE's DOM chrome. Lists the ACTIVE file source as a collapsible
// tree and opens a file as a 3D grid on click. The source is whatever
// ctx.fileProvider is: the GitHub baseline (client-only, no relay) or the relay's
// local filesystem. It is NOT gated on the relay — the GitHub tree lists with zero
// backend.
//
// It issues NO bespoke loading logic: a click runs `file.open <path>` through the
// command router — the exact command the CLI/Claude runs. The panel is a thin
// command surface, so UI and bus stay in lockstep by construction.
//
// Re-lists (debounced) whenever the scene changes (a repo.load / file.open / local
// restore mutates the registry) or the relay (re)connects (local re-mirror).

const styles = {
  // FileTree is now panel CONTENT — dockview owns the panel container + tab chrome
  // (title, drag, close), so this just fills the panel with the same near-black,
  // monospace surface the chrome uses elsewhere.
  content: {
    width: '100%', height: '100%',
    background: 'rgba(8,10,14,0.92)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  contentHeader: {
    padding: '8px', borderBottom: '1px solid #1b1f29',
    color: '#7c8596', letterSpacing: '0.04em', flex: '0 0 auto',
    display: 'flex', alignItems: 'center', gap: 8,
  },
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
  closeBtn: (lit) => ({
    flex: '0 0 auto', marginLeft: 6, padding: '0 5px', borderRadius: 3,
    color: lit ? '#e0888f' : '#4a515f', cursor: 'pointer',
  }),
  dir: { color: '#9aa3b2' },
  fileLoaded: { color: '#7ad7a0' },                                   // a grid for this file is in the field
  fileActive: { color: '#cfeaff', boxShadow: 'inset 2px 0 0 #6cf' },  // the focused file (attention.primary)
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

function TreeRow({ node, depth, expanded, toggle, loaded, openFile, openDir, closeFile, hover, setHover, activePath }) {
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
            expanded={expanded} toggle={toggle} loaded={loaded}
            openFile={openFile} openDir={openDir} closeFile={closeFile}
            hover={hover} setHover={setHover} activePath={activePath} />
        ))}
      </>
    );
  }

  const isActive = node.path === activePath;
  const isLoaded = loaded.has(node.path);
  return (
    <div
      title={node.path}
      onClick={() => openFile(node.path)}
      onMouseEnter={() => setHover(node.path)}
      onMouseLeave={() => setHover((h) => (h === node.path ? null : h))}
      style={{
        ...styles.row, paddingLeft: pad + 12,
        background: isActive ? 'rgba(102,204,255,0.16)' : bg,
        ...(isLoaded ? styles.fileLoaded : null),
        ...(isActive ? styles.fileActive : null),
      }}
    >
      <span style={styles.name}>{node.name}</span>
      {/* a grid for this file is in the field → close it from the list */}
      {isLoaded && (
        <span title="close / remove from view"
          onClick={(e) => { e.stopPropagation(); closeFile(node.path); }}
          style={styles.closeBtn(hovered)}>✕</span>
      )}
    </div>
  );
}

export default function FileTree({ client }) {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(() => new Set());  // files with a grid in the field (from the registry)
  const [expanded, setExpanded] = useState(() => new Set([''])); // root expanded
  const [hover, setHover] = useState(null);
  const [activePath, setActivePath] = useState(null);  // the focused file (attention.primary)

  // Reflect scene/tab selection in the tree: the focused grid's registry id IS its
  // path, so highlight the row that matches attention.primary. Click → sheet.focus
  // sets it; a canvas/tab click sets it too — the tree follows either way.
  useEffect(() => {
    const am = client?.ctx?.attentionManager;
    if (!am?.on) return undefined;
    const update = () => setActivePath(am.get?.('primary')?.id ?? null);
    update();
    return am.on('change:primary', update);
  }, [client]);

  // List the active fileProvider's tree — GitHub (client-only) or the relay's local
  // fs. NOT gated on the relay. Re-list (debounced) on scene changes (repo.load /
  // file.open / local restore mutate the registry) and on relay (re)connect.
  useEffect(() => {
    if (!client) return undefined;
    let cancelled = false, timer = null;
    const list = async () => {
      const provider = client.ctx?.fileProvider;
      if (!provider) return;
      try {
        const entries = await provider.listTree('file:///');
        const code = provider.filterCodeFiles({ tree: entries });
        if (cancelled) return;
        setFiles(code.map((f) => f.path).sort());
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    };
    // `loaded` = files with a grid in the field, straight from the registry (the
    // truth of what's rendered). Recompute immediately on change so a close drops the
    // ✕ at once; the tree re-list is debounced separately.
    const recomputeLoaded = () => {
      const r = client.ctx?.registry;
      if (r) setLoaded(new Set(r.findByType('grid').map((e) => e.id)));
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(list, 150); };
    const onReg = () => { recomputeLoaded(); schedule(); };
    const reg = client.ctx?.registry;
    const bridge = client.bridge;
    reg?.addChangeListener?.(onReg);
    const offConn = bridge?.onConnectionChange?.((c) => { setConnected(c); schedule(); });
    recomputeLoaded();
    list();  // initial — a ?repo GitHub tree may already be loaded
    return () => {
      cancelled = true; clearTimeout(timer);
      reg?.removeChangeListener?.(onReg);
      offConn?.();
    };
  }, [client]);

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
    // sheet.focus is the single "go look at it" gesture: sets attention.primary (so
    // the tree row lights up as focused), frames the camera, marks the sheet active.
    // Array form keeps a space/slash path intact. (file.open created the sheet.)
    client.router.execute(['sheet.focus', `sheet:${path}`]);
  }, [client]);

  // The ⊞ button: recursively open a directory's files + tree-layout, then frame
  // the lot. Empty path == repo root == the whole project (root is just a dir).
  const openDir = useCallback(async (path) => {
    if (!client) return;
    await client.router.execute(`file.openDir ${path}`.trimEnd());
    client.router.execute('camera.fitall');
  }, [client]);

  // The ✕ on a loaded row: remove that grid from the field (grid.close = sheet.close
  // if it backs a tab, else a bare remove). The registry change recomputes `loaded`.
  const closeFile = useCallback((path) => {
    client?.router.execute(['grid.close', path]);
  }, [client]);

  let body;
  if (!client) body = <div style={styles.msg}>starting…</div>;
  else if (error) body = <div style={styles.err}>tree error:{'\n'}{error}</div>;
  else if (!tree) body = <div style={styles.msg}>listing files…</div>;
  else if (tree.children.length === 0) body = <div style={styles.msg}>no files — load a repo (or connect the relay)</div>;
  else body = (
    <div style={styles.list}>
      {/* The root is just a directory row: its ⊞ opens the whole project. */}
      <TreeRow node={tree} depth={0}
        expanded={expanded} toggle={toggle} loaded={loaded}
        openFile={openFile} openDir={openDir} closeFile={closeFile}
        hover={hover} setHover={setHover} activePath={activePath} />
    </div>
  );

  return (
    <div style={styles.content}>
      <div style={styles.contentHeader}>
        <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {files ? `${files.length} files` : 'files'}{loaded.size ? ` · ${loaded.size} loaded` : ''}
        </span>
        <span style={styles.dot(connected)} title={connected ? 'relay connected' : 'relay disconnected'}>●</span>
      </div>
      {body}
    </div>
  );
}
