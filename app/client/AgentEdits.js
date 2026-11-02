/**
 * AgentEdits — an agent's edit LANDS in the file you have open, and the line you're reading stays
 * where it is on screen.
 *
 * A live tool call that lands ok (SessionBooks' follow push, never a history read) carries the file
 * as the call left it (an Edit's / Write's `file.text`, whole when `file.start === 1`). If that file
 * is open as a code grid, its text is swapped in place, and the ANCHOR — the top visible row of a
 * framed grid, else the line at the plane view's center when a plane is up — keeps its screen row:
 * a framed grid's scroll moves by the lines the edit added or removed above the anchor; a plane
 * view's aim moves by them. A grid you're editing yourself (a caret in it) is never overwritten.
 */

import * as THREE from 'three';
import { sessionPath } from '@glyph3d/core/collections/agentEvents.js';

/**
 * How far an edit moves a line: lines before the first change keep their index, lines after the last
 * change shift by the line-count difference, a line inside the change stays (the edit is under it).
 * @param {string} before @param {string} after @param {number} line  0-based, in `before`
 * @returns {number} the shift (lines) to add to `line`
 */
export function anchorShift(before, after, line) {
    const a = before.split('\n'), b = after.split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    if (line < pre) return 0;
    if (line >= a.length - suf) return b.length - a.length;
    return 0;
}

/**
 * Land one tool record's edit in an open grid, if any. @param {Object} ctx AppContext
 * @param {Object} rec an eventRecord (action edit|write, target, file) @param {string} cwd
 * @returns {Promise<{path:string, shift:number, anchor:string}|null>} what landed, or null
 */
export async function landAgentEdit(ctx, rec, cwd) {
    if ((rec.action !== 'edit' && rec.action !== 'write') || !rec.target) return null;
    const path = sessionPath(rec.target, cwd);
    const grid = ctx.registry?.get?.(path)?.grid;
    if (!grid || typeof grid.loadText !== 'function') return null;
    if (grid._cursor) {
        console.info(`[edits] ${path}: an agent edited it while you're editing it here — left as you have it`);
        return null;
    }
    const after = rec.file?.start === 1 ? rec.file.text : String((await ctx.fileProvider?.getFile?.(path)) ?? '');
    const before = typeof grid.content === 'string' ? grid.content : null;
    if (before == null || after === before) return null;

    const cc = ctx.cameraController;
    const plane = cc?.planeState?.() ?? null;
    let anchor = 'none', line = null;
    const frameRows = grid.getFrameRows?.() || 0;
    const lineH = grid.metrics?.lineSpacing;
    if (frameRows > 0) {
        anchor = 'scroll';
        line = grid.getScrollOffset?.() || 0;
    } else if (plane && !plane.tweening && Number.isFinite(lineH) && typeof grid.pixelOrigin === 'function') {
        // The plane point at the view center, in the grid's own frame → the line under your eye.
        const cam = ctx.camera;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const center = cam.position.clone().addScaledVector(fwd, plane.camera.distance);
        grid.updateWorldMatrix(true, false);
        const local = grid.worldToLocal(center.clone());
        line = Math.floor((grid.pixelOrigin().y - local.y) / lineH);
        anchor = 'plane';
    }
    const shift = line == null ? 0 : anchorShift(before, after, line);

    await grid.loadText(after);
    if (anchor === 'scroll' && shift) await grid.setScrollOffset((grid.getScrollOffset?.() || 0) + shift);
    if (anchor === 'plane' && shift) {
        const s = Math.abs(grid.getWorldScale(new THREE.Vector3()).y);
        cc.setPlaneAim(plane.aim.x, plane.aim.y - shift * lineH * s);
    }
    console.info(`[edits] ${path}: an agent's ${rec.action} landed (${shift >= 0 ? '+' : ''}${shift} lines above your anchor, ${anchor})`);
    return { path, shift, anchor };
}
