/**
 * GridBackground — background panel mesh creation, bounds calculation, and layout fitting.
 */

import * as THREE from 'three';
import { createPanelMaterial } from '../panelMaterial.js';
import { enrollPanel } from '../PanelBatch.js';
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
 * Compute background layout for a fixed cell grid (cols x rows) with metrics.
 *
 * A glyph slot's position is its cell's pen origin: the LEFT edge and the vertical CENTRE
 * (glyphMaterial's `aPos`). So the cells span x ∈ [0, cols·strideX] and
 * y ∈ [strideY/2 − rows·strideY, strideY/2], and the panel centres on that span.
 *
 * @param {number} cols
 * @param {number} rows
 * @param {{charWidth:number,charHeight:number,letterSpacing:number,lineSpacing:number}} metrics
 * @param {number} [padding=0.3]
 * @param {number} [bgGap]
 * @returns {{width:number, height:number, cx:number, cy:number, strideX:number, strideY:number, z:number}}
 */
export function computeCellGridLayout(cols, rows, metrics, padding = 0.3, bgGap) {
    const strideX = metrics.charWidth + metrics.letterSpacing;
    const strideY = metrics.lineSpacing;
    const width = cols * strideX + padding * 2;
    const height = rows * strideY + padding * 2;
    const cx = (cols * strideX) / 2;
    const cy = -(rows * strideY) / 2 + strideY / 2;
    const gap = bgGap ?? getBandDistance(LAYER_BAND.GRID_BACKGROUND);
    return { width, height, cx, cy, strideX, strideY, z: -gap };
}


/**
 * The cell under a point of a cell grid, in the grid's own frame (the one computeCellGridLayout lays
 * out: the cells span x ∈ [0, cols·strideX] and y ∈ [strideY/2 − rows·strideY, strideY/2], row 0 on
 * top). `x` and `y` are the point in cells from the grid's top-left corner, clamped to the grid
 * (3.5 is the middle of the fourth column); `col` and `row` the cell holding it, from 0. A point off
 * the grid is its nearest edge's, as a terminal goes on reporting a drag that left it.
 *
 * @param {number} cols
 * @param {number} rows
 * @param {{charWidth:number,letterSpacing:number,lineSpacing:number}} metrics
 * @param {number} px - the point's x in the grid's frame
 * @param {number} py - the point's y in the grid's frame
 * @param {{x:number, y:number, col:number, row:number}} [out] - filled and returned (a pointer move reads into one, allocating nothing)
 * @returns {{x:number, y:number, col:number, row:number}}
 */
export function cellAtPoint(cols, rows, metrics, px, py, out = { x: 0, y: 0, col: 0, row: 0 }) {
    const strideX = metrics.charWidth + metrics.letterSpacing;
    const strideY = metrics.lineSpacing;
    const x = Math.min(Math.max(px / strideX, 0), cols);
    const y = Math.min(Math.max((strideY / 2 - py) / strideY, 0), rows);
    out.x = x; out.y = y; out.col = Math.min(Math.floor(x), cols - 1); out.row = Math.min(Math.floor(y), rows - 1);
    return out;
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
    });

    const mesh = enrollPanel(new THREE.Mesh(geometry, panel.material));
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
