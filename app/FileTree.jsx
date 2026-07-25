import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { canonicalPath } from './commands/handlers/pathResolve.js';

// FileTree — the Files panel IS the file browser. One tree that:
//
//   • BROWSES the real filesystem lazily — one shallow readDir per expanded
//     directory (file.list's primitive), nothing loads until asked. In relay
//     mode that reaches ANYTHING the operator can read (served root, opened
//     roots, ~, /); in GitHub mode it's synthesized from the loaded repo tree —
//     one code path either way.
//   • SHOWS what's loaded — derived live from the registry (never stored), so
//     the same directory reached via any route lights up identically: node
//     identity is the canonical path, exactly the registry's id space.
//   • OPENS and CLOSES arbitrary nodes — click a file to open+focus it, ⊞ pops
//     a whole directory into the world (file.openDir), ✕ on a directory closes
//     everything under it (file.closeDir). Selection and viewing are the same
//     place — no separate "Open" dialog choosing at a distance.
//
// No bespoke logic: every action is a bus verb (file.open / file.openDir /
// file.closeDir / grid.close / grid.visibility), the same the CLI/Claude run.
// `attention.primary` is the one selection authority, reflected here.

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
  anchor: { color: '#5f6875' },                                       // ~ and / — quiet browse anchors
  loadedDot: { flex: '0 0 auto', marginLeft: 6, color: '#7ad7a0', fontSize: 9 },
  dotfile: { opacity: 0.62 },
  fileLoaded: { color: '#7ad7a0' },                                   // a grid for this file is in the scene
  fileHidden: { color: '#5c6675', fontStyle: 'italic' },              // loaded but grid.visible === false
  fileActive: { color: '#cfeaff', boxShadow: 'inset 2px 0 0 #6cf' },  // the focused file (attention.primary)
  note: { color: '#5c6675', fontStyle: 'italic' },
  errNote: { color: '#b0666d', fontStyle: 'italic' },
  msg: { padding: '12px', color: '#7c8596' },
  err: { padding: '12px', color: '#e0888f', whiteSpace: 'pre-wrap' },
};

const baseName = (p) => {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
};
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : dir ? `${dir}/${name}` : name);
const underOf = (path) => (path === '/' || path === '' ? path : path + '/');

/** Nest flat registry ids into {name, path, isDir, children} — the loaded-only view. */
function nestIds(ids) {
  const root = { name: '', path: null, isDir: true, children: new Map() };
  for (const id of ids) {
    const abs = String(id).startsWith('/');
    const parts = String(id).split('/').filter(Boolean);
    let node = root, acc = '';
    parts.forEach((seg, i) => {
      acc = acc ? `${acc}/${seg}` : (abs ? '/' + seg : seg);
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, path: acc, isDir: i < parts.length - 1, children: new Map() });
      }
      node = node.children.get(seg);
      if (i < parts.length - 1) node.isDir = true;
    });
  }
  const finish = (n) => ({ ...n, children: [...n.children.values()].map(finish) });
  return finish(root);
}

