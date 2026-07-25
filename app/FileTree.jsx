import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { buildTree } from './treeUtil.js';
import { canonicalPath } from './commands/handlers/pathResolve.js';

// FileTree — the Files panel: ONE tree that is both the source browser (summon a file
// into the scene with a click) AND the scene view for files (loaded rows are lit, with
// per-row hide + close, and a "loaded only" filter to prune to what's in the field).
//
// Why one tree, not a browser + a separate outliner: in glyph3d a file loads as exactly
// one grid — scene objects are 1:1 with source files — so a second "scene tree" is just
// a near-duplicate of this one. (The DCC browser/outliner split assumes assets ≠ scene
// instances; that doesn't hold for files here. Terminals/memory, which have no source
// row, are a different story — they live in their own panels.)
//
// No bespoke logic: every action is a bus verb (file.open / grid.close / grid.visibility),
// the same the CLI/Claude run. `loaded` comes straight from the registry (the truth of
// what's rendered); `attention.primary` is the one selection authority, reflected here.

const styles = {
  content: {
    width: '100%', height: '100%', background: 'rgba(8,10,14,0.92)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  contentHeader: {
    padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
    letterSpacing: '0.04em', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8,
  },
  filter: (on) => ({
    flex: '0 0 auto', font: 'inherit', fontSize: 11, cursor: 'pointer', borderRadius: 4, padding: '1px 7px',
    color: on ? '#08101a' : '#8b9aa8', background: on ? '#6cf' : 'transparent', border: '1px solid ' + (on ? '#6cf' : '#2a3340'),
  }),
  clearAll: {
    flex: '0 0 auto', font: 'inherit', fontSize: 11, cursor: 'pointer', borderRadius: 4, padding: '1px 7px',
    color: '#d99', background: 'transparent', border: '1px solid #4a2730',
  },
  dot: (ok) => ({ color: ok ? '#7ad7a0' : '#caa14a', flex: '0 0 auto' }),
  list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
  row: {
    cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    userSelect: 'none', paddingRight: 8, display: 'flex', alignItems: 'center',
  },
  caret: { display: 'inline-block', width: 12, color: '#5c6675', opacity: 0.8, flex: '0 0 auto' },
  name: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  treeBtn: (lit) => ({
    flex: '0 0 auto', marginLeft: 6, padding: '0 5px', borderRadius: 3,
    color: lit ? '#7ad7a0' : '#39414f', cursor: 'pointer',
  }),
  vis: (shown, lit) => ({
    flex: '0 0 auto', marginLeft: 6, padding: '0 4px', borderRadius: 3,
    color: shown ? (lit ? '#cfe3ff' : '#4a5566') : '#caa14a', cursor: 'pointer',
  }),
  close: (lit) => ({
    flex: '0 0 auto', marginLeft: 4, padding: '0 5px', borderRadius: 3,
    color: lit ? '#e0888f' : '#4a515f', cursor: 'pointer',
  }),
  dir: { color: '#9aa3b2' },
  fileLoaded: { color: '#7ad7a0' },                                   // a grid for this file is in the scene
  fileHidden: { color: '#5c6675', fontStyle: 'italic' },              // loaded but grid.visible === false
  fileActive: { color: '#cfeaff', boxShadow: 'inset 2px 0 0 #6cf' },  // the focused file (attention.primary)
  msg: { padding: '12px', color: '#7c8596' },
  err: { padding: '12px', color: '#e0888f', whiteSpace: 'pre-wrap' },
};

function TreeRow({ node, depth, expanded, toggle, loadedVis, openFile, openDir, closeFile, hideFile, hover, setHover, activePath }) {
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
          <span title="lay this folder out in 3D"
            onClick={(e) => { e.stopPropagation(); openDir(node.path); }}
            style={styles.treeBtn(hovered)}>⊞</span>
        </div>
        {isExp && node.children.map((c) => (
          <TreeRow key={c.path} node={c} depth={depth + 1}
            expanded={expanded} toggle={toggle} loadedVis={loadedVis}
            openFile={openFile} openDir={openDir} closeFile={closeFile} hideFile={hideFile}
            hover={hover} setHover={setHover} activePath={activePath} />
        ))}
      </>
    );
  }

  const isActive = node.path === activePath;
  const isLoaded = loadedVis.has(node.path);
  const shown = loadedVis.get(node.path) !== false;
  return (
    <div
      title={node.path}
      onClick={() => openFile(node.path)}
      onMouseEnter={() => setHover(node.path)}
      onMouseLeave={() => setHover((h) => (h === node.path ? null : h))}
      style={{
        ...styles.row, paddingLeft: pad + 12,
        background: isActive ? 'rgba(102,204,255,0.16)' : bg,
        ...(isLoaded ? (shown ? styles.fileLoaded : styles.fileHidden) : null),
        ...(isActive ? styles.fileActive : null),
      }}
    >
      <span style={styles.name}>{node.name}</span>
      {/* loaded files get scene-management affordances inline: hide + close */}
      {isLoaded && (
        <>
          <span title={shown ? 'hide' : 'show'} style={styles.vis(shown, hovered)}
            onClick={(e) => { e.stopPropagation(); hideFile(node.path, shown); }}>{shown ? '◉' : '○'}</span>
          <span title="close / remove from scene" style={styles.close(hovered)}
            onClick={(e) => { e.stopPropagation(); closeFile(node.path); }}>✕</span>
        </>
      )}
    </div>
  );
}

