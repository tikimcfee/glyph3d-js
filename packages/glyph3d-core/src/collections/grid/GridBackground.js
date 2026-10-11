/**
 * GridBackground — background panel mesh creation, bounds calculation, and layout fitting.
 */

import * as THREE from 'three';
import { createPanelMaterial } from '../panelMaterial.js';
import { RENDER_ORDER } from '../../core/renderOrder.js';
import { LAYER_BAND, getBandDistance } from '../../core/layerBands.js';

/**
 * Compute the dimensions and 3D position for a background panel.
 * @param {{min:{x:number,y:number,z?:number}, max:{x:number,y:number,z?:number}, width:number, height:number}|null} bounds
 * @param {number} padding
 * @param {number} frameRows
 * @param {number} lineHeight
 * @param {number} originY
 * @param {number} [bgGap]
 * @returns {{width: number, height: number, position: {x: number, y: number, z: number}}|null}
 */
export function computeBackgroundLayout(bounds, padding, frameRows, lineHeight, originY, bgGap) {
    if (!bounds) return null;
    const framed = (frameRows || 0) > 0;
    const frameH = framed ? frameRows * lineHeight : bounds.height;
    const width = bounds.width + padding * 2;
    const height = frameH + padding * 2;

    if (width <= 0 || height <= 0) return null;

    const zMin = bounds.min.z !== undefined ? bounds.min.z : 0;
    const gap = bgGap ?? getBandDistance(LAYER_BAND.GRID_BACKGROUND);
    const backgroundZ = zMin - gap;

    const centerY = framed
        ? (originY + 0.5 * lineHeight) - frameH / 2
        : bounds.min.y + bounds.height / 2;

    const centerX = bounds.min.x + bounds.width / 2;

    return {
        width,
        height,
        position: { x: centerX, y: centerY, z: backgroundZ },
    };
}

/**
 * Create a background plane mesh backed by panelMaterial.
 * @param {Object} config
 * @param {number|string} [config.backgroundColor]
 * @param {number} [config.backgroundOpacity]
 * @param {boolean} [config.showBackground]
 * @param {number} [bgGap]
 * @returns {{mesh: THREE.Mesh, panel: Object}}
 */
export function createBackgroundMesh(config = {}, bgGap) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const panel = createPanelMaterial({
        color: config.backgroundColor,
        opacity: config.backgroundOpacity,
        side: THREE.DoubleSide,
        depthWrite: true,
        layerBand: LAYER_BAND.GRID_BACKGROUND,
    });

    const mesh = new THREE.Mesh(geometry, panel.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
    mesh.position.z = -(bgGap ?? getBandDistance(LAYER_BAND.GRID_BACKGROUND));
    mesh.visible = config.showBackground ?? true;

    return { mesh, panel };
}

/**
 * Resize and position an existing background mesh to fit content/frame bounds.
 * @param {THREE.Mesh|null} backgroundMesh
 * @param {Object|null} bounds
 * @param {number} padding
 * @param {number} frameRows
 * @param {number} lineHeight
 * @param {number} originY
 * @param {number} [bgGap]
 */
export function fitBackground(backgroundMesh, bounds, padding, frameRows, lineHeight, originY, bgGap) {
    if (!backgroundMesh) return;
    const layout = computeBackgroundLayout(bounds, padding, frameRows, lineHeight, originY, bgGap);
    if (!layout) {
        backgroundMesh.visible = false;
        return;
    }
    backgroundMesh.scale.set(layout.width, layout.height, 1);
    backgroundMesh.position.set(layout.position.x, layout.position.y, layout.position.z);
    backgroundMesh.visible = true;
}