/** One directory row + (when expanded) its lazily-fetched children. */
function DirNode({ path, label, depth, kind, ui }) {
  const expandedHere = ui.expanded.has(path);
  const hovered = ui.hover === path;
  const bg = hovered ? 'rgba(255,255,255,0.05)' : 'transparent';
  const listing = ui.listings.get(path);
  const loadedUnder = ui.hasLoadedUnder(path);
  const pad = 8 + depth * 12;

  return (
    <>
      <div
        title={path || label}
        onClick={() => ui.toggle(path)}
        onMouseEnter={() => ui.setHover(path)}
        onMouseLeave={() => ui.clearHover(path)}
        style={{ ...styles.row, ...(kind === 'anchor' ? styles.anchor : styles.dir), paddingLeft: pad, background: bg }}
      >
        <span style={styles.caret}>{expandedHere ? '▾' : '▸'}</span>
        <span style={styles.name}>{label}</span>
        {loadedUnder && <span style={styles.loadedDot}>●</span>}
        <span title="lay this folder out in 3D"
          onClick={(e) => { e.stopPropagation(); ui.openDir(path); }}
          style={styles.treeBtn(hovered)}>⊞</span>
        {loadedUnder && (
          <span title="close everything loaded under this folder"
            onClick={(e) => { e.stopPropagation(); ui.closeDir(path); }}
            style={styles.close(hovered)}>✕</span>
        )}
      </div>
      {expandedHere && (
        listing == null || listing === 'loading' ? (
          <div style={{ ...styles.row, ...styles.note, paddingLeft: pad + 24 }}>…</div>
        ) : listing.error ? (
          <div style={{ ...styles.row, ...styles.errNote, paddingLeft: pad + 24 }}>{listing.error}</div>
        ) : (
          <>
            {listing.entries.filter((e) => e.type === 'directory').map((e) => (
              <DirNode key={e.name} path={joinPath(path, e.name)} label={e.name} depth={depth + 1} kind="dir" ui={ui} />
            ))}
            {listing.entries.filter((e) => e.type !== 'directory').map((e) => (
              <FileNode key={e.name} path={joinPath(path, e.name)} name={e.name} depth={depth + 1} ui={ui} />
            ))}
            {listing.entries.length === 0 && (
              <div style={{ ...styles.row, ...styles.note, paddingLeft: pad + 24 }}>(empty)</div>
            )}
            {listing.truncated && (
              <div style={{ ...styles.row, ...styles.errNote, paddingLeft: pad + 24 }}>… listing truncated</div>
            )}
          </>
        )
      )}
    </>
  );
}

function FileNode({ path, name, depth, ui }) {
  const hovered = ui.hover === path;
  const bg = hovered ? 'rgba(255,255,255,0.05)' : 'transparent';
  const isActive = path === ui.activeId;
  const isLoaded = ui.loadedVis.has(path);
  const shown = ui.loadedVis.get(path) !== false;
  return (
    <div
      title={path}
      onClick={() => ui.openFile(path)}
      onMouseEnter={() => ui.setHover(path)}
      onMouseLeave={() => ui.clearHover(path)}
      style={{
        ...styles.row, paddingLeft: 8 + depth * 12 + 12,
        background: isActive ? 'rgba(102,204,255,0.16)' : bg,
        ...(name.startsWith('.') ? styles.dotfile : null),
        ...(isLoaded ? (shown ? styles.fileLoaded : styles.fileHidden) : null),
        ...(isActive ? styles.fileActive : null),
      }}
    >
      <span style={styles.name}>{name}</span>
      {/* loaded files get scene-management affordances inline: hide + close */}
      {isLoaded && (
        <>
          <span title={shown ? 'hide' : 'show'} style={styles.vis(shown, hovered)}
            onClick={(e) => { e.stopPropagation(); ui.hideFile(path, shown); }}>{shown ? '◉' : '○'}</span>
          <span title="close / remove from scene" style={styles.close(hovered)}
            onClick={(e) => { e.stopPropagation(); ui.closeFile(path); }}>✕</span>
        </>
      )}
    </div>
  );
}

/** The loaded-only view: everything in the registry, nested, always expanded. */
function LoadedNode({ node, depth, ui }) {
  if (node.isDir) {
    const pad = 8 + depth * 12;
    const hovered = ui.hover === node.path;
    return (
      <>
        {node.path != null && (
          <div style={{ ...styles.row, ...styles.dir, paddingLeft: pad }}
            onMouseEnter={() => ui.setHover(node.path)} onMouseLeave={() => ui.clearHover(node.path)}>
            <span style={styles.caret}>▾</span>
            <span style={styles.name}>{node.name}</span>
            <span title="close everything loaded under this folder"
              onClick={() => ui.closeDir(node.path)} style={styles.close(hovered)}>✕</span>
          </div>
        )}
        {node.children.map((c) => (
          <LoadedNode key={c.path} node={c} depth={node.path == null ? depth : depth + 1} ui={ui} />
        ))}
      </>
    );
  }
  return <FileNode path={node.path} name={node.name} depth={depth} ui={ui} />;
}

