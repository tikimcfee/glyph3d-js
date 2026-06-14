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

/** Parse a "COLSxROWS" dims arg (e.g. "16x9"); falls back to defaults. */
function parseDims(arg, defCols, defRows) {
    if (typeof arg !== 'string') return { cols: defCols, rows: defRows };
    const m = arg.match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (!m) return { cols: defCols, rows: defRows };
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

        const { cols, rows } = parseDims(args[0], 16, 9);
        const name = args[1] || `screen-${Date.now()}`;

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
        video.playsInline = true;
        video.srcObject = stream;
        try { await video.play(); } catch { /* autoplay of a muted stream is allowed; ignore */ }

        const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
        const aspect = (settings.width && settings.height)
            ? settings.width / settings.height
            : (16 / 9);

        const texture = new THREE.VideoTexture(video);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        // NoColorSpace: the frame branch decodes display-sRGB → linear with pow(2.2)
        // itself (matching the emoji path), so we must NOT also let three convert on
        // sample. If the frame looks washed/dark, this is the colorspace dial.
        texture.colorSpace = THREE.NoColorSpace;

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
}
