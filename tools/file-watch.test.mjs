// file-watch.test.mjs — an open file follows its file on disk (app/client/FileWatch.js over the
// relay's fs/watch → fs/changed; cli/fs_watch.go has its own Go test), on a REAL SceneRegistry and a
// REAL CodeGrid.
//
//   bun tools/file-watch.test.mjs
//
// Locks:
//   - the relay's subscriptions follow the open files: registering a code grid watches its path,
//     unregistering unwatches it, a non-file entry is never watched; a reconnect sends them all again
//   - fs/changed for an open file swaps its text in place (read through the file provider); an
//     unchanged text is a no-op; a path not watched is ignored
//   - a file being edited here (unsaved edits) is NEVER overwritten — teeth: the same push lands on
//     the unmodified twin
//   - Settings ▸ Files files.followDisk off: everything unwatched and pushes ignored

import './headless-canvas.mjs';
const store = new Map();
globalThis.localStorage ??= {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
globalThis.window.dispatchEvent ??= () => {};
const THREE = await import('three');
const { default: CodeGrid } = await import('../packages/glyph3d-core/src/collections/CodeGrid.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: FileWatch } = await import('../app/client/FileWatch.js');
const { setSetting } = await import('../app/client/settings.js');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const settle = () => new Promise((r) => setTimeout(r, 5));
const quiet = async (fn) => { const i = console.info; console.info = () => {}; try { return await fn(); } finally { console.info = i; } };

const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };
const scene = new THREE.Scene();
const disk = new Map([['/w/a.js', 'a1\na2\n'], ['/w/b.js', 'b1\n']]);
const calls = [];
let notify = null;
const bridge = {
    connected: true,
    onRpcNotification(fn) { notify = fn; return () => { notify = null; }; },
    async rpcRequest(method, params) { calls.push({ method, paths: [...params.paths].sort() }); return { ok: true }; },
};
const registry = new SceneRegistry();
const ctx = { registry, fileProvider: { getFile: async (p) => disk.get(p) }, cameraController: null };
const fw = new FileWatch(ctx, bridge);

const open = async (path) => {
    const g = new CodeGrid(scene, atlas, { showFilename: false });
    await g.loadText(disk.get(path));
    registry.register(path, g, { type: 'grid', sourcePath: path });
    await settle();
    return g;
};
const push = async (paths) => { await quiet(async () => { notify('fs/changed', { paths }); await settle(); await settle(); }); };

const a = await open('/w/a.js');
ok(calls.some((c) => c.method === 'fs/watch' && c.paths.includes('/w/a.js')), 'opening a file watches its path');
registry.register('term-1', { loadText() {} }, { type: 'terminal' });
await settle();
ok(!calls.some((c) => c.paths.includes('term-1')), 'a non-file entry is never watched');

disk.set('/w/a.js', 'a0\na1\na2\n');
await push(['/w/a.js']);
ok(a.content === 'a0\na1\na2\n', `a change on disk lands in the open file (${JSON.stringify(a.content)})`);
const n = fw.landed;
await push(['/w/a.js']);
ok(fw.landed === n, 'the same text again is a no-op');
await push(['/w/nope.js']);
ok(fw.landed === n, 'a path not watched is ignored');

// a file being edited here is never overwritten; its unmodified twin is (teeth)
const b = await open('/w/b.js');
b._modified = true;
disk.set('/w/b.js', 'b-from-disk\n');
await push(['/w/b.js']);
ok(b.content === 'b1\n', `unsaved edits here are never overwritten (${JSON.stringify(b.content)})`);
b._modified = false;
await push(['/w/b.js']);
ok(b.content === 'b-from-disk\n', 'teeth: unmodified, the same push lands');

// close → unwatch; reconnect → everything again
registry.unregister('/w/b.js');
await settle();
ok(calls.some((c) => c.method === 'fs/unwatch' && c.paths.includes('/w/b.js')), 'closing a file unwatches it');
const before = calls.length;
fw.reconnect();
await settle();
ok(calls.slice(before).some((c) => c.method === 'fs/watch' && c.paths.join() === '/w/a.js'), 'a reconnect watches the open files again');

// followDisk off
setSetting(ctx, 'files.followDisk', false);
await fw.sync();
ok(calls.at(-1).method === 'fs/unwatch' && calls.at(-1).paths.includes('/w/a.js') && fw.watched.size === 0, 'followDisk off: everything unwatched');
disk.set('/w/a.js', 'changed again\n');
await push(['/w/a.js']);
ok(a.content === 'a0\na1\na2\n', 'followDisk off: pushes ignored');
setSetting(ctx, 'files.followDisk', true);

fw.dispose();
console.log(`${fails ? 'FAIL' : 'ok'} file-watch: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