export default function FileTree({ client }) {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [loadedVis, setLoadedVis] = useState(() => new Map());  // path → visible, from the registry
  const [expanded, setExpanded] = useState(() => new Set([''])); // root expanded
  const [hover, setHover] = useState(null);
  const [activePath, setActivePath] = useState(null);  // the focused file (attention.primary)
  const [loadedOnly, setLoadedOnly] = useState(false); // filter the tree to scene contents

  // Registry ids are CANONICAL (absolute in relay mode); this tree's rows are
  // root-relative until the browser rewrite. Map ids into row space here so
  // loaded/active accents keep lighting up. (Interim — the lazy-browse tree
  // adopts canonical node paths outright.)
  const toRowPath = useCallback((id) => {
    const root = client?.ctx?.fileProvider?.rootInfo?.root;
    const s = String(id ?? '');
    return root && s.startsWith(root + '/') ? s.slice(root.length + 1) : s;
  }, [client]);

  // The focused grid → row accent (one attention.primary authority).
  useEffect(() => {
    const am = client?.ctx?.attentionManager;
    if (!am?.on) return undefined;
    const update = () => {
      const id = am.get?.('primary')?.id ?? null;
      setActivePath(id == null ? null : toRowPath(id));
    };
    update();
    return am.on('change:primary', update);
  }, [client, toRowPath]);

  // Source listing (debounced) + the loaded map (immediate), both off the registry.
  useEffect(() => {
    if (!client) return undefined;
    let cancelled = false, timer = null;
    const list = async () => {
      const provider = client.ctx?.fileProvider;
      if (!provider) return;
      try {
        const { entries } = await provider.listTree('file:///');
        const code = provider.filterCodeFiles({ tree: entries });
        if (cancelled) return;
        setFiles(code.map((f) => f.path).sort());
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    };
    const recomputeLoaded = () => {
      const r = client.ctx?.registry;
      if (r) setLoadedVis(new Map(r.findByType('grid').map((e) => [toRowPath(e.id), e.grid?.visible !== false])));
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(list, 150); };
    const onReg = () => { recomputeLoaded(); schedule(); };
    const reg = client.ctx?.registry;
    const bridge = client.bridge;
    reg?.addChangeListener?.(onReg);
    const offConn = bridge?.onConnectionChange?.((c) => { setConnected(c); schedule(); });
    recomputeLoaded();
    list();
    return () => {
      cancelled = true; clearTimeout(timer);
      reg?.removeChangeListener?.(onReg);
      offConn?.();
    };
  }, [client]);

  // Source vs scene-only: build the tree from all files, or just the loaded subset.
  const tree = useMemo(() => {
    const paths = loadedOnly ? [...loadedVis.keys()] : files;
    if (!paths || paths.length === 0) return null;
    const t = buildTree([...paths].sort());
    t.name = '/';
    return t;
  }, [files, loadedOnly, loadedVis]);

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const openFile = useCallback(async (path) => {
    if (!client) return;
    const p = canonicalPath(client.ctx, path);
    await client.router.execute(['file.open', p]);
    // sheet.focus = the single "go look at it" gesture: attention.primary (drives the
    // accent) + frame + mark active. Array form keeps a space/slash path intact; the
    // sheet id is 'sheet:' + the canonical path stripped of its leading slash
    // (WorkspaceModel.openSheet's id rule).
    client.router.execute(['sheet.focus', `sheet:${p.replace(/^\/+/, '')}`]);
  }, [client]);

  const openDir = useCallback(async (path) => {
    if (!client) return;
    await client.router.execute(['file.openDir', canonicalPath(client.ctx, path)]);
    client.router.execute('camera.fitall');
  }, [client]);

  const closeFile = useCallback((path) => {
    client?.router.execute(['grid.close', canonicalPath(client.ctx, path)]);  // sheet.close if a tab, else bare remove
  }, [client]);

  const hideFile = useCallback((path, shown) => {
    if (!client) return;
    client.router.execute(['grid.visibility', canonicalPath(client.ctx, path), shown ? 'false' : 'true']);
    // grid.visible mutates without a registry event → refresh the loaded map now.
    const r = client.ctx?.registry;
    if (r) setLoadedVis(new Map(r.findByType('grid').map((e) => [toRowPath(e.id), e.grid?.visible !== false])));
  }, [client, toRowPath]);

  let body;
  if (!client) body = <div style={styles.msg}>starting…</div>;
  else if (error) body = <div style={styles.err}>tree error:{'\n'}{error}</div>;
  else if (!tree) body = <div style={styles.msg}>{loadedOnly ? 'nothing loaded yet' : 'listing files…'}</div>;
  else if (tree.children.length === 0) body = <div style={styles.msg}>no files — load a repo (or connect the relay)</div>;
  else body = (
    <div style={styles.list}>
      <TreeRow node={tree} depth={0}
        expanded={expanded} toggle={toggle} loadedVis={loadedVis}
        openFile={openFile} openDir={openDir} closeFile={closeFile} hideFile={hideFile}
        hover={hover} setHover={setHover} activePath={activePath} />
    </div>
  );

  return (
    <div style={styles.content}>
      <div style={styles.contentHeader}>
        <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {files ? `${files.length} files` : 'files'}{loadedVis.size ? ` · ${loadedVis.size} loaded` : ''}
        </span>
        {loadedVis.size > 0 && (
          <span style={styles.clearAll} title="remove all loaded grids — clear the scene"
            onClick={() => client?.router.execute('scene.clear_grids')}>clear</span>
        )}
        <span style={styles.filter(loadedOnly)} title="show only files loaded into the scene"
          onClick={() => setLoadedOnly((v) => !v)}>loaded</span>
        <span style={styles.dot(connected)} title={connected ? 'relay connected' : 'relay disconnected'}>●</span>
      </div>
      {body}
    </div>
  );
}
