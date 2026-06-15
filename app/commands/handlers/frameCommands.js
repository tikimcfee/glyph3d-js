/**
 * Frame commands: frame.capture — pull the OS screen-share frame buffer into the
 * scene as a FrameGrid (the "frame buffer is the atlas" path).
 *
 * The command is the verb of record (CLI/agent-discoverable), but getDisplayMedia
 * requires a real user gesture, so the actual permission prompt only fires when the
 * command is dispatched from an in-page click (e.g. the ButtonBar "capture" button).
 * A relayed/headless invocation will reach the getDisplayMedia call but the browser
 * will reject it without a gesture — that's expected and acknowledged.
 */

import * as THREE from 'three';
import FrameGrid from '@glyph3d/core/collections/FrameGrid.js';

/** Default cell budget when dims aren't given — see FrameGrid.deriveGrid. Cell count is
 *  scatter granularity, not image detail, so this is a perf/taste ceiling. */
const DEFAULT_CELL_BUDGET = 4096;

/** Parse an explicit "COLSxROWS" dims arg (e.g. "16x9"); null if absent/unparseable
 *  (the capture path then derives a grid from the real frame size). */
function parseDims(arg) {
    if (typeof arg !== 'string') return null;
    const m = arg.match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (!m) return null;
    return { cols: Math.max(1, +m[1]), rows: Math.max(1, +m[2]) };
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerFrameCommands(router) {
    router.register('frame.capture', async (args, ctx) => {
        const md = (typeof navigator !== 'undefined') && navigator.mediaDevices;
        if (!md || typeof md.getDisplayMedia !== 'function') {
            return { text: 'ERR: getDisplayMedia not available in this environment', data: null };
        }

        // Explicit "COLSxROWS" wins; otherwise the grid is derived from the real capture
        // size below (once getSettings() is known). If arg0 isn't dims, it's the name.
        const explicitDims = parseDims(args[0]);
        const name = (explicitDims ? args[1] : args[0]) || `screen-${Date.now()}`;

        // Must run inside the click gesture — await directly, no pre-work.
        let stream;
        try {
            stream = await md.getDisplayMedia({ video: true, audio: false });
        } catch (err) {
            return { text: `ERR: screen capture denied or failed: ${err?.message || err}`, data: null };
        }

        // Drive a VideoTexture off a hidden <video>. getSettings() gives the real
        // capture dimensions up front, so the grid's aspect is right on frame one.
        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        // Attach offscreen (NOT display:none — that pauses playback in some browsers,
        // the classic "black panel" cause). 1px, transparent, out of the way keeps it
        // decoding. Removed again in FrameGrid.dispose().
        video.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(video);
        try { await video.play(); } catch { /* autoplay of a muted stream is allowed; ignore */ }

        const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
        const aspect = (settings.width && settings.height)
            ? settings.width / settings.height
            : (16 / 9);

        // Cell grid: honor an explicit COLSxROWS, else derive one proportional to the
        // real capture size, bounded by the cell budget (always within the buffer).
        const { cols, rows } = explicitDims
            || FrameGrid.deriveGrid(settings.width, settings.height, { budget: DEFAULT_CELL_BUDGET });

        const texture = new THREE.VideoTexture(video);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        // SRGBColorSpace is three's documented WebGPU VideoTexture path: the texture
        // node linearizes on sample, and the frame branch does NOT manually pow(). See
        // the colorspace dial note in GlyphField's frame branch if this looks off.
        texture.colorSpace = THREE.SRGBColorSpace;

        const grid = new FrameGrid(ctx.scene, ctx.atlas, { name, cols, rows, aspect });

        // Place it upright in front of the camera, facing the viewer.
        const cam = ctx.camera;
        if (cam) {
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
            grid.position.copy(cam.position).addScaledVector(forward, 30);
            grid.quaternion.copy(cam.quaternion);
        }

        grid.setFrameSource({ texture, stream, video });

        // Registered as type 'frame' so grid/surface consumers (virtualizer, camera
        // framing, edit/keystroke routing) skip it — it's a display surface, not an
        // editable code grid. Deliberately NOT made the 'primary' attention target.
        const registryId = ctx.addGrid(grid, { id: name, type: 'frame' });

        // If the user stops sharing from the browser's own UI, remove the grid so the
        // scene and the capture lifecycle stay in sync.
        const endTrack = stream.getVideoTracks()[0];
        if (endTrack) {
            endTrack.addEventListener('ended', () => {
                try { ctx.removeGrid(registryId); } catch { /* already gone */ }
            }, { once: true });
        }

        return {
            text: `OK: capturing screen → "${registryId}" (${cols}x${rows} cells, aspect ${aspect.toFixed(2)})`,
            data: { registryId, cols, rows, cells: grid.getCellCount(), aspect },
        };
    }, { description: 'Capture the OS screen share into a FrameGrid', usage: '[COLSxROWS] [name]' });

    router.register('frame.regrid', (args, ctx) => {
        const id   = args[0];
        const dims = parseDims(args[1]);
        if (!id || !dims) {
            return { text: 'ERR: usage: frame.regrid <id> <COLSxROWS>', data: null };
        }
        const grid = ctx.registry?.get(id)?.grid;
        if (!grid || typeof grid.setGrid !== 'function') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        // Live re-dice: same texture, finer/coarser independently-movable cells.
        grid.setGrid(dims.cols, dims.rows);
        return {
            text: `OK: re-diced "${id}" → ${grid.cols}x${grid.rows} (${grid.getCellCount()} cells)`,
            data: { id, cols: grid.cols, rows: grid.rows, cells: grid.getCellCount() },
        };
    }, { description: 'Re-dice a FrameGrid into a new cell grid (live)', usage: '<id> <COLSxROWS>' });

    // ── Observability + lifecycle: CLI/bus control of capture state, mirroring the
    //    terminal.* roster verbs. These ride only the registry (no interaction/scale
    //    layer), so they're independent of the chrome/dock work. The richer per-capture
    //    intent (source label, place, resume) lands with the state-model work.

    /** Summarize one FrameGrid for list/info output. */
    const frameSummary = (id, grid) => ({
        id,
        cols: grid.cols,
        rows: grid.rows,
        cells: grid.getCellCount?.() ?? grid.cols * grid.rows,
        aspect: +(grid.aspect ?? 0).toFixed(3),
    });

    router.register('frame.list', (args, ctx) => {
        const entries = ctx.registry?.findByType?.('frame') ?? [];
        const frames = entries.map((e) => frameSummary(ctx.registry.getIdByGrid(e.grid), e.grid));
        const text = frames.length
            ? frames.map((f) => `${f.id}  ${f.cols}x${f.rows} (${f.cells} cells, aspect ${f.aspect})`).join('\n')
            : '(no captures)';
        return { text, data: { frames, count: frames.length } };
    }, { description: 'List active screen captures (FrameGrids)', usage: '' });

    router.register('frame.info', (args, ctx) => {
        const id = args[0];
        const grid = id && ctx.registry?.get(id)?.grid;
        if (!grid || typeof grid.getCellCount !== 'function') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        const info = frameSummary(id, grid);
        return { text: `${info.id}: ${info.cols}x${info.rows}, ${info.cells} cells, aspect ${info.aspect}`, data: info };
    }, { description: 'Show one capture’s grid + dims', usage: '<id>' });

    router.register('frame.kill', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: frame.kill <id>', data: null };
        const entry = ctx.registry?.get(id);
        if (!entry || entry.type !== 'frame') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        // Generic teardown — removeGrid disposes the grid, which stops the MediaStream
        // (so the OS "sharing" indicator clears) and detaches the offscreen <video>.
        ctx.removeGrid(id);
        return { text: `OK: killed capture "${id}"`, data: { id } };
    }, { description: 'Stop a screen capture and remove it', usage: '<id>' });
}