export default function FileTree({ client }) {
  const [connected, setConnected] = useState(false);
  const [rootInfo, setRootInfo] = useState(null);          // {root, extraRoots, home, sep} | null
  const [repoLabel, setRepoLabel] = useState(null);        // GitHub mode header label
  const [pinnedRoots, setPinnedRoots] = useState([]);      // opened local roots outside the served one
  const [listings, setListings] = useState(() => new Map()); // path → 'loading' | {entries,truncated} | {error}
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadedVis, setLoadedVis] = useState(() => new Map()); // registry id → visible
  const [activeId, setActiveId] = useState(null);
  const [hover, setHover] = useState(null);
  const [loadedOnly, setLoadedOnly] = useState(false);
  const fetching = useRef(new Set());

  // The focused grid → row accent (one attention.primary authority; ids are canonical).
  useEffect(() => {
    const am = client?.ctx?.attentionManager;
    if (!am?.on) return undefined;
    const update = () => setActiveId(am.get?.('primary')?.id ?? null);
    update();
    return am.on('change:primary', update);
  }, [client]);

  // Registry → loaded map + pinned roots + the GitHub label. No tree re-walk:
  // listings are filesystem truth, loading files doesn't change them.
  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => {
      const r = client.ctx?.registry;
      if (r) setLoadedVis(new Map(r.findByType('grid').map((e) => [e.id, e.grid?.visible !== false])));
      const sources = Array.isArray(client.ctx?.fieldSources) ? client.ctx.fieldSources : [];
      setPinnedRoots(sources.filter((s) => s?.type === 'local' && String(s.dir).startsWith('/')).map((s) => s.dir));
      const p = client.ctx?.fileProvider;
      const repo = p?._currentRepo;
      setRepoLabel(repo ? `${repo.owner}/${repo.repo}` : null);
      // Track the ACTIVE provider: repo.load swaps in GitHub (no rootInfo →
      // filesystem anchors drop), a relay connect swaps the local one back in.
      setRootInfo(p?.rootInfo ? { ...p.rootInfo } : null);
    };
    const reg = client.ctx?.registry;
    reg?.addChangeListener?.(refresh);
    refresh();
    const offConn = client.bridge?.onConnectionChange?.((c) => {
      setConnected(c);
      if (!c) return;
      // Roots arrive via the provider's own refresh (idempotent; CommandProvider
      // already ordered one before session restore) — reflect them when known.
      const p = client.ctx?.fileProvider;
      p?.refreshRoots?.().then(() => setRootInfo({ ...p.rootInfo })).catch(() => {});
    });
    const p = client.ctx?.fileProvider;
    if (p?.rootInfo) setRootInfo({ ...p.rootInfo });
    return () => { reg?.removeChangeListener?.(refresh); offConn?.(); };
  }, [client]);

  // Top-level anchors: served root (expanded) + opened roots + quiet ~ and /.
  const rootsList = useMemo(() => {
    if (rootInfo?.root) {
      const served = rootInfo.root;
      const out = [{ path: served, label: baseName(served) || served, kind: 'served' }];
      for (const p of pinnedRoots) {
        if (p !== served && !p.startsWith(underOf(served))) out.push({ path: p, label: baseName(p), kind: 'pinned' });
      }
      if (rootInfo.home) out.push({ path: rootInfo.home, label: '~', kind: 'anchor' });
      out.push({ path: '/', label: '/', kind: 'anchor' });
      return out;
    }
    return [{ path: '', label: repoLabel || 'repository', kind: 'served' }];
  }, [rootInfo, pinnedRoots, repoLabel]);

  // Auto-expand the primary root when it (re)appears.
  const primaryRoot = rootsList[0]?.path;
  useEffect(() => {
    if (primaryRoot == null) return;
    setExpanded((prev) => (prev.has(primaryRoot) ? prev : new Set(prev).add(primaryRoot)));
  }, [primaryRoot]);

  // Lazy fetch: one shallow readDir per expanded dir without a listing. The
  // fetching guard stops double-fires while a request is in flight; a landed
  // listing re-runs the effect and finds nothing left to fetch.
  useEffect(() => {
    const provider = client?.ctx?.fileProvider;
    if (!provider?.readDir) return;
    for (const p of expanded) {
      if (listings.has(p) || fetching.current.has(p)) continue;
      fetching.current.add(p);
      provider.readDir(p)
        .then((res) => setListings((prev) => new Map(prev).set(p, { entries: res.entries, truncated: !!res.truncated })))
        .catch((err) => setListings((prev) => new Map(prev).set(p, { error: err?.message || String(err) })))
        .finally(() => fetching.current.delete(p));
    }
  }, [client, expanded, listings, rootInfo, repoLabel]);

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Drop the cached listing so re-expanding refetches — fresh by construction.
        setListings((l) => { const n = new Map(l); n.delete(path); return n; });
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const clearHover = useCallback((path) => setHover((h) => (h === path ? null : h)), []);

  const openFile = useCallback(async (path) => {
    if (!client) return;
    const p = canonicalPath(client.ctx, path);
    await client.router.execute(['file.open', p]);
    // sheet.focus = the single "go look at it" gesture: attention.primary (drives the
    // accent) + frame + mark active. Array form keeps a space/slash path intact; the
    // sheet id is 'sheet:' + the canonical path stripped of its leading slash.
    client.router.execute(['sheet.focus', `sheet:${p.replace(/^\/+/, '')}`]);
  }, [client]);

  const openDir = useCallback(async (path) => {
    if (!client) return;
    await client.router.execute(['file.openDir', canonicalPath(client.ctx, path)]);
    client.router.execute('camera.fitall');
  }, [client]);

  const closeDir = useCallback((path) => {
    client?.router.execute(['file.closeDir', canonicalPath(client.ctx, path)]);
  }, [client]);

  const closeFile = useCallback((path) => {
    client?.router.execute(['grid.close', canonicalPath(client.ctx, path)]);  // sheet.close if a tab, else bare remove
  }, [client]);

  const hideFile = useCallback((path, shown) => {
    if (!client) return;
    client.router.execute(['grid.visibility', canonicalPath(client.ctx, path), shown ? 'false' : 'true']);
    // grid.visible mutates without a registry event → refresh the loaded map now.
    const r = client.ctx?.registry;
    if (r) setLoadedVis(new Map(r.findByType('grid').map((e) => [e.id, e.grid?.visible !== false])));
  }, [client]);

  const hasLoadedUnder = useCallback((path) => {
    const prefix = underOf(path);
    for (const id of loadedVis.keys()) {
      if (id === path || (prefix && String(id).startsWith(prefix))) return true;
    }
    return false;
  }, [loadedVis]);

  const ui = {
    expanded, listings, hover, setHover, clearHover, toggle, activeId, loadedVis,
    openFile, openDir, closeDir, closeFile, hideFile, hasLoadedUnder,
  };

  const loadedTree = useMemo(() => (loadedOnly ? nestIds([...loadedVis.keys()]) : null), [loadedOnly, loadedVis]);

  let body;
  if (!client) body = <div style={styles.msg}>starting…</div>;
  else if (loadedOnly) {
    body = loadedTree && loadedTree.children.length
      ? <div style={styles.list}><LoadedNode node={loadedTree} depth={0} ui={ui} /></div>
      : <div style={styles.msg}>nothing loaded yet</div>;
  } else if (!rootInfo && !repoLabel) {
    body = <div style={styles.msg}>no files — load a repo (or connect the relay)</div>;
  } else {
    body = (
      <div style={styles.list}>
        {rootsList.map((r) => (
          <DirNode key={r.path || '(repo)'} path={r.path} label={r.label} depth={0} kind={r.kind} ui={ui} />
        ))}
      </div>
    );
  }

  return (
    <div style={styles.content}>
      <div style={styles.contentHeader}>
        <span title={rootInfo?.root || ''} style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {rootInfo?.root || repoLabel || 'files'}{loadedVis.size ? ` · ${loadedVis.size} loaded` : ''}
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
