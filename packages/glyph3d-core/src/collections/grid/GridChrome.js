import Button3D from '../../components/Button3D.js';
import { computeCellGridLayout } from './GridBackground.js';


/**
 * Terminal / Grid window chrome specification.
 * A row of bottom-edge controls laid out right-to-left from the SE corner.
 */
export const TERMINAL_CONTROL_SPEC = Object.freeze([
    { role: 'resize',        label: 'Resize', color: 0x6ee7a0, grab: true  },                    // green grip: drag → cols/rows
    { role: 'scale',         label: 'Scale',  color: 0xf2787a, grab: true  },                    // red grip:   drag → zoom
    { role: 'capture',       label: 'Lock',   color: 0xff7a18, grab: false },                    // orange:     click → settle/unsettle keyboard capture
    { role: 'pin',           label: 'Pin',    color: 0xf2c14e, grab: false },                    // amber:      click → maximize toggle
    { role: 'drop',          label: 'Drop',   color: 0x8ab4f8, grab: false },                    // blue:       click → set down camera-front (window.drop)
    { role: 'close',         label: 'Close',  color: 0x8a93a0, grab: false },                    // slate:      click → arm the confirm
    { role: 'close-confirm', label: 'Sure?',  color: 0xe5534b, grab: false, popupOf: 'close' },  // alarm red:  click → terminal.kill
]);

export class GridChrome {
    /**
     * @param {THREE.Object3D} parent
     * @param {import('../../utils/Metrics.js').Metrics} metrics
     * @param {Array<Object>} [specs]
     */
    constructor(parent, metrics, specs = TERMINAL_CONTROL_SPEC) {
        this.parent = parent;
        this.metrics = metrics;
        this.specs = specs;
        this.controls = [];
        this._initControls();
    }

    _initControls() {
        const m = this.metrics;
        const h = m.lineSpacing * 1.5;
        this.controls = this.specs.map((spec) => {
            const button = new Button3D({
                label: spec.label,
                height: h,
                color: spec.color,
                grab: spec.grab,
                opacity: spec.grab ? 0.66 : 0.6,
                role: spec.role,
            });
            if (spec.popupOf) button.visible = false;
            if (this.parent) this.parent.add(button);
            return { spec, button };
        });
    }

    /**
     * Place the control row along the bottom edge, packing pills right→left from the SE corner.
     * Popups (popupOf) are positioned directly above their anchor button.
     *
     * @param {number} cols
     * @param {number} rows
     * @param {number} [padding=0.3]
     */
    layout(cols, rows, padding = 0.3) {
        if (!this.controls?.length) return;
        const layout = computeCellGridLayout(cols, rows, this.metrics, padding);
        const edgeY = layout.cy - layout.height / 2;
        const gap = layout.strideX * 0.5;
        const placed = new Map();
        let xRight = layout.cx + layout.width / 2;

        for (const c of this.controls) {
            if (c.spec.popupOf) continue;
            const w = c.button.width;
            const x = xRight - w / 2;
            c.button.position.set(x, edgeY, 0.5);
            placed.set(c.spec.role, { x, h: c.button.height });
            xRight -= (w + gap);
        }

        for (const c of this.controls) {
            if (!c.spec.popupOf) continue;
            const anchor = placed.get(c.spec.popupOf);
            if (anchor) {
                c.button.position.set(anchor.x, edgeY + anchor.h + gap, 0.5);
            }
        }
    }

    /**
     * Register controls on the picking system 'handle' channel.
     *
     * @param {import('../../picking/PickingSystem.js').PickingSystem} pickingSystem
     * @param {THREE.Object3D} hostGrid
     */
    registerPicking(pickingSystem, hostGrid) {
        if (!pickingSystem) return;
        for (const c of this.controls) {
            pickingSystem.register('handle', c.button, {
                grid: hostGrid,
                edge: 'se',
                role: c.spec.role,
                button: c.button,
            });
        }
    }

    /**
     * Unregister controls from the picking system.
     *
     * @param {import('../../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    unregisterPicking(pickingSystem) {
        if (!pickingSystem) return;
        for (const c of this.controls) {
            pickingSystem.unregister('handle', c.button);
        }
    }

    /**
     * Set active state on a button by role.
     *
     * @param {string} role
     * @param {boolean} on
     */
    setActive(role, on) {
        const c = this.controls.find((x) => x.spec.role === role);
        c?.button.setActive(!!on);
    }

    /**
     * Set visibility on a button by role.
     *
     * @param {string} role
     * @param {boolean} on
     */
    setVisible(role, on) {
        const c = this.controls.find((x) => x.spec.role === role);
        if (c) c.button.visible = !!on;
    }

    /**
     * Dispose buttons and detach from parent.
     */
    dispose() {
        for (const c of this.controls) {
            c.button.dispose();
            if (this.parent) this.parent.remove(c.button);
        }
        this.controls = [];
    }
}
