// buildTree — flat path strings → a nested {name, path, isDir, children[]} tree.
// Used by the Files panel for both the source listing and its "loaded only" filtered
// view, so the hierarchy (not a flat list) handles a bulk repo's hundreds of entries.
// Sorted dirs-first, then alphabetical.

export function buildTree(paths) {
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
