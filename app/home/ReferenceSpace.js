/**
 * ReferenceSpace — the drafting-paper world the home page sits inside.
 *
 * Three quiet layers, each tuned to be felt more than seen:
 *
 *   1. A ground grid plane at y = -40, low opacity. Gives the eye a
 *      horizon, a "floor" the content sits above. Two stacked grids
 *      (coarse + fine) so the spacing has rhythm.
 *
 *   2. Exponential fog, dialed gentle. Distant geometry fades to the
 *      background. The clusters at z≈0 stay crisp (camera is at z=200,
 *      so they're well inside the unfogged near range); only the
 *      reference geometry softens with distance. If glyph clusters use
 *      a custom shader that ignores scene.fog, that's a feature here —
 *      content stays sharp, atmosphere recedes.
 *
 *   3. A sparse field of dim far-points, scattered deep in -Z. When
 *      the camera shifts even slightly they parallax against the
 *      foreground — the eye reads this as "I am standing in a space"
 *      without ever cognitively registering the points themselves.
 *
 * Add one of these to the scene, separate from your layout root.
 * It's not a layout participant; it's the room.
 */

import * as THREE from 'three';

const DEFAULTS = Object.freeze({
    backgroundColor: 0x050608,
    floorY:          -42,
    coarseSize:      2000,
    coarseDivisions: 40,    // 50-unit cells
    fineDivisions:   200,   // 10-unit cells
    coarseColor:     0x223044,
    fineColor:       0x141a24,
    coarseOpacity:   0.35,
    fineOpacity:     0.16,
    fogNear:         320,
    fogFar:          2400,
    farPointCount:   180,
    farPointZMin:    -2200,
    farPointZMax:    -500,
    farPointXY:      1600,
    farPointColor:   0x6a7896,
    farPointSize:    1.6,
    farPointOpacity: 0.55,
});

export default class ReferenceSpace extends THREE.Object3D {
    /**
     * @param {Object} [opts]
     * @param {THREE.Scene} [opts.scene]  if provided, installs fog onto it
     */
    constructor(opts = {}) {
        super();
        this.name = 'ReferenceSpace';
        const cfg = { ...DEFAULTS, ...opts };
        this._cfg = cfg;

        this._buildFloor(cfg);
        this._buildFarPoints(cfg);

        if (opts.scene) this.applyTo(opts.scene);
    }

    /**
     * Install fog + background color on the given scene. Idempotent.
     * Done as a separate call so a single ReferenceSpace can be added
     * to multiple scenes (or so callers can opt out of fog).
     */
    applyTo(scene) {
        scene.fog = new THREE.Fog(this._cfg.backgroundColor, this._cfg.fogNear, this._cfg.fogFar);
        // Background already set by HomeShell — only overwrite if absent.
        if (!scene.background) scene.background = new THREE.Color(this._cfg.backgroundColor);
        return this;
    }

    _buildFloor(cfg) {
        // Two grids stacked: coarse + fine. Each is its own line material
        // so we can tint and fade independently.
        const coarse = new THREE.GridHelper(
            cfg.coarseSize, cfg.coarseDivisions,
            cfg.coarseColor, cfg.coarseColor,
        );
        coarse.material.transparent = true;
        coarse.material.opacity = cfg.coarseOpacity;
        coarse.material.depthWrite = false;
        coarse.position.y = cfg.floorY;
        coarse.name = 'floor-coarse';

        const fine = new THREE.GridHelper(
            cfg.coarseSize, cfg.fineDivisions,
            cfg.fineColor, cfg.fineColor,
        );
        fine.material.transparent = true;
        fine.material.opacity = cfg.fineOpacity;
        fine.material.depthWrite = false;
        // Lift fine slightly so depth ties break in favor of it (avoids
        // z-fighting flicker where coarse + fine overlap).
        fine.position.y = cfg.floorY + 0.01;
        fine.name = 'floor-fine';

        this.add(fine);
        this.add(coarse);
    }

    _buildFarPoints(cfg) {
        const positions = new Float32Array(cfg.farPointCount * 3);
        for (let i = 0; i < cfg.farPointCount; i++) {
            // Distribute mostly in deep Z, scattered XY. Bias Z toward
            // farther so the field reads as a *gradient* not a curtain.
            const t = Math.pow(Math.random(), 0.6);
            const z = cfg.farPointZMin + (cfg.farPointZMax - cfg.farPointZMin) * (1 - t);
            positions[i * 3 + 0] = (Math.random() * 2 - 1) * cfg.farPointXY;
            positions[i * 3 + 1] = (Math.random() * 2 - 1) * cfg.farPointXY * 0.6;
            positions[i * 3 + 2] = z;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: cfg.farPointColor,
            size: cfg.farPointSize,
            sizeAttenuation: true,
            transparent: true,
            opacity: cfg.farPointOpacity,
            depthWrite: false,
            // Slight additive blend so overlapping points don't punch
            // dark dots into the fog.
            blending: THREE.AdditiveBlending,
        });

        const points = new THREE.Points(geom, mat);
        points.name = 'far-points';
        this.add(points);
    }
}
