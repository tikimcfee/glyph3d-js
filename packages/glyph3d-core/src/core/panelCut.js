/**
 * panelCut — a flat panel cut to a rect, on the CPU (no GL scissor: one draw per kind holds).
 *
 * A panel is a unit quad (1×1 PlaneGeometry) posed by its matrixWorld. It may carry
 * `userData.panelClip` — a rect {left, right, top, bottom} in its PARENT's space (a window clipped
 * to a tile: FramedGlyphField.setClipRect). What is drawn of it — by the PanelBatch — and what is
 * picked of it — by the PickingSystem's flat pass — is the part of the quad inside that rect: the
 * same matrix, so a click past the tile goes to what is there. The quad must sit unrotated in its
 * parent (a window's own panels do); otherwise it fails loud.
 */

import * as THREE from 'three';

/**
 * The cut part of a panel's unit quad, in its own unit coords, or null when nothing is left.
 * @param {THREE.Object3D} p @returns {{x0:number,x1:number,y0:number,y1:number}|null}
 */
export function cutRect(p) {
    const c = p.userData.panelClip;
    const q = p.quaternion;
    if (q.x !== 0 || q.y !== 0 || q.z !== 0) throw new Error(`panelCut: panelClip on a rotated panel (${p.name || p.type}) — the cut is stated in its parent's axes`);
    const sx = p.scale.x, sy = p.scale.y, px = p.position.x, py = p.position.y;
    const x0 = Math.max(-0.5, (c.left - px) / sx), x1 = Math.min(0.5, (c.right - px) / sx);
    const y0 = Math.max(-0.5, (c.bottom - py) / sy), y1 = Math.min(0.5, (c.top - py) / sy);
    return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
}

const _local = new THREE.Matrix4();

/**
 * A clipped panel's matrix: its world matrix times the cut (write into `out`). Null when nothing
 * is left of it.
 * @param {THREE.Object3D} p @param {THREE.Matrix4} out @returns {THREE.Matrix4|null}
 */
export function cutMatrix(p, out) {
    const r = cutRect(p);
    if (!r) return null;
    _local.makeScale(r.x1 - r.x0, r.y1 - r.y0, 1).setPosition((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0);
    return out.multiplyMatrices(p.matrixWorld, _local);
}
