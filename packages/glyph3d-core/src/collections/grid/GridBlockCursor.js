import * as THREE from 'three';
import { createCursorMaterial } from '../cursorMaterial.js';

export const DEFAULT_CURSOR_RENDER_ORDER = 5;

/**
 * GridBlockCursor — manages the 3D cursor mesh (solid, hollow, or captured look)
 * for a terminal cell grid.
 */
export class GridBlockCursor {
    /**
     * @param {Object} options
     * @param {THREE.Object3D} [options.parent]
     * @param {import('../../utils/Metrics.js').Metrics} options.metrics
     * @param {number|string} [options.color='#6ee7a0']
     * @param {number} [options.fillOpacity=0.5]
     * @param {number} [options.borderWidth=1.5]
     * @param {number} [options.renderOrder=5]
     */
    constructor({
        parent = null,
        metrics,
        color = '#6ee7a0',
        fillOpacity = 0.5,
        borderWidth = 1.5,
        renderOrder = DEFAULT_CURSOR_RENDER_ORDER,
    } = {}) {
        this.parent = parent;
        this.metrics = metrics;
        this.color = color;
        this.fillOpacity = fillOpacity;
        this.borderWidth = borderWidth;
        this.renderOrder = renderOrder;

        this.col = 0;
        this.row = 0;
        this.cursorVisible = true;
        this.gridVisible = true;
        this.focused = false;
        this.captured = false;

        this.ctl = createCursorMaterial({
            color: this.color,
            fillOpacity: this.fillOpacity,
            borderWidth: this.borderWidth,
        });
        this._applyState();

        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ctl.material);
        this.mesh.renderOrder = this.renderOrder;
        this.mesh.frustumCulled = false;
        if (this.parent) {
            this.parent.add(this.mesh);
        }
    }

    _applyState() {
        const state = this.captured ? 'captured' : this.focused ? 'solid' : 'hollow';
        this.ctl?.setState(state);
    }

    setFocused(focused) {
        this.focused = !!focused;
        this._applyState();
    }

    setCaptured(captured) {
        this.captured = !!captured;
        this._applyState();
    }

    setCursorVisible(visible) {
        this.cursorVisible = !!visible;
    }

    setGridVisible(visible) {
        this.gridVisible = !!visible;
    }

    setStyle({ color, fillOpacity, borderWidth } = {}) {
        if (color != null) this.color = color;
        if (fillOpacity != null) this.fillOpacity = fillOpacity;
        if (borderWidth != null) this.borderWidth = borderWidth;
        this.ctl?.setStyle({ color, fillOpacity, borderWidth });
    }

    /**
     * Position and scale the cursor block on cell (col, row).
     *
     * @param {number} col
     * @param {number} row
     * @param {number} cols
     * @param {number} rows
     * @param {import('../../utils/Metrics.js').Metrics} [metrics]
     */
    update(col, row, cols, rows, metrics = this.metrics) {
        this.col = col;
        this.row = row;
        if (!this.mesh) return;

        if (!this.gridVisible || !this.cursorVisible || col < 0 || col >= cols || row < 0 || row >= rows) {
            this.mesh.visible = false;
            return;
        }

        const m = metrics || this.metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        this.mesh.scale.set(strideX, strideY, 1);
        this.mesh.position.set(col * strideX + strideX / 2, -row * strideY, 0.05);
        this.mesh.visible = true;
    }

    dispose() {
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            if (this.parent) {
                this.parent.remove(this.mesh);
            }
            this.mesh = null;
            this.ctl = null;
        }
    }
}
