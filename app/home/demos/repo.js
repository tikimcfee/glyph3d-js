/**
 * demo.repo — load real source files from the local relay and lay them
 * out with the home page's layout kit.
 *
 * Concretely: list files under `prefix` via RemoteFileSystemProvider
 * (the same client GitHubRepoViewer uses for local mode), read each,
 * spawn a CodeGrid per file (truncating long bodies so we don't burn a
 * minute on a single file's atlas/slug pipeline), wrap the lot in a
 * VStack, swap it in for welcome+tryThis, and reframe the camera.
 *
 * The point: the layout kit needs to handle "a few" and "many" with
 * the same primitives. This proves it.
 */

import * as THREE from 'three';
import { RemoteFileSystemProvider } from '../../../src/services/data/RemoteFileSystemProvider.js';
import CodeGrid from '../../../src/collections/CodeGrid.js';
import { VStack, HStack, Spacer, Anchor, frameNodes } from '../layout/index.js';
import { sleep } from './helpers.js';

const MAX_LINES = 16;   // truncate per file so dozens of grids stay tractable
const LINE_LIMIT_LABEL = `… (truncated to ${MAX_LINES} lines for preview)`;
const FILE_WORLD_SCALE = 0.045;
const FILE_GAP = 14;    // world units between files in the stack
const COLUMN_GAP = 30;  // gap between columns in multi-column layouts

const FILE_LABEL_COLOR = { r: 1.00, g: 0.80, b: 0.35 };  // amber for filenames

function truncateContent(text) {
    const lines = text.split('\n');
    if (lines.length <= MAX_LINES) return text;
    return lines.slice(0, MAX_LINES).concat([LINE_LIMIT_LABEL]).join('\n');
}

/**
 * Build a single file's CodeGrid: filename header line + truncated body.
 */
function makeFileGrid(scene, atlas, entry) {
    const grid = new CodeGrid(scene, atlas, {
        name: `repo-file:${entry.path}`,
        showBackground: false,
        showFilename: false,
        textColor: { r: 0.30, g: 0.30, b: 0.35 },
        worldScale: FILE_WORLD_SCALE,
        gridScale: 1.0,
    });
    const header = `// ${entry.path}`;
    const body = truncateContent(entry.content || '(empty)');
    grid.loadText(`${header}\n${body}`);
    // Header line in amber — tells the eye "this is a file label."
    grid.highlightRange(0, 0, 0, header.length, FILE_LABEL_COLOR);
    return grid;
}

/**
 * @param {Object} deps
 * @param {THREE.Scene} deps.scene
 * @param {Object} deps.atlas
 * @param {Object} deps.bridge      WebSocketBridge
 * @param {Object} deps.camera      THREE.PerspectiveCamera
 * @param {Object} deps.welcome     WelcomeCluster (will be hidden + restored)
 * @param {Object} deps.tryThis     TryThisCluster (will be hidden + restored)
 * @param {Object} deps.layoutRoot  current Center(HStack(...)) — temporarily hidden
 * @param {Object} [deps.cameraControls]
 * @param {Object} [deps.bar]
 * @param {{ signal: AbortSignal }} [deps.run]
 * @param {Object} [deps.opts]
 * @param {string} [deps.opts.prefix='app/home/']
 * @param {number} [deps.opts.limit=16]
 * @param {number} [deps.opts.columns=2]
 */
export default async function demoRepo(deps) {
    const {
        scene, atlas, bridge, camera, welcome, tryThis, layoutRoot,
        cameraController, bar, run, opts = {},
    } = deps;
    const signal = run?.signal;
    const prefix  = opts.prefix  || 'app/home/';
    const limit   = opts.limit   ?? 16;
    const columns = opts.columns ?? 2;

    if (!bridge) {
        return { text: 'ERR: no bridge — cannot fetch files' };
    }

    bar?.appendOutput(`  • listing files under ${prefix}…`, 'info');
    const fs = new RemoteFileSystemProvider(bridge, { root: '.' });

    // Use the existing tree fetch — it already filters to text files.
    let tree;
    try {
        tree = await fs.listTree('file:///');
    } catch (e) {
        return { text: `ERR: listTree failed: ${e?.message || e}` };
    }
    if (signal?.aborted) throw { cancelled: true };

    const files = (tree || [])
        .filter(e => e.type === 'file' && e.path.startsWith(prefix))
        .slice(0, limit);

    if (files.length === 0) {
        return { text: `OK: no files under ${prefix}` };
    }
    bar?.appendOutput(`  • fetching ${files.length} files…`, 'info');

    // Read all in parallel — the relay's RPC dispatch handles concurrency.
    const reads = await Promise.all(files.map(async e => {
        try {
            const r = await fs.readFile(`file:///${e.path}`);
            return { path: e.path, content: r?.content || '' };
        } catch (err) {
            return { path: e.path, content: `// error: ${err?.message || err}` };
        }
    }));
    if (signal?.aborted) throw { cancelled: true };

    bar?.appendOutput(`  • building ${reads.length} CodeGrids + composing…`, 'info');

    // Spin up one CodeGrid per file. Held in fileGrids so cleanup can
    // dispose them and remove from scene.
    const fileGrids = reads.map(e => makeFileGrid(scene, atlas, e));

    // Split into columns: round-robin so column heights stay close.
    const columnsArr = Array.from({ length: columns }, () => []);
    fileGrids.forEach((g, i) => columnsArr[i % columns].push(g));

    // Each column is a VStack with FILE_GAP. Columns are joined in an HStack.
    const vstacks = columnsArr.map(grids => {
        const items = [];
        for (let i = 0; i < grids.length; i++) {
            if (i > 0) items.push(Spacer(FILE_GAP));
            items.push(grids[i]);
        }
        return VStack({ gap: 0, align: Anchor.TOP_LEFT }, items);
    });

    const root = HStack(
        { gap: COLUMN_GAP, align: Anchor.TOP_CENTER },
        vstacks,
    );
    scene.add(root);

    // Hide the home page's normal content during the demo.
    if (layoutRoot) layoutRoot.visible = false;

    root.layout();

    // Reframe to fit the new composition. Use lighter bottomReserve
    // since the file grid is taller than the home cluster and we don't
    // need as much offset.
    const framed = frameNodes(camera, [root], { padding: 1.12, bottomReserve: 0.55 });
    if (framed && cameraController?.input?.focus?.pivot) {
        cameraController.input.focus.pivot.copy(framed.target);
    }

    bar?.appendOutput(`  • showing ${fileGrids.length} files; type any command to exit.`, 'info');

    // Hold the view until the demo is cancelled (re-typing demo.repo, or
    // any other demo, cancels via the runner). No animation — this is
    // a "look at it" demo, not a "watch it move" demo.
    try {
        // Indefinite hold; signal will throw {cancelled:true} when fired.
        await sleep(60_000, signal);
    } catch (e) {
        if (!e?.cancelled) throw e;
    } finally {
        // Cleanup: remove our grids from scene + dispose, restore home.
        for (const g of fileGrids) {
            try { g.dispose?.(); } catch {}
            if (g.parent) g.parent.remove(g);
        }
        scene.remove(root);
        if (layoutRoot) layoutRoot.visible = true;
    }

    return { text: `OK: shown ${fileGrids.length} files from ${prefix}` };
}
