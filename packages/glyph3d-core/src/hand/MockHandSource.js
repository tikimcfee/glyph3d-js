/**
 * Mock Hand Source
 *
 * Generates procedural hand skeleton data from mouse position.
 * For development and testing without a camera or phone.
 *
 * - Move mouse to position the hand
 * - Hold Space to simulate pinch
 */

import { JOINT_COUNT } from './HandData.js';

class MockHandSource {
    /**
     * @param {Object} options
     * @param {HTMLCanvasElement} options.canvas - Canvas element for mouse tracking
     */
    constructor(options = {}) {
        this.canvas = options.canvas || document.querySelector('canvas');
        this.mouseX = 0.5;
        this.mouseY = 0.5;
        this.pinching = false;

        this._onMouseMove = this._onMouseMove.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);

        this.canvas.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    /** @private */
    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouseX = (e.clientX - rect.left) / rect.width;
        this.mouseY = (e.clientY - rect.top) / rect.height;
    }

    /** @private */
    _onKeyDown(e) {
        if (e.code === 'Space') {
            e.preventDefault();
            this.pinching = true;
        }
    }

    /** @private */
    _onKeyUp(e) {
        if (e.code === 'Space') {
            this.pinching = false;
        }
    }

    /**
     * Generate a procedural hand frame at current mouse position.
     * Call this in your render loop.
     * @returns {Array<HandFrame>}
     */
    detect() {
        const cx = this.mouseX;
        const cy = this.mouseY;
        const t = performance.now() * 0.001;

        // Subtle idle animation
        const wobble = Math.sin(t * 2) * 0.002;

        const spread = 0.04;
        const segLen = 0.025;

        const landmarks = new Array(JOINT_COUNT);

        // 0: Wrist — below hand center
        landmarks[0] = { x: cx, y: cy + 0.12, z: 0 };

        // Finger base positions and angles relative to hand center
        const fingerDefs = [
            { bx: -spread * 1.8, by: 0.03, angle: -0.4 },  // thumb
            { bx: -spread,       by: -0.02, angle: -0.1 },  // index
            { bx: 0,             by: -0.03, angle: 0 },     // middle
            { bx: spread,        by: -0.02, angle: 0.1 },   // ring
            { bx: spread * 1.8,  by: 0,     angle: 0.2 },   // pinky
        ];

        for (let f = 0; f < 5; f++) {
            const def = fingerDefs[f];
            const baseIdx = f === 0 ? 1 : 5 + (f - 1) * 4;
            const len = f === 0 ? segLen * 0.9 : segLen;

            for (let j = 0; j < 4; j++) {
                const progress = (j + 1) / 4;
                let x = cx + def.bx + Math.sin(def.angle) * len * (j + 1);
                let y = cy + def.by - len * (j + 1) + wobble * progress;
                let z = 0;

                // Pinch: move thumb tip toward index tip
                if (this.pinching && f === 0 && j === 3) {
                    const idxDef = fingerDefs[1];
                    const itx = cx + idxDef.bx + Math.sin(idxDef.angle) * segLen * 4;
                    const ity = cy + idxDef.by - segLen * 4;
                    x += (itx - x) * 0.92;
                    y += (ity - y) * 0.92;
                }

                landmarks[baseIdx + j] = { x, y, z };
            }
        }

        return [{
            handedness: 'right',
            landmarks,
            timestamp: performance.now(),
        }];
    }

    /**
     * Cleanup event listeners
     */
    dispose() {
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }
}

export default MockHandSource;
